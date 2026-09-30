'use strict';
/* Public-facing endpoints: site config, support requests, in-app feedback,
   approved testimonials, browser error reports and cookie-free page analytics. */
const express = require('express');
const crypto = require('node:crypto');
const config = require('../config');
const { q } = require('../db');
const S = require('../security');
const { sendMail } = require('../mailer');

const router = express.Router();

router.get('/public/config', (req, res) => {
  res.json({
    supportEmail: config.support.email,
    whatsapp: config.support.whatsapp,
    betaMode: config.betaMode,
    plausibleDomain: config.plausibleDomain,
    demoVideoUrl: config.demoVideoUrl,
  });
});

/* ---------------- Support requests ---------------- */
const TOPICS = new Set(['question', 'problem', 'billing', 'account', 'beta', 'feature', 'other']);
router.post('/support', async (req, res) => {
  const u = req.user;
  const name = S.str(req.body.name ?? u?.name, { field: 'Name', required: true, max: 80 });
  const email = u ? u.email : S.email(req.body.email);
  const topic = TOPICS.has(req.body.topic) ? req.body.topic : 'other';
  const message = S.str(req.body.message, { field: 'Message', required: true, min: 10, max: 4000 });
  const page = S.str(req.body.page || '', { max: 200 });
  if (req.body.website) return res.json({ ok: true }); // honeypot field — bots fill it, people don't
  const id = q.run('INSERT INTO support_tickets (user_id, name, email, topic, message, page, created_at) VALUES (?,?,?,?,?,?,?)',
    u?.id ?? null, name, email, topic, message, page, Date.now()).lastInsertRowid;
  const ref = `PF-${String(id).padStart(5, '0')}`;
  if (config.support.email) {
    await sendMail(config.support.email, `[${config.appName} support ${ref}] ${topic}: ${message.slice(0, 60)}`,
      `From: ${name} <${email}>${u ? ` (user #${u.id}, workspace #${u.workspace_id})` : ''}\nTopic: ${topic}\nPage: ${page || '-'}\n\n${message}`);
  }
  await sendMail(email, `We got your message (${ref})`,
    `Hi ${name},\n\nThanks for contacting ${config.appName} support. Your reference is ${ref}.\nWe usually reply within one business day.\n\nYour message:\n${message}`);
  res.status(201).json({ ok: true, ref });
});

/* ---------------- In-app feedback (+ optional testimonial consent) ---------------- */
router.post('/feedback', S.requireAuth, (req, res) => {
  const rating = parseInt(req.body.rating, 10);
  if (!(rating >= 1 && rating <= 5)) throw new S.HttpError(400, 'Pick a rating from 1 to 5.');
  const message = S.str(req.body.message || '', { field: 'Feedback', max: 2000 });
  const allow = !!req.body.allowQuote;
  const displayName = S.str(req.body.displayName || '', { field: 'Name to show', max: 60 });
  const business = S.str(req.body.business || '', { field: 'Business', max: 80 });
  if (allow && (!message || message.length < 15)) throw new S.HttpError(400, 'Please write a sentence or two if we may quote you.');
  if (allow && !displayName) throw new S.HttpError(400, 'Add the name we should show with your quote.');
  q.run(`INSERT INTO feedback (user_id, workspace_id, rating, message, allow_quote, display_name, business, created_at)
         VALUES (?,?,?,?,?,?,?,?)`, req.user.id, req.user.workspace_id, rating, message, allow ? 1 : 0, displayName, business, Date.now());
  S.audit(req, 'feedback.sent', { rating, allowQuote: allow });
  res.status(201).json({ ok: true });
});

/* Only testimonials the customer agreed to share AND an admin approved */
router.get('/public/testimonials', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  res.json(q.all(`SELECT rating, message, display_name, business FROM feedback
                  WHERE approved = 1 AND allow_quote = 1 ORDER BY id DESC LIMIT 12`));
});

/* Before/after examples for the home page. Your own (uploaded in Platform admin) replace the built-in samples. */
router.get('/public/examples', (req, res) => {
  res.set('Cache-Control', 'public, max-age=300');
  const own = q.all('SELECT id, industry, caption, before_file, after_file FROM site_examples ORDER BY sort, id LIMIT 12');
  if (own.length) return res.json({ sample: false, items: own.map(e => ({ industry: e.industry, caption: e.caption, before: '/site/' + e.before_file, after: '/site/' + e.after_file })) });
  let items = [];
  try { items = require('../../public/examples/examples.json'); } catch { /* none */ }
  res.json({ sample: true, items });
});

/* ---------------- Browser error reports (lightweight error tracking) ---------------- */
router.post('/client-error', (req, res) => {
  const message = String(req.body.message || '').slice(0, 500);
  if (!message) return res.status(204).end();
  const source = String(req.body.source || '').slice(0, 300);
  const stack = String(req.body.stack || '').slice(0, 3000);
  const page = String(req.body.page || '').slice(0, 200);
  const now = Date.now();
  const existing = q.get('SELECT id FROM client_errors WHERE message = ? AND source = ? AND last_seen > ?', message, source, now - 7 * 86400000);
  if (existing) q.run('UPDATE client_errors SET count = count + 1, last_seen = ? WHERE id = ?', now, existing.id);
  else q.run('INSERT INTO client_errors (user_id, message, source, stack, page, user_agent, last_seen, created_at) VALUES (?,?,?,?,?,?,?,?)',
    req.user?.id ?? null, message, source, stack, page, String(req.get('user-agent') || '').slice(0, 250), now, now);
  res.status(204).end();
});

/* ---------------- Privacy-friendly page analytics ----------------
   No cookies, no IP addresses stored. A visitor is counted once per day per page
   using a salted hash that is kept in memory only and rotates daily. */
let salt = crypto.randomBytes(16).toString('hex'), saltDay = '', seen = new Set();
router.post('/pv', (req, res) => {
  const day = new Date().toISOString().slice(0, 10);
  if (day !== saltDay) { saltDay = day; salt = crypto.randomBytes(16).toString('hex'); seen = new Set(); }
  let path = String(req.body.path || '/').split('?')[0].slice(0, 100);
  if (!/^\/[\w\-/]*$/.test(path)) path = '/other';
  let ref = '';
  try { const r = new URL(String(req.body.ref || '')); if (r.host !== req.get('host')) ref = r.hostname.replace(/^www\./, '').slice(0, 80); } catch { /* none */ }
  const visitor = crypto.createHash('sha256').update(salt + S.clientIp(req) + (req.get('user-agent') || '') + path).digest('hex');
  const isNew = !seen.has(visitor);
  if (isNew) { seen.add(visitor); if (seen.size > 200000) seen = new Set(); }
  q.run(`INSERT INTO page_views (day, path, referrer, views, visitors) VALUES (?,?,?,1,?)
         ON CONFLICT(day, path, referrer) DO UPDATE SET views = views + 1, visitors = visitors + excluded.visitors`, day, path, ref, isNew ? 1 : 0);
  res.status(204).end();
});

module.exports = { router };
