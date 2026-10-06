'use strict';
/* Platform administration — only for users with is_superadmin = 1.
   Non-admins get a 404 so the area isn't even discoverable. */
const express = require('express');
const { q } = require('../db');
const S = require('../security');
const { subscriptionIsLive } = require('../plans');

const router = express.Router();
router.use(S.requireSuperadmin);
const DAY = 86400000;

router.get('/stats', (req, res) => {
  const now = Date.now();
  const wss = q.all('SELECT w.*, p.price_cents, p.name plan_name FROM workspaces w JOIN plans p ON p.code = w.plan_code');
  const live = wss.filter(subscriptionIsLive);
  const byPlan = {};
  for (const w of live) byPlan[w.plan_name] = (byPlan[w.plan_name] || 0) + w.seats;
  const mrr = live.filter(w => w.billing_mode === 'stripe' || w.billing_mode === 'demo')
    .reduce((s, w) => s + w.price_cents * w.seats, 0);
  const daily = q.all(`SELECT date(created_at/1000, 'unixepoch') d, COUNT(*) n FROM exports
                       WHERE created_at > ? GROUP BY d ORDER BY d`, now - 14 * DAY);
  res.json({
    users: q.get("SELECT COUNT(*) n FROM users WHERE status != 'removed'").n,
    activeUsers30d: q.get('SELECT COUNT(*) n FROM users WHERE last_login_at > ?', now - 30 * DAY).n,
    signups7d: q.get('SELECT COUNT(*) n FROM users WHERE created_at > ?', now - 7 * DAY).n,
    workspaces: wss.length,
    paidWorkspaces: live.length,
    paidSeatsByPlan: byPlan,
    mrrCents: mrr,
    exports24h: q.get('SELECT COUNT(*) n FROM exports WHERE created_at > ?', now - DAY).n,
    exports30d: q.get('SELECT COUNT(*) n FROM exports WHERE created_at > ?', now - 30 * DAY).n,
    designs: q.get('SELECT COUNT(*) n FROM designs WHERE deleted_at IS NULL').n,
    storageBytes: q.get('SELECT COALESCE(SUM(size),0) s FROM media').s,
    lockedAccounts: q.get('SELECT COUNT(*) n FROM users WHERE locked_until > ?', now).n,
    failedLogins24h: q.get("SELECT COUNT(*) n FROM audit_log WHERE action IN ('auth.login_failed','auth.locked','auth.totp_failed') AND created_at > ?", now - DAY).n,
    dailyExports: daily,
  });
});

router.get('/users', (req, res) => {
  const term = `%${String(req.query.q || '').slice(0, 80)}%`;
  const page = Math.max(0, parseInt(req.query.page, 10) || 0);
  const rows = q.all(`
    SELECT u.id, u.name, u.email, u.role, u.status, u.is_superadmin, u.email_verified, u.totp_enabled,
           u.created_at, u.last_login_at, u.locked_until, u.client_brand_id,
           w.id workspace_id, w.name workspace, w.account_type, w.plan_code, w.sub_status, w.seats, w.billing_mode, w.current_period_end,
           (SELECT COUNT(*) FROM exports e WHERE e.user_id = u.id AND e.created_at > ?) exports30d
    FROM users u JOIN workspaces w ON w.id = u.workspace_id
    WHERE u.status != 'removed' AND (u.email LIKE ? OR u.name LIKE ? OR w.name LIKE ?)
    ORDER BY u.id DESC LIMIT 50 OFFSET ?`, Date.now() - 30 * DAY, term, term, term, page * 50);
  res.json(rows);
});

router.patch('/users/:id', (req, res) => {
  const u = q.get('SELECT * FROM users WHERE id = ?', +req.params.id);
  if (!u) throw new S.HttpError(404, 'User not found.');
  if (u.id === req.user.id && (req.body.status === 'suspended' || req.body.is_superadmin === false))
    throw new S.HttpError(400, "You can't suspend or demote yourself.");
  if (req.body.status !== undefined) {
    if (!['active', 'suspended'].includes(req.body.status)) throw new S.HttpError(400, 'Bad status.');
    q.run('UPDATE users SET status = ? WHERE id = ?', req.body.status, u.id);
    if (req.body.status === 'suspended') q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
  }
  if (req.body.is_superadmin !== undefined) q.run('UPDATE users SET is_superadmin = ? WHERE id = ?', req.body.is_superadmin ? 1 : 0, u.id);
  if (req.body.email_verified) q.run('UPDATE users SET email_verified = 1 WHERE id = ?', u.id);
  if (req.body.unlock) q.run('UPDATE users SET locked_until = NULL, failed_logins = 0 WHERE id = ?', u.id);
  if (req.body.reset2fa) q.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', u.id);
  S.audit(req, 'admin.user_updated', { target: u.id, changes: req.body });
  res.json({ ok: true });
});

/* Switch a workspace between Retail and Business profiles */
router.patch('/workspaces/:id', (req, res) => {
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', +req.params.id);
  if (!ws) throw new S.HttpError(404, 'Workspace not found.');
  const t = String(req.body.account_type || '');
  if (!['retail', 'business'].includes(t)) throw new S.HttpError(400, 'Pick retail or business.');
  q.run('UPDATE workspaces SET account_type = ? WHERE id = ?', t, ws.id);
  S.audit(req, 'admin.account_type', { workspace: ws.id, from: ws.account_type, to: t });
  res.json({ ok: true });
});

/* Grant / change a workspace's plan manually ("comp" — e.g. partners, refunds, testing) */
router.post('/workspaces/:id/plan', (req, res) => {
  const ws = q.get('SELECT * FROM workspaces WHERE id = ?', +req.params.id);
  if (!ws) throw new S.HttpError(404, 'Workspace not found.');
  const plan = q.get('SELECT * FROM plans WHERE code = ?', String(req.body.plan || ''));
  if (!plan) throw new S.HttpError(400, 'Unknown plan.');
  const seats = Math.max(1, Math.min(500, parseInt(req.body.seats, 10) || ws.seats));
  const days = Math.max(1, Math.min(3650, parseInt(req.body.days, 10) || 30));
  if (plan.code === 'free') {
    q.run("UPDATE workspaces SET plan_code = 'free', sub_status = 'none', billing_mode = 'none', seats = ? WHERE id = ?", seats, ws.id);
  } else {
    q.run(`UPDATE workspaces SET plan_code = ?, seats = ?, sub_status = 'active', billing_mode = 'comp',
           cancel_at_period_end = 1, current_period_end = ? WHERE id = ?`, plan.code, seats, Date.now() + days * DAY, ws.id);
  }
  S.audit(req, 'admin.plan_granted', { workspace: ws.id, plan: plan.code, seats, days });
  res.json({ ok: true });
});

/* ---------------- Plans (pricing schemes) ---------------- */
const PLAN_FIELDS = {
  name: 'str', description: 'str', price_cents: 'int', price_cents_annual: 'int', currency: 'str', quota_limit: 'int', quota_period: 'period', daily_limit: 'int',
  max_quality: 'int', video_export: 'bool', batch_export: 'bool', premium_templates: 'bool', watermark: 'bool',
  max_designs: 'int', max_brand_kits: 'int', max_upload_mb: 'int', storage_mb: 'int', public: 'bool', active: 'bool',
  sort: 'int', stripe_price_id: 'str', stripe_price_id_annual: 'str',
  ai_credits_monthly: 'int', ai_credits_lifetime: 'int', ai_video: 'bool', max_video_seconds: 'int', max_video_mb: 'int', audience: 'audience', api_access: 'bool',
};
function planValues(body) {
  const out = {};
  for (const [k, t] of Object.entries(PLAN_FIELDS)) {
    if (body[k] === undefined) continue;
    const v = body[k];
    if (t === 'audience') { if (!['retail', 'business', 'both'].includes(v)) throw new S.HttpError(400, 'Audience must be retail, business or both.'); out[k] = v; continue; }
    if (t === 'str') out[k] = S.str(String(v), { field: k, max: 300 });
    else if (t === 'bool') out[k] = v ? 1 : 0;
    else if (t === 'period') { if (!['day', 'month', 'lifetime'].includes(v)) throw new S.HttpError(400, 'Period must be day, month or lifetime.'); out[k] = v; }
    else { const n = parseInt(v, 10); if (!Number.isFinite(n) || n < -1 || n > 1e7) throw new S.HttpError(400, `${k} must be a number.`); out[k] = n; }
  }
  if (out.max_quality !== undefined && (out.max_quality < 1 || out.max_quality > 3)) throw new S.HttpError(400, 'Max quality is 1–3.');
  return out;
}

router.get('/plans', (req, res) => res.json(q.all('SELECT * FROM plans ORDER BY sort, price_cents')));

router.post('/plans', (req, res) => {
  const code = String(req.body.code || '').toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(code)) throw new S.HttpError(400, 'Code must be 2–30 lowercase letters, numbers, - or _.');
  if (q.get('SELECT code FROM plans WHERE code = ?', code)) throw new S.HttpError(409, 'A plan with that code exists.');
  const v = planValues(req.body);
  if (!v.name || v.quota_limit === undefined || !v.quota_period) throw new S.HttpError(400, 'Name, quota limit and period are required.');
  const cols = ['code', ...Object.keys(v)];
  q.run(`INSERT INTO plans (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, code, ...Object.values(v));
  S.audit(req, 'admin.plan_created', { code });
  res.status(201).json({ ok: true });
});

router.put('/plans/:code', (req, res) => {
  const p = q.get('SELECT * FROM plans WHERE code = ?', String(req.params.code));
  if (!p) throw new S.HttpError(404, 'Plan not found.');
  const v = planValues(req.body);
  if (p.code === 'free') { delete v.price_cents; delete v.price_cents_annual; delete v.active; }
  const keys = Object.keys(v);
  if (keys.length) q.run(`UPDATE plans SET ${keys.map(k => `${k} = ?`).join(', ')} WHERE code = ?`, ...Object.values(v), p.code);
  S.audit(req, 'admin.plan_updated', { code: p.code, changes: v });
  res.json({ ok: true });
});

router.get('/audit/verify', (req, res) => res.json(S.verifyAuditChain()));
router.get('/audit', (req, res) => {
  const action = String(req.query.action || '');
  const rows = q.all(`SELECT a.*, u.email FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
                      WHERE (? = '' OR a.action LIKE ?) ORDER BY a.id DESC LIMIT 300`, action, action + '%');
  res.json(rows);
});

// Private links (password reset, email confirmation, invites) go only to the person they were sent to.
// Admins see them only when the email could NOT be delivered, so they can still help someone by hand.
const PRIVATE_LINK = /https?:\/\/\S*[?&]token=[A-Za-z0-9_-]+/g;
router.get('/outbox', (req, res) => res.json(q.all('SELECT * FROM outbox ORDER BY id DESC LIMIT 50').map(m =>
  m.status === 'sent' || m.status === 'sending' ? { ...m, body: m.body.replace(PRIVATE_LINK, '[private link — sent only to the user]') } : m)));

/* ---------------- Email sending status + test ---------------- */
const mailer = require('../mailer');
router.get('/mail-status', async (req, res) => {
  if (req.query.check) await mailer.checkConnection();
  res.json(mailer.mailStatus());
});
router.post('/test-email', async (req, res) => {
  const to = S.email(req.body.to || req.user.email);
  const ok = await mailer.sendMail(to, `${require('../config').appName} test email`,
    `This is a test email from ${require('../config').appName}.\n\nIf you can read this, password reset and verification emails will reach your users.`);
  S.audit(req, 'admin.test_email', { to, ok });
  res.json({ ok, ...mailer.mailStatus() });
});

/* Send a password reset link to the user's own email address */
router.post('/users/:id/send-reset', (req, res) => {
  const u = q.get('SELECT * FROM users WHERE id = ?', +req.params.id);
  if (!u) throw new S.HttpError(404, 'User not found.');
  if (u.status !== 'active') throw new S.HttpError(400, 'Re-activate this user first.');
  require('./auth').sendResetEmail(u);
  S.audit(req, 'admin.reset_sent', { target: u.id });
  res.json({ ok: true, sending: mailer.mailStatus().configured });
});

/* ---------------- Landing page before/after examples ---------------- */
const SITE_DIR = require('node:path').join(require('../config').DATA_DIR, 'site');
const siteUpload = require('multer')({ storage: require('multer').memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 2 } })
  .fields([{ name: 'before', maxCount: 1 }, { name: 'after', maxCount: 1 }]);
router.get('/examples', (req, res) => res.json(q.all('SELECT * FROM site_examples ORDER BY sort, id')));
router.post('/examples', siteUpload, (req, res) => {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
  const { sniff } = require('./media');
  const names = {};
  for (const k of ['before', 'after']) {
    const f = req.files?.[k]?.[0];
    if (!f) throw new S.HttpError(400, `Choose the ${k} image.`);
    const t = sniff(f.buffer);
    if (!t || t.kind !== 'image') throw new S.HttpError(400, `The ${k} file must be a PNG, JPG or WebP image.`);
    names[k] = `${crypto.randomBytes(8).toString('hex')}.${t.ext}`;
  }
  fs.mkdirSync(SITE_DIR, { recursive: true });
  fs.writeFileSync(path.join(SITE_DIR, names.before), req.files.before[0].buffer);
  fs.writeFileSync(path.join(SITE_DIR, names.after), req.files.after[0].buffer);
  q.run('INSERT INTO site_examples (industry, caption, before_file, after_file, sort, created_at) VALUES (?,?,?,?,?,?)',
    S.str(req.body.industry || '', { max: 40 }), S.str(req.body.caption || '', { max: 160 }), names.before, names.after,
    parseInt(req.body.sort, 10) || 0, Date.now());
  S.audit(req, 'admin.example_added', {});
  res.status(201).json({ ok: true });
});
router.delete('/examples/:id', (req, res) => {
  const e = q.get('SELECT * FROM site_examples WHERE id = ?', +req.params.id);
  if (!e) throw new S.HttpError(404, 'Not found.');
  for (const f of [e.before_file, e.after_file]) require('node:fs').rmSync(require('node:path').join(SITE_DIR, f), { force: true });
  q.run('DELETE FROM site_examples WHERE id = ?', e.id);
  res.json({ ok: true });
});

/* ---------------- Support inbox ---------------- */
router.get('/support', (req, res) => {
  const status = ['open', 'closed'].includes(req.query.status) ? req.query.status : 'open';
  res.json(q.all('SELECT * FROM support_tickets WHERE status = ? ORDER BY id DESC LIMIT 200', status));
});
router.patch('/support/:id', (req, res) => {
  const status = req.body.status === 'closed' ? 'closed' : 'open';
  q.run('UPDATE support_tickets SET status = ? WHERE id = ?', status, +req.params.id);
  res.json({ ok: true });
});

/* ---------------- Feedback & testimonials ---------------- */
router.get('/feedback', (req, res) => res.json(q.all(`
  SELECT f.*, u.email FROM feedback f LEFT JOIN users u ON u.id = f.user_id ORDER BY f.id DESC LIMIT 300`)));
router.patch('/feedback/:id', (req, res) => {
  const f = q.get('SELECT * FROM feedback WHERE id = ?', +req.params.id);
  if (!f) throw new S.HttpError(404, 'Not found.');
  if (req.body.approved && !f.allow_quote) throw new S.HttpError(400, 'This customer did not give permission to quote them.');
  q.run('UPDATE feedback SET approved = ? WHERE id = ?', req.body.approved ? 1 : 0, f.id);
  S.audit(req, 'admin.feedback_' + (req.body.approved ? 'approved' : 'hidden'), { id: f.id });
  res.json({ ok: true });
});

/* ---------------- AI studio ---------------- */
router.get('/ai', (req, res) => {
  const ai = require('../ai');
  res.json({ ...ai.stats(), templates: ai.templates(true) });
});
router.patch('/ai/settings', (req, res) => {
  const ai = require('../ai');
  if (req.body.enabled !== undefined) ai.setEnabled(!!req.body.enabled);
  if (req.body.qualityCheck !== undefined) ai.setQualityCheck(!!req.body.qualityCheck);
  if (req.body.dailyBudget !== undefined) {
    const v = parseFloat(req.body.dailyBudget);
    if (!Number.isFinite(v) || v < 0 || v > 10000) throw new S.HttpError(400, 'Daily budget must be between 0 and 10,000 USD.');
    ai.setDailyBudget(v);
  }
  S.audit(req, 'admin.ai_settings', req.body);
  res.json({ ok: true, ...ai.stats() });
});
/* AI service keys (stored encrypted; never returned in full) */
router.get('/ai/keys', (req, res) => res.json(require('../ai/keys').status()));
router.put('/ai/keys', (req, res) => {
  const keys = require('../ai/keys');
  let st;
  try { st = keys.save(req.body || {}); } catch (e) { throw new S.HttpError(e.status || 400, e.message); }
  // audit what changed, never the key itself
  S.audit(req, 'admin.ai_keys', { gemini: req.body.geminiKey ? 'set' : req.body.clear_geminiKey ? 'removed' : undefined,
    openai: req.body.openaiKey ? 'set' : req.body.clear_openaiKey ? 'removed' : undefined, provider: req.body.provider });
  res.json({ ...st, active: require('../ai/providers').active(), videoActive: require('../ai/videogen').active() });
});
router.post('/ai/keys/check', async (req, res) => {
  const which = req.body.which === 'openai' ? 'openai' : 'gemini';
  res.json(await require('../ai/keys').check(which));
});
router.put('/ai/templates/:id', (req, res) => {
  const t = q.get('SELECT * FROM ai_templates WHERE id = ?', +req.params.id);
  if (!t) throw new S.HttpError(404, 'Style not found.');
  const name = S.str(req.body.name ?? t.name, { field: 'Name', required: true, max: 60 });
  const description = S.str(req.body.description ?? t.description, { field: 'Description', max: 160 }) || '';
  const prompt = String(req.body.prompt ?? t.prompt).slice(0, 4000);
  if (prompt.trim().length < 30) throw new S.HttpError(400, 'The prompt is too short.');
  const setting = S.str(req.body.setting ?? t.setting, { field: 'Default scene', max: 160 }) || '';
  const space = ['top', 'left', 'bottom', 'none'].includes(req.body.text_space) ? req.body.text_space : t.text_space;
  q.run(`UPDATE ai_templates SET name = ?, description = ?, prompt = ?, setting = ?, text_space = ?, needs_photo = ?, active = ?, updated_at = ? WHERE id = ?`,
    name, description, prompt, setting, space, req.body.needs_photo !== undefined ? (req.body.needs_photo ? 1 : 0) : t.needs_photo,
    req.body.active !== undefined ? (req.body.active ? 1 : 0) : t.active, Date.now(), t.id);
  S.audit(req, 'admin.ai_template_updated', { key: t.key });
  res.json({ ok: true });
});
/* Check the AI key works (makes one real image — costs a few cents) */
router.post('/ai/test', async (req, res) => {
  const providers = require('../ai/providers');
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('../config').DATA_DIR, 'tmp', 'aitest-'));
  try {
    const r = await providers.generate({ prompt: 'A photorealistic red apple on a white table, soft daylight. No text.', aspect: '1:1', n: 1, tmpDir: dir });
    const b = r.images[0];
    res.json({ ok: true, provider: r.provider, model: r.model, bytes: b.length, preview: `data:image/${b[0] === 0xff ? 'jpeg' : 'png'};base64,${b.toString('base64')}` });
  } catch (e) {
    res.json({ ok: false, provider: providers.active(), error: e.message, detail: e.detail || '' });
  } finally { require('node:fs').rm(dir, { recursive: true, force: true }, () => {}); }
});
router.post('/workspaces/:id/ai-credits', (req, res) => {
  const ws = q.get('SELECT id FROM workspaces WHERE id = ?', +req.params.id);
  if (!ws) throw new S.HttpError(404, 'Workspace not found.');
  const n = parseInt(req.body.credits, 10);
  if (!Number.isFinite(n) || n === 0 || Math.abs(n) > 100000) throw new S.HttpError(400, 'Enter a number of credits (negative to remove).');
  q.run('UPDATE workspaces SET ai_topup_credits = MAX(0, ai_topup_credits + ?) WHERE id = ?', n, ws.id);
  S.audit(req, 'admin.ai_credits', { workspace: ws.id, credits: n });
  res.json({ ok: true, balance: q.get('SELECT ai_topup_credits b FROM workspaces WHERE id = ?', ws.id).b });
});

/* ---------------- Closed beta invite codes ---------------- */
router.get('/beta-codes', (req, res) => res.json(q.all('SELECT * FROM beta_codes ORDER BY created_at DESC')));
router.post('/beta-codes', (req, res) => {
  let code = String(req.body.code || '').trim().toUpperCase();
  if (!code) code = 'BETA-' + require('node:crypto').randomBytes(3).toString('hex').toUpperCase();
  if (!/^[A-Z0-9-]{4,30}$/.test(code)) throw new S.HttpError(400, 'Code must be 4–30 letters, numbers or dashes.');
  if (q.get('SELECT code FROM beta_codes WHERE code = ?', code)) throw new S.HttpError(409, 'That code already exists.');
  const plan = q.get('SELECT code FROM plans WHERE code = ?', String(req.body.plan_code || 'pro'));
  if (!plan) throw new S.HttpError(400, 'Unknown plan.');
  const maxUses = Math.max(1, Math.min(1000, parseInt(req.body.max_uses, 10) || 1));
  const days = Math.max(0, Math.min(3650, parseInt(req.body.plan_days, 10) || 60));
  const expDays = parseInt(req.body.expires_days, 10);
  q.run('INSERT INTO beta_codes (code, note, max_uses, plan_code, plan_days, expires_at, created_at) VALUES (?,?,?,?,?,?,?)',
    code, S.str(req.body.note, { max: 120 }) || '', maxUses, plan.code, days, expDays > 0 ? Date.now() + expDays * DAY : null, Date.now());
  S.audit(req, 'admin.beta_code_created', { code });
  res.status(201).json({ ok: true, code });
});
router.delete('/beta-codes/:code', (req, res) => {
  q.run('DELETE FROM beta_codes WHERE code = ?', String(req.params.code));
  res.json({ ok: true });
});

/* ---------------- Reliability: errors, backups, health ---------------- */
router.get('/errors', (req, res) => res.json(q.all('SELECT * FROM client_errors ORDER BY last_seen DESC LIMIT 200')));
router.delete('/errors', (req, res) => { q.run('DELETE FROM client_errors'); res.json({ ok: true }); });

const backup = require('../backup');
router.get('/backups', (req, res) => res.json({
  dir: backup.BACKUP_DIR, offsite: backup.s3Enabled(),
  lastVerify: JSON.parse(require('../db').metaGet('last_backup_verify') || 'null'),
  backups: backup.listBackups().map(({ dir, ...b }) => b),
}));
router.post('/backups', async (req, res) => {
  const r = await backup.runBackup('manual');
  S.audit(req, 'admin.backup_run', { name: r.name });
  res.json({ ok: true, name: r.name, offsite: r.offsite });
});
router.post('/backups/verify', (req, res) => {
  let r;
  try { r = backup.verifyBackup(String(req.body?.name || 'latest')); }
  catch (e) { r = { ok: false, error: e.message, checkedAt: Date.now() }; }
  require('../db').metaSet('last_backup_verify', JSON.stringify(r));
  S.audit(req, 'admin.backup_verified', { name: r.backup, ok: r.ok });
  res.json(r);
});

/* ---------------- Privacy-friendly analytics (no cookies, no IPs stored) ---------------- */
router.get('/analytics', (req, res) => {
  const days = Math.max(1, Math.min(90, parseInt(req.query.days, 10) || 30));
  const since = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  res.json({
    days,
    daily: q.all('SELECT day, SUM(views) views, SUM(visitors) visitors FROM page_views WHERE day >= ? GROUP BY day ORDER BY day', since),
    pages: q.all('SELECT path, SUM(views) views, SUM(visitors) visitors FROM page_views WHERE day >= ? GROUP BY path ORDER BY views DESC LIMIT 20', since),
    referrers: q.all("SELECT referrer, SUM(views) views FROM page_views WHERE day >= ? AND referrer != '' GROUP BY referrer ORDER BY views DESC LIMIT 20", since),
    signups: q.all("SELECT date(created_at/1000,'unixepoch') day, COUNT(*) n FROM users WHERE created_at > ? GROUP BY day ORDER BY day", Date.now() - days * DAY),
  });
});

module.exports = { router };
