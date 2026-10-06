'use strict';
/* Embeddable website widget: a business pastes one <script> tag on its website (or a partner platform puts it
   in their dashboard) and visitors get a "resize your photo for every social platform" tool in the business's
   own name and colour. Only the websites listed on the publishable key can show it (browser-enforced via
   frame-ancestors). Each image made counts as a download for the key's owner. */
const express = require('express');
const path = require('node:path');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { q } = require('../db');
const S = require('../security');
const { resolveKey } = require('./apiv1');
const { SIZES } = require('./review');

const router = express.Router();
const HEX = /^#[0-9a-f]{6}$/i;
const lookup = raw => {
  const r = resolveKey(String(raw || ''), 'publishable');
  return r && !r.blocked ? r : null;
};

/* the loader script businesses paste on their site */
router.get('/widget.js', (req, res) => {
  res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*', 'Cross-Origin-Resource-Policy': 'cross-origin' });
  res.send(`/* PostGenX widget loader */
(function(){var s=document.currentScript;if(!s)return;var k=s.getAttribute('data-key')||'';var h=parseInt(s.getAttribute('data-height')||'640',10);
var o=new URL(s.src).origin;var t=s.getAttribute('data-target');var box=t?document.querySelector(t):null;
var f=document.createElement('iframe');f.src=o+'/embed?key='+encodeURIComponent(k);f.title='Photo resizer';f.loading='lazy';
f.setAttribute('allow','clipboard-write');f.style.cssText='width:100%;max-width:880px;border:0;border-radius:16px;display:block;height:'+h+'px';
(box||s.parentNode).insertBefore(f,box?null:s);
window.addEventListener('message',function(e){if(e.origin===o&&e.source===f.contentWindow&&e.data&&e.data.pfHeight){f.style.height=Math.min(2000,Math.max(300,e.data.pfHeight))+'px';}});})();`);
});

/* the widget page itself (inside the iframe) */
router.get('/embed', (req, res) => {
  const r = lookup(req.query.key);
  if (!r) return res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><p style="font-family:sans-serif;color:#666;padding:20px">This tool is not available. (Widget key missing, deleted, or the plan no longer includes it.)</p>');
  const origins = JSON.parse(r.k.origins || '[]').filter(o => /^https?:\/\/[a-z0-9.:-]+$/i.test(o));
  // allow framing only by the listed websites (replace the app-wide 'none')
  const csp = String(res.getHeader('Content-Security-Policy') || '').replace(/frame-ancestors [^;]*/, `frame-ancestors ${origins.join(' ') || "'none'"}`);
  res.setHeader('Content-Security-Policy', csp);
  res.removeHeader('X-Frame-Options');
  res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' });
  res.sendFile(path.join(config.ROOT, 'views', 'embed.html'));
});

const api = express.Router();
api.use(rateLimit({ windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Too many images from this connection — please try again later.' }, skip: () => process.env.NODE_ENV === 'test' }));
api.get('/config', (req, res) => {
  const r = lookup(req.query.key);
  if (!r) return res.status(404).json({ error: 'This tool is not available.' });
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', r.k.workspace_id);
  res.set('Cache-Control', 'no-store').json({ name: ws.portal_name || ws.name, color: HEX.test(ws.portal_color) ? ws.portal_color : '#1a1a2e',
    sizes: Object.entries(SIZES).map(([key, [label, width, height]]) => ({ key, label, width, height })) });
});
/* called right before the visitor downloads: records the images against the owner's allowance */
api.post('/authorise', (req, res) => {
  // only our own widget page (same origin as this server) may call this
  const self = config.appUrl.replace(/\/$/, '');
  const origin = req.headers.origin || '';
  if (origin && origin !== self && !(origin === `${req.protocol}://${req.get('host')}`)) return res.status(403).json({ error: 'Not allowed.' });
  if (!/json/.test(req.headers['content-type'] || '')) return res.status(415).json({ error: 'Send JSON.' });
  const r = lookup(req.body.key);
  if (!r) return res.status(404).json({ error: 'This tool is not available.' });
  const sizes = [...new Set(Array.isArray(req.body.sizes) ? req.body.sizes : [])].filter(s => SIZES[s]).slice(0, 14);
  if (!sizes.length) return res.status(400).json({ error: 'Pick at least one size.' });
  try {
    require('./workspace').authoriseExports(r.u, sizes.map(s => ({ platform: s, kind: 'image' })), 1, null);
  } catch (e) {
    return res.status(e.status === 402 ? 429 : (e.status || 500)).json({ error: e.status === 402 ? 'This tool has reached today’s limit — please try again tomorrow.' : 'Something went wrong.' });
  }
  q.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', Date.now(), r.k.id);
  S.audit(req, 'widget.images', { key: r.k.id, sizes: sizes.length }, r.u);
  res.json({ ok: true });
});

module.exports = { router, api };
