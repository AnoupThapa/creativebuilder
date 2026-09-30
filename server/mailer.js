'use strict';
/* Email delivery. With SMTP_* set, mail goes out through your provider
   (SendGrid, Mailgun, SES, Gmail SMTP…). Without it, messages are printed
   to the server console and stored in the `outbox` table so you can test. */
const config = require('./config');
const { q } = require('./db');

let transport = null;
if (config.smtp.host) {
  const nodemailer = require('nodemailer');
  transport = nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
  });
}

async function sendMail(to, subject, text) {
  q.run('INSERT INTO outbox (to_email, subject, body, created_at) VALUES (?,?,?,?)', to, subject, text, Date.now());
  if (transport) {
    try {
      await transport.sendMail({ from: config.smtp.from, to, subject, text });
    } catch (e) {
      console.error('[mail] send failed:', e.message);
    }
  } else if (process.env.NODE_ENV !== 'test') {
    console.log(`\n[mail → ${to}] ${subject}\n${text}\n`);
  }
}

module.exports = { sendMail };
