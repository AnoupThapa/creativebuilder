'use strict';
/* Error tracking.
   - Always: server and browser errors are grouped and stored in the database
     (Platform admin → Reliability → Errors), so you see problems even with no extra service.
   - Optional: set SENTRY_DSN and run `npm install @sentry/node` to also send server errors
     to Sentry (free tier is enough for a small SaaS) and get email alerts. */
const config = require('./config');

let sentry = null;
function init() {
  if (!config.sentryDsn) return;
  try {
    sentry = require('@sentry/node');
    sentry.init({ dsn: config.sentryDsn, environment: config.isProd ? 'production' : 'development', tracesSampleRate: 0, sendDefaultPii: false });
    console.log('Error tracking: Sentry enabled.');
  } catch {
    console.warn('SENTRY_DSN is set but @sentry/node is not installed. Run: npm install @sentry/node');
  }
}

function capture(err, req, ref) {
  try {
    const { q } = require('./db');
    const message = `[server] ${String(err && err.message || err).slice(0, 300)}`;
    const now = Date.now();
    const page = req ? `${req.method} ${req.originalUrl || req.url}`.slice(0, 300) : '';
    const row = q.get('SELECT id FROM client_errors WHERE message = ? AND page = ?', message, page);
    if (row) q.run('UPDATE client_errors SET count = count + 1, last_seen = ? WHERE id = ?', now, row.id);
    else q.run(`INSERT INTO client_errors (user_id, message, source, stack, page, user_agent, last_seen, created_at)
                VALUES (?,?,?,?,?,?,?,?)`, req?.user?.id || null, message, 'server ref ' + (ref || ''),
                String(err && err.stack || '').slice(0, 4000), page, String(req?.headers?.['user-agent'] || '').slice(0, 300), now, now);
  } catch { /* never let error logging throw */ }
  if (sentry) sentry.withScope(s => { if (ref) s.setTag('ref', ref); if (req?.user) s.setUser({ id: String(req.user.id) }); sentry.captureException(err); });
}

module.exports = { init, capture };
