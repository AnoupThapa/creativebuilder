'use strict';
/* GIF maker API. Each size made counts as one download, like any other export. */
const express = require('express');
const multer = require('multer');
const path = require('node:path');
const config = require('../config');
const S = require('../security');
const gif = require('../gif');
const { authoriseExports } = require('./workspace');

const router = express.Router();
const WATERMARK = path.join(__dirname, '..', 'assets', 'gif-watermark.png');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 150 * 1024 * 1024, files: gif.LIMITS.maxPhotos, fields: 5 } })
  .array('files', gif.LIMITS.maxPhotos);

router.get('/gif/options', (req, res) => res.json({ sizes: gif.SIZES, limits: gif.LIMITS, available: gif.available() }));

router.post('/gif/make', (req, res, next) => upload(req, res, err => {
  if (err) return next(new S.HttpError(400, err.code === 'LIMIT_FILE_SIZE' ? 'That file is too big (max 150 MB).' : 'Upload failed: ' + err.message));
  next();
}), async (req, res) => {
  const u = req.user;
  if (u.role === 'viewer') throw new S.HttpError(403, 'Viewers can look at designs but not create GIFs.');
  if (config.security.requireVerifiedEmailToExport && !u.email_verified)
    throw new S.HttpError(403, 'Please confirm your email address before downloading.', { code: 'verify_email' });
  if (!gif.available()) throw new S.HttpError(501, 'The GIF maker is not available on this server.');

  const files = (req.files || []).map(f => ({ buffer: f.buffer, type: gif.sniff(f.buffer) }));
  if (!files.length) throw new S.HttpError(400, 'Add a video, a GIF or some photos first.');
  if (files.some(f => !f.type)) throw new S.HttpError(415, 'Use MP4, MOV, WEBM or GIF videos, or JPG, PNG or WEBP photos.');
  const kinds = new Set(files.map(f => f.type.kind));
  if (kinds.size > 1) throw new S.HttpError(400, 'Use either one video/GIF or several photos — not both.');
  if (kinds.has('video') && files.length > 1) throw new S.HttpError(400, 'Use one video at a time.');
  if (kinds.has('image') && files.length < 2) throw new S.HttpError(400, 'Add at least 2 photos to make a slideshow GIF (or upload a video).');

  let raw = {};
  try { raw = JSON.parse(req.body.options || '{}'); } catch { throw new S.HttpError(400, 'Bad options.'); }
  const opts = gif.cleanOptions(raw);
  if (!opts.sizes.length) throw new S.HttpError(400, 'Pick at least one size.');

  const auth = authoriseExports(u, opts.sizes.map(s => ({ platform: `gif:${s.w}x${s.h}`, kind: 'gif' })), 1, null);
  S.audit(req, 'export.gif', { sizes: opts.sizes.length, photos: kinds.has('image') ? files.length : 0 });
  try {
    const out = await gif.make({ userId: u.id, files, opts, watermarkPath: auth.watermark ? WATERMARK : null });
    res.json({ ok: true, id: out.id, results: out.results, usage: auth.usage, watermark: auth.watermark });
  } catch (e) {
    throw new S.HttpError(422, /too long/.test(e.message) ? e.message : 'Could not make the GIF from this file. Try another video or fewer sizes.');
  }
});

router.get('/gif/out/:id/:file', (req, res) => {
  const p = gif.outputPath(req.user.id, req.params.id, req.params.file);
  if (!p) return res.status(404).json({ error: 'This file has expired — make it again.' });
  const name = 'postforge-' + req.params.file;
  if (req.query.download) res.attachment(name);
  res.set('Cache-Control', 'private, max-age=3600');
  res.sendFile(p);
});

module.exports = { router };
