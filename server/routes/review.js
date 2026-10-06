'use strict';
/* White-label client review portal.
   Agency side (signed in): send designs for review (full-size images of the chosen sizes), portal look
   (name, colour, logo), one secret review link per client brand, replies.
   Client side (no login, secret link): an unbranded page in the agency's look where the client sees each
   design, approves it or asks for changes, comments, and downloads the files. */
const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const { q, tx } = require('../db');
const S = require('../security');
const { effectivePlan } = require('../plans');
const { sendMail } = require('../mailer');

const DIR = path.join(config.DATA_DIR, 'review');
fs.mkdirSync(DIR, { recursive: true });
const HEX = /^#[0-9a-fA-F]{6}$/;
const SIZES = {
  ig_post: ['Instagram Post', 1080, 1080], ig_portrait: ['Instagram Portrait', 1080, 1350], ig_story: ['Instagram Story / Reels', 1080, 1920],
  fb_post: ['Facebook Post', 1080, 1080], fb_story: ['Facebook Story', 1080, 1920], fb_cover: ['Facebook Cover', 851, 315],
  li_post: ['LinkedIn Post', 1080, 1350], li_banner: ['LinkedIn Banner', 1584, 396], pin: ['Pinterest Pin', 1000, 1500],
  x_post: ['X (Twitter) Post', 1080, 1080], tiktok: ['TikTok', 1080, 1920], yt_thumb: ['YouTube Thumbnail', 1280, 720],
  yt_shorts: ['YouTube Shorts', 1080, 1920], wa_status: ['WhatsApp Status', 1080, 1920],
};
const wsOf = u => q.get('SELECT * FROM workspaces WHERE id = ?', u.workspace_id);
function requirePortal(req) {
  const ws = wsOf(req.user), plan = effectivePlan(ws);
  if (ws.account_type !== 'business') throw new S.HttpError(400, 'Client review links are part of Business accounts (Account & security → Account type).', { code: 'business_only' });
  if (plan.code === 'free') throw new S.HttpError(402, 'Client review links are included in paid plans.', { code: 'upgrade' });
  return { ws, plan };
}
const portalLook = ws => ({ name: ws.portal_name || ws.name, color: HEX.test(ws.portal_color) ? ws.portal_color : '#1a1a2e', logo: !!ws.portal_logo_media_id });
const snapFile = s => path.join(DIR, String(s.workspace_id), s.file);
const snapOut = (s, base) => ({ id: s.id, platform: s.platform, label: (SIZES[s.platform] || [s.platform])[0], width: s.width, height: s.height, bytes: s.bytes, url: `${base}/${s.id}` });
const commentsOf = id => q.all('SELECT id, author_type, author_name, action, body, created_at FROM review_comments WHERE design_id = ? ORDER BY id', id);

/* ================================================================== */
/* AGENCY SIDE (mounted under /api, signed in)                         */
/* ================================================================== */
const router = express.Router();

router.get('/workspace/portal', (req, res) => {
  const ws = wsOf(req.user);
  res.json({ ...portalLook(ws), portal_name: ws.portal_name, portal_color: ws.portal_color, logo_url: ws.portal_logo_media_id ? `/media/${ws.portal_logo_media_id}` : null, logo_media_id: ws.portal_logo_media_id });
});
router.put('/workspace/portal', S.requireRole('admin'), (req, res) => {
  const ws = wsOf(req.user);
  const name = S.str(req.body.portal_name ?? ws.portal_name, { field: 'Portal name', max: 80 });
  const color = String(req.body.portal_color ?? ws.portal_color ?? '');
  if (color && !HEX.test(color)) throw new S.HttpError(400, 'Colour must look like #1a1a2e.');
  let logo = req.body.portal_logo_media_id !== undefined ? req.body.portal_logo_media_id : ws.portal_logo_media_id;
  if (logo) {
    const m = q.get("SELECT id FROM media WHERE id = ? AND workspace_id = ? AND kind = 'image'", String(logo), ws.id);
    if (!m) throw new S.HttpError(400, 'Logo file not found.');
    logo = m.id;
  } else logo = null;
  q.run('UPDATE workspaces SET portal_name = ?, portal_color = ?, portal_logo_media_id = ? WHERE id = ?', name, color, logo, ws.id);
  S.audit(req, 'portal.look_updated', { name });
  res.json({ ok: true });
});

/* review links per brand / client */
function linkOut(l) {
  let url = null; try { url = `${config.appUrl.replace(/\/$/, '')}/r/${S.decrypt(l.token_enc)}`; } catch {}
  return { id: l.id, brand_kit_id: l.brand_kit_id, url, created_at: l.created_at, expires_at: l.expires_at, last_opened_at: l.last_opened_at };
}
router.get('/brand-kits/:id/review-links', S.requireRole('designer'), (req, res) => {
  const k = q.get('SELECT id FROM brand_kits WHERE id = ? AND workspace_id = ?', +req.params.id, req.user.workspace_id);
  if (!k) throw new S.HttpError(404, 'Brand not found.');
  res.json(q.all('SELECT * FROM review_links WHERE brand_kit_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?) ORDER BY id DESC', k.id, Date.now()).map(linkOut));
});
router.post('/brand-kits/:id/review-links', S.requireRole('admin'), (req, res) => {
  requirePortal(req);
  const k = q.get('SELECT * FROM brand_kits WHERE id = ? AND workspace_id = ?', +req.params.id, req.user.workspace_id);
  if (!k) throw new S.HttpError(404, 'Brand not found.');
  const active = q.get('SELECT COUNT(*) n FROM review_links WHERE brand_kit_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', k.id, Date.now()).n;
  if (active >= 5) throw new S.HttpError(400, 'This brand already has 5 active review links. Turn one off first.');
  const days = Math.max(0, Math.min(365, parseInt(req.body.days, 10) || 0));
  const token = 'rv_' + S.randomToken(24);
  const id = q.run('INSERT INTO review_links (workspace_id, brand_kit_id, token_hash, token_enc, created_by, created_at, expires_at) VALUES (?,?,?,?,?,?,?)',
    req.user.workspace_id, k.id, S.sha256(token), S.encrypt(token), req.user.id, Date.now(), days ? Date.now() + days * 86400000 : null).lastInsertRowid;
  S.audit(req, 'portal.link_created', { brand: k.id, days });
  res.status(201).json(linkOut(q.get('SELECT * FROM review_links WHERE id = ?', id)));
});
router.delete('/review-links/:id', S.requireRole('admin'), (req, res) => {
  const l = q.get('SELECT * FROM review_links WHERE id = ? AND workspace_id = ?', +req.params.id, req.user.workspace_id);
  if (!l) throw new S.HttpError(404, 'Link not found.');
  q.run('UPDATE review_links SET revoked_at = ? WHERE id = ?', Date.now(), l.id);
  S.audit(req, 'portal.link_revoked', { link: l.id, brand: l.brand_kit_id });
  res.json({ ok: true });
});

/* designs: full-size images for review + status + comments */
function designFor(req, edit = false) {
  const d = q.get('SELECT * FROM designs WHERE id = ? AND workspace_id = ? AND deleted_at IS NULL', String(req.params.id), req.user.workspace_id);
  const { canView, canEdit } = require('./designs');
  if (!d || !canView(req.user, d) || (edit && !canEdit(req.user, d))) throw new S.HttpError(404, 'Design not found.');
  return d;
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 6 } }).single('image');
router.post('/reviews/designs/:id/snapshots', S.requireRole('designer'), (req, res, next) => upload(req, res, err => {
  if (err) return next(new S.HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'Image too big (max 15 MB).' : 'Upload failed.'));
  next();
}), (req, res) => {
  requirePortal(req);
  const d = designFor(req, true);
  if (!d.brand_kit_id) throw new S.HttpError(400, 'Choose the client’s brand for this design first (dashboard → brand on the design card).');
  const platform = String(req.body.platform || '');
  if (!SIZES[platform]) throw new S.HttpError(400, 'Unknown size.');
  const b = req.file && req.file.buffer;
  const isJpg = b && b[0] === 0xff && b[1] === 0xd8, isPng = b && b.toString('ascii', 1, 4) === 'PNG';
  if (!isJpg && !isPng) throw new S.HttpError(415, 'Send a JPG or PNG image.');
  // each size sent to a client is a finished file → counts like a download
  require('./workspace').authoriseExports(req.user, [{ platform, kind: 'image' }], 1, d.id);
  const [, W, H] = SIZES[platform];
  const dir = path.join(DIR, String(d.workspace_id)); fs.mkdirSync(dir, { recursive: true });
  const file = `${d.id}-${platform}-${crypto.randomBytes(4).toString('hex')}.${isJpg ? 'jpg' : 'png'}`;
  const old = q.get('SELECT * FROM review_snapshots WHERE design_id = ? AND platform = ?', d.id, platform);
  fs.writeFileSync(path.join(dir, file), b, { mode: 0o600 });
  if (old) { fs.rm(snapFile(old), { force: true }, () => {}); q.run('DELETE FROM review_snapshots WHERE id = ?', old.id); }
  q.run('INSERT INTO review_snapshots (design_id, workspace_id, platform, file, width, height, bytes, created_at) VALUES (?,?,?,?,?,?,?,?)',
    d.id, d.workspace_id, platform, file, W, H, b.length, Date.now());
  res.status(201).json({ ok: true });
});
router.post('/reviews/designs/:id/send', S.requireRole('designer'), (req, res) => {
  requirePortal(req);
  const d = designFor(req, true);
  const n = q.get('SELECT COUNT(*) n FROM review_snapshots WHERE design_id = ?', d.id).n;
  if (!n) throw new S.HttpError(400, 'Add at least one size first.');
  const note = S.str(req.body.note, { field: 'Note', max: 1000 });
  tx(() => {
    q.run("UPDATE designs SET review_status = 'in_review', review_updated_at = ? WHERE id = ?", Date.now(), d.id);
    q.run(`INSERT INTO review_comments (design_id, workspace_id, author_type, author_name, user_id, action, body, created_at)
           VALUES (?,?,'agency',?,?,'sent',?,?)`, d.id, d.workspace_id, req.user.name, req.user.id, note, Date.now());
  });
  S.audit(req, 'portal.sent_for_review', { design: d.id, sizes: n });
  const links = q.get('SELECT COUNT(*) n FROM review_links WHERE brand_kit_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)', d.brand_kit_id, Date.now()).n;
  res.json({ ok: true, hasLink: links > 0 });
});
router.get('/reviews/designs/:id', (req, res) => {
  const d = designFor(req);
  res.json({ status: d.review_status, snapshots: q.all('SELECT * FROM review_snapshots WHERE design_id = ? ORDER BY id', d.id).map(s => snapOut(s, '/api/reviews/snapshots')),
    comments: commentsOf(d.id) });
});
router.post('/reviews/designs/:id/comments', S.requireRole('designer'), (req, res) => {
  const d = designFor(req);
  const body = S.str(req.body.body, { field: 'Comment', required: true, max: 2000 });
  q.run(`INSERT INTO review_comments (design_id, workspace_id, author_type, author_name, user_id, body, created_at) VALUES (?,?,'agency',?,?,?,?)`,
    d.id, d.workspace_id, req.user.name, req.user.id, body, Date.now());
  res.status(201).json({ ok: true, comments: commentsOf(d.id) });
});
router.delete('/reviews/snapshots/:id', S.requireRole('designer'), (req, res) => {
  const s = q.get('SELECT * FROM review_snapshots WHERE id = ? AND workspace_id = ?', +req.params.id, req.user.workspace_id);
  if (!s) throw new S.HttpError(404, 'Not found.');
  fs.rm(snapFile(s), { force: true }, () => {});
  q.run('DELETE FROM review_snapshots WHERE id = ?', s.id);
  res.json({ ok: true });
});
router.get('/reviews/snapshots/:id', (req, res) => {
  const s = q.get('SELECT * FROM review_snapshots WHERE id = ? AND workspace_id = ?', +req.params.id, req.user.workspace_id);
  if (!s || !fs.existsSync(snapFile(s))) return res.status(404).json({ error: 'Not found' });
  res.set('Cache-Control', 'private, max-age=300').sendFile(snapFile(s));
});

/* ================================================================== */
/* CLIENT SIDE (public, secret link)                                   */
/* ================================================================== */
const portal = express.Router();
function linkFrom(req) {
  const t = String(req.params.token || '');
  if (!/^rv_[\w-]{20,60}$/.test(t)) return null;
  const l = q.get('SELECT * FROM review_links WHERE token_hash = ?', S.sha256(t));
  if (!l || l.revoked_at || (l.expires_at && l.expires_at < Date.now())) return null;
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', l.workspace_id);
  const brand = q.get('SELECT * FROM brand_kits WHERE id = ? AND workspace_id = ?', l.brand_kit_id, l.workspace_id);
  if (!ws || !brand || ws.account_type !== 'business' || effectivePlan(ws).code === 'free') return null;
  return { l, ws, brand };
}
const need = req => { const x = linkFrom(req); if (!x) throw new S.HttpError(404, 'This review link has expired or was turned off. Ask for a new one.'); return x; };
const portalDesigns = x => q.all(`SELECT * FROM designs WHERE workspace_id = ? AND brand_kit_id = ? AND deleted_at IS NULL AND review_status != ''
                                  ORDER BY review_updated_at DESC`, x.ws.id, x.brand.id);
const portalDesign = (x, id) => portalDesigns(x).find(d => d.id === String(id));

portal.use((req, res, next) => { res.set({ 'X-Robots-Tag': 'noindex, nofollow', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); next(); });
portal.get('/:token', (req, res) => {
  const x = need(req);
  q.run('UPDATE review_links SET last_opened_at = ? WHERE id = ?', Date.now(), x.l.id);
  const base = `/portal-api/${req.params.token}`;
  res.json({
    portal: { ...portalLook(x.ws), logo_url: x.ws.portal_logo_media_id ? `${base}/logo` : null },
    brand: { name: x.brand.name, color: x.brand.color, logo_url: x.brand.logo_media_id ? `${base}/brand-logo` : null },
    designs: portalDesigns(x).map(d => ({ id: d.id, name: d.name, status: d.review_status, updated_at: d.review_updated_at,
      snapshots: q.all('SELECT * FROM review_snapshots WHERE design_id = ? ORDER BY id', d.id).map(s => snapOut(s, `${base}/img`)),
      comments: commentsOf(d.id) })),
  });
});
function sendMedia(res, ws, mediaId) {
  const m = mediaId && q.get("SELECT * FROM media WHERE id = ? AND workspace_id = ? AND kind = 'image'", mediaId, ws.id);
  if (!m) return res.status(404).end();
  res.set({ 'Content-Type': m.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
    .sendFile(path.join(config.UPLOAD_DIR, String(ws.id), m.id), err => { if (err && !res.headersSent) res.status(404).end(); });
}
portal.get('/:token/logo', (req, res) => { const x = need(req); sendMedia(res, x.ws, x.ws.portal_logo_media_id); });
portal.get('/:token/brand-logo', (req, res) => { const x = need(req); sendMedia(res, x.ws, x.brand.logo_media_id); });
portal.get('/:token/img/:id', (req, res) => {
  const x = need(req);
  const s = q.get('SELECT * FROM review_snapshots WHERE id = ? AND workspace_id = ?', +req.params.id, x.ws.id);
  if (!s || !portalDesign(x, s.design_id) || !fs.existsSync(snapFile(s))) return res.status(404).json({ error: 'Not found' });
  if (req.query.download) {
    const d = portalDesign(x, s.design_id);
    const slug = String(d.name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 50) || 'design';
    res.attachment(`${slug}-${s.platform}.${s.file.split('.').pop()}`);
  }
  res.sendFile(snapFile(s));
});

async function notify(x, d, action, who, body) {
  const owners = q.all("SELECT DISTINCT email, name FROM users WHERE status = 'active' AND id IN (?, ?)", d.owner_id, x.ws.owner_id);
  const what = action === 'approved' ? 'approved' : action === 'changes' ? 'asked for changes to' : 'commented on';
  const url = `${config.appUrl.replace(/\/$/, '')}/app#designs`;
  for (const o of owners) {
    await sendMail(o.email, `${who} ${what} “${d.name}” (${x.brand.name})`,
      `Hi ${o.name},\n\n${who} from ${x.brand.name} ${what} “${d.name}”.${body ? `\n\n“${body}”` : ''}\n\nOpen your designs: ${url}`).catch(() => {});
  }
}
function clientAction(action) {
  return async (req, res) => {
    if (!/json/.test(req.headers['content-type'] || '')) throw new S.HttpError(415, 'Send JSON.');
    const x = need(req);
    const d = portalDesign(x, req.params.id);
    if (!d) throw new S.HttpError(404, 'Design not found.');
    const who = S.str(req.body.name, { field: 'Your name', required: true, max: 60 });
    const body = S.str(req.body.body, { field: 'Comment', max: 2000, required: action !== 'approved' });
    tx(() => {
      q.run(`INSERT INTO review_comments (design_id, workspace_id, author_type, author_name, action, body, created_at) VALUES (?,?,'client',?,?,?,?)`,
        d.id, x.ws.id, who, action === 'comment' ? '' : action, body, Date.now());
      if (action !== 'comment') q.run('UPDATE designs SET review_status = ?, review_updated_at = ? WHERE id = ?', action, Date.now(), d.id);
    });
    S.audit(req, `portal.client_${action}`, { design: d.id, brand: x.brand.id, name: who }, { id: null, workspace_id: x.ws.id });
    notify(x, d, action, who, body);
    res.status(201).json({ ok: true, status: action === 'comment' ? d.review_status : action, comments: commentsOf(d.id) });
  };
}
portal.post('/:token/designs/:id/comment', clientAction('comment'));
portal.post('/:token/designs/:id/approve', clientAction('approved'));
portal.post('/:token/designs/:id/changes', clientAction('changes'));
portal.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong.' });
});

module.exports = { router, portal, linkFrom, SIZES };
