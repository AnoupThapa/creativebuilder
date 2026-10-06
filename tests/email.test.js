'use strict';
/* Password reset / invite emails really reach each person's own inbox.
   A tiny fake mail server (SMTP) records who every email was delivered to. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const test = require('node:test');
const assert = require('node:assert/strict');

/* ---- fake SMTP server ---- */
const inbox = []; // { to: [..], data }
const smtp = net.createServer(sock => {
  let msg = { to: [] }, inData = false, buf = '';
  sock.write('220 fake ESMTP\r\n');
  sock.on('data', chunk => {
    buf += chunk.toString('utf8');
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') { inData = false; inbox.push(msg); msg = { to: [] }; sock.write('250 OK queued\r\n'); }
        else msg.data = (msg.data || '') + line.replace(/^\.\./, '.') + '\n';
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250-fake\r\n250 8BITMIME\r\n');
      else if (cmd === 'MAIL') { msg.from = line; sock.write('250 OK\r\n'); }
      else if (cmd === 'RCPT') { msg.to.push(line.match(/<([^>]+)>/)[1].toLowerCase()); sock.write('250 OK\r\n'); }
      else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') { sock.end('221 bye\r\n'); }
      else sock.write('250 OK\r\n');
    }
  });
  sock.on('error', () => {});
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-mail-'));
let app, ensureAdmin, q, hotp, base, server;

function client() {
  let cookie = '', csrf = '';
  const call = async (method, url, body) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const v = c.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const text = await res.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b), me: () => call('GET', '/api/me') };
}
const wait = ms => new Promise(r => setTimeout(r, ms));
async function mailTo(email, subjectRe, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const m = [...inbox].reverse().find(x => x.to.includes(email) && subjectRe.test(x.data));
    if (m) return m;
    await wait(50);
  }
  throw new Error(`no email to ${email} matching ${subjectRe}`);
}
const decodeQP = t => t.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
const tokenIn = m => new URL(decodeQP(m.data).match(/https?:\/\/\S+token=[A-Za-z0-9_-]+/)[0]).searchParams.get('token');

test.before(async () => {
  await new Promise(r => smtp.listen(0, '127.0.0.1', r));
  Object.assign(process.env, {
    DATA_DIR: tmp, NODE_ENV: 'test', ADMIN_EMAIL: 'Root@Example.com', ADMIN_PASSWORD: 'RootPassword123',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), MAIL_FROM: 'PostGenX <hello@example.com>', BETA_MODE: 'true',
  });
  ({ app, ensureAdmin } = require('../server/index.js'));
  ({ q } = require('../server/db.js'));
  ({ hotp } = require('../server/security.js'));
  await ensureAdmin();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); smtp.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

async function adminClient() {
  const a = client();
  const u = q.get("SELECT id FROM users WHERE lower(email) = 'root@example.com'");
  const { encrypt } = require('../server/security.js');
  q.run('UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?', encrypt('JBSWY3DPEHPK3PXP'), u.id);
  const r = await a.post('/api/auth/login', { email: 'root@example.com', password: 'RootPassword123', totp: hotp('JBSWY3DPEHPK3PXP', Math.floor(Date.now() / 30000)) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await a.me();
  return a;
}

let admin, friend;
test('friend signs up with an invite code; confirmation email goes to their own address', async () => {
  admin = await adminClient();
  let r = await admin.post('/api/admin/beta-codes', { code: 'FRIENDS7', max_uses: 5, plan_code: 'pro', plan_days: 4 });
  assert.equal(r.status, 201);
  friend = client();
  r = await friend.post('/api/auth/signup', { name: 'Sita', business: 'Sita Bakery', email: 'Sita.Friend@Gmail.com', password: 'FriendPass2026', acceptTerms: true, betaCode: 'FRIENDS7' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const m = await mailTo('sita.friend@gmail.com', /Confirm your/);
  assert.match(m.from, /hello@example\.com/, 'sent from MAIL_FROM');
  r = await friend.get('/api/auth/verify?token=' + tokenIn(m));
  assert.ok([200, 302, 303].includes(r.status));
  assert.equal((await friend.me()).data.user.email_verified, true);
});

test('forgot password: reset email reaches the friend, new password works, old one does not', async () => {
  const anon = client();
  let r = await anon.post('/api/auth/forgot', { email: '  SITA.friend@gmail.com ' });
  assert.equal(r.status, 200);
  const first = await mailTo('sita.friend@gmail.com', /Reset your/);
  // asking twice: only the newest link works
  await anon.post('/api/auth/forgot', { email: 'sita.friend@gmail.com' });
  await wait(300);
  const all = inbox.filter(x => x.to.includes('sita.friend@gmail.com') && /Reset your/.test(x.data));
  assert.equal(all.length, 2);
  const oldTok = tokenIn(all[0]), newTok = tokenIn(all[1]);
  assert.equal((await anon.get('/api/auth/reset-check?token=' + oldTok)).status, 400, 'older link stops working');
  r = await anon.get('/api/auth/reset-check?token=' + newTok);
  assert.equal(r.status, 200);
  assert.equal(r.data.email, 'sita.friend@gmail.com');
  r = await anon.post('/api/auth/reset', { token: newTok, password: 'NewFriendPass77' });
  assert.equal(r.status, 200);
  assert.equal((await friend.me()).status, 401, 'signed out everywhere');
  assert.equal((await client().post('/api/auth/login', { email: 'sita.friend@gmail.com', password: 'FriendPass2026' })).status, 401);
  friend = client();
  r = await friend.post('/api/auth/login', { email: 'sita.friend@gmail.com', password: 'NewFriendPass77' });
  assert.equal(r.status, 200);
  assert.equal(first.to.length, 1, 'sent only to that person');
});

test('change password while logged in', async () => {
  await friend.me();
  let r = await friend.post('/api/me/password', { current: 'wrong-one-123', password: 'ChangedPass88' });
  assert.equal(r.status, 400);
  r = await friend.post('/api/me/password', { current: 'NewFriendPass77', password: 'ChangedPass88' });
  assert.equal(r.status, 200);
  assert.equal((await client().post('/api/auth/login', { email: 'sita.friend@gmail.com', password: 'ChangedPass88' })).status, 200);
});

test('team invite link: invitee who never joined gets a fresh invite from "Forgot password"', async () => {
  const sql = require('../server/db.js').q;
  const ws = sql.get("SELECT workspace_id FROM users WHERE email = 'sita.friend@gmail.com'").workspace_id;
  sql.run('UPDATE workspaces SET seats = 3 WHERE id = ?', ws);
  await friend.me();
  let r = await friend.post('/api/team/invite', { email: 'ram.helper@outlook.com', role: 'designer' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const inv = await mailTo('ram.helper@outlook.com', /invited you/);
  const oldTok = tokenIn(inv);
  // Ram loses the email and tries "Forgot password"
  r = await client().post('/api/auth/forgot', { email: 'ram.helper@outlook.com' });
  assert.equal(r.status, 200);
  const fresh = await mailTo('ram.helper@outlook.com', /Your invite to/);
  const newTok = tokenIn(fresh);
  assert.equal((await client().get('/api/auth/invite?token=' + oldTok)).status, 404, 'old invite link replaced');
  const ram = client();
  r = await ram.post('/api/auth/accept-invite', { token: newTok, name: 'Ram', password: 'RamPassword99' });
  assert.equal(r.status, 201);
  // now he has an account, so Forgot password sends a normal reset to his own email
  await client().post('/api/auth/forgot', { email: 'ram.helper@outlook.com' });
  const reset = await mailTo('ram.helper@outlook.com', /Reset your/);
  r = await client().post('/api/auth/reset', { token: tokenIn(reset), password: 'RamNewPass100' });
  assert.equal(r.status, 200);
  assert.equal((await client().post('/api/auth/login', { email: 'ram.helper@outlook.com', password: 'RamNewPass100' })).status, 200);
});

test('unknown or suspended emails get no mail; same reply', async () => {
  const before = inbox.length;
  const a = await client().post('/api/auth/forgot', { email: 'stranger@yahoo.com' });
  const ok = await client().post('/api/auth/forgot', { email: 'ram.helper@outlook.com' });
  assert.equal(a.data.message, ok.data.message);
  await wait(400);
  assert.ok(!inbox.slice(before).some(m => m.to.includes('stranger@yahoo.com')));
});

test('platform admin: email status, test email, send reset link to a user, outbox shows delivered', async () => {
  let r = await admin.get('/api/admin/mail-status?check=1');
  assert.equal(r.data.configured, true);
  assert.equal(r.data.ok, true);
  r = await admin.post('/api/admin/test-email', { to: 'owner.check@gmail.com' });
  assert.equal(r.data.ok, true);
  await mailTo('owner.check@gmail.com', /test email/);
  const uid = q.get("SELECT id FROM users WHERE email = 'sita.friend@gmail.com'").id;
  r = await admin.post(`/api/admin/users/${uid}/send-reset`);
  assert.equal(r.status, 200);
  await mailTo('sita.friend@gmail.com', /Reset your/);
  await wait(200);
  r = await admin.get('/api/admin/outbox');
  assert.ok(r.data.length > 0 && r.data.every(m => m.status === 'sent'), JSON.stringify(r.data.map(m => m.status)));
});

test('the login address works regardless of capital letters', async () => {
  const r = await client().post('/api/auth/login', { email: 'ROOT@example.com', password: 'RootPassword123' });
  assert.notEqual(r.status, 401);
});

test('plain-English fix for common email errors', () => {
  const { mailHint } = require('../server/mailer.js');
  assert.match(mailHint('Invalid login: 525 5.7.1 Unauthorized IP address'), /Authorised IPs/);
  assert.match(mailHint('Invalid login: 535 Authentication failed'), /SMTP_PASS/);
  assert.match(mailHint('553 Sender address rejected'), /MAIL_FROM/);
});

test('admin outbox hides private links that were delivered to the user', async () => {
  const r = await admin.get('/api/admin/outbox');
  const reset = r.data.find(m => /Reset your/.test(m.subject) && m.status === 'sent');
  assert.ok(reset, 'has a delivered reset email');
  assert.doesNotMatch(reset.body, /token=/);
  assert.match(reset.body, /private link/);
});
