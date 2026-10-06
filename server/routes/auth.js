'use strict';
/* Sign up, log in (with lockout + optional 2FA), email verification,
   password reset, invites, and the signed-in user's own account settings. */
const express = require('express');
const QRCode = require('qrcode');
const config = require('../config');
const { q, tx } = require('../db');
const S = require('../security');
const { effectivePlan, usageFor, publicPlan, storageUsed, getPlan } = require('../plans');
const { sendMail } = require('../mailer');
const video = require('../video');

const router = express.Router();
const isDev = !config.isProd;

function meResponse(req) {
  const u = req.user;
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', u.workspace_id);
  const plan = effectivePlan(ws);
  return {
    user: {
      id: u.id, name: u.name, email: u.email, role: u.role, is_superadmin: !!u.is_superadmin,
      email_verified: !!u.email_verified, timezone: u.timezone, totp_enabled: !!u.totp_enabled,
      client_brand: u.client_brand_id ? (q.get('SELECT id, name FROM brand_kits WHERE id = ?', u.client_brand_id) || null) : null,
    },
    workspace: {
      id: ws.id, name: ws.name, seats: ws.seats, plan_code: ws.plan_code, sub_status: ws.sub_status, account_type: ws.account_type || 'retail',
      current_period_end: ws.current_period_end, cancel_at_period_end: !!ws.cancel_at_period_end,
      billing_mode: ws.billing_mode, billing_interval: ws.billing_interval || 'month',
      members: q.get("SELECT COUNT(*) n FROM users WHERE workspace_id = ? AND status != 'removed' AND client_brand_id IS NULL", ws.id).n,
      subscribed_plan: publicPlan(getPlan(ws.plan_code)),
    },
    plan: publicPlan(plan),
    usage: usageFor(u, plan),
    storage: { used: storageUsed(ws.id), limit: plan.storage_mb * 1024 * 1024 },
    requireVerifiedEmail: config.security.requireVerifiedEmailToExport,
    requireAdmin2fa: config.requireAdmin2fa,
    features: { mp4Convert: video.available(), socialPosting: config.socialPosting },
    csrf: req.session.csrf,
  };
}

async function sendVerification(user) {
  const token = S.createToken('verify', { userId: user.id, ttlMs: 48 * 3600 * 1000 });
  const link = `${config.appUrl}/api/auth/verify?token=${token}`;
  await sendMail(user.email, `Confirm your ${config.appName} email`,
    `Hi ${user.name},\n\nConfirm your email to start downloading designs:\n${link}\n\nThis link expires in 48 hours.`);
  return link;
}

/* ---------------- Sign up ---------------- */
router.post('/auth/signup', async (req, res) => {
  const name = S.str(req.body.name, { field: 'Name', required: true, max: 80 });
  const email = S.email(req.body.email);
  const business = S.str(req.body.business, { field: 'Business name', max: 80 }) || `${name}'s business`;
  const password = String(req.body.password || '');
  const problem = S.passwordProblem(password, email);
  if (problem) throw new S.HttpError(400, problem);
  if (!req.body.acceptTerms) throw new S.HttpError(400, 'Please accept the terms to continue.');
  const tz = S.validTimezone(String(req.body.timezone || 'UTC'));
  const accountType = req.body.accountType === 'business' ? 'business' : 'retail';

  if (q.get('SELECT id FROM users WHERE email = ?', email))
    throw new S.HttpError(409, 'An account with that email already exists. Try logging in.');

  // Closed beta: sign-up needs an invite code; the code can include a free plan period
  let beta = null;
  const codeIn = String(req.body.betaCode || '').trim();
  if (config.betaMode || codeIn) {
    beta = codeIn ? q.get('SELECT * FROM beta_codes WHERE code = ?', codeIn) : null;
    const usable = beta && beta.uses < beta.max_uses && (!beta.expires_at || beta.expires_at > Date.now());
    if (!usable) {
      if (config.betaMode) throw new S.HttpError(403, codeIn ? 'That invite code is not valid or has been used up.' : 'PostGenX is in private beta — you need an invite code to sign up.', { code: 'beta_code_required' });
      beta = null;
    }
  }

  const hash = await S.hashPassword(password);
  const user = tx(() => {
    const now = Date.now();
    const wsId = q.run('INSERT INTO workspaces (name, account_type, created_at) VALUES (?, ?, ?)', business, accountType, now).lastInsertRowid;
    const uid = q.run(`INSERT INTO users (email, name, password_hash, workspace_id, role, timezone, created_at)
                       VALUES (?,?,?,?,?,?,?)`, email, name, hash, wsId, 'owner', tz, now).lastInsertRowid;
    q.run('UPDATE workspaces SET owner_id = ? WHERE id = ?', uid, wsId);
    if (beta) {
      q.run('UPDATE beta_codes SET uses = uses + 1 WHERE code = ?', beta.code);
      if (beta.plan_code !== 'free' && beta.plan_days > 0)
        q.run(`UPDATE workspaces SET plan_code = ?, sub_status = 'active', billing_mode = 'comp', cancel_at_period_end = 1,
               current_period_end = ? WHERE id = ?`, beta.plan_code, now + beta.plan_days * 86400000, wsId);
    }
    return q.get('SELECT * FROM users WHERE id = ?', uid);
  });
  const link = await sendVerification(user);
  S.createSession(req, res, user);
  S.audit(req, 'auth.signup', { email, accountType, beta: beta?.code || null }, user);
  res.status(201).json({ ok: true, ...(isDev ? { devVerifyLink: link } : {}) });
});

/* ---------------- Log in ---------------- */
router.post('/auth/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  const password = String(req.body.password || '');
  const user = q.get('SELECT * FROM users WHERE email = ?', email);
  const now = Date.now();

  if (user && user.locked_until && user.locked_until > now) {
    const mins = Math.ceil((user.locked_until - now) / 60000);
    throw new S.HttpError(429, `Too many failed attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''} or reset your password.`);
  }
  const ok = await S.verifyPassword(password, user?.password_hash); // constant work even if no user
  if (!user || !ok) {
    if (user) {
      const fails = user.failed_logins + 1;
      const lock = fails >= config.security.maxFailedLogins ? now + config.security.lockMinutes * 60000 : null;
      q.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock, user.id);
      S.audit(req, lock ? 'auth.locked' : 'auth.login_failed', { email }, user);
    }
    throw new S.HttpError(401, 'Email or password is incorrect.');
  }
  if (user.status !== 'active') throw new S.HttpError(403, 'This account is not active. Contact support.');

  if (user.totp_enabled) {
    const code = req.body.totp;
    if (!code) return res.json({ needTotp: true });
    if (!S.verifyTotp(S.decrypt(user.totp_secret), code)) {
      const fails = user.failed_logins + 1;
      const lock = fails >= config.security.maxFailedLogins ? now + config.security.lockMinutes * 60000 : null;
      q.run('UPDATE users SET failed_logins = ?, locked_until = ? WHERE id = ?', lock ? 0 : fails, lock, user.id);
      S.audit(req, 'auth.totp_failed', {}, user);
      throw new S.HttpError(401, 'That 2-step code is not right.');
    }
  }
  q.run('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', now, user.id);
  S.createSession(req, res, user);
  S.audit(req, 'auth.login', {}, user);
  res.json({ ok: true });
});

router.post('/auth/logout', (req, res) => {
  if (req.user) S.audit(req, 'auth.logout');
  S.destroySession(req, res);
  res.json({ ok: true });
});

/* ---------------- Email verification ---------------- */
router.get('/auth/verify', (req, res) => {
  const t = S.consumeToken('verify', String(req.query.token || ''));
  if (!t) return res.redirect('/login?msg=verify_invalid');
  q.run('UPDATE users SET email_verified = 1 WHERE id = ?', t.user_id);
  S.audit(req, 'auth.email_verified', {}, { id: t.user_id });
  res.redirect(req.user ? '/app?verified=1' : '/login?msg=verified');
});

router.post('/auth/resend-verification', S.requireAuth, async (req, res) => {
  if (req.user.email_verified) return res.json({ ok: true });
  const link = await sendVerification(req.user);
  res.json({ ok: true, ...(isDev ? { devVerifyLink: link } : {}) });
});

/* ---------------- Password reset ---------------- */
/* Emails a fresh reset link to the account's own address. Older unused reset links stop working. */
function sendResetEmail(user) {
  q.run("UPDATE tokens SET used_at = ? WHERE type = 'reset' AND user_id = ? AND used_at IS NULL", Date.now(), user.id);
  const token = S.createToken('reset', { userId: user.id, ttlMs: 3600 * 1000 });
  const link = `${config.appUrl}/reset?token=${token}`;
  sendMail(user.email, `Reset your ${config.appName} password`,
    `Hi ${user.name},\n\nSomeone (hopefully you) asked to reset the password for your ${config.appName} account (${user.email}).\n\n` +
    `Choose a new password here (the link works for 1 hour, once):\n${link}\n\n` +
    `If you didn't ask for this, ignore this email - your password stays the same.`);
  return link;
}

/* People who were invited to a team but never finished joining have no password yet.
   If they use "Forgot password", send them a fresh invite link instead. */
function resendPendingInvite(email) {
  const now = Date.now();
  const pending = q.all("SELECT * FROM tokens WHERE type = 'invite' AND used_at IS NULL AND expires_at > ?", now)
    .map(t => ({ ...t, data: JSON.parse(t.data || '{}') }))
    .filter(t => String(t.data.email || '').toLowerCase() === email);
  if (!pending.length) return null;
  const latest = pending.sort((a, b) => b.created_at - a.created_at)[0];
  const ws = q.get('SELECT name FROM workspaces WHERE id = ?', latest.data.workspace_id);
  if (!ws) return null;
  for (const t of pending) q.run('UPDATE tokens SET used_at = ? WHERE token_hash = ?', now, t.token_hash);
  const token = S.createToken('invite', { data: latest.data, ttlMs: 7 * 86400000 });
  const link = `${config.appUrl}/invite?token=${token}`;
  sendMail(email, `Your invite to ${ws.name} on ${config.appName}`,
    `Hi,\n\nYou asked to reset your password, but you haven't finished joining "${ws.name}" yet - so there is no password to reset.\n\n` +
    `Open this link to finish joining and choose your password (valid 7 days):\n${link}`);
  return link;
}

router.post('/auth/forgot', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  let link;
  if (email.includes('@')) {
    const user = q.get("SELECT * FROM users WHERE lower(email) = ? AND status = 'active'", email);
    if (user) {
      link = sendResetEmail(user); // not awaited: the reply time doesn't reveal whether the account exists
      S.audit(req, 'auth.reset_requested', {}, user);
    } else if (!q.get('SELECT id FROM users WHERE lower(email) = ?', email)) {
      link = resendPendingInvite(email);
      if (link) S.audit(req, 'team.invite_resent', { email });
    }
  }
  // Same answer whether or not the account exists (no account enumeration)
  res.json({ ok: true, message: 'If that email has an account, a reset link is on its way. Check your inbox and Spam folder.', ...(isDev && link ? { devResetLink: link } : {}) });
});

const RESET_EXPIRED = 'This reset link has expired or was already used. Click "Forgot password" to get a new one.';
router.get('/auth/reset-check', (req, res) => {
  const t = S.peekToken('reset', String(req.query.token || ''));
  if (!t) throw new S.HttpError(400, RESET_EXPIRED);
  const u = q.get('SELECT email FROM users WHERE id = ?', t.user_id);
  res.json({ ok: true, email: u?.email || '' });
});

router.post('/auth/reset', async (req, res) => {
  const t = S.peekToken('reset', String(req.body.token || ''));
  if (!t) throw new S.HttpError(400, RESET_EXPIRED);
  const user = q.get('SELECT * FROM users WHERE id = ?', t.user_id);
  const problem = S.passwordProblem(String(req.body.password || ''), user.email);
  if (problem) throw new S.HttpError(400, problem);
  const hash = await S.hashPassword(req.body.password);
  S.consumeToken('reset', req.body.token);
  q.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, email_verified = 1 WHERE id = ?', hash, user.id);
  q.run('DELETE FROM sessions WHERE user_id = ?', user.id); // sign out everywhere
  S.audit(req, 'auth.password_reset', {}, user);
  res.json({ ok: true });
});

/* ---------------- Invites ---------------- */
const INVITE_EXPIRED = 'This invite link has expired or was already used. Go to "Forgot password" and enter your email to get a fresh link, or ask the person who invited you.';
router.get('/auth/invite', (req, res) => {
  const t = S.peekToken('invite', String(req.query.token || ''));
  if (!t) throw new S.HttpError(404, INVITE_EXPIRED);
  const ws = q.get('SELECT name FROM workspaces WHERE id = ?', t.data.workspace_id);
  res.json({ email: t.data.email, role: t.data.role, workspace: ws?.name || '' });
});

router.post('/auth/accept-invite', async (req, res) => {
  const t = S.peekToken('invite', String(req.body.token || ''));
  if (!t) throw new S.HttpError(400, INVITE_EXPIRED);
  const name = S.str(req.body.name, { field: 'Name', required: true, max: 80 });
  const password = String(req.body.password || '');
  const problem = S.passwordProblem(password, t.data.email);
  if (problem) throw new S.HttpError(400, problem);
  if (q.get('SELECT id FROM users WHERE email = ?', t.data.email))
    throw new S.HttpError(409, 'That email already has an account. Ask your admin to invite a different email.');

  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', t.data.workspace_id);
  const hash = await S.hashPassword(password);
  const user = tx(() => {
    const clientBrand = t.data.client_brand_id
      ? q.get('SELECT id FROM brand_kits WHERE id = ? AND workspace_id = ?', t.data.client_brand_id, ws.id)?.id
      : null;
    if (t.data.client_brand_id && !clientBrand) throw new S.HttpError(409, 'That brand no longer exists. Ask for a new invite.');
    if (!clientBrand) {
      const members = q.get("SELECT COUNT(*) n FROM users WHERE workspace_id = ? AND status != 'removed' AND client_brand_id IS NULL", ws.id).n;
      if (members >= ws.seats) throw new S.HttpError(409, 'This team has no free seats. Ask the owner to add a seat.');
    }
    const uid = q.run(`INSERT INTO users (email, name, password_hash, workspace_id, role, email_verified, timezone, client_brand_id, created_at)
                       VALUES (?,?,?,?,?,1,?,?,?)`, t.data.email, name, hash, ws.id, clientBrand ? 'viewer' : t.data.role,
      S.validTimezone(String(req.body.timezone || 'UTC')), clientBrand, Date.now()).lastInsertRowid;
    q.run('UPDATE tokens SET used_at = ? WHERE token_hash = ?', Date.now(), t.token_hash);
    return q.get('SELECT * FROM users WHERE id = ?', uid);
  });
  S.createSession(req, res, user);
  S.audit(req, 'team.invite_accepted', { role: user.role }, user);
  res.status(201).json({ ok: true });
});

/* ---------------- Current user ---------------- */
router.get('/me', S.requireAuth, (req, res) => res.json(meResponse(req)));

router.patch('/me', S.requireAuth, (req, res) => {
  const name = S.str(req.body.name ?? req.user.name, { field: 'Name', required: true, max: 80 });
  const tz = S.validTimezone(String(req.body.timezone ?? req.user.timezone));
  q.run('UPDATE users SET name = ?, timezone = ? WHERE id = ?', name, tz, req.user.id);
  if (req.body.workspaceName !== undefined && ['owner', 'admin'].includes(req.user.role)) {
    q.run('UPDATE workspaces SET name = ? WHERE id = ?',
      S.str(req.body.workspaceName, { field: 'Business name', required: true, max: 80 }), req.user.workspace_id);
  }
  res.json({ ok: true });
});

router.post('/me/password', S.requireAuth, async (req, res) => {
  if (!(await S.verifyPassword(req.body.current, req.user.password_hash)))
    throw new S.HttpError(400, 'Current password is incorrect.');
  const problem = S.passwordProblem(String(req.body.password || ''), req.user.email);
  if (problem) throw new S.HttpError(400, problem);
  q.run('UPDATE users SET password_hash = ? WHERE id = ?', await S.hashPassword(req.body.password), req.user.id);
  q.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', req.user.id, req.session.id);
  S.audit(req, 'auth.password_changed');
  res.json({ ok: true });
});

/* Sessions / devices */
router.get('/me/sessions', S.requireAuth, (req, res) => {
  const rows = q.all('SELECT id, created_at, last_seen, ip, user_agent FROM sessions WHERE user_id = ? ORDER BY last_seen DESC', req.user.id);
  res.json(rows.map(r => ({ ...r, current: r.id === req.session.id })));
});
router.delete('/me/sessions/:id', S.requireAuth, (req, res) => {
  q.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', +req.params.id, req.user.id);
  S.audit(req, 'auth.session_revoked', { session: +req.params.id });
  res.json({ ok: true });
});
router.post('/me/sessions/revoke-others', S.requireAuth, (req, res) => {
  q.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', req.user.id, req.session.id);
  S.audit(req, 'auth.sessions_revoked_all');
  res.json({ ok: true });
});

/* 2-step verification (TOTP) */
router.post('/me/2fa/setup', S.requireAuth, async (req, res) => {
  if (req.user.totp_enabled) throw new S.HttpError(400, '2-step verification is already on.');
  const secret = S.newTotpSecret();
  q.run('UPDATE users SET totp_secret = ? WHERE id = ?', S.encrypt(secret), req.user.id);
  const uri = `otpauth://totp/${encodeURIComponent(config.appName)}:${encodeURIComponent(req.user.email)}?secret=${secret}&issuer=${encodeURIComponent(config.appName)}`;
  res.json({ secret, qr: await QRCode.toDataURL(uri, { margin: 1, width: 200 }) });
});
router.post('/me/2fa/enable', S.requireAuth, (req, res) => {
  const u = q.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!u.totp_secret) throw new S.HttpError(400, 'Start setup first.');
  if (!S.verifyTotp(S.decrypt(u.totp_secret), req.body.code)) throw new S.HttpError(400, 'That code is not right — check the time on your phone.');
  q.run('UPDATE users SET totp_enabled = 1 WHERE id = ?', u.id);
  S.audit(req, 'auth.2fa_enabled');
  res.json({ ok: true });
});
router.post('/me/2fa/disable', S.requireAuth, async (req, res) => {
  if (!(await S.verifyPassword(req.body.password, req.user.password_hash))) throw new S.HttpError(400, 'Password is incorrect.');
  q.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', req.user.id);
  S.audit(req, 'auth.2fa_disabled');
  res.json({ ok: true });
});

module.exports = { router, meResponse, sendResetEmail };
