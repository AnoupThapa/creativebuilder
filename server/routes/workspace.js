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
const SOCIALS = ['instagram', 'facebook', 'tiktok', 'linkedin', 'youtube', 'x', 'whatsapp'];
const FONT_RE = /^[A-Za-z0-9 \-]{0,60}$/;
function parseJson(v, fallback) { try { return typeof v === 'string' ? JSON.parse(v) : (v ?? fallback); } catch { return fallback; } }
function kitInput(body, prev = {}) {
  const color = body.color ?? prev.color ?? '#ff6b4a';
  if (!HEX.test(color)) throw new S.HttpError(400, 'Colour must look like #ff6b4a.');
  const colors = body.colors !== undefined ? body.colors : parseJson(prev.colors, []);
  if (!Array.isArray(colors) || colors.length > 5 || colors.some(c => !HEX.test(c))) throw new S.HttpError(400, 'Extra colours must look like #ff6b4a (up to 5).');
  const fonts = {};
  for (const f of ['font_heading', 'font_body']) {
    fonts[f] = String(body[f] ?? prev[f] ?? '').trim();
    if (!FONT_RE.test(fonts[f])) throw new S.HttpError(400, 'Font names only use letters, numbers and spaces.');
  }
  const inSoc = body.socials !== undefined ? body.socials : parseJson(prev.socials, {});
  const socials = {};
  for (const k of SOCIALS) if (inSoc && inSoc[k]) socials[k] = S.str(String(inSoc[k]), { field: k, max: 120 });
  return {
    name: S.str(body.name ?? prev.name, { field: 'Name', required: true, max: 80 }),
    color, colors: JSON.stringify(colors), ...fonts,
    phone: S.str(body.phone ?? prev.phone ?? '', { field: 'Phone', max: 40 }),
    website: S.str(body.website ?? prev.website ?? '', { field: 'Website', max: 120 }),
    tagline: S.str(body.tagline ?? prev.tagline ?? '', { field: 'Tagline', max: 120 }),
    email: S.str(body.email ?? prev.email ?? '', { field: 'Email', max: 120 }),
    address: S.str(body.address ?? prev.address ?? '', { field: 'Address', max: 200 }),
    socials: JSON.stringify(socials),
    logo_media_id: body.logo_media_id !== undefined ? body.logo_media_id : (prev.logo_media_id ?? null),
  };
}
function checkLogo(u, mediaId) {
  if (!mediaId) return null;
  const m = q.get("SELECT id FROM media WHERE id = ? AND workspace_id = ? AND kind = 'image'", String(mediaId), u.workspace_id);
  if (!m) throw new S.HttpError(400, 'Logo file not found.');
  return m.id;
}
const kitOut = k => ({ ...k, colors: parseJson(k.colors, []), socials: parseJson(k.socials, {}), logo_url: k.logo_media_id ? `/media/${k.logo_media_id}` : null,
  designs: q.get('SELECT COUNT(*) n FROM designs WHERE brand_kit_id = ? AND deleted_at IS NULL', k.id).n,
  clients: q.get("SELECT COUNT(*) n FROM users WHERE client_brand_id = ? AND status != 'removed'", k.id).n });

router.get('/brand-kits', (req, res) => {
  const rows = S.isClient(req.user)
    ? q.all('SELECT * FROM brand_kits WHERE workspace_id = ? AND id = ?', req.user.workspace_id, req.user.client_brand_id)
    : q.all('SELECT * FROM brand_kits WHERE workspace_id = ? ORDER BY id', req.user.workspace_id);
  res.json(rows.map(kitOut));
});
router.post('/brand-kits', S.requireRole('designer'), (req, res) => {
  const plan = effectivePlan(wsOf(req.user));
  const n = q.get('SELECT COUNT(*) n FROM brand_kits WHERE workspace_id = ?', req.user.workspace_id).n;
  if (n >= plan.max_brand_kits)
    throw new S.HttpError(402, `Your ${plan.name} plan includes ${plan.max_brand_kits} brand kit${plan.max_brand_kits > 1 ? 's' : ''}. Edit the existing one or upgrade.`);
  const k = kitInput(req.body);
  const now = Date.now();
  const id = q.run(`INSERT INTO brand_kits (workspace_id, name, color, colors, font_heading, font_body, phone, website, tagline, email, address, socials,
                    logo_media_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, req.user.workspace_id, k.name, k.color, k.colors,
    k.font_heading, k.font_body, k.phone, k.website, k.tagline, k.email, k.address, k.socials, checkLogo(req.user, k.logo_media_id), now, now).lastInsertRowid;
  S.audit(req, 'brand.created', { id, name: k.name });
  res.status(201).json(kitOut(q.get('SELECT * FROM brand_kits WHERE id = ?', id)));
});
router.put('/brand-kits/:id', S.requireRole('designer'), (req, res) => {
  const prev = q.get('SELECT * FROM brand_kits WHERE id = ? AND workspace_id = ?', +req.params.id, req.user.workspace_id);
  if (!prev) throw new S.HttpError(404, 'Brand kit not found.');
  const k = kitInput(req.body, prev);
  q.run(`UPDATE brand_kits SET name=?, color=?, colors=?, font_heading=?, font_body=?, phone=?, website=?, tagline=?, email=?, address=?, socials=?,
         logo_media_id=?, updated_at=? WHERE id=?`, k.name, k.color, k.colors, k.font_heading, k.font_body, k.phone, k.website, k.tagline, k.email,
    k.address, k.socials, checkLogo(req.user, k.logo_media_id), Date.now(), prev.id);
  res.json(kitOut(q.get('SELECT * FROM brand_kits WHERE id = ?', prev.id)));
});
router.delete('/brand-kits/:id', S.requireRole('admin'), (req, res) => {
  const k = q.get('SELECT * FROM brand_kits WHERE id = ? AND workspace_id = ?', +req.params.id, req.user.workspace_id);
  if (!k) return res.json({ ok: true });
  if (q.get("SELECT COUNT(*) n FROM users WHERE client_brand_id = ? AND status != 'removed'", k.id).n)
    throw new S.HttpError(409, 'This brand still has client logins. Remove them in Team first.');
  tx(() => {
    q.run('UPDATE designs SET brand_kit_id = NULL WHERE brand_kit_id = ?', k.id);
    q.run('DELETE FROM brand_kits WHERE id = ?', k.id);
  });
  S.audit(req, 'brand.deleted', { id: k.id, name: k.name });
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
      throw new S.HttpError(402, `Video export is included from the Starter plan.`, { code: 'upgrade' });
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
  if (u.role === 'viewer' && !S.isClient(u)) throw new S.HttpError(403, 'Viewers can look at designs but not download them.');
  if (S.isClient(u)) {
    // agency clients download their own brand's shared designs only
    const d = q.get('SELECT * FROM designs WHERE id = ?', String(req.body.designId || ''));
    if (!require('./designs').canView(u, d)) throw new S.HttpError(403, 'Open one of your brand’s designs to download it.');
  }
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
  if (req.user.role === 'viewer' && !S.isClient(req.user)) throw new S.HttpError(403, 'Viewers cannot export video.');
  const plan = effectivePlan(wsOf(req.user));
  if (!plan.video_export) throw new S.HttpError(402, 'Video export is included from the Starter plan.', { code: 'upgrade' });
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

/* Seats: everyone except client viewers (agency clients log in free, up to 3 per brand) */
const seatUsers = wsId => q.get("SELECT COUNT(*) n FROM users WHERE workspace_id = ? AND status != 'removed' AND client_brand_id IS NULL", wsId).n;
const clientUsers = wsId => q.get("SELECT COUNT(*) n FROM users WHERE workspace_id = ? AND status != 'removed' AND client_brand_id IS NOT NULL", wsId).n;

router.get('/team', (req, res) => {
  const ws = wsOf(req.user);
  const members = q.all(`SELECT u.id, u.name, u.email, u.role, u.status, u.totp_enabled, u.email_verified, u.last_login_at, u.created_at,
                         u.client_brand_id, b.name client_brand FROM users u LEFT JOIN brand_kits b ON b.id = u.client_brand_id
                         WHERE u.workspace_id = ? AND u.status != 'removed' ORDER BY u.id`, ws.id);
  const isAdmin = S.ROLE_RANK[req.user.role] >= S.ROLE_RANK.admin;
  const inv = isAdmin ? pendingInvites(ws.id) : [];
  res.json({ seats: ws.seats, seatsUsed: seatUsers(ws.id) + inv.filter(i => !i.client_brand_id).length,
    clients: clientUsers(ws.id), clientLimit: effectivePlan(ws).max_brand_kits * 3, members, invites: inv });
});

router.post('/team/invite', S.requireRole('admin'), async (req, res) => {
  const email = S.email(req.body.email);
  let role = String(req.body.role || 'designer');
  let clientBrand = null;
  if (role === 'client') {
    // agency client: view & download one brand's shared designs; no seat needed
    const kit = q.get('SELECT * FROM brand_kits WHERE id = ? AND workspace_id = ?', +req.body.brand_kit_id, req.user.workspace_id);
    if (!kit) throw new S.HttpError(400, 'Pick the client’s brand.');
    clientBrand = kit.id; role = 'viewer';
  }
  if (!ASSIGNABLE.has(role)) throw new S.HttpError(400, 'Pick a valid role.');
  if (role === 'admin' && req.user.role !== 'owner') throw new S.HttpError(403, 'Only the owner can invite admins.');
  const ws = wsOf(req.user);
  const plan = effectivePlan(ws);
  if (plan.code === 'free') throw new S.HttpError(402, 'Team members are available on paid plans. Upgrade to add seats.', { code: 'upgrade' });
  if (q.get('SELECT id FROM users WHERE email = ?', email)) throw new S.HttpError(409, 'That email already has an account.');
  const pend = pendingInvites(ws.id);
  if (clientBrand) {
    if (ws.account_type !== 'business') throw new S.HttpError(400, 'Client logins are part of Business accounts. Switch your account type in Account & security.');
    const limit = plan.max_brand_kits * 3;
    if (clientUsers(ws.id) + pend.filter(i => i.client_brand_id).length >= limit)
      throw new S.HttpError(402, `Your ${plan.name} plan allows ${limit} client logins.`, { code: 'upgrade' });
  } else {
    const used = seatUsers(ws.id) + pend.filter(i => !i.client_brand_id).length;
    if (used >= ws.seats) throw new S.HttpError(402, `All ${ws.seats} seats are in use. Add a seat in Billing first (each seat is billed per user).`, { code: 'seats' });
  }

  const token = S.createToken('invite', { data: { workspace_id: ws.id, email, role, client_brand_id: clientBrand, invited_by: req.user.id }, ttlMs: 7 * 86400000 });
  const link = `${config.appUrl}/invite?token=${token}`;
  const brandName = clientBrand ? q.get('SELECT name FROM brand_kits WHERE id = ?', clientBrand).name : '';
  await sendMail(email, clientBrand ? `${ws.name} shared your ${brandName} designs with you` : `${req.user.name} invited you to ${ws.name} on ${config.appName}`,
    clientBrand
      ? `Hi,\n\n${req.user.name} from ${ws.name} invited you to review and download the designs for ${brandName}.\n\nCreate your login (valid 7 days):\n${link}`
      : `Hi,\n\n${req.user.name} invited you to join "${ws.name}" as a ${role}.\n\nAccept the invite (valid 7 days):\n${link}`);
  S.audit(req, 'team.invite', { email, role: clientBrand ? 'client' : role, brand: clientBrand });
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
  if (m.client_brand_id) throw new S.HttpError(400, 'Client logins can’t be changed to team roles. Remove the client and invite them as a team member instead.');
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

/* ================================================================== */
/* PROFILE (retail / business) & ACTIVITY LOG                          */
/* ================================================================== */
router.put('/workspace/account-type', S.requireRole('owner'), (req, res) => {
  const t = String(req.body.account_type || '');
  if (!['retail', 'business'].includes(t)) throw new S.HttpError(400, 'Pick Retail or Business.');
  const ws = wsOf(req.user);
  if (t === 'retail' && clientUsers(ws.id)) throw new S.HttpError(409, 'Remove your client logins (Team) before switching to Retail.');
  q.run('UPDATE workspaces SET account_type = ? WHERE id = ?', t, ws.id);
  S.audit(req, 'workspace.account_type', { from: ws.account_type, to: t });
  res.json({ ok: true, account_type: t });
});

/* Workspace activity log for owners/admins — on screen, or downloaded as CSV / JSON for auditors */
router.get('/workspace/activity', S.requireRole('admin'), (req, res) => {
  const days = Math.max(1, Math.min(3650, parseInt(req.query.days, 10) || 90));
  const rows = q.all(`SELECT a.id, a.created_at, a.action, a.detail, a.ip, a.hash, u.email, u.name
                      FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                      WHERE a.workspace_id = ? AND a.created_at > ? ORDER BY a.id DESC LIMIT ?`,
  req.user.workspace_id, Date.now() - days * 86400000, req.query.format ? 100000 : 300);
  const out = rows.map(r => ({ id: r.id, time: new Date(r.created_at).toISOString(), user: r.email || '', name: r.name || '', action: r.action,
    ip: r.ip || '', detail: r.detail === '{}' ? '' : r.detail, hash: r.hash || '' }));
  if (req.query.format === 'csv' || req.query.format === 'json') {
    S.audit(req, 'workspace.activity_exported', { format: req.query.format, days, rows: out.length });
    const name = `postgenx-activity-${new Date().toISOString().slice(0, 10)}.${req.query.format}`;
    res.attachment(name);
    if (req.query.format === 'json') return res.json({ workspace: req.user.workspace_id, exported_at: new Date().toISOString(), days, rows: out });
    const cell = v => { const s = String(v ?? ''); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
    const cols = ['id', 'time', 'user', 'name', 'action', 'ip', 'detail', 'hash'];
    return res.type('text/csv').send([cols.join(','), ...out.map(r => cols.map(c => cell(r[c])).join(','))].join('\r\n'));
  }
  res.json(out);
});

module.exports = { router, authoriseExports, PLATFORM_KEYS };
