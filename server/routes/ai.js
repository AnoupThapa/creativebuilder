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
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 12 } }).single('photo');
const wrap = e => (e instanceof ai.HttpErr ? new S.HttpError(e.status, e.message, e.extra) : e);

router.get('/ai/options', (req, res) => {
  const tpls = ai.templates().map(t => ({ key: t.key, industry: t.industry, kind: t.kind, name: t.name, description: t.description, emoji: t.emoji, needsPhoto: !!t.needs_photo }));
  res.json({ industries: ai.INDUSTRIES, templates: tpls, aspects: ai.ASPECTS, credits: ai.creditStatus(req.user),
    enabled: ai.enabled(), demo: require('../ai/providers').active() === 'demo',
    topup: { credits: config.ai.topupCredits, price_cents: config.ai.topupPriceCents } });
});

router.get('/ai/credits', (req, res) => res.json(ai.creditStatus(req.user)));

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
  const out = ai.outputFile(req.user, req.params.id, req.params.n);
  if (!out || !fs.existsSync(out.path)) return res.status(404).json({ error: 'This AI image is no longer available.' });
  if (req.query.download) {
    const st = ai.creditStatus(req.user);
    if (st.plan === 'free') return res.status(402).json({ error: 'Open it in the editor to download (free plan).' });
    res.attachment(`postforge-ai-${out.job.id.slice(0, 8)}-${req.params.n}.${out.file.split('.').pop()}`);
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
