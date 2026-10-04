'use strict';
/* Authentication, sessions, CSRF, role checks, 2FA (TOTP) and audit logging. */
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const config = require('./config');
const { q } = require('./db');

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

class HttpError extends Error {
  constructor(status, message, extra) { super(message); this.status = status; this.extra = extra; }
}

function clientIp(req) { return req.ip || req.socket?.remoteAddress || ''; }

/* Activity log. Each row carries a hash of itself + the previous row (a chain), so any later edit or
   deletion of a row is detectable with verifyAuditChain() — "tamper-evident". */
const auditHash = (prev, r) => sha256([prev, r.user_id ?? '', r.workspace_id ?? '', r.action, r.detail, r.ip ?? '', r.created_at].join('|'));
function audit(req, action, detail = {}, userOverride) {
  const u = userOverride || req.user;
  try {
    const row = { user_id: u?.id ?? null, workspace_id: u?.workspace_id ?? null, action, detail: JSON.stringify(detail), ip: clientIp(req), created_at: Date.now() };
    const prev = q.get("SELECT hash FROM audit_log WHERE hash != '' ORDER BY id DESC LIMIT 1")?.hash || '';
    q.run('INSERT INTO audit_log (user_id, workspace_id, action, detail, ip, created_at, prev_hash, hash) VALUES (?,?,?,?,?,?,?,?)',
      row.user_id, row.workspace_id, row.action, row.detail, row.ip, row.created_at, prev, auditHash(prev, row));
  } catch (e) { console.error('audit failed', e); }
}
function verifyAuditChain() {
  let prev = null, checked = 0;
  for (const r of q.iterate ? q.iterate("SELECT * FROM audit_log WHERE hash != '' ORDER BY id") : q.all("SELECT * FROM audit_log WHERE hash != '' ORDER BY id")) {
    if (prev !== null && r.prev_hash !== prev) return { ok: false, checked, brokenAt: r.id, reason: 'a row before this one was changed or deleted' };
    if (auditHash(r.prev_hash, r) !== r.hash) return { ok: false, checked, brokenAt: r.id, reason: 'this row was changed' };
    prev = r.hash; checked++;
  }
  return { ok: true, checked };
}

/* Client viewers: a viewer tied to one brand (agency clients). They only see that brand's shared designs. */
const isClient = u => !!(u && u.role === 'viewer' && u.client_brand_id);

/* ------------------------------------------------------------------ */
/* Passwords                                                           */
/* ------------------------------------------------------------------ */
const COMMON = new Set(['password', 'password1', 'password123', '123456789', '1234567890', 'qwertyuiop',
  'iloveyou123', 'letmein123', 'welcome123', 'admin12345', 'qwerty12345', 'abc1234567', 'passw0rd123']);

function passwordProblem(pw, email = '') {
  if (typeof pw !== 'string' || pw.length < 10) return 'Password must be at least 10 characters.';
  if (pw.length > 128) return 'Password is too long (max 128).';
  if (!/[A-Za-z]/.test(pw) || !/[0-9]/.test(pw)) return 'Password needs at least one letter and one number.';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common.';
  if (email && pw.toLowerCase().includes(email.split('@')[0].toLowerCase()) && email.split('@')[0].length > 3)
    return 'Password should not contain your email name.';
  return null;
}
const hashPassword = pw => bcrypt.hash(pw, config.security.bcryptRounds);
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 10);
const verifyPassword = (pw, hash) => bcrypt.compare(String(pw || ''), hash || DUMMY_HASH);

/* ------------------------------------------------------------------ */
/* Encryption at rest (2FA secrets) — AES-256-GCM                      */
/* ------------------------------------------------------------------ */
const encKey = crypto.createHash('sha256').update('pf-enc:' + config.appSecret).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', encKey, iv);
  const out = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), out].map(b => b.toString('base64url')).join('.');
}
function decrypt(blob) {
  const [iv, tag, data] = String(blob).split('.').map(s => Buffer.from(s, 'base64url'));
  const d = crypto.createDecipheriv('aes-256-gcm', encKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString('utf8');
}

/* ------------------------------------------------------------------ */
/* TOTP (RFC 6238) — works with Google Authenticator, Authy, 1Password */
/* ------------------------------------------------------------------ */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function base32Decode(str) {
  const clean = String(str).replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = 0, value = 0; const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch); if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
function hotp(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(code % 1e6).padStart(6, '0');
}
function verifyTotp(secret, code, window = 1) {
  const c = String(code || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return false;
  const step = Math.floor(Date.now() / 30000);
  for (let i = -window; i <= window; i++) {
    const expected = hotp(secret, step + i);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return true;
  }
  return false;
}
const newTotpSecret = () => base32Encode(crypto.randomBytes(20));

/* ------------------------------------------------------------------ */
/* One-time tokens (email verification, password reset, invites)      */
/* ------------------------------------------------------------------ */
function createToken(type, { userId = null, data = {}, ttlMs }) {
  const raw = randomToken(32);
  q.run('INSERT INTO tokens (token_hash, type, user_id, data, expires_at, created_at) VALUES (?,?,?,?,?,?)',
    sha256(raw), type, userId, JSON.stringify(data), Date.now() + ttlMs, Date.now());
  return raw;
}
function peekToken(type, raw) {
  if (!raw || typeof raw !== 'string') return null;
  const row = q.get('SELECT * FROM tokens WHERE token_hash = ? AND type = ?', sha256(raw), type);
  if (!row || row.used_at || row.expires_at < Date.now()) return null;
  return { ...row, data: JSON.parse(row.data || '{}') };
}
function consumeToken(type, raw) {
  const row = peekToken(type, raw);
  if (!row) return null;
  q.run('UPDATE tokens SET used_at = ? WHERE token_hash = ?', Date.now(), row.token_hash);
  return row;
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function setSessionCookie(res, value, maxAgeMs) {
  const parts = [`${config.session.cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (config.isProd) parts.push('Secure');
  parts.push(maxAgeMs > 0 ? `Max-Age=${Math.floor(maxAgeMs / 1000)}` : 'Max-Age=0');
  res.append('Set-Cookie', parts.join('; '));
}

function createSession(req, res, user) {
  const raw = randomToken(32);
  const now = Date.now();
  q.run(`INSERT INTO sessions (token_hash, user_id, csrf, created_at, last_seen, expires_at, ip, user_agent)
         VALUES (?,?,?,?,?,?,?,?)`,
    sha256(raw), user.id, randomToken(24), now, now, now + config.session.idleMs,
    clientIp(req), String(req.get('user-agent') || '').slice(0, 250));
  setSessionCookie(res, raw, config.session.idleMs);
}

function destroySession(req, res) {
  if (req.session) q.run('DELETE FROM sessions WHERE id = ?', req.session.id);
  setSessionCookie(res, '', 0);
}

/* Loads req.user / req.session from the cookie on every request. */
function loadSession(req, res, next) {
  const raw = parseCookies(req.headers.cookie)[config.session.cookieName];
  if (!raw) return next();
  const s = q.get('SELECT * FROM sessions WHERE token_hash = ?', sha256(raw));
  const now = Date.now();
  if (!s || s.expires_at < now || s.created_at + config.session.absoluteMs < now) {
    if (s) q.run('DELETE FROM sessions WHERE id = ?', s.id);
    setSessionCookie(res, '', 0);
    return next();
  }
  const u = q.get('SELECT * FROM users WHERE id = ?', s.user_id);
  if (!u || u.status !== 'active') {
    q.run('DELETE FROM sessions WHERE id = ?', s.id);
    setSessionCookie(res, '', 0);
    return next();
  }
  // Rolling idle expiry, written at most every 5 minutes
  if (now - s.last_seen > 5 * 60 * 1000) {
    q.run('UPDATE sessions SET last_seen = ?, expires_at = ? WHERE id = ?', now, now + config.session.idleMs, s.id);
    setSessionCookie(res, raw, config.session.idleMs);
  }
  req.session = s;
  req.user = u;
  next();
}

/* ------------------------------------------------------------------ */
/* CSRF: same-origin check on every state-changing API request, plus   */
/* a per-session token header for authenticated requests.              */
/* ------------------------------------------------------------------ */
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
// harmless, write-only telemetry (still same-origin checked) — sent with navigator.sendBeacon
const CSRF_EXEMPT = new Set(['/client-error', '/pv']);
// Log-in / sign-up style forms are used *before* the page has a token. If the browser still holds an
// older session (e.g. someone else logged in on this computer), these must still work. They are
// protected by the same-origin check above, and they replace the old session anyway.
const AUTH_ENTRY = new Set(['/auth/login', '/auth/signup', '/auth/forgot', '/auth/reset', '/auth/accept-invite']);
function csrfProtect(req, res, next) {
  if (SAFE.has(req.method)) return next();
  if (req.path === '/billing/webhook') return next(); // verified by Stripe signature instead
  const origin = req.get('origin') || req.get('referer');
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== req.get('host')) return next(new HttpError(403, 'Cross-site request blocked.'));
  }
  if (req.session && !CSRF_EXEMPT.has(req.path) && !AUTH_ENTRY.has(req.path)) {
    const sent = req.get('x-csrf-token') || '';
    const ok = sent.length === req.session.csrf.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(req.session.csrf));
    if (!ok) return next(new HttpError(403, 'Your session changed (for example you logged in or out in another tab). Please refresh the page and try again.', { code: 'csrf' }));
  }
  next();
}

/* ------------------------------------------------------------------ */
/* Access control                                                      */
/* ------------------------------------------------------------------ */
function requireAuth(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in.'));
  next();
}
const ROLE_RANK = { viewer: 0, designer: 1, admin: 2, owner: 3 };
/* requireRole('designer') → designer, admin or owner may pass */
function requireRole(minRole) {
  return (req, res, next) => {
    if (!req.user) return next(new HttpError(401, 'Please log in.'));
    if ((ROLE_RANK[req.user.role] ?? -1) < ROLE_RANK[minRole])
      return next(new HttpError(403, `Your role (${req.user.role}) can't do this.`));
    next();
  };
}
function requireSuperadmin(req, res, next) {
  if (!req.user) return next(new HttpError(401, 'Please log in.'));
  if (!req.user.is_superadmin) return next(new HttpError(404, 'Not found'));
  if (config.requireAdmin2fa && !req.user.totp_enabled)
    return next(new HttpError(403, 'Turn on 2-step login for your admin account first (Account & security).', { code: 'admin_2fa_required' }));
  next();
}
/* For HTML pages: redirect to login instead of returning JSON */
function pageAuth(opts = {}) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (opts.superadmin && !req.user.is_superadmin) return res.redirect('/app');
    if (opts.superadmin && config.requireAdmin2fa && !req.user.totp_enabled) return res.redirect('/app?admin2fa=1#account');
    if (opts.noClient && isClient(req.user)) return res.redirect('/app');
    next();
  };
}

/* ------------------------------------------------------------------ */
/* Input validation helpers                                            */
/* ------------------------------------------------------------------ */
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9.-]{1,190}\.[A-Za-z]{2,24}$/;
function str(v, { max = 200, min = 0, field = 'value', required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') throw new HttpError(400, `${field} must be text.`);
  v = v.trim();
  if (required && !v) throw new HttpError(400, `${field} is required.`);
  if (v.length < min) throw new HttpError(400, `${field} is too short.`);
  if (v.length > max) throw new HttpError(400, `${field} is too long (max ${max}).`);
  return v;
}
function email(v) {
  const e = str(v, { max: 254, field: 'Email', required: true }).toLowerCase();
  if (!EMAIL_RE.test(e)) throw new HttpError(400, 'Enter a valid email address.');
  return e;
}
function validTimezone(tz) {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return tz; } catch { return 'UTC'; }
}

module.exports = {
  HttpError, sha256, randomToken, audit, verifyAuditChain, isClient, clientIp,
  passwordProblem, hashPassword, verifyPassword,
  encrypt, decrypt, newTotpSecret, verifyTotp, hotp,
  createToken, peekToken, consumeToken,
  createSession, destroySession, loadSession, setSessionCookie,
  csrfProtect, requireAuth, requireRole, requireSuperadmin, pageAuth, ROLE_RANK,
  str, email, validTimezone,
};
