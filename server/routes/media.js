'use strict';
/* Media uploads (photos, videos, logos). Files are type-checked by their
   actual bytes (not the name or browser-sent type), size-limited per plan,
   stored under random names, and only served to members of the workspace. */
const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const { q } = require('../db');
const S = require('../security');
const { effectivePlan, storageUsed } = require('../plans');

const router = express.Router();

function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { mime: 'image/png', kind: 'image', ext: 'png' };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', kind: 'image', ext: 'jpg' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { mime: 'image/webp', kind: 'image', ext: 'webp' };
  if (buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'qt  ') return { mime: 'video/quicktime', kind: 'video', ext: 'mov' };
    if (/^(heic|heix|mif1|avif)/.test(brand)) return null; // HEIC/AVIF: not supported by canvas everywhere
    return { mime: 'video/mp4', kind: 'video', ext: 'mp4' };
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { mime: 'video/webm', kind: 'video', ext: 'webm' };
  return null;
}

function wsDir(wsId) {
  const d = path.join(config.UPLOAD_DIR, String(wsId));
  fs.mkdirSync(d, { recursive: true });
  return d;
}
const filePath = m => path.join(config.UPLOAD_DIR, String(m.workspace_id), m.id);

router.post('/media', S.requireRole('designer'), (req, res, next) => {
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', req.user.workspace_id);
  const plan = effectivePlan(ws);
  const videoMb = plan.video_export ? (plan.max_video_mb || plan.max_upload_mb) : 0;
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: Math.max(plan.max_upload_mb, videoMb) * 1024 * 1024, files: 1, fields: 5 },
  }).single('file');

  upload(req, res, async err => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE')
        return next(new S.HttpError(413, `File is too big — your ${plan.name} plan allows up to ${Math.max(plan.max_upload_mb, videoMb)} MB per file.`));
      return next(new S.HttpError(400, 'Upload failed: ' + err.message));
    }
    let id = null;
    try {
      if (!req.file) throw new S.HttpError(400, 'No file received.');
      const type = sniff(req.file.buffer);
      if (!type) throw new S.HttpError(415, 'Unsupported file. Use JPG, PNG, WEBP, MP4, MOV or WEBM.');
      if (type.kind === 'video' && !plan.video_export)
        throw new S.HttpError(402, `Your own videos are included from the Starter plan. Your plan: ${plan.name}.`, { code: 'upgrade' });
      const maxMb = type.kind === 'video' ? videoMb : plan.max_upload_mb;
      if (req.file.size > maxMb * 1024 * 1024)
        throw new S.HttpError(413, `File is too big — your ${plan.name} plan allows ${type.kind === 'video' ? 'videos' : 'photos'} up to ${maxMb} MB.`);
      if (storageUsed(ws.id) + req.file.size > plan.storage_mb * 1024 * 1024)
        throw new S.HttpError(413, 'Your storage is full. Delete old media or upgrade your plan.');

      id = crypto.randomUUID();
      const file = path.join(wsDir(ws.id), id);
      fs.writeFileSync(file, req.file.buffer, { mode: 0o600 });
      if (type.kind === 'video' && plan.max_video_seconds > 0) {
        const secs = await require('../video').probeDuration(file);
        if (secs != null && secs > plan.max_video_seconds + 0.9) {
          fs.rmSync(file, { force: true }); id = null;
          throw new S.HttpError(413, `This video is ${Math.round(secs)} seconds long — your ${plan.name} plan allows videos up to ${plan.max_video_seconds} seconds. Trim it on your phone, or upgrade to Pro for longer videos.`, { code: 'video_too_long' });
        }
      }
      const filename = String(req.file.originalname || 'upload').replace(/[^\w.\- ]+/g, '_').slice(0, 120);
      q.run('INSERT INTO media (id, workspace_id, owner_id, filename, mime, kind, size, created_at) VALUES (?,?,?,?,?,?,?,?)',
        id, ws.id, req.user.id, filename, type.mime, type.kind, req.file.size, Date.now());
      res.status(201).json({ id, url: `/media/${id}`, kind: type.kind, mime: type.mime, filename, size: req.file.size });
    } catch (e) { next(e); }
  });
});

router.get('/media', (req, res) => {
  if (S.isClient(req.user)) return res.json([]); // clients don't browse the media library
  res.json(q.all(`SELECT id, filename, mime, kind, size, created_at, owner_id FROM media
                  WHERE workspace_id = ? ORDER BY created_at DESC LIMIT 200`, req.user.workspace_id)
    .map(m => ({ ...m, url: `/media/${m.id}` })));
});

router.delete('/media/:id', S.requireRole('designer'), (req, res) => {
  const m = q.get('SELECT * FROM media WHERE id = ? AND workspace_id = ?', String(req.params.id), req.user.workspace_id);
  if (!m) throw new S.HttpError(404, 'Not found');
  if (m.owner_id !== req.user.id && S.ROLE_RANK[req.user.role] < S.ROLE_RANK.admin)
    throw new S.HttpError(403, 'Only the uploader or an admin can delete this file.');
  try { fs.unlinkSync(filePath(m)); } catch {}
  q.run('DELETE FROM media WHERE id = ?', m.id);
  q.run('UPDATE brand_kits SET logo_media_id = NULL WHERE logo_media_id = ?', m.id);
  res.json({ ok: true });
});

/* File serving — mounted at /media/:id (outside /api so <img> can use it) */
function serveMedia(req, res) {
  if (!req.user) return res.status(401).end();
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/.test(id)) return res.status(404).end();
  const m = q.get('SELECT * FROM media WHERE id = ? AND workspace_id = ?', id, req.user.workspace_id);
  if (!m) return res.status(404).end();
  // client viewers: only files used by their brand (its logo, or a design shared with them)
  if (S.isClient(req.user)) {
    const b = req.user.client_brand_id;
    const used = q.get('SELECT 1 x FROM brand_kits WHERE id = ? AND workspace_id = ? AND logo_media_id = ?', b, m.workspace_id, id)
      || q.get(`SELECT 1 x FROM designs WHERE workspace_id = ? AND brand_kit_id = ? AND deleted_at IS NULL AND visibility != 'private'
                AND instr(data, ?) > 0 LIMIT 1`, m.workspace_id, b, id);
    if (!used) return res.status(404).end();
  }
  res.sendFile(filePath(m), {
    headers: {
      'Content-Type': m.mime,
      'Cache-Control': 'private, max-age=3600',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': 'inline',
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  }, err => { if (err && !res.headersSent) res.status(404).end(); });
}

module.exports = { router, serveMedia, sniff };
