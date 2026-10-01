'use strict';
/* Email delivery. With SMTP_* set, mail goes out through your provider
   (Brevo, Gmail SMTP, SendGrid, Mailgun, SES…). Without it, messages are printed
   to the server console and stored in the `outbox` table so you can test.
   Every message is recorded in the outbox with its delivery status:
   sent | failed | not_sent (email sending not set up) | sending. */
const config = require('./config');
const { q } = require('./db');

// Sender shown in the "From" line. Falls back to the SMTP login when it is an email address,
// because Gmail / Brevo reject a From address that isn't yours.
function fromAddress() {
  if (process.env.MAIL_FROM) return config.smtp.from;
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(config.smtp.user)) return `${config.appName} <${config.smtp.user}>`;
  return config.smtp.from;
}

let transport = null;
if (config.smtp.host) {
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
}

const status = { configured: !!transport, ok: null, error: '', checkedAt: null };

async function checkConnection() {
  if (!transport) return status;
  try { await transport.verify(); status.ok = true; status.error = ''; }
  catch (e) { status.ok = false; status.error = e.message; console.error('[mail] SMTP login failed:', e.message); }
  status.checkedAt = Date.now();
  return status;
}
if (transport && process.env.NODE_ENV !== 'test') checkConnection().then(s => { if (s.ok) console.log('[mail] email sending is ready'); });

/* Records the message, then delivers it. The outbox row is written immediately (synchronously),
   so callers that don't await still get it recorded. Never throws. */
async function sendMail(to, subject, text) {
  const id = q.run('INSERT INTO outbox (to_email, subject, body, created_at, status) VALUES (?,?,?,?,?)',
    to, subject, text, Date.now(), transport ? 'sending' : 'not_sent').lastInsertRowid;
  if (!transport) {
    if (process.env.NODE_ENV !== 'test') console.log(`\n[mail → ${to}] ${subject}\n${text}\n`);
    return false;
  }
  try {
    await transport.sendMail({ from: fromAddress(), to, subject, text });
    q.run("UPDATE outbox SET status = 'sent', error = '' WHERE id = ?", id);
    status.ok = true; status.error = '';
    return true;
  } catch (e) {
    console.error('[mail] send failed:', e.message);
    q.run("UPDATE outbox SET status = 'failed', error = ? WHERE id = ?", String(e.message).slice(0, 300), id);
    status.ok = false; status.error = e.message;
    return false;
  }
}

// Plain-English advice for the most common provider errors (shown in Platform admin → Email outbox)
function mailHint(err) {
  const e = String(err || '');
  if (!e) return '';
  if (/unauthori[sz]ed ip|\b525\b/i.test(e))
    return 'Your email provider is blocking the server\'s internet address. In Brevo: click your name (top right) → Security → Authorised IPs → turn OFF "Block unknown IP addresses" (or authorise the address shown in the alert email Brevo sent you).';
  if (/\b535\b|invalid login|username and password not accepted|authentication failed/i.test(e))
    return 'The email login was refused. Check SMTP_USER and SMTP_PASS in Fly.io → Secrets (for Brevo use the SMTP key, for Gmail an App Password).';
  if (/sender|from address|\b553\b|not verified|\b550\b/i.test(e))
    return 'The sender address was refused. MAIL_FROM must be exactly the sender address you verified with your email provider.';
  if (/timeout|timed out|econnrefused|enotfound|etimedout|greeting/i.test(e))
    return 'Could not reach the email server. Check SMTP_HOST (e.g. smtp-relay.brevo.com) and SMTP_PORT (587).';
  return 'Check the SMTP_* settings in Fly.io → Secrets.';
}

function mailStatus() {
  return { configured: status.configured, ok: status.ok, error: status.error, hint: mailHint(status.error), from: transport ? fromAddress() : '',
    host: config.smtp.host, checkedAt: status.checkedAt };
}

module.exports = { sendMail, mailStatus, checkConnection, mailHint };
