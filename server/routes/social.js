'use strict';
/* Social media publishing: connect Facebook Pages / Instagram accounts, post now or schedule. */
const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const config = require('../config');
const { q } = require('../db');
const S = require('../security');
const social = require('../social');
const { effectivePlan } = require('../plans');
const { authoriseExports, PLATFORM_KEYS } = require('./workspace');

const router = express.Router();
const DAY = 86400000;
const wsOf = u => q.get('SELECT * FROM workspaces WHERE id = ?', u.workspace_id);
const isManager = u => ['owner', 'admin'].includes(u.role);

/* ---------------- status + accounts ---------------- */
router.get('/social/status', (req, res) => {
  res.json({
    demo: social.isDemo(),
    canManage: isManager(req.user),
    canPost: req.user.role !== 'viewer',
    instagramReady: social.isDemo() || !social.isLocalUrl(config.appUrl),
    accounts: social.listAccounts(req.user.workspace_id),
  });
});

/* Opens in a pop-up: sends the person to Facebook's own login/permission screen */
router.get('/social/meta/start', (req, res) => {
  if (!isManager(req.user)) return res.redirect('/social/done?error=' + encodeURIComponent('Only the owner or an admin can connect accounts.'));
  if (social.isDemo()) return res.redirect('/social/connect-demo');
  res.redirect(social.loginUrl(social.newState(req.user)));
});

router.get('/social/meta/callback', async (req, res) => {
  const fail = msg => res.redirect('/social/done?error=' + encodeURIComponent(msg));
  if (req.query.error) return fail(req.query.error_description || 'Facebook login was cancelled.');
  if (!social.takeState(req.query.state, req.user)) return fail('This login link has expired. Please try connecting again.');
  try {
    const r = await social.completeLogin(String(req.query.code || ''), req.user);
    S.audit(req, 'social.connected', { provider: 'meta', pages: r.pages, accounts: r.accounts });
    if (!r.accounts) return fail('No Facebook Pages were shared. Connect again and tick the Pages (and their Instagram accounts) you want to use.');
    res.redirect(`/social/done?ok=1&n=${r.accounts}`);
  } catch (e) {
    console.warn('[social] login failed:', e.message);
    fail('Facebook connection failed: ' + String(e.message).slice(0, 200));
  }
});

router.post('/social/meta/demo', (req, res) => {
  if (!isManager(req.user)) throw new S.HttpError(403, 'Only the owner or an admin can connect accounts.');
  if (!social.isDemo()) throw new S.HttpError(400, 'Demo accounts are only available while Meta is not configured.');
  const r = social.connectDemo(req.user);
  S.audit(req, 'social.connected', { provider: 'demo' });
  res.json({ ok: true, ...r });
});

router.delete('/social/accounts/:id', (req, res) => {
  if (!isManager(req.user)) throw new S.HttpError(403, 'Only the owner or an admin can disconnect accounts.');
  const a = q.get('SELECT * FROM social_accounts WHERE id = ? AND workspace_id = ?', +req.params.id, req.user.workspace_id);
  if (!a) throw new S.HttpError(404, 'Account not found.');
  q.run('DELETE FROM social_accounts WHERE id = ?', a.id);
  S.audit(req, 'social.disconnected', { platform: a.platform, name: a.name });
  res.json({ ok: true });
});

/* ---------------- creating a post ---------------- */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 20 } }).single('file');

function sniff(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg', kind: 'image' };
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', ext: 'png', kind: 'image' };
  if (buf.length > 12 && buf.toString('ascii', 4, 8) === 'ftyp') return { mime: 'video/mp4', ext: 'mp4', kind: 'video' };
  return null;
}

router.post('/social/posts', (req, res, next) => upload(req, res, err => {
  if (err) return next(new S.HttpError(err.code === 'LIMIT_FILE_SIZE' ? 413 : 400, err.code === 'LIMIT_FILE_SIZE' ? 'File is too large (max 100 MB).' : 'Upload failed.'));
  try { createPost(req, res); } catch (e) { next(e); }
}));

function createPost(req, res) {
  const u = req.user;
  if (u.role === 'viewer') throw new S.HttpError(403, 'Viewers can’t post.');
  if (!req.file) throw new S.HttpError(400, 'No image or video received.');
  const type = sniff(req.file.buffer);
  if (!type) throw new S.HttpError(415, 'Posts must be a JPEG/PNG image or an MP4 video.');
  const b = req.body;

  let ids;
  try { ids = JSON.parse(b.accountIds || '[]').map(Number).filter(Boolean); } catch { ids = []; }
  if (!ids.length) throw new S.HttpError(400, 'Choose at least one account to post to.');
  const accounts = ids.map(id => q.get('SELECT * FROM social_accounts WHERE id = ? AND workspace_id = ?', id, u.workspace_id));
  if (accounts.some(a => !a)) throw new S.HttpError(400, 'One of the chosen accounts is not connected.');
  const broken = accounts.find(a => a.status !== 'active');
  if (broken) throw new S.HttpError(400, `${broken.name} needs to be reconnected before you can post to it.`);

  const caption = S.str(b.caption || '', { field: 'Caption', max: 2200 });
  const placement = b.igPlacement === 'story' ? 'story' : 'feed';
  const width = parseInt(b.width, 10) || 0, height = parseInt(b.height, 10) || 0;
  const platform = PLATFORM_KEYS.has(b.platform) ? b.platform : 'ig_post';

  if (type.kind === 'image' && req.file.size > 8 * 1024 * 1024 && accounts.some(a => a.platform === 'instagram'))
    throw new S.HttpError(400, 'Instagram images must be under 8 MB. Use 1× quality.');
  if (accounts.some(a => a.platform === 'instagram') && placement === 'feed' && type.kind === 'image' && width && height) {
    const r = width / height;
    if (r < 0.79 || r > 1.92) throw new S.HttpError(400, 'Instagram feed posts must be between portrait 4:5 and landscape 1.91:1. Choose “Story” or switch to the Instagram Post / Portrait size.');
  }
  if (accounts.some(a => a.platform === 'instagram') && !social.isDemo() && social.isLocalUrl(config.appUrl))
    throw new S.HttpError(400, 'Instagram can only fetch posts from an online PostForge (e.g. on Fly.io), not from localhost. Facebook works from here.');

  let scheduledAt = null;
  if (b.scheduledAt) {
    scheduledAt = Number(b.scheduledAt);
    if (!Number.isFinite(scheduledAt)) throw new S.HttpError(400, 'Invalid schedule time.');
    if (scheduledAt < Date.now() + 60000) throw new S.HttpError(400, 'Pick a time at least 1 minute from now.');
    if (scheduledAt > Date.now() + 90 * DAY) throw new S.HttpError(400, 'You can schedule up to 90 days ahead.');
  }

  // counts against the plan's download allowance, exactly like a download
  const plan = effectivePlan(wsOf(u));
  if (type.kind === 'video' && !plan.video_export) throw new S.HttpError(402, 'Video posts are included from the Starter plan.', { code: 'upgrade' });
  if (config.security.requireVerifiedEmailToExport && !u.email_verified)
    throw new S.HttpError(403, 'Please confirm your email address before posting.', { code: 'verify_email' });
  const designId = b.designId ? String(b.designId).slice(0, 40) : null;
  const grant = authoriseExports(u, [{ platform, kind: type.kind }], 1, designId);

  const file = social.saveMedia(req.file.buffer, type.ext);
  const now = Date.now();
  const postId = q.run(`INSERT INTO social_posts (workspace_id, user_id, design_id, design_name, kind, file, mime, width, height, caption,
                        ig_placement, scheduled_at, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?)`,
  u.workspace_id, u.id, designId, S.str(b.designName || '', { max: 100 }), type.kind, file, type.mime, width, height, caption,
  placement, scheduledAt || now, now).lastInsertRowid;
  for (const a of accounts) {
    q.run('INSERT INTO social_post_targets (post_id, account_id, platform, updated_at) VALUES (?,?,?,?)', postId, a.id, a.platform, now);
  }
  S.audit(req, scheduledAt ? 'social.scheduled' : 'social.posted', { post: postId, accounts: accounts.length, kind: type.kind });
  if (!scheduledAt) social.publishPost(postId).catch(e => console.error('[social] publish', e));
  res.status(201).json({ ok: true, post: social.postView(q.get('SELECT * FROM social_posts WHERE id = ?', postId)), usage: grant.usage });
}

/* ---------------- history, cancel, retry ---------------- */
function getPost(req) {
  const p = q.get('SELECT * FROM social_posts WHERE id = ? AND workspace_id = ?', +req.params.id, req.user.workspace_id);
  if (!p) throw new S.HttpError(404, 'Post not found.');
  return p;
}
const canChange = (u, p) => isManager(u) || p.user_id === u.id;

router.get('/social/posts', (req, res) => {
  const filter = String(req.query.filter || 'all');
  const where = filter === 'scheduled' ? "AND status IN ('scheduled','publishing')"
    : filter === 'done' ? "AND status IN ('published','partial','failed','cancelled')" : '';
  const rows = q.all(`SELECT * FROM social_posts WHERE workspace_id = ? ${where}
                      ORDER BY CASE WHEN status IN ('scheduled','publishing') THEN 0 ELSE 1 END, COALESCE(scheduled_at, created_at) DESC LIMIT 100`,
  req.user.workspace_id);
  res.json(rows.map(social.postView));
});

router.get('/social/posts/:id', (req, res) => res.json(social.postView(getPost(req))));

router.get('/social/posts/:id/media', (req, res) => {
  const p = getPost(req);
  const f = social.mediaPath(p.file);
  if (!fs.existsSync(f)) throw new S.HttpError(404, 'File not found.');
  res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, max-age=3600', 'X-Content-Type-Options': 'nosniff' });
  res.sendFile(f);
});

router.patch('/social/posts/:id', (req, res) => {
  const p = getPost(req);
  if (!canChange(req.user, p)) throw new S.HttpError(403, 'Only the person who created this post or an admin can change it.');
  if (p.status !== 'scheduled') throw new S.HttpError(400, 'Only scheduled posts can be changed.');
  if (req.body.caption !== undefined) q.run('UPDATE social_posts SET caption = ? WHERE id = ?', S.str(req.body.caption, { field: 'Caption', max: 2200 }), p.id);
  if (req.body.scheduledAt !== undefined) {
    const t = Number(req.body.scheduledAt);
    if (!Number.isFinite(t) || t < Date.now() + 60000 || t > Date.now() + 90 * DAY) throw new S.HttpError(400, 'Pick a time between 1 minute and 90 days from now.');
    q.run('UPDATE social_posts SET scheduled_at = ? WHERE id = ?', t, p.id);
  }
  res.json(social.postView(q.get('SELECT * FROM social_posts WHERE id = ?', p.id)));
});

router.post('/social/posts/:id/cancel', (req, res) => {
  const p = getPost(req);
  if (!canChange(req.user, p)) throw new S.HttpError(403, 'Only the person who created this post or an admin can cancel it.');
  if (p.status !== 'scheduled') throw new S.HttpError(400, 'This post is no longer scheduled.');
  q.run("UPDATE social_posts SET status = 'cancelled' WHERE id = ?", p.id);
  S.audit(req, 'social.cancelled', { post: p.id });
  res.json({ ok: true });
});

router.post('/social/posts/:id/retry', (req, res) => {
  const p = getPost(req);
  if (!canChange(req.user, p)) throw new S.HttpError(403, 'Only the person who created this post or an admin can retry it.');
  if (!['failed', 'partial'].includes(p.status)) throw new S.HttpError(400, 'Only failed posts can be retried.');
  social.publishPost(p.id, { onlyFailed: true }).catch(e => console.error('[social] retry', e));
  res.json({ ok: true });
});

router.delete('/social/posts/:id', (req, res) => {
  const p = getPost(req);
  if (!canChange(req.user, p)) throw new S.HttpError(403, 'Only the person who created this post or an admin can remove it.');
  if (p.status === 'publishing') throw new S.HttpError(400, 'This post is being published right now.');
  q.run('DELETE FROM social_post_targets WHERE post_id = ?', p.id);
  q.run('DELETE FROM social_posts WHERE id = ?', p.id);
  social.deletePostFiles(p);
  res.json({ ok: true });
});

/* Public, unguessable link Instagram uses to fetch the picture/video (not listed anywhere) */
function servePublic(req, res, next) {
  const name = String(req.params.file || '');
  if (!/^[0-9a-f]{32}\.(jpg|png|mp4)$/.test(name)) return next();
  const p = q.get("SELECT mime, status FROM social_posts WHERE file = ? AND status != 'cancelled'", name);
  const f = social.mediaPath(name);
  if (!p || !fs.existsSync(f)) return next();
  res.set({ 'Content-Type': p.mime, 'Cache-Control': 'public, max-age=86400', 'X-Robots-Tag': 'noindex' });
  res.sendFile(f);
}

module.exports = { router, servePublic };
