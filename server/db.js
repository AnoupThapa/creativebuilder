'use strict';
/* SQLite storage using Node's built-in driver (node:sqlite) — no native
   add-ons to compile. All queries are parameterised. */
const { DatabaseSync } = require('node:sqlite');
const config = require('./config');

const db = new DatabaseSync(process.env.DB_FILE_OVERRIDE || config.DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS plans (
  code              TEXT PRIMARY KEY,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  price_cents       INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'usd',
  quota_limit       INTEGER NOT NULL,             -- exports allowed per period, per user
  quota_period      TEXT NOT NULL CHECK (quota_period IN ('day','month','lifetime')),
  max_quality       INTEGER NOT NULL DEFAULT 1,   -- 1x / 2x / 3x export multiplier
  video_export      INTEGER NOT NULL DEFAULT 0,
  batch_export      INTEGER NOT NULL DEFAULT 0,
  premium_templates INTEGER NOT NULL DEFAULT 0,
  watermark         INTEGER NOT NULL DEFAULT 0,
  max_designs       INTEGER NOT NULL DEFAULT -1,  -- -1 = unlimited (per workspace)
  max_brand_kits    INTEGER NOT NULL DEFAULT 1,
  max_upload_mb     INTEGER NOT NULL DEFAULT 10,
  storage_mb        INTEGER NOT NULL DEFAULT 200,
  public            INTEGER NOT NULL DEFAULT 1,   -- shown on pricing page / purchasable
  active            INTEGER NOT NULL DEFAULT 1,
  sort              INTEGER NOT NULL DEFAULT 0,
  stripe_price_id   TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS workspaces (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  name                   TEXT NOT NULL,
  owner_id               INTEGER,
  plan_code              TEXT NOT NULL DEFAULT 'free' REFERENCES plans(code),
  seats                  INTEGER NOT NULL DEFAULT 1,
  sub_status             TEXT NOT NULL DEFAULT 'none',  -- none|active|trialing|past_due|canceled
  current_period_end     INTEGER,
  cancel_at_period_end   INTEGER NOT NULL DEFAULT 0,
  billing_mode           TEXT NOT NULL DEFAULT 'none',  -- none|stripe|demo|comp
  stripe_customer_id     TEXT,
  stripe_subscription_id TEXT,
  created_at             INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  workspace_id   INTEGER NOT NULL REFERENCES workspaces(id),
  role           TEXT NOT NULL CHECK (role IN ('owner','admin','designer','viewer')),
  is_superadmin  INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'active',        -- active|suspended|removed
  email_verified INTEGER NOT NULL DEFAULT 0,
  timezone       TEXT NOT NULL DEFAULT 'UTC',
  totp_secret    TEXT,
  totp_enabled   INTEGER NOT NULL DEFAULT 0,
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   INTEGER,
  created_at     INTEGER NOT NULL,
  last_login_at  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_users_ws ON users(workspace_id);

CREATE TABLE IF NOT EXISTS sessions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash  TEXT NOT NULL UNIQUE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf        TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  last_seen   INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL,
  ip          TEXT,
  user_agent  TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash  TEXT PRIMARY KEY,
  type        TEXT NOT NULL,             -- verify|reset|invite
  user_id     INTEGER,
  data        TEXT NOT NULL DEFAULT '{}',
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id           TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  owner_id     INTEGER NOT NULL REFERENCES users(id),
  filename     TEXT NOT NULL,
  mime         TEXT NOT NULL,
  kind         TEXT NOT NULL,            -- image|video
  size         INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_ws ON media(workspace_id);

CREATE TABLE IF NOT EXISTS designs (
  id           TEXT PRIMARY KEY,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id),
  owner_id     INTEGER NOT NULL REFERENCES users(id),
  name         TEXT NOT NULL,
  data         TEXT NOT NULL DEFAULT '{}',
  thumbnail    TEXT,
  visibility   TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','team_view','team_edit')),
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_designs_ws ON designs(workspace_id, deleted_at);

CREATE TABLE IF NOT EXISTS brand_kits (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  INTEGER NOT NULL REFERENCES workspaces(id),
  name          TEXT NOT NULL,
  color         TEXT NOT NULL DEFAULT '#ff6b4a',
  phone         TEXT NOT NULL DEFAULT '',
  website       TEXT NOT NULL DEFAULT '',
  logo_media_id TEXT,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS exports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id),
  workspace_id INTEGER NOT NULL,
  design_id    TEXT,
  platform     TEXT NOT NULL,
  kind         TEXT NOT NULL,            -- image|video
  quality      INTEGER NOT NULL,
  plan_code    TEXT NOT NULL,
  local_day    TEXT NOT NULL,            -- YYYY-MM-DD in the user's timezone
  local_month  TEXT NOT NULL,            -- YYYY-MM
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_exports_user_day ON exports(user_id, local_day);
CREATE INDEX IF NOT EXISTS idx_exports_user_month ON exports(user_id, local_month);

CREATE TABLE IF NOT EXISTS audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,
  workspace_id INTEGER,
  action       TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '{}',
  ip           TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);

CREATE TABLE IF NOT EXISTS outbox (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email   TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

/* ---------- tiny query helpers ---------- */
const cache = new Map();
function stmt(sql) {
  let s = cache.get(sql);
  if (!s) { s = db.prepare(sql); cache.set(sql, s); }
  return s;
}
const q = {
  get: (sql, ...p) => stmt(sql).get(...p),
  all: (sql, ...p) => stmt(sql).all(...p),
  run: (sql, ...p) => stmt(sql).run(...p),
  iterate: (sql, ...p) => stmt(sql).iterate(...p),
};

/* Serialised write transaction. BEGIN IMMEDIATE takes the write lock up
   front so quota checks + inserts can't race each other. */
function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}

/* ---------- seed plans (only inserted if missing; admins edit them later) ---------- */
db.exec(`
CREATE TABLE IF NOT EXISTS support_tickets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  name       TEXT NOT NULL,
  email      TEXT NOT NULL,
  topic      TEXT NOT NULL,
  message    TEXT NOT NULL,
  page       TEXT,
  status     TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS feedback (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER,
  workspace_id INTEGER,
  rating       INTEGER NOT NULL,
  message      TEXT NOT NULL DEFAULT '',
  allow_quote  INTEGER NOT NULL DEFAULT 0,
  display_name TEXT NOT NULL DEFAULT '',
  business     TEXT NOT NULL DEFAULT '',
  approved     INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS beta_codes (
  code        TEXT PRIMARY KEY COLLATE NOCASE,
  note        TEXT NOT NULL DEFAULT '',
  max_uses    INTEGER NOT NULL DEFAULT 1,
  uses        INTEGER NOT NULL DEFAULT 0,
  plan_code   TEXT NOT NULL DEFAULT 'pro',
  plan_days   INTEGER NOT NULL DEFAULT 60,
  expires_at  INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS client_errors (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER,
  message    TEXT NOT NULL,
  source     TEXT,
  stack      TEXT,
  page       TEXT,
  user_agent TEXT,
  count      INTEGER NOT NULL DEFAULT 1,
  last_seen  INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS page_views (
  day      TEXT NOT NULL,
  path     TEXT NOT NULL,
  referrer TEXT NOT NULL DEFAULT '',
  views    INTEGER NOT NULL DEFAULT 0,
  visitors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, referrer)
);
CREATE TABLE IF NOT EXISTS social_accounts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  platform     TEXT NOT NULL,              -- facebook | instagram
  external_id  TEXT NOT NULL,              -- Facebook Page id / Instagram account id
  name         TEXT NOT NULL DEFAULT '',
  username     TEXT NOT NULL DEFAULT '',
  picture      TEXT NOT NULL DEFAULT '',
  parent_id    TEXT NOT NULL DEFAULT '',   -- for Instagram: the linked Facebook Page id
  token_enc    TEXT NOT NULL DEFAULT '',   -- encrypted Page access token
  demo         INTEGER NOT NULL DEFAULT 0,
  status       TEXT NOT NULL DEFAULT 'active',
  last_error   TEXT NOT NULL DEFAULT '',
  connected_by INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  UNIQUE (workspace_id, platform, external_id)
);
CREATE TABLE IF NOT EXISTS social_posts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL,
  user_id      INTEGER,
  design_id    TEXT,
  design_name  TEXT NOT NULL DEFAULT '',
  kind         TEXT NOT NULL,              -- image | video
  file         TEXT NOT NULL,              -- random file name in DATA_DIR/social
  mime         TEXT NOT NULL,
  width        INTEGER NOT NULL DEFAULT 0,
  height       INTEGER NOT NULL DEFAULT 0,
  caption      TEXT NOT NULL DEFAULT '',
  ig_placement TEXT NOT NULL DEFAULT 'feed',
  scheduled_at INTEGER,
  status       TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | publishing | published | partial | failed | cancelled
  created_at   INTEGER NOT NULL,
  published_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_social_posts_due ON social_posts(status, scheduled_at);
CREATE TABLE IF NOT EXISTS social_post_targets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id    INTEGER NOT NULL,
  account_id INTEGER NOT NULL,
  platform   TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending',   -- pending | publishing | published | failed
  remote_id  TEXT NOT NULL DEFAULT '',
  permalink  TEXT NOT NULL DEFAULT '',
  error      TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_states (
  state        TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  workspace_id INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS site_examples (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  industry    TEXT NOT NULL DEFAULT '',
  caption     TEXT NOT NULL DEFAULT '',
  before_file TEXT NOT NULL,
  after_file  TEXT NOT NULL,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
`);

/* ---------- schema migrations (safe to run on every start) ---------- */
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
function hasColumn(table, col) { return db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col); }
function addColumn(table, col, def) { if (!hasColumn(table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`); }
addColumn('plans', 'daily_limit', 'INTEGER NOT NULL DEFAULT 0');              // extra per-day cap (0 = none)
addColumn('plans', 'price_cents_annual', 'INTEGER NOT NULL DEFAULT 0');       // yearly price (0 = no annual option)
addColumn('plans', 'stripe_price_id_annual', "TEXT NOT NULL DEFAULT ''");
addColumn('workspaces', 'billing_interval', "TEXT NOT NULL DEFAULT 'month'"); // month | year
addColumn('outbox', 'status', "TEXT NOT NULL DEFAULT 'not_sent'");          // sent | failed | not_sent | sending
addColumn('outbox', 'error', "TEXT NOT NULL DEFAULT ''");
/* AI studio */
addColumn('plans', 'ai_credits_monthly', 'INTEGER NOT NULL DEFAULT 0');    // AI credits per seat per month
addColumn('plans', 'ai_credits_lifetime', 'INTEGER NOT NULL DEFAULT 0');   // one-off AI credits per user (free tier)
addColumn('plans', 'ai_video', 'INTEGER NOT NULL DEFAULT 0');           // AI product videos (Pro, Business)
addColumn('plans', 'max_video_seconds', 'INTEGER NOT NULL DEFAULT 0');  // longest own video allowed (0 = no limit)
addColumn('plans', 'max_video_mb', 'INTEGER NOT NULL DEFAULT 0');       // biggest own video file (0 = same as max_upload_mb)
/* Retail vs Business (B2B) profiles */
addColumn('workspaces', 'account_type', "TEXT NOT NULL DEFAULT 'retail'");  // retail | business
addColumn('plans', 'audience', "TEXT NOT NULL DEFAULT 'both'");              // retail | business | both (which pricing page shows it)
addColumn('brand_kits', 'colors', "TEXT NOT NULL DEFAULT '[]'");           // extra palette colours (#hex)
addColumn('brand_kits', 'font_heading', "TEXT NOT NULL DEFAULT ''");
addColumn('brand_kits', 'font_body', "TEXT NOT NULL DEFAULT ''");
addColumn('brand_kits', 'tagline', "TEXT NOT NULL DEFAULT ''");
addColumn('brand_kits', 'email', "TEXT NOT NULL DEFAULT ''");
addColumn('brand_kits', 'address', "TEXT NOT NULL DEFAULT ''");
addColumn('brand_kits', 'socials', "TEXT NOT NULL DEFAULT '{}'");          // {instagram, facebook, tiktok, linkedin, youtube, x, whatsapp}
addColumn('designs', 'brand_kit_id', 'INTEGER');                           // which brand / client the design belongs to
addColumn('users', 'client_brand_id', 'INTEGER');                          // set = client viewer who only sees this brand
addColumn('audit_log', 'prev_hash', "TEXT NOT NULL DEFAULT ''");          // tamper-evident chain
addColumn('audit_log', 'hash', "TEXT NOT NULL DEFAULT ''");
/* Phase 3: white-label review portal, developer API, embeddable widget */
addColumn('plans', 'api_access', 'INTEGER NOT NULL DEFAULT 0');            // developer API + website widget
addColumn('workspaces', 'portal_name', "TEXT NOT NULL DEFAULT ''");         // white-label review portal
addColumn('workspaces', 'portal_color', "TEXT NOT NULL DEFAULT ''");
addColumn('workspaces', 'portal_logo_media_id', 'TEXT');
addColumn('designs', 'review_status', "TEXT NOT NULL DEFAULT ''");         // '' | in_review | approved | changes
addColumn('designs', 'review_updated_at', 'INTEGER');
db.exec(`
CREATE TABLE IF NOT EXISTS review_links (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  INTEGER NOT NULL,
  brand_kit_id  INTEGER NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  token_enc     TEXT NOT NULL,                 -- encrypted so the agency can copy the link again
  created_by    INTEGER,
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER,
  revoked_at    INTEGER,
  last_opened_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_review_links_ws ON review_links(workspace_id, brand_kit_id);
CREATE TABLE IF NOT EXISTS review_snapshots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id    TEXT NOT NULL,
  workspace_id INTEGER NOT NULL,
  platform     TEXT NOT NULL,
  file         TEXT NOT NULL,
  width        INTEGER NOT NULL,
  height       INTEGER NOT NULL,
  bytes        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  UNIQUE(design_id, platform)
);
CREATE TABLE IF NOT EXISTS review_comments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  design_id    TEXT NOT NULL,
  workspace_id INTEGER NOT NULL,
  author_type  TEXT NOT NULL,                 -- agency | client
  author_name  TEXT NOT NULL DEFAULT '',
  user_id      INTEGER,
  action       TEXT NOT NULL DEFAULT '',      -- '' | sent | approved | changes
  body         TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_comments ON review_comments(design_id, id);
CREATE TABLE IF NOT EXISTS api_keys (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id  INTEGER NOT NULL,
  user_id       INTEGER NOT NULL,             -- the API acts as this person (their download allowance)
  kind          TEXT NOT NULL,                -- secret | publishable
  name          TEXT NOT NULL DEFAULT '',
  prefix        TEXT NOT NULL,
  key_hash      TEXT NOT NULL UNIQUE,
  key_enc       TEXT,                         -- publishable keys only (safe to show again)
  origins       TEXT NOT NULL DEFAULT '[]',   -- websites allowed to embed the widget
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER,
  revoked_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_ws ON api_keys(workspace_id);
`);
addColumn('workspaces', 'ai_topup_credits', 'INTEGER NOT NULL DEFAULT 0'); // bought credit packs (never expire)
db.exec(`
CREATE TABLE IF NOT EXISTS ai_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  key         TEXT NOT NULL UNIQUE,
  industry    TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'image',      -- image | video
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  emoji       TEXT NOT NULL DEFAULT '✨',
  prompt      TEXT NOT NULL,
  needs_photo INTEGER NOT NULL DEFAULT 0,         -- 1 = only with the real product photo (e.g. food)
  text_space  TEXT NOT NULL DEFAULT 'top',        -- where to leave clean space for the editor's text
  setting     TEXT NOT NULL DEFAULT '',           -- default scene when the user gives none
  active      INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS ai_jobs (
  id            TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  workspace_id  INTEGER NOT NULL,
  template_key  TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'image',
  status        TEXT NOT NULL,                   -- queued | running | done | failed
  provider      TEXT NOT NULL DEFAULT '',
  model         TEXT NOT NULL DEFAULT '',
  inputs        TEXT NOT NULL DEFAULT '{}',      -- what the user typed (no secrets)
  prompt        TEXT NOT NULL DEFAULT '',
  aspect        TEXT NOT NULL DEFAULT '4:5',
  count         INTEGER NOT NULL DEFAULT 1,
  outputs       TEXT NOT NULL DEFAULT '[]',      -- file names
  credits       INTEGER NOT NULL DEFAULT 0,
  credits_topup INTEGER NOT NULL DEFAULT 0,      -- how many of the credits came from bought packs
  local_month   TEXT NOT NULL,
  cost_usd      REAL NOT NULL DEFAULT 0,         -- estimated provider cost
  error         TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  finished_at   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_ws ON ai_jobs(workspace_id, local_month);
CREATE INDEX IF NOT EXISTS idx_ai_jobs_user ON ai_jobs(user_id, created_at);
`);
addColumn('ai_jobs', 'redone', 'INTEGER NOT NULL DEFAULT 0');  // images the quality check rejected and made again
addColumn('ai_jobs', 'remote_op', "TEXT NOT NULL DEFAULT ''");  // video: the AI service's job name, so waiting can resume after a restart
addColumn('ai_jobs', 'rejected', 'INTEGER NOT NULL DEFAULT 0'); // images still failing after the retry (not delivered, refunded)
const metaGet = k => q.get('SELECT value FROM meta WHERE key = ?', k)?.value;
const metaSet = (k, v) => q.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));

/* ---------- seed plans (only inserted if missing; admins edit them later) ---------- */
const SEED_PLANS = [
  { code: 'free', name: 'Free trial', description: 'Try every tool: 5 watermarked downloads and 5 AI photos to test the app.',
    price_cents: 0, price_cents_annual: 0, currency: 'usd', quota_limit: 5, quota_period: 'lifetime', daily_limit: 0, max_quality: 1, video_export: 0, batch_export: 0,
    premium_templates: 0, watermark: 1, max_designs: 5, max_brand_kits: 1, max_upload_mb: 10, storage_mb: 100, public: 1, sort: 0,
    ai_credits_monthly: 0, ai_credits_lifetime: 5 },
  { code: 'starter', name: 'Starter', description: 'Post every day: 5 a day, up to 100 a month, your own videos up to 30 s, plus 40 AI images.',
    price_cents: 900, price_cents_annual: 9000, currency: 'usd', quota_limit: 100, quota_period: 'month', daily_limit: 5, max_quality: 2, video_export: 1, batch_export: 1,
    premium_templates: 1, watermark: 0, max_designs: 200, max_brand_kits: 1, max_upload_mb: 15, storage_mb: 1024, public: 1, sort: 1,
    ai_credits_monthly: 40, ai_credits_lifetime: 0, max_video_seconds: 30, max_video_mb: 50 },
  { code: 'pro', name: 'Pro', description: 'For busy businesses: 15 a day, up to 300 a month, 150 AI credits, AI videos and AI model presenters.',
    price_cents: 2400, price_cents_annual: 24000, currency: 'usd', quota_limit: 300, quota_period: 'month', daily_limit: 15, max_quality: 3, video_export: 1, batch_export: 1,
    premium_templates: 1, watermark: 0, max_designs: -1, max_brand_kits: 5, max_upload_mb: 100, storage_mb: 5120, public: 1, sort: 2,
    ai_credits_monthly: 150, ai_credits_lifetime: 0, ai_video: 1 },
  { code: 'business', name: 'Business', description: 'For multi-store brands and wholesalers: 50 a day, up to 1,000 a month, 400 AI credits, developer API and website widget.',
    price_cents: 5900, price_cents_annual: 59000, currency: 'usd', quota_limit: 1000, quota_period: 'month', daily_limit: 50, max_quality: 3, video_export: 1, batch_export: 1,
    premium_templates: 1, watermark: 0, max_designs: -1, max_brand_kits: 20, max_upload_mb: 200, storage_mb: 20480, public: 1, sort: 3,
    ai_credits_monthly: 400, ai_credits_lifetime: 0, ai_video: 1, api_access: 1 },
  { code: 'agency', name: 'Agency', description: 'For agencies managing many brands: up to 50 client brands, white-label client review portal, 800 AI credits.',
    price_cents: 11900, price_cents_annual: 119000, currency: 'usd', quota_limit: 2000, quota_period: 'month', daily_limit: 100, max_quality: 3, video_export: 1, batch_export: 1,
    premium_templates: 1, watermark: 0, max_designs: -1, max_brand_kits: 50, max_upload_mb: 500, storage_mb: 51200, public: 1, sort: 4,
    ai_credits_monthly: 800, ai_credits_lifetime: 0, ai_video: 1, audience: 'business', api_access: 1 },
];
for (const p of SEED_PLANS) {
  const exists = q.get('SELECT code FROM plans WHERE code = ?', p.code);
  if (!exists) {
    const cols = Object.keys(p);
    q.run(`INSERT INTO plans (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`, ...cols.map(c => p[c]));
  }
}
/* One-time launch pricing update for databases created before pricing v2 */
if (!metaGet('pricing_v2')) {
  for (const p of SEED_PLANS) {
    q.run(`UPDATE plans SET description = ?, price_cents = ?, price_cents_annual = ?, currency = ?, quota_limit = ?, quota_period = ?,
           daily_limit = ? WHERE code = ?`, p.description, p.price_cents, p.price_cents_annual, p.currency, p.quota_limit, p.quota_period, p.daily_limit, p.code);
  }
  metaSet('pricing_v2', Date.now());
}
/* One-time pricing v3: AI credits included in every plan, new Business plan */
if (!metaGet('pricing_v3_ai')) {
  for (const p of SEED_PLANS) {
    q.run(`UPDATE plans SET description = ?, price_cents = ?, price_cents_annual = ?, ai_credits_monthly = ?, ai_credits_lifetime = ? WHERE code = ?`,
      p.description, p.price_cents, p.price_cents_annual, p.ai_credits_monthly, p.ai_credits_lifetime, p.code);
  }
  metaSet('pricing_v3_ai', Date.now());
}
/* One-time: Starter can use its own videos (up to 30 s / 50 MB); AI videos stay on Pro & Business */
if (!metaGet('starter_video_v1')) {
  q.run("UPDATE plans SET video_export = 1, max_video_seconds = 30, max_video_mb = 50 WHERE code = 'starter'");
  q.run("UPDATE plans SET description = ? WHERE code = 'starter' AND description = ?", 'Post every day: 5 a day, up to 100 a month, your own videos up to 30 s, plus 40 AI images.', 'Post every day: 5 images a day, up to 100 a month, plus 40 AI images.');
  q.run("UPDATE plans SET ai_video = 1 WHERE code IN ('pro', 'business')");
  metaSet('starter_video_v1', Date.now());
}
/* One-time: developer API + widget on Business and Agency */
if (!metaGet('api_access_v1')) {
  q.run("UPDATE plans SET api_access = 1 WHERE code IN ('business', 'agency')");
  metaSet('api_access_v1', Date.now());
}
/* One-time pricing v4 (Oct 2026): lower prices after a competitor review, more generous free trial,
   AI credits sized so every plan stays profitable even when all credits are used */
if (!metaGet('pricing_v4')) {
  for (const p of SEED_PLANS) {
    q.run(`UPDATE plans SET description = ?, price_cents = ?, price_cents_annual = ?, quota_limit = ?, ai_credits_monthly = ?, ai_credits_lifetime = ? WHERE code = ?`,
      p.description, p.price_cents, p.price_cents_annual, p.quota_limit, p.ai_credits_monthly, p.ai_credits_lifetime, p.code);
  }
  metaSet('pricing_v4', Date.now());
}
/* One-time: which pricing page each plan appears on */
if (!metaGet('audience_v1')) {
  q.run("UPDATE plans SET audience = 'retail' WHERE code = 'starter'");
  q.run("UPDATE plans SET audience = 'business' WHERE code = 'agency'");
  metaSet('audience_v1', Date.now());
}
// Stripe price IDs from env override whatever is stored
for (const [code, price] of Object.entries(config.stripe.prices)) {
  if (price) q.run('UPDATE plans SET stripe_price_id = ? WHERE code = ?', price, code);
}
for (const [code, price] of Object.entries(config.stripe.pricesAnnual || {})) {
  if (price) q.run('UPDATE plans SET stripe_price_id_annual = ? WHERE code = ?', price, code);
}

/* ---------- housekeeping ---------- */
function cleanup() {
  const now = Date.now();
  q.run('DELETE FROM sessions WHERE expires_at < ?', now);
  q.run('DELETE FROM tokens WHERE expires_at < ?', now - 7 * 86400000);
}
cleanup();
setInterval(cleanup, 3600 * 1000).unref();

module.exports = { db, q, tx, metaGet, metaSet, hasColumn };
