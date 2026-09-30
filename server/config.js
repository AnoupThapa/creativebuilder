'use strict';
/* Central configuration. Values come from environment variables or a
   .env file in the project root (loaded with Node's built-in loader). */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  try { process.loadEnvFile(envFile); } catch (e) { console.warn('Could not read .env:', e.message); }
}

const env = process.env;
const isProd = env.NODE_ENV === 'production';
const DATA_DIR = path.resolve(ROOT, env.DATA_DIR || 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

/* APP_SECRET encrypts 2FA secrets at rest. In production it must be set;
   in development one is generated once and kept in data/.secret. */
function loadSecret() {
  if (env.APP_SECRET && env.APP_SECRET.length >= 32) return env.APP_SECRET;
  if (isProd) {
    console.error('FATAL: APP_SECRET (32+ random characters) must be set in production.');
    process.exit(1);
  }
  const f = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  return s;
}

const port = parseInt(env.PORT || '3000', 10);

module.exports = {
  ROOT,
  DATA_DIR,
  UPLOAD_DIR: path.join(DATA_DIR, 'uploads'),
  DB_FILE: path.join(DATA_DIR, 'postforge.db'),
  isProd,
  port,
  appUrl: (env.APP_URL || `http://localhost:${port}`).replace(/\/$/, ''),
  appName: env.APP_NAME || 'PostForge',
  appSecret: loadSecret(),
  trustProxy: env.TRUST_PROXY ? (isNaN(+env.TRUST_PROXY) ? env.TRUST_PROXY : +env.TRUST_PROXY) : false,

  session: {
    cookieName: isProd ? '__Host-pf_sid' : 'pf_sid',
    idleMs: 7 * 24 * 3600 * 1000,       // log out after 7 days of inactivity
    absoluteMs: 30 * 24 * 3600 * 1000,  // and always after 30 days
  },
  security: {
    bcryptRounds: 12,
    maxFailedLogins: 5,
    lockMinutes: 15,
    requireVerifiedEmailToExport: env.REQUIRE_VERIFIED_EMAIL !== 'false',
  },

  support: {
    email: env.SUPPORT_EMAIL || '',              // where support requests are sent
    whatsapp: (env.SUPPORT_WHATSAPP || '').replace(/[^\d]/g, ''), // e.g. 9779800000000 (country code, no +)
  },
  betaMode: env.BETA_MODE === 'true',           // sign-up needs an invite code
  requireAdmin2fa: env.REQUIRE_ADMIN_2FA !== 'false',
  sentryDsn: env.SENTRY_DSN || '',
  plausibleDomain: env.PLAUSIBLE_DOMAIN || '',
  demoVideoUrl: env.DEMO_VIDEO_URL || '',

  admin: {
    email: env.ADMIN_EMAIL || '',
    password: env.ADMIN_PASSWORD || '',
  },

  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    prices: {
      starter: env.STRIPE_PRICE_STARTER || '',
      pro: env.STRIPE_PRICE_PRO || '',
    },
    pricesAnnual: {
      starter: env.STRIPE_PRICE_STARTER_ANNUAL || '',
      pro: env.STRIPE_PRICE_PRO_ANNUAL || '',
    },
  },

  smtp: {
    host: env.SMTP_HOST || '',
    port: parseInt(env.SMTP_PORT || '587', 10),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'PostForge <no-reply@postforge.local>',
  },
};
