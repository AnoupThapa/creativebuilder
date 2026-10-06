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
  // the product was renamed from PostForge — an old APP_NAME / MAIL_FROM left on the server must not bring it back
  appName: env.APP_NAME && !/postforge/i.test(env.APP_NAME) ? env.APP_NAME : 'PostGenX',
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
  // Posting & scheduling to Facebook / Instagram. Off for the creative-only beta; set SOCIAL_POSTING=on to bring it back.
  socialPosting: /^(on|true|1)$/i.test(env.SOCIAL_POSTING || ''),
  meta: {                                       // Facebook + Instagram publishing (Meta app)
    appId: env.META_APP_ID || '',
    appSecret: env.META_APP_SECRET || '',
    graphVersion: env.META_GRAPH_VERSION || 'v25.0',
    graphUrl: (env.META_GRAPH_URL || 'https://graph.facebook.com').replace(/\/$/, ''),
    videoUrl: (env.META_VIDEO_URL || env.META_GRAPH_URL || 'https://graph-video.facebook.com').replace(/\/$/, ''),
    dialogUrl: (env.META_DIALOG_URL || 'https://www.facebook.com').replace(/\/$/, ''),
    configId: env.META_LOGIN_CONFIG_ID || '',     // optional: "Facebook Login for Business" configuration ID
  },
  betaMode: env.BETA_MODE === 'true',           // sign-up needs an invite code
  requireAdmin2fa: env.REQUIRE_ADMIN_2FA !== 'false',
  sentryDsn: env.SENTRY_DSN || '',
  plausibleDomain: env.PLAUSIBLE_DOMAIN || '',
  demoVideoUrl: env.DEMO_VIDEO_URL || '',

  admin: {
    email: (env.ADMIN_EMAIL || '').trim().toLowerCase(),
    password: env.ADMIN_PASSWORD || '',
  },

  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    prices: {
      starter: env.STRIPE_PRICE_STARTER || '',
      pro: env.STRIPE_PRICE_PRO || '',
      business: env.STRIPE_PRICE_BUSINESS || '',
      agency: env.STRIPE_PRICE_AGENCY || '',
    },
    pricesAnnual: {
      starter: env.STRIPE_PRICE_STARTER_ANNUAL || '',
      pro: env.STRIPE_PRICE_PRO_ANNUAL || '',
      business: env.STRIPE_PRICE_BUSINESS_ANNUAL || '',
      agency: env.STRIPE_PRICE_AGENCY_ANNUAL || '',
    },
  },

  /* AI studio. Without any key the studio runs in DEMO mode (free placeholder pictures). */
  ai: {
    geminiKey: env.GEMINI_API_KEY || '',
    openaiKey: env.OPENAI_API_KEY || '',
    provider: (env.AI_IMAGE_PROVIDER || '').toLowerCase(),          // gemini | openai (default: whichever key is set)
    geminiImageModel: env.GEMINI_IMAGE_MODEL || 'gemini-3.1-flash-image',
    openaiImageModel: env.OPENAI_IMAGE_MODEL || 'gpt-image-2',
    openaiQuality: env.OPENAI_IMAGE_QUALITY || 'medium',
    dailyBudgetUsd: parseFloat(env.AI_DAILY_BUDGET_USD || '20'),      // stop all AI for the day after this much estimated spend
    jobs: Math.max(1, parseInt(env.AI_JOBS || '2', 10) || 2),         // AI jobs at the same time
    topupCredits: parseInt(env.AI_TOPUP_CREDITS || '100', 10),
    topupPriceCents: parseInt(env.AI_TOPUP_PRICE_CENTS || '1000', 10),
    veoModel: env.VEO_MODEL || 'veo-3.1-fast-generate-preview',      // or veo-3.1-lite-generate-preview (cheaper) / veo-3.1-generate-preview (best)
    videoResolution: env.AI_VIDEO_RESOLUTION || '720p',
    videoCostPerSec: parseFloat(env.AI_VIDEO_COST_PER_SEC || '0.10'), // estimate for the budget cap (Veo 3.1 Fast 720p)
    videoCredits: parseInt(env.AI_VIDEO_CREDITS || '10', 10),        // credits per video
    presenterCredits: parseInt(env.AI_PRESENTER_CREDITS || '15', 10),     // AI model presenter video, 8 s (with voice)
    presenterCredits15: parseInt(env.AI_PRESENTER_CREDITS_15 || '28', 10), // ~15 s (two parts)
    videoJobs: Math.max(1, parseInt(env.AI_VIDEO_JOBS || '1', 10) || 1),
    videoTimeoutMin: parseInt(env.AI_VIDEO_TIMEOUT_MIN || '12', 10),
    qualityCheck: env.AI_QUALITY_CHECK !== 'false',                 // inspect every AI image for lettering / damaged product
    geminiCheckModel: env.GEMINI_CHECK_MODEL || 'gemini-flash-latest',
    openaiCheckModel: env.OPENAI_CHECK_MODEL || 'gpt-5-mini',
    geminiBase: env.GEMINI_API_BASE || 'https://generativelanguage.googleapis.com',
    openaiBase: env.OPENAI_API_BASE || 'https://api.openai.com',
  },

  smtp: {
    host: env.SMTP_HOST || '',
    port: parseInt(env.SMTP_PORT || '587', 10),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: (env.MAIL_FROM || 'PostGenX <no-reply@postgenx.local>').replace(/PostForge/gi, 'PostGenX'),
  },
};
