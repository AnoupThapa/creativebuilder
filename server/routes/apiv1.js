'use strict';
/* Developer API (v1) + API key management.
   - Secret keys (pf_live_…) are for a business's own servers: resize, background removal, captions, AI images.
     Stored only as a hash; shown once. Each output file counts as a download for the key's owner.
   - Publishable keys (pf_pub_…) only power the embeddable website widget, from the listed websites. */
const express = require('express');
const multer = require('multer');
const JSZip = require('jszip');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { q } = require('../db');
const S = require('../security');
const { effectivePlan, usageFor, publicPlan } = require('../plans');
const imaging = require('../imaging');
const { SIZES } = require('./review');

const wsOf = u => q.get('SELECT * FROM workspaces WHERE id = ?', u.workspace_id);
const MAX_KEYS = 10;

/* ================================================================== */
/* KEY MANAGEMENT (signed in, under /api)                              */
/* ================================================================== */
const manage = express.Router();
function requireApiPlan(u) {
  const plan = effectivePlan(wsOf(u));
  if (!plan.api_access) throw new S.HttpError(402, 'The developer API and website widget are included in the Business and Agency plans.', { code: 'upgrade' });
  return plan;
}
const originOk = o => /^https:\/\/[a-z0-9.-]+(:\d{2,5})?$/i.test(o) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d{2,5})?$/i.test(o);
function keyOut(k) {
  let full = null;
  if (k.kind === 'publishable' && k.key_enc) { try { full = S.decrypt(k.key_enc); } catch {} }
  return { id: k.id, kind: k.kind, name: k.name, prefix: k.prefix, key: full, origins: JSON.parse(k.origins || '[]'), created_at: k.created_at, last_used_at: k.last_used_at };
}
manage.get('/api-keys', S.requireRole('admin'), (req, res) => {
  const plan = effectivePlan(wsOf(req.user));
  res.json({ allowed: !!plan.api_access, keys: q.all('SELECT * FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL ORDER BY id DESC', req.user.workspace_id).map(keyOut) });
});
manage.post('/api-keys', S.requireRole('admin'), (req, res) => {
  requireApiPlan(req.user);
  const kind = req.body.kind === 'publishable' ? 'publishable' : 'secret';
  const name = S.str(req.body.name, { field: 'Name', max: 60 }) || (kind === 'secret' ? 'Server key' : 'Website widget');
  if (q.get('SELECT COUNT(*) n FROM api_keys WHERE workspace_id = ? AND revoked_at IS NULL', req.user.workspace_id).n >= MAX_KEYS)
    throw new S.HttpError(400, `You can have up to ${MAX_KEYS} active keys. Delete an old one first.`);
  let origins = [];
  if (kind === 'publishable') {
    origins = [...new Set((Array.isArray(req.body.origins) ? req.body.origins : String(req.body.origins || '').split(/[\s,]+/))
      .map(o => String(o).trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean))].slice(0, 10);
    if (!origins.length) throw new S.HttpError(400, 'Add the website(s) where the widget will appear, e.g. https://www.yourshop.com');
    const bad = origins.find(o => !originOk(o));
    if (bad) throw new S.HttpError(400, `“${bad}” isn't a valid website address — use the form https://www.yourshop.com`);
  }
  const key = (kind === 'secret' ? 'pf_live_' : 'pf_pub_') + S.randomToken(kind === 'secret' ? 30 : 20);
  const id = q.run(`INSERT INTO api_keys (workspace_id, user_id, kind, name, prefix, key_hash, key_enc, origins, created_at) VALUES (?,?,?,?,?,?,?,?,?)`,
    req.user.workspace_id, req.user.id, kind, name, key.slice(0, 14), S.sha256(key), kind === 'publishable' ? S.encrypt(key) : null, JSON.stringify(origins), Date.now()).lastInsertRowid;
  S.audit(req, 'api.key_created', { id, kind, name, origins });
  res.status(201).json({ ...keyOut(q.get('SELECT * FROM api_keys WHERE id = ?', id)), key, shownOnce: kind === 'secret' });
});
manage.delete('/api-keys/:id', S.requireRole('admin'), (req, res) => {
  const k = q.get('SELECT * FROM api_keys WHERE id = ? AND workspace_id = ? AND revoked_at IS NULL', +req.params.id, req.user.workspace_id);
  if (!k) throw new S.HttpError(404, 'Key not found.');
  q.run('UPDATE api_keys SET revoked_at = ? WHERE id = ?', Date.now(), k.id);
  S.audit(req, 'api.key_revoked', { id: k.id, kind: k.kind, prefix: k.prefix });
  res.json({ ok: true });
});

/* Look up an active key + its owner; the owner must still be active and the plan must include the API. */
function resolveKey(raw, kind) {
  if (typeof raw !== 'string' || !/^pf_(live|pub)_[\w-]{20,60}$/.test(raw)) return null;
  const k = q.get('SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL', S.sha256(raw));
  if (!k || k.kind !== kind) return null;
  const u = q.get("SELECT * FROM users WHERE id = ? AND workspace_id = ? AND status = 'active'", k.user_id, k.workspace_id);
  if (!u) return null;
  const plan = effectivePlan(wsOf(u));
  if (!plan.api_access) return { k, u, plan, blocked: true };
  return { k, u, plan };
}

/* ================================================================== */
/* PUBLIC API v1 (Bearer secret key — never cookies)                   */
/* ================================================================== */
const v1 = express.Router();
const fail = (res, status, error, code) => res.status(status).json({ error, code });
v1.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
  if (!m) return fail(res, 401, 'Send your secret key as: Authorization: Bearer pf_live_…', 'auth');
  const r = resolveKey(m[1], 'secret');
  if (!r) return fail(res, 401, 'That API key is not valid or was deleted.', 'auth');
  if (r.blocked) return fail(res, 402, 'The developer API is included in the Business and Agency plans.', 'upgrade');
  req.user = r.u; req.apiKey = r.k; req.plan = r.plan;
  q.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', Date.now(), r.k.id);
  next();
});
v1.use(rateLimit({ windowMs: 60 * 1000, limit: 120, keyGenerator: req => 'k' + req.apiKey.id, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Too many requests — up to 120 a minute per key.', code: 'rate_limit' }, skip: () => process.env.NODE_ENV === 'test' }));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 20 } }).single('image');
const withImage = (req, res, next) => upload(req, res, err => {
  if (err) return fail(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'Image too big (max 15 MB).' : 'Send the photo as multipart field “image”.', 'bad_request');
  if (!req.file) return fail(res, 400, 'Send the photo as multipart field “image”.', 'bad_request');
  const b = req.file.buffer;
  const ok = (b[0] === 0xff && b[1] === 0xd8) || b.toString('ascii', 1, 4) === 'PNG' || b.toString('ascii', 8, 12) === 'WEBP';
  if (!ok) return fail(res, 415, 'Use a JPG, PNG or WEBP image.', 'unsupported');
  next();
});
const charge = (req, items) => require('./workspace').authoriseExports(req.user, items, 1, null);

v1.get('/me', (req, res) => {
  const ws = wsOf(req.user);
  res.json({ workspace: { id: ws.id, name: ws.name, account_type: ws.account_type }, key: { name: req.apiKey.name, prefix: req.apiKey.prefix },
    plan: publicPlan(req.plan), usage: usageFor(req.user, req.plan) });
});
v1.get('/sizes', (req, res) => res.json(Object.entries(SIZES).map(([key, [label, width, height]]) => ({ key, label, width, height }))));
v1.get('/brands', (req, res) => res.json(q.all('SELECT * FROM brand_kits WHERE workspace_id = ? ORDER BY id', req.user.workspace_id)
  .map(k => ({ id: k.id, name: k.name, color: k.color, colors: JSON.parse(k.colors || '[]'), font_heading: k.font_heading, font_body: k.font_body,
    phone: k.phone, website: k.website, email: k.email, tagline: k.tagline, socials: JSON.parse(k.socials || '{}') }))));

/* Resize one photo into one or more platform sizes. One size → the image; several → a ZIP. */
v1.post('/resize', withImage, async (req, res) => {
  const sizes = [...new Set(String(req.body.sizes || 'ig_post').split(/[\s,]+/).filter(Boolean))];
  const bad = sizes.find(s => !SIZES[s]);
  if (bad || !sizes.length || sizes.length > 14) return fail(res, 400, bad ? `Unknown size “${bad}”. GET /api/v1/sizes lists them.` : 'Ask for 1–14 sizes.', 'bad_request');
  const fit = req.body.fit === 'cover' ? 'cover' : 'contain';
  const format = req.body.format === 'png' ? 'png' : 'jpg';
  let background = ['blur', 'white', 'color', 'brand', 'transparent'].includes(req.body.background) ? req.body.background : 'blur';
  let color = /^#[0-9a-f]{6}$/i.test(req.body.color || '') ? req.body.color : '#ffffff';
  if (background === 'brand') {
    const k = q.get('SELECT color FROM brand_kits WHERE id = ? AND workspace_id = ?', +req.body.brand_id, req.user.workspace_id);
    if (!k) return fail(res, 400, 'Send brand_id (GET /api/v1/brands) when background=brand.', 'bad_request');
    background = 'color'; color = k.color;
  }
  if (background === 'transparent' && format !== 'png') return fail(res, 400, 'background=transparent needs format=png.', 'bad_request');
  const usage = charge(req, sizes.map(s => ({ platform: s, kind: 'image' })));
  const files = [];
  for (const s of sizes) {
    const [, W, H] = SIZES[s];
    files.push({ name: `${s}_${W}x${H}.${format}`, data: await imaging.resize(req.file.buffer, W, H, { fit, background, color, format }) });
  }
  res.set('X-PostGenX-Downloads-Left', String(usage.usage.remaining));
  if (files.length === 1) return res.type(format === 'png' ? 'image/png' : 'image/jpeg').attachment(files[0].name).send(files[0].data);
  const zip = new JSZip(); files.forEach(f => zip.file(f.name, f.data));
  res.type('application/zip').attachment('postgenx-sizes.zip').send(await zip.generateAsync({ type: 'nodebuffer' }));
});

/* Remove the background → transparent PNG */
v1.post('/remove-background', withImage, async (req, res) => {
  const usage = charge(req, [{ platform: 'api_cutout', kind: 'image' }]);
  const r = await imaging.removeBackground(req.file.buffer);
  res.set('X-PostGenX-Downloads-Left', String(usage.usage.remaining));
  res.type('image/png').attachment('cutout.png').send(r.png);
});

/* Captions for each platform (same daily allowance as in the app) */
v1.post('/captions', async (req, res) => {
  const limit = req.plan.code === 'free' ? 5 : 100;
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const used = q.get("SELECT COUNT(*) n FROM audit_log WHERE user_id = ? AND action = 'ai.captions' AND created_at >= ?", req.user.id, start.getTime()).n;
  if (used >= limit) return fail(res, 429, 'Daily caption limit reached — try again tomorrow.', 'captions_limit');
  try {
    const r = await require('../ai/captions').write(req.body || {});
    S.audit(req, 'ai.captions', { platforms: Object.keys(r.captions), source: r.source, api: req.apiKey.id });
    res.json({ ...r, left: limit - used - 1 });
  } catch (e) { fail(res, e.status || 400, e.message, 'bad_request'); }
});

/* AI product photos (uses AI credits like the app) */
v1.get('/ai/styles', (req, res) => res.json(require('../ai').templates().filter(t => t.kind === 'image')
  .map(t => ({ key: t.key, industry: t.industry, name: t.name, description: t.description, needs_photo: !!t.needs_photo }))));
v1.post('/ai/images', (req, res, next) => upload(req, res, () => next()), (req, res) => {
  const ai = require('../ai');
  let photo = null;
  if (req.file) {
    const t = require('./media').sniff(req.file.buffer);
    if (!t || t.kind !== 'image') return fail(res, 415, 'Use a JPG, PNG or WEBP image.', 'unsupported');
    photo = { buffer: req.file.buffer, mime: t.mime };
  }
  const str = (v, n) => String(v || '').slice(0, n);
  try {
    const job = ai.createJob(req.user, { templateKey: req.body.style, photo, aspect: req.body.aspect, count: req.body.count,
      input: { product: str(req.body.product, 120), details: str(req.body.details, 400), price: str(req.body.price, 30), colours: str(req.body.colours, 80), mood: str(req.body.mood, 60), setting: str(req.body.setting, 120) } });
    S.audit(req, 'ai.job', { id: job.id, api: req.apiKey.id });
    res.status(202).json(jobOut(job));
  } catch (e) { fail(res, e.status || 400, e.message, e.extra?.code || 'bad_request'); }
});
function jobOut(j) {
  const p = require('../ai').publicJob(j);
  return { id: p.id, status: p.status, style: p.template, aspect: p.aspect, error: p.error || undefined,
    images: p.outputs.map(o => `/api/v1/ai/jobs/${p.id}/images/${o.n}`), created_at: p.created_at, finished_at: p.finished_at };
}
v1.get('/ai/jobs/:id', (req, res) => {
  const j = q.get('SELECT * FROM ai_jobs WHERE id = ? AND workspace_id = ?', String(req.params.id), req.user.workspace_id);
  if (!j) return fail(res, 404, 'Job not found.', 'not_found');
  res.json(jobOut(j));
});
v1.get('/ai/jobs/:id/images/:n', (req, res) => {
  const out = require('../ai').outputFile(req.user, req.params.id, req.params.n);
  if (!out || !require('node:fs').existsSync(out.path)) return fail(res, 404, 'Image not found.', 'not_found');
  res.sendFile(out.path);
});

v1.use((req, res) => fail(res, 404, 'Unknown endpoint. See /developers for the list.', 'not_found'));
v1.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
  if (!err.status || err.status >= 500) console.error('[api v1]', err);
  fail(res, err.status || 500, err.status ? err.message : 'Something went wrong on our side.', err.extra?.code || (err.status ? 'error' : 'server_error'));
});

module.exports = { manage, v1, resolveKey, originOk };
