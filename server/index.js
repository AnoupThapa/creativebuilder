'use strict';
const path = require('node:path');
const crypto = require('node:crypto');
const express = require('express');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
const { q, tx } = require('./db');
const S = require('./security');

const auth = require('./routes/auth');
const designs = require('./routes/designs');
const media = require('./routes/media');
const workspace = require('./routes/workspace');
const billing = require('./routes/billing');
const admin = require('./routes/admin');
const account = require('./routes/account');
const publicRoutes = require('./routes/public');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

/* ---------------- Security headers ---------------- */
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", ...(config.plausibleDomain ? ['https://plausible.io'] : [])],
      'style-src': ["'self'", "'unsafe-inline'"],
      'font-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'media-src': ["'self'", 'blob:', ...(/^https:\/\//.test(config.demoVideoUrl || '') ? [new URL(config.demoVideoUrl).origin] : [])],
      'connect-src': ["'self'", ...(config.plausibleDomain ? ['https://plausible.io'] : [])],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
      'object-src': ["'none'"],
      'upgrade-insecure-requests': config.isProd ? [] : null,
    },
  },
  hsts: config.isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  next();
});

/* ---------------- Rate limits ---------------- */
const limiter = (windowMin, limit, message) => rateLimit({
  windowMs: windowMin * 60 * 1000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: message },
  skip: () => process.env.NODE_ENV === 'test',
});
const apiLimiter = limiter(1, 300, 'Too many requests — slow down a little.');
const authLimiter = limiter(15, 30, 'Too many attempts from this network. Please wait 15 minutes.');
const uploadLimiter = limiter(10, 60, 'Too many uploads — please wait a few minutes.');

/* ---------------- Stripe webhook needs the raw body (before JSON parser) ---------------- */
app.post('/api/billing/webhook', express.raw({ type: 'application/json', limit: '1mb' }), billing.webhook);

app.use(express.json({ limit: '600kb' }));
app.use(S.loadSession);

/* ---------------- API ---------------- */
const api = express.Router();
api.use(apiLimiter);
api.use(S.csrfProtect);
api.use(['/auth/login', '/auth/signup', '/auth/forgot', '/auth/reset', '/auth/accept-invite', '/me/2fa', '/me/password', '/me/delete'], authLimiter);
api.post('/media', uploadLimiter);
api.post('/video/convert', uploadLimiter);
api.post('/support', limiter(15, 6, 'Too many messages — please wait a few minutes or email us.'));
api.post(['/client-error', '/pv'], limiter(1, 60, 'Slow down.'));

api.use(auth.router);
api.use(publicRoutes.router);
api.use(billing.router);             // /billing/plans is public; the rest check roles
api.use('/admin', admin.router);
api.use(S.requireAuth);              // everything below needs a signed-in user
api.use(designs.router);
api.use(media.router);
api.use(workspace.router);
api.use(account.router);
api.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use('/api', api);

/* ---------------- Media files (auth-checked) ---------------- */
app.get('/media/:id', media.serveMedia);

/* ---------------- Static assets ---------------- */
const PUB = path.join(config.ROOT, 'public');
const VIEWS = path.join(config.ROOT, 'views');
require('./fonts').mount(app);
app.use('/vendor/jszip.min.js', (req, res) => res.sendFile(require.resolve('jszip/dist/jszip.min.js')));
app.use(express.static(PUB, { index: false, maxAge: config.isProd ? '1h' : 0 }));

/* ---------------- Pages ---------------- */
const page = f => (req, res) => res.sendFile(path.join(VIEWS, f), { headers: { 'Cache-Control': 'no-store' } });
/* Home page with SEO tags filled in (canonical URL, social previews, structured data) */
const fsx = require('node:fs');
let homeCache = null;
app.get('/', (req, res) => {
  if (!homeCache || !config.isProd) {
    const { q: qq } = require('./db');
    const paid = qq.all("SELECT name, price_cents, price_cents_annual, currency FROM plans WHERE public = 1 AND active = 1 AND price_cents > 0 ORDER BY sort, price_cents");
    const ld = {
      '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: config.appName,
      applicationCategory: 'DesignApplication', operatingSystem: 'Web browser (desktop and mobile)',
      description: 'Social media post and video creator for small businesses: one photo in, every platform size out.',
      url: config.appUrl,
      offers: paid.map(p => ({ '@type': 'Offer', name: p.name, price: (p.price_cents / 100).toFixed(2), priceCurrency: (p.currency || 'usd').toUpperCase() })),
    };
    homeCache = fsx.readFileSync(path.join(VIEWS, 'index.html'), 'utf8')
      .replaceAll('{{APP_URL}}', config.appUrl.replace(/\/$/, ''))
      .replaceAll('{{APP_NAME}}', config.appName)
      .replace('{{JSON_LD}}', JSON.stringify(ld).replace(/</g, '\\u003c'));
  }
  res.set('Cache-Control', 'no-cache').type('html').send(homeCache);
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send(
  `User-agent: *\nAllow: /\nDisallow: /app\nDisallow: /editor\nDisallow: /admin\nDisallow: /api/\nDisallow: /media/\n\nSitemap: ${config.appUrl.replace(/\/$/, '')}/sitemap.xml\n`));
app.get('/sitemap.xml', (req, res) => {
  const u = config.appUrl.replace(/\/$/, ''), d = new Date().toISOString().slice(0, 10);
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    [['/', '1.0'], ['/help', '0.6'], ['/signup', '0.8'], ['/login', '0.3']].map(([p, pr]) => `  <url><loc>${u}${p}</loc><lastmod>${d}</lastmod><priority>${pr}</priority></url>`).join('\n') + '\n</urlset>\n');
});
app.use('/site', express.static(path.join(config.DATA_DIR, 'site'), { index: false, maxAge: '1d' }));
for (const p of ['/login', '/signup', '/forgot', '/reset', '/invite']) app.get(p, page('auth.html'));
app.get('/help', page('help.html'));
app.get('/app', S.pageAuth(), page('app.html'));
app.get('/editor', S.pageAuth(), page('editor.html'));
app.get('/admin', S.pageAuth({ superadmin: true }), page('admin.html'));
/* Health check for uptime monitors (UptimeRobot, Better Stack…): checks the database and disk */
app.get('/health', (req, res) => {
  const out = { ok: true, uptime: Math.round(process.uptime()) };
  try { q.get('SELECT 1 x'); out.db = 'ok'; } catch (e) { out.ok = false; out.db = 'error'; }
  try {
    const st = require('node:fs').statfsSync(config.DATA_DIR);
    out.diskFreeMb = Math.round(st.bavail * st.bsize / 1048576);
    if (out.diskFreeMb < 200) { out.ok = false; out.disk = 'low'; }
  } catch { /* statfs not available on this platform */ }
  const last = parseInt(require('./db').metaGet('last_backup') || '0', 10);
  out.lastBackupHoursAgo = last ? Math.round((Date.now() - last) / 3600000) : null;
  res.status(out.ok ? 200 : 503).set('Cache-Control', 'no-store').json(out);
});
app.use((req, res) => res.status(404).sendFile(path.join(VIEWS, '404.html')));

/* ---------------- Errors ---------------- */
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof S.HttpError) return res.status(err.status).json({ error: err.message, ...(err.extra || {}) });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request is too large.' });
  const ref = crypto.randomBytes(4).toString('hex');
  console.error(`[error ${ref}]`, err);
  require('./errors').capture(err, req, ref);
  res.status(500).json({ error: `Something went wrong (ref ${ref}). Please try again.` });
});

/* ---------------- First-run platform admin ---------------- */
async function ensureAdmin() {
  let emailAddr = config.admin.email;
  let password = config.admin.password;
  const existing = q.get('SELECT id FROM users WHERE is_superadmin = 1');
  // Lost your authenticator phone? Set ADMIN_RESET_2FA=true, restart, log in, set it up again, then remove the setting.
  if (process.env.ADMIN_RESET_2FA === 'true' && emailAddr) {
    const r = q.run('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE email = ? AND is_superadmin = 1', emailAddr.toLowerCase());
    if (r.changes) console.log(`2-step login was reset for ${emailAddr}. Remove ADMIN_RESET_2FA from settings now.`);
  }
  if (emailAddr && password) {
    const u = q.get('SELECT * FROM users WHERE email = ?', emailAddr.toLowerCase());
    if (u) {
      // The admin login in .env (set from the Control Panel) is authoritative:
      // keep that account a platform admin, active, and on the configured password.
      if (!u.is_superadmin || u.status !== 'active') q.run("UPDATE users SET is_superadmin = 1, status = 'active' WHERE id = ?", u.id);
      if (!(await S.verifyPassword(password, u.password_hash))) {
        q.run('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, email_verified = 1 WHERE id = ?', await S.hashPassword(password), u.id);
        q.run('DELETE FROM sessions WHERE user_id = ?', u.id);
        console.log(`Admin password for ${u.email} updated from settings.`);
      }
      return;
    }
  } else if (existing) {
    return;
  } else {
    emailAddr = 'admin@postforge.local';
    password = S.randomToken(12) + '7a';
    console.log('\n==============================================================');
    console.log(' No admin configured — created a platform admin account:');
    console.log(`   email:    ${emailAddr}`);
    console.log(`   password: ${password}`);
    console.log(' Change it after logging in, or set ADMIN_EMAIL / ADMIN_PASSWORD.');
    console.log('==============================================================\n');
  }
  const hash = await S.hashPassword(password);
  tx(() => {
    const now = Date.now();
    const wsId = q.run('INSERT INTO workspaces (name, created_at) VALUES (?, ?)', 'Platform Admin', now).lastInsertRowid;
    const uid = q.run(`INSERT INTO users (email, name, password_hash, workspace_id, role, is_superadmin, email_verified, created_at)
                       VALUES (?,?,?,?,?,1,1,?)`, emailAddr.toLowerCase(), 'Platform Admin', hash, wsId, 'owner', now).lastInsertRowid;
    q.run(`UPDATE workspaces SET owner_id = ?, plan_code = 'pro', seats = 5, sub_status = 'active', billing_mode = 'comp',
           current_period_end = ? WHERE id = ?`, uid, now + 3650 * 86400000, wsId);
  });
}

if (require.main === module) {
  process.on('unhandledRejection', e => console.error('[unhandled]', e));
  require('./errors').init();
  require('./backup').schedule();
  ensureAdmin().then(() => {
    app.listen(config.port, () => {
      console.log(`${config.appName} running at ${config.appUrl}  (${config.isProd ? 'production' : 'development'})`);
      if (config.requireAdmin2fa) console.log('Admin area requires 2-step login (set REQUIRE_ADMIN_2FA=false to disable, not recommended).');
      console.log(`Billing mode: ${config.stripe.secretKey ? 'Stripe' : 'DEMO (no payments taken)'} · Email: ${config.smtp.host ? 'SMTP' : 'console'}`);
    });
  });
}

module.exports = { app, ensureAdmin };
