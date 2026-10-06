'use strict';
/* AI studio API (signed-in users). Images are made in the background: POST a job, then poll it. */
const express = require('express');
const multer = require('multer');
const fs = require('node:fs');
const config = require('../config');
const S = require('../security');
const ai = require('../ai');
const { readProductPage, fetchImage } = require('../ai/fetchurl');
const { sniff } = require('./media');

const router = express.Router();
const CH = require('../ai/characters');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 12 } }).single('photo');
const wrap = e => (e instanceof ai.HttpErr ? new S.HttpError(e.status, e.message, e.extra) : e);

router.get('/ai/options', (req, res) => {
  const all = ai.templates().map(t => ({ key: t.key, industry: t.industry, kind: t.kind, name: t.name, description: t.description, emoji: t.emoji, needsPhoto: !!t.needs_photo }));
  const { q } = require('../db');
  const plan = require('../plans').effectivePlan(q.get('SELECT * FROM workspaces WHERE id = ?', req.user.workspace_id));
  res.json({ industries: ai.INDUSTRIES, templates: all.filter(t => t.kind === 'image'), videoTemplates: all.filter(t => t.kind === 'video'),
    video: { allowed: !!plan.ai_video, credits: config.ai.videoCredits, seconds: [4, 6, 8], demo: require('../ai/videogen').active() === 'demo' },
    aspects: ai.ASPECTS, credits: ai.creditStatus(req.user),
    models: {
      characters: CH.CHARACTERS.map(c => ({ ...CH.pub(c), portrait: ai.characterPortraitUrl(c.key) })),
      actions: Object.entries(CH.ACTIONS).map(([key, a]) => ({ key, label: a.label })),
      looks: Object.entries(CH.LOOKS).map(([key, l]) => ({ key, label: l.label })),
      presenter: { allowed: !!plan.ai_video, credits8: ai.presenterCredits(8), credits15: ai.presenterCredits(15) },
    },
    enabled: ai.enabled(), demo: require('../ai/providers').active() === 'demo',
    topup: { credits: config.ai.topupCredits, price_cents: config.ai.topupPriceCents } });
});

/* AI captions for each platform — no credits used; fair-use daily limit */
router.post('/ai/captions', S.requireRole('designer'), async (req, res) => {
  const { q } = require('../db');
  const plan = require('../plans').effectivePlan(q.get('SELECT * FROM workspaces WHERE id = ?', req.user.workspace_id));
  const limit = plan.code === 'free' ? 5 : 100;
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const used = q.get("SELECT COUNT(*) n FROM audit_log WHERE user_id = ? AND action = 'ai.captions' AND created_at >= ?", req.user.id, start.getTime()).n;
  if (used >= limit) throw new S.HttpError(429, plan.code === 'free'
    ? `You've written ${limit} sets of captions today — upgrade for up to 100 a day.` : 'That’s a lot of captions today — please try again tomorrow.', { code: 'captions_limit' });
  let r;
  try { r = await require('../ai/captions').write(req.body || {}); } catch (e) { throw new S.HttpError(e.status || 400, e.message); }
  S.audit(req, 'ai.captions', { platforms: Object.keys(r.captions), source: r.source });
  res.json({ ...r, left: limit - used - 1 });
});

router.get('/ai/credits', (req, res) => res.json(ai.creditStatus(req.user)));

/* ---------- AI models ---------- */
function photoFrom(req) {
  if (req.file) {
    const t = sniff(req.file.buffer);
    if (!t || t.kind !== 'image') throw new S.HttpError(415, 'Use a JPG, PNG or WEBP photo.');
    return { buffer: req.file.buffer, mime: t.mime };
  }
  if (/^data:image\/(png|jpeg|webp);base64,/.test(req.body.photoData || '')) {
    const buf = Buffer.from(req.body.photoData.split(',')[1], 'base64');
    const t = sniff(buf);
    if (t && t.kind === 'image' && buf.length < 15 * 1024 * 1024) return { buffer: buf, mime: t.mime };
  }
  return null;
}
router.get('/ai/characters/:key/portrait', (req, res) => {
  const k = String(req.params.key);
  if (!CH.byKey(k)) return res.status(404).end();
  const f = require('node:path').join(ai.CHAR_DIR, `${k}-${require('../ai/providers').active()}.png`);
  if (!fs.existsSync(f)) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=86400').sendFile(f);
});
router.post('/ai/model-jobs', (req, res, next) => upload(req, res, err => {
  if (err) return next(new S.HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'That photo is too big (max 15 MB).' : 'Upload failed.'));
  next();
}), (req, res) => {
  const str = (v, n) => String(v || '').slice(0, n);
  const input = { product: str(req.body.product, 120), details: str(req.body.details, 400), price: str(req.body.price, 30), setting: str(req.body.setting, 120) };
  try {
    const job = ai.createModelJob(req.user, { character: req.body.character, action: req.body.action, look: req.body.look, input,
      photo: photoFrom(req), aspect: req.body.aspect, count: req.body.count });
    S.audit(req, 'ai.model_job', { id: job.id, character: req.body.character, count: job.count });
    res.status(201).json({ job: ai.publicJob(job), credits: ai.creditStatus(req.user) });
  } catch (e) { throw wrap(e); }
});
/* what the presenter says — no credits; same fair-use daily limit as captions */
router.post('/ai/presenter-script', S.requireRole('designer'), async (req, res) => {
  const { q } = require('../db');
  const plan = require('../plans').effectivePlan(q.get('SELECT * FROM workspaces WHERE id = ?', req.user.workspace_id));
  const limit = plan.code === 'free' ? 5 : 100;
  const start = new Date(); start.setUTCHours(0, 0, 0, 0);
  const used = q.get("SELECT COUNT(*) n FROM audit_log WHERE user_id = ? AND action = 'ai.script' AND created_at >= ?", req.user.id, start.getTime()).n;
  if (used >= limit) throw new S.HttpError(429, 'That’s a lot of scripts today — please try again tomorrow.');
  let r;
  try { r = await require('../ai/script').write(req.body || {}); } catch (e) { throw new S.HttpError(e.status || 400, e.message); }
  S.audit(req, 'ai.script', { source: r.source });
  res.json(r);
});
router.post('/ai/presenter-videos', S.requireRole('designer'), (req, res) => {
  const b = req.body || {};
  try {
    const job = ai.createPresenterJob(req.user, { from: b.fromJob ? { id: String(b.fromJob).slice(0, 40), n: parseInt(b.n, 10) || 0 } : null,
      parts: Array.isArray(b.parts) ? b.parts.slice(0, 2) : [String(b.script || '')], language: b.language, tone: b.tone, look: b.look,
      seconds: b.seconds, aspect: b.aspect, label: b.label !== false, product: b.product });
    S.audit(req, 'ai.presenter_job', { id: job.id, character: job.template_key, seconds: +b.seconds === 15 ? 15 : 8 });
    res.status(201).json({ job: ai.publicJob(job), credits: ai.creditStatus(req.user) });
  } catch (e) { throw wrap(e); }
});

/* Paste a product link → name, details, price and the main photo */
router.post('/ai/from-url', async (req, res) => {
  try {
    const info = await readProductPage(String(req.body.url || '').slice(0, 2000));
    let photo = null;
    if (info.imageUrl) {
      try {
        const buf = await fetchImage(info.imageUrl);
        const t = sniff(buf);
        if (t && t.kind === 'image') photo = `data:${t.mime};base64,${buf.toString('base64')}`;
      } catch { /* page without a usable photo is fine */ }
    }
    res.json({ product: info.product, details: info.details, price: info.price, photo, pageUrl: info.pageUrl });
  } catch (e) {
    throw new S.HttpError(e.status || 400, e.message || 'Could not read that link.');
  }
});

router.post('/ai/jobs', (req, res, next) => upload(req, res, err => {
  if (err) return next(new S.HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'That photo is too big (max 15 MB).' : 'Upload failed.'));
  next();
}), (req, res) => {
  let photo = null;
  if (req.file) {
    const t = sniff(req.file.buffer);
    if (!t || t.kind !== 'image') throw new S.HttpError(415, 'Use a JPG, PNG or WEBP photo.');
    photo = { buffer: req.file.buffer, mime: t.mime };
  } else if (/^data:image\/(png|jpeg|webp);base64,/.test(req.body.photoData || '')) {
    const buf = Buffer.from(req.body.photoData.split(',')[1], 'base64');
    const t = sniff(buf);
    if (t && t.kind === 'image' && buf.length < 15 * 1024 * 1024) photo = { buffer: buf, mime: t.mime };
  }
  const str = (v, n) => String(v || '').slice(0, n);
  const input = { product: str(req.body.product, 120), details: str(req.body.details, 400), price: str(req.body.price, 30),
    colours: str(req.body.colours, 80), mood: str(req.body.mood, 60), setting: str(req.body.setting, 120) };
  try {
    const job = ai.createJob(req.user, { templateKey: req.body.template, input, photo, aspect: req.body.aspect, count: req.body.count });
    S.audit(req, 'ai.job', { id: job.id, template: job.template_key, count: job.count });
    res.status(201).json({ job: ai.publicJob(job), credits: ai.creditStatus(req.user) });
  } catch (e) { throw wrap(e); }
});

/* AI video from one of your AI images (fromJob + n) or an uploaded photo */
router.post('/ai/videos', (req, res, next) => upload(req, res, err => {
  if (err) return next(new S.HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'That photo is too big (max 15 MB).' : 'Upload failed.'));
  next();
}), (req, res) => {
  let photo = null;
  if (req.file) {
    const t = sniff(req.file.buffer);
    if (!t || t.kind !== 'image') throw new S.HttpError(415, 'Use a JPG, PNG or WEBP photo.');
    photo = { buffer: req.file.buffer, mime: t.mime };
  }
  const str = (v, n) => String(v || '').slice(0, n);
  const input = { product: str(req.body.product, 120), price: str(req.body.price, 30) };
  try {
    const job = ai.createVideoJob(req.user, { templateKey: req.body.template, input, photo, aspect: req.body.aspect, seconds: req.body.seconds,
      from: req.body.fromJob ? { id: String(req.body.fromJob).slice(0, 40), n: parseInt(req.body.n, 10) || 0 } : null });
    S.audit(req, 'ai.video_job', { id: job.id, template: job.template_key });
    res.status(201).json({ job: ai.publicJob(job), credits: ai.creditStatus(req.user) });
  } catch (e) { throw wrap(e); }
});

router.get('/ai/jobs', (req, res) => {
  const { q } = require('../db');
  const rows = q.all('SELECT * FROM ai_jobs WHERE user_id = ? ORDER BY created_at DESC LIMIT 24', req.user.id);
  res.json({ jobs: rows.map(ai.publicJob), credits: ai.creditStatus(req.user) });
});

router.get('/ai/jobs/:id', (req, res) => {
  const { q } = require('../db');
  const j = q.get('SELECT * FROM ai_jobs WHERE id = ? AND user_id = ?', String(req.params.id), req.user.id);
  if (!j) throw new S.HttpError(404, 'Not found');
  res.json({ job: ai.publicJob(j), credits: j.status === 'queued' || j.status === 'running' ? undefined : ai.creditStatus(req.user) });
});

/* The image itself. Free-plan users must take it through the editor (watermarked downloads). */
router.get('/ai/out/:id/:n', (req, res) => {
  const out = ai.outputFile(req.user, req.params.id, req.params.n, { poster: !!req.query.poster });
  if (!out || !fs.existsSync(out.path)) return res.status(404).json({ error: 'This AI result is no longer available.' });
  if (req.query.download && !req.query.poster) {
    const st = ai.creditStatus(req.user);
    if (st.plan === 'free') return res.status(402).json({ error: 'Open it in the editor to download (free plan).' });
    res.attachment(`postgenx-ai-${out.job.id.slice(0, 8)}-${req.params.n}.${out.file.split('.').pop()}`);
  }
  res.set('Cache-Control', 'private, max-age=86400');
  res.sendFile(out.path);
});

router.post('/ai/jobs/:id/design', S.requireRole('designer'), (req, res) => {
  try {
    const r = ai.toDesign(req.user, req.params.id, req.body.n || 0);
    S.audit(req, 'ai.to_design', { job: req.params.id, design: r.designId });
    res.status(201).json(r);
  } catch (e) { throw wrap(e); }
});

module.exports = { router };
