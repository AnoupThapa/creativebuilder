'use strict';
/* Brand kits, export authorisation (quota enforcement) and team management. */
const express = require('express');
const config = require('../config');
const { q, tx } = require('../db');
const S = require('../security');
const { effectivePlan, usageFor, localParts } = require('../plans');
const { sendMail } = require('../mailer');
const video = require('../video');

const router = express.Router();
const isDev = !config.isProd;
const wsOf = u => q.get('SELECT * FROM workspaces WHERE id = ?', u.workspace_id);

/* ================================================================== */
/* BRAND KITS                                                          */
/* ================================================================== */
const HEX = /^#[0-9a-fA-F]{6}$/;
function kitInput(body, prev = {}) {
  const color = body.color ?? prev.color ?? '#ff6b4a';
  if (!HEX.test(color)) throw new S.HttpError(400, 'Colour must look like #ff6b4a.');
  return {
    name: S.str(body.name ?? prev.name, { field: 'Name', required: true, max: 80 }),
    color,
    phone: S.str(body.phone ?? prev.phone ?? '', { field: 'Phone', max: 40 }),
    website: S.str(body.website ?? prev.website ?? '', { field: 'Website', max: 120 }),
    logo_media_id: body.logo_media_id !== undefined ? body.logo_media_id : (prev.logo_media_id ?? null),
  };
}
function checkLogo(u, mediaId) {
  if (!mediaId) return null;
  const m = q.get("SELECT id FROM media WHERE id = ? AND workspace_id = ? AND kind = 'image'", String(mediaId), u.workspace_id);
  if (!m) throw new S.HttpError(400, 'Logo file not found.');
  return m.id;
}
const kitOut = k => ({ ...k, logo_url: k.logo_media_id ? `/media/${k.logo_media_id}` : null });

router.get('/brand-kits', (req, res) => {
  res.json(q.all('SELECT * FROM brand_kits WHERE workspace_id = ? ORDER BY id', req.user.workspace_id).map(kitOut));
});
router.post('/brand-kits', S.requireRole('designer'), (req, res) => {
  const plan = effectivePlan(wsOf(req.user));
  const n = q.get('SELECT COUNT(*) n FROM brand_kits WHERE workspace_id = ?', req.user.workspace_id).n;
  if (n >= plan.max_brand_kits)
    throw new S.HttpError(402, `Your ${plan.name} plan includes ${plan.max_brand_kits} brand kit${plan.max_brand_kits > 1 ? 's' : ''}. Edit the existing one or upgrade.`);
  const k = kitInput(req.body);
  const now = Date.now();
  const id = q.run(`INSERT INTO brand_kits (workspace_id, name, color, phone, website, logo_media_id, created_at, updated_at)
                    VALUES (?,?,?,?,?,?,?,?)`, req.user.workspace_id, k.name, k.color, k.phone, k.website,
    checkLogo(req.user, k.logo_media_id), now, now).lastInsertRowid;
  res.status(201).json(kitOut(q.get('SELECT * FROM brand_kits WHERE id = ?', id)));
});
router.put('/brand-kits/:id', S.requireRole('designer'), (req, res) => {
  const prev = q.get('SELECT * FROM brand_kits WHERE id = ? AND workspace_id = ?', +req.params.id, req.user.workspace_id);
  if (!prev) throw new S.HttpError(404, 'Brand kit not found.');
  const k = kitInput(req.body, prev);
  q.run('UPDATE brand_kits SET name=?, color=?, phone=?, website=?, logo_media_id=?, updated_at=? WHERE id=?',
    k.name, k.color, k.phone, k.website, checkLogo(req.user, k.logo_media_id), Date.now(), prev.id);
  res.json(kitOut(q.get('SELECT * FROM brand_kits WHERE id = ?', prev.id)));
});
router.delete('/brand-kits/:id', S.requireRole('admin'), (req, res) => {
  q.run('DELETE FROM brand_kits WHERE id = ? AND workspace_id = ?', +req.params.id, req.user.workspace_id);
  res.json({ ok: true });
});

/* ================================================================== */
/* EXPORTS — every download is authorised and counted here first       */
/* ================================================================== */
const PLATFORM_KEYS = new Set(['ig_post', 'ig_portrait', 'ig_story', 'fb_post', 'fb_story', 'fb_cover', 'li_post',
  'li_banner', 'pin', 'x_post', 'tiktok', 'yt_thumb', 'yt_shorts', 'wa_status']);

router.get('/usage', (req, res) => {
  const plan = effectivePlan(wsOf(req.user));
  res.json(usageFor(req.user, plan));
});

/* Checks the plan + allowance and records the downloads. Also used when posting to social media. */
function authoriseExports(u, items, quality, designId) {
  return tx(() => {
    const ws = wsOf(u);
    const plan = effectivePlan(ws);
    if (quality < 1 || quality > plan.max_quality)
      throw new S.HttpError(402, `${quality}× quality isn't included in ${plan.name}. Max: ${plan.max_quality}×.`, { code: 'upgrade' });
    if (items.some(i => i.kind === 'video') && !plan.video_export)
      throw new S.HttpError(402, `Video export is a Pro feature.`, { code: 'upgrade' });
    if (items.length > 1 && !plan.batch_export)
      throw new S.HttpError(402, `Multi-platform batch export isn't included in ${plan.name}.`, { code: 'upgrade' });

    const usage = usageFor(u, plan);
    if (usage.remaining < items.length) {
      const msg = usage.remaining === 0
        ? `You've used all ${usage.limit} downloads ${usage.label}. ${usage.resets}.`
        : `Only ${usage.remaining} download${usage.remaining > 1 ? 's' : ''} left ${usage.label} — pick fewer sizes.`;
      throw new S.HttpError(402, msg, { code: 'quota', usage });
    }
    const { day, month } = localParts(u.timezone);
    const now = Date.now();
    for (const it of items) {
      q.run(`INSERT INTO exports (user_id, workspace_id, design_id, platform, kind, quality, plan_code, local_day, local_month, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,?)`, u.id, u.workspace_id, designId, it.platform, it.kind, quality, plan.code, day, month, now);
    }
    return { watermark: !!plan.watermark, usage: usageFor(u, plan) };
  });
}

router.post('/exports', (req, res) => {
  const u = req.user;
  if (u.role === 'viewer') throw new S.HttpError(403, 'Viewers can look at designs but not download them.');
  if (config.security.requireVerifiedEmailToExport && !u.email_verified)
    throw new S.HttpError(403, 'Please confirm your email address before downloading.', { code: 'verify_email' });

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  if (!items.length || items.length > 20) throw new S.HttpError(400, 'Choose between 1 and 20 sizes.');
  for (const it of items) {
    if (!PLATFORM_KEYS.has(it?.platform)) throw new S.HttpError(400, 'Unknown platform size.');
    if (!['image', 'video'].includes(it.kind)) throw new S.HttpError(400, 'Unknown export type.');
  }
  const quality = parseInt(req.body.quality, 10) || 1;
  const designId = req.body.designId ? String(req.body.designId).slice(0, 40) : null;

  const result = authoriseExports(u, items, quality, designId);
  S.audit(req, 'export.authorised', { count: items.length, quality, designId });
  res.json({ ok: true, ...result });
});

/* Recorded video → Instagram/Facebook-ready MP4 (H.264 + AAC). Quota is counted at /exports. */
router.post('/video/convert', express.raw({ type: () => true, limit: '200mb' }), async (req, res) => {
  if (req.user.role === 'viewer') throw new S.HttpError(403, 'Viewers cannot export video.');
  const plan = effectivePlan(wsOf(req.user));
  if (!plan.video_export) throw new S.HttpError(402, 'Video export is a Pro feature.', { code: 'upgrade' });
  if (!video.available()) throw new S.HttpError(501, 'MP4 conversion is not available on this server.');
  if (!Buffer.isBuffer(req.body) || req.body.length < 100) throw new S.HttpError(400, 'No video received.');
  const head = req.body.subarray(0, 12);
  const isWebm = head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
  const isMp4 = head.toString('ascii', 4, 8) === 'ftyp';
  if (!isWebm && !isMp4) throw new S.HttpError(415, 'Unsupported video format.');
  const out = await video.toMp4(req.body);
  res.set({ 'Content-Type': 'video/mp4', 'Content-Length': out.length, 'Cache-Control': 'no-store' });
  res.send(out);
});

router.get('/exports/history', (req, res) => {
  const rows = q.all(`SELECT e.platform, e.kind, e.quality, e.created_at, e.design_id, d.name design_name
                      FROM exports e LEFT JOIN designs d ON d.id = e.design_id
                      WHERE e.user_id = ? ORDER BY e.id DESC LIMIT 50`, req.user.id);
  res.json(rows);
});

/* ================================================================== */
/* TEAM                                                                */
/* ================================================================== */
const ASSIGNABLE = new Set(['admin', 'designer', 'viewer']);

function pendingInvites(wsId) {
  return q.all(`SELECT token_hash, data, expires_at, created_at FROM tokens
                WHERE type = 'invite' AND used_at IS NULL AND expires_at > ?
                AND json_extract(data, '$.workspace_id') = ?`, Date.now(), wsId)
    .map(t => ({ id: t.token_hash.slice(0, 24), ...JSON.parse(t.data), expires_at: t.expires_at, created_at: t.created_at }));
}

router.get('/team', (req, res) => {
  const ws = wsOf(req.user);
  const members = q.all(`SELECT id, name, email, role, status, totp_enabled, email_verified, last_login_at, created_at
                         FROM users WHERE workspace_id = ? AND status != 'removed' ORDER BY id`, ws.id);
  const isAdmin = S.ROLE_RANK[req.user.role] >= S.ROLE_RANK.admin;
  res.json({ seats: ws.seats, members, invites: isAdmin ? pendingInvites(ws.id) : [] });
});

router.post('/team/invite', S.requireRole('admin'), async (req, res) => {
  const email = S.email(req.body.email);
  const role = String(req.body.role || 'designer');
  if (!ASSIGNABLE.has(role)) throw new S.HttpError(400, 'Pick a valid role.');
  if (role === 'admin' && req.user.role !== 'owner') throw new S.HttpError(403, 'Only the owner can invite admins.');
  const ws = wsOf(req.user);
  const plan = effectivePlan(ws);
  if (plan.code === 'free') throw new S.HttpError(402, 'Team members are available on paid plans. Upgrade to add seats.', { code: 'upgrade' });
  if (q.get('SELECT id FROM users WHERE email = ?', email)) throw new S.HttpError(409, 'That email already has an account.');
  const used = q.get("SELECT COUNT(*) n FROM users WHERE workspace_id = ? AND status != 'removed'", ws.id).n + pendingInvites(ws.id).length;
  if (used >= ws.seats) throw new S.HttpError(402, `All ${ws.seats} seats are in use. Add a seat in Billing first (each seat is billed per user).`, { code: 'seats' });

  const token = S.createToken('invite', { data: { workspace_id: ws.id, email, role, invited_by: req.user.id }, ttlMs: 7 * 86400000 });
  const link = `${config.appUrl}/invite?token=${token}`;
  await sendMail(email, `${req.user.name} invited you to ${ws.name} on ${config.appName}`,
    `Hi,\n\n${req.user.name} invited you to join "${ws.name}" as a ${role}.\n\nAccept the invite (valid 7 days):\n${link}`);
  S.audit(req, 'team.invite', { email, role });
  res.status(201).json({ ok: true, ...(isDev ? { devInviteLink: link } : {}) });
});

router.delete('/team/invites/:id', S.requireRole('admin'), (req, res) => {
  const id = String(req.params.id).slice(0, 24);
  q.run(`DELETE FROM tokens WHERE type = 'invite' AND substr(token_hash, 1, 24) = ?
         AND json_extract(data, '$.workspace_id') = ?`, id, req.user.workspace_id);
  res.json({ ok: true });
});

router.patch('/team/:id', S.requireRole('admin'), (req, res) => {
  const m = q.get("SELECT * FROM users WHERE id = ? AND workspace_id = ? AND status != 'removed'", +req.params.id, req.user.workspace_id);
  if (!m) throw new S.HttpError(404, 'Member not found.');
  if (m.role === 'owner') throw new S.HttpError(403, "The owner's role can't be changed.");
  if (m.id === req.user.id) throw new S.HttpError(403, "You can't change your own role.");
  const role = String(req.body.role || '');
  if (!ASSIGNABLE.has(role)) throw new S.HttpError(400, 'Pick a valid role.');
  if ((role === 'admin' || m.role === 'admin') && req.user.role !== 'owner') throw new S.HttpError(403, 'Only the owner can manage admins.');
  q.run('UPDATE users SET role = ? WHERE id = ?', role, m.id);
  S.audit(req, 'team.role_changed', { member: m.id, from: m.role, to: role });
  res.json({ ok: true });
});

router.delete('/team/:id', S.requireRole('admin'), (req, res) => {
  const m = q.get("SELECT * FROM users WHERE id = ? AND workspace_id = ? AND status != 'removed'", +req.params.id, req.user.workspace_id);
  if (!m) throw new S.HttpError(404, 'Member not found.');
  if (m.role === 'owner' || m.id === req.user.id) throw new S.HttpError(403, "You can't remove this member.");
  if (m.role === 'admin' && req.user.role !== 'owner') throw new S.HttpError(403, 'Only the owner can remove admins.');
  q.run("UPDATE users SET status = 'removed', email = email || '.removed.' || id WHERE id = ?", m.id);
  q.run('DELETE FROM sessions WHERE user_id = ?', m.id);
  S.audit(req, 'team.member_removed', { member: m.id, email: m.email });
  res.json({ ok: true });
});

module.exports = { router, authoriseExports, PLATFORM_KEYS };
