'use strict';
/* End-to-end API tests: run with `npm test`. Uses a throwaway data folder. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-test-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'root@example.com';
process.env.ADMIN_PASSWORD = 'RootPassword123';

const { app, ensureAdmin } = require('../server/index.js');
const { hotp } = require('../server/security.js');
const { q } = require('../server/db.js');

let base, server;

/* Minimal cookie-keeping client */
function client() {
  let cookie = '', csrf = '';
  const call = async (method, url, body, extraHeaders = {}) => {
    const headers = { ...extraHeaders };
    if (cookie) headers.cookie = cookie;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    const sc = res.headers.getSetCookie();
    for (const c of sc) { const v = c.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: u => call('GET', u), post: (u, b, h) => call('POST', u, b, h), put: (u, b) => call('PUT', u, b),
    patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u),
    async me() { return call('GET', '/api/me'); },
    get cookie() { return cookie; },
  };
}

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.before(async () => {
  await ensureAdmin();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('security headers and protected pages', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.equal(r.headers.get('x-powered-by'), null);
  const app = await fetch(base + '/app', { redirect: 'manual' });
  assert.equal(app.status, 302);
  assert.match(app.headers.get('location'), /^\/login/);
  const api = await fetch(base + '/api/designs');
  assert.equal(api.status, 401);
  const views = await fetch(base + '/editor.html');
  assert.equal(views.status, 404, 'raw view files must not be served statically');
});

test('signup validation', async () => {
  const c = client();
  let r = await c.post('/api/auth/signup', { name: 'A', email: 'bad', password: 'x', acceptTerms: true });
  assert.equal(r.status, 400);
  r = await c.post('/api/auth/signup', { name: 'A', email: 'a@example.com', password: 'short1', acceptTerms: true });
  assert.equal(r.status, 400);
  r = await c.post('/api/auth/signup', { name: 'A', email: 'a@example.com', password: 'password123', acceptTerms: true });
  assert.equal(r.status, 400, 'common password rejected');
});

let owner, ownerDesign;
test('owner signs up on free trial; quota + verification enforced', async () => {
  owner = client();
  let r = await owner.post('/api/auth/signup', { name: 'Olivia', business: 'Olive Café', email: 'olivia@example.com', password: 'CorrectHorse42', acceptTerms: true, timezone: 'Asia/Kathmandu' });
  assert.equal(r.status, 201);
  r = await owner.me();
  assert.equal(r.data.plan.code, 'free');
  assert.equal(r.data.usage.limit, 3);
  assert.equal(r.data.user.role, 'owner');

  // CSRF: request without token is rejected
  const noCsrf = await fetch(base + '/api/designs', { method: 'POST', headers: { cookie: owner.cookie, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);
  // Cross-origin request rejected
  const xo = await owner.post('/api/designs', {}, { origin: 'https://evil.example' });
  assert.equal(xo.status, 403);

  r = await owner.post('/api/designs', { name: 'Weekend promo' });
  assert.equal(r.status, 201);
  ownerDesign = r.data.id;

  // unverified email cannot export
  r = await owner.post('/api/exports', { designId: ownerDesign, items: [{ platform: 'ig_post', kind: 'image' }], quality: 1 });
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'verify_email');

  // verify via token from outbox
  const mail = q.get("SELECT body FROM outbox WHERE to_email = 'olivia@example.com' ORDER BY id DESC");
  const link = mail.body.match(/https?:\/\/\S+token=\S+/)[0];
  const token = new URL(link).searchParams.get('token');
  const v = await owner.get('/api/auth/verify?token=' + token);
  assert.equal(v.status, 302);
  assert.equal((await owner.me()).data.user.email_verified, true);

  // free plan: no batch, no 2x, watermark on
  r = await owner.post('/api/exports', { items: [{ platform: 'ig_post', kind: 'image' }, { platform: 'fb_post', kind: 'image' }], quality: 1 });
  assert.equal(r.status, 402);
  r = await owner.post('/api/exports', { items: [{ platform: 'ig_post', kind: 'image' }], quality: 2 });
  assert.equal(r.status, 402);
  for (let i = 0; i < 3; i++) {
    r = await owner.post('/api/exports', { designId: ownerDesign, items: [{ platform: 'ig_post', kind: 'image' }], quality: 1 });
    assert.equal(r.status, 200);
    assert.equal(r.data.watermark, true);
  }
  r = await owner.post('/api/exports', { items: [{ platform: 'ig_post', kind: 'image' }], quality: 1 });
  assert.equal(r.status, 402);
  assert.equal(r.data.code, 'quota');
  // invalid platform key rejected
  r = await owner.post('/api/exports', { items: [{ platform: '<script>', kind: 'image' }], quality: 1 });
  assert.equal(r.status, 400);
});

test('Starter plan: 5 images per day (max 100/month) per user, batch allowed', async () => {
  let r = await owner.post('/api/billing/checkout', { plan: 'starter', seats: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'demo');
  r = await owner.me();
  assert.equal(r.data.plan.code, 'starter');
  assert.equal(r.data.usage.limit, 5);
  assert.equal(r.data.usage.day.limit, 5);
  assert.equal(r.data.usage.month.limit, 100);
  assert.equal(r.data.usage.used, 0, 'trial downloads do not count against paid daily quota');
  assert.equal(r.data.workspace.seats, 2);

  r = await owner.post('/api/exports', { items: ['ig_post', 'ig_story', 'fb_post', 'li_post', 'pin', 'x_post'].map(p => ({ platform: p, kind: 'image' })), quality: 2 });
  assert.equal(r.status, 402, '6 > 5 remaining');
  r = await owner.post('/api/exports', { items: ['ig_post', 'ig_story', 'fb_post', 'li_post'].map(p => ({ platform: p, kind: 'image' })), quality: 2 });
  assert.equal(r.status, 200);
  assert.equal(r.data.watermark, false);
  assert.equal(r.data.usage.remaining, 1);
  const st = (await owner.me()).data.plan;
  assert.equal(st.video_export, true, 'Starter can use its own videos');
  assert.equal(st.max_video_seconds, 30); assert.equal(st.max_video_mb, 50); assert.equal(st.ai_video, false);
  r = await owner.post('/api/exports', { items: [{ platform: 'ig_post', kind: 'image' }], quality: 3 });
  assert.equal(r.status, 402, '3x is Pro only');
});

test('Pro plan: 15 a day, up to 300 a month, yearly billing', async () => {
  let r = await owner.post('/api/billing/checkout', { plan: 'pro', seats: 2, interval: 'year' });
  assert.equal(r.status, 200);
  r = await owner.me();
  assert.equal(r.data.plan.code, 'pro');
  assert.equal(r.data.workspace.billing_interval, 'year');
  assert.ok(r.data.workspace.current_period_end > Date.now() + 300 * 86400000, 'yearly period');
  assert.equal(r.data.usage.day.limit, 15);
  assert.equal(r.data.usage.month.limit, 300);
  assert.equal(r.data.usage.day.used, 4, "today's paid downloads count");
  assert.equal(r.data.usage.remaining, 11);
  r = await owner.post('/api/exports', { items: [{ platform: 'tiktok', kind: 'video' }], quality: 3 });
  assert.equal(r.status, 200);
  const plans = await owner.get('/api/billing/plans');
  const pro = plans.data.plans.find(p => p.code === 'pro');
  assert.equal(pro.currency, 'usd');
  assert.equal(pro.price_cents_annual, 29000, 'yearly = 10 x monthly');
  r = await owner.post('/api/billing/checkout', { plan: 'pro', seats: 2, interval: 'month' });
  assert.equal((await owner.me()).data.workspace.billing_interval, 'month');
});

test('video: recorded WebM is converted to Instagram-ready MP4 (H.264/AAC)', async () => {
  const webm = fs.readFileSync(path.join(__dirname, 'fixture.webm'));
  const r = await fetch(base + '/api/video/convert', { method: 'POST', body: webm,
    headers: { cookie: owner.cookie, 'content-type': 'video/webm', 'x-csrf-token': (await owner.me()).data.csrf } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'video/mp4');
  const out = Buffer.from(await r.arrayBuffer());
  assert.equal(out.toString('ascii', 4, 8), 'ftyp');
  const probe = require('node:child_process').spawnSync(require('ffmpeg-static'), ['-hide_banner', '-i', 'pipe:0'], { input: out });
  const info = probe.stderr.toString();
  assert.match(info, /Video: h264/);
  assert.match(info, /Audio: aac/);
  assert.match(info, /yuv420p/);
});

let designer, viewer;
test('team: invites, seats, roles and design access', async () => {
  // invite a designer (seat 2 of 2)
  let r = await owner.post('/api/team/invite', { email: 'dan@example.com', role: 'designer' });
  assert.equal(r.status, 201);
  // no seat left for another
  r = await owner.post('/api/team/invite', { email: 'vera@example.com', role: 'viewer' });
  assert.equal(r.status, 402);
  assert.equal(r.data.code, 'seats');

  const inv = q.get("SELECT body FROM outbox WHERE to_email = 'dan@example.com' ORDER BY id DESC").body;
  const token = new URL(inv.match(/https?:\/\/\S+token=\S+/)[0]).searchParams.get('token');
  designer = client();
  r = await designer.post('/api/auth/accept-invite', { token, name: 'Dan', password: 'DesignerPass9' });
  assert.equal(r.status, 201);
  r = await designer.me();
  assert.equal(r.data.user.role, 'designer');
  assert.equal(r.data.plan.code, 'pro', 'team members share the workspace plan');
  assert.equal(r.data.usage.used, 0, 'quota is per user');

  // designer cannot see owner's private design
  r = await designer.get('/api/designs/' + ownerDesign);
  assert.equal(r.status, 404);
  // owner shares for viewing
  r = await owner.put('/api/designs/' + ownerDesign, { visibility: 'team_view' });
  assert.equal(r.status, 200);
  r = await designer.get('/api/designs/' + ownerDesign);
  assert.equal(r.status, 200);
  assert.equal(r.data.can_edit, false);
  r = await designer.put('/api/designs/' + ownerDesign, { name: 'hacked' });
  assert.equal(r.status, 403);
  // designer can't change sharing or delete
  r = await designer.del('/api/designs/' + ownerDesign);
  assert.equal(r.status, 403);
  // team_edit lets designer edit
  await owner.put('/api/designs/' + ownerDesign, { visibility: 'team_edit' });
  r = await designer.put('/api/designs/' + ownerDesign, { name: 'Weekend promo v2', data: { headline: 'Hi' } });
  assert.equal(r.status, 200);
  // designer can't invite / manage billing
  r = await designer.post('/api/team/invite', { email: 'x@example.com', role: 'viewer' });
  assert.equal(r.status, 403);
  r = await designer.post('/api/billing/checkout', { plan: 'pro', seats: 5 });
  assert.equal(r.status, 403);
  // designer is not a platform admin → admin API hidden
  r = await designer.get('/api/admin/stats');
  assert.equal(r.status, 404);

  // add a seat, invite a viewer
  await owner.post('/api/billing/checkout', { plan: 'pro', seats: 3 });
  r = await owner.post('/api/team/invite', { email: 'vera@example.com', role: 'viewer' });
  assert.equal(r.status, 201);
  const inv2 = q.get("SELECT body FROM outbox WHERE to_email = 'vera@example.com' ORDER BY id DESC").body;
  viewer = client();
  await viewer.post('/api/auth/accept-invite', { token: new URL(inv2.match(/https?:\/\/\S+token=\S+/)[0]).searchParams.get('token'), name: 'Vera', password: 'ViewerPass77' });
  r = await viewer.post('/api/designs', { name: 'nope' });
  assert.equal(r.status, 403);
  r = await viewer.post('/api/exports', { items: [{ platform: 'ig_post', kind: 'image' }], quality: 1 });
  assert.equal(r.status, 403);
  r = await viewer.get('/api/designs');
  assert.equal(r.data.length, 1);

  // can't reduce seats below members
  r = await owner.post('/api/billing/checkout', { plan: 'pro', seats: 2 });
  assert.equal(r.status, 400);

  // remove viewer → sessions revoked
  const vid = (await viewer.me()).data.user.id;
  r = await owner.del('/api/team/' + vid);
  assert.equal(r.status, 200);
  r = await viewer.me();
  assert.equal(r.status, 401);
});

test('media upload: type sniffing, workspace isolation', async () => {
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'logo.png');
  let r = await owner.post('/api/media', fd);
  assert.equal(r.status, 201);
  const mediaId = r.data.id;

  // a fake "image" (HTML) is rejected
  const bad = new FormData();
  bad.append('file', new Blob(['<html><script>alert(1)</script></html>'], { type: 'image/png' }), 'x.png');
  r = await owner.post('/api/media', bad);
  assert.equal(r.status, 415);

  // same workspace can read it, other workspace cannot
  let f = await fetch(base + '/media/' + mediaId, { headers: { cookie: designer.cookie } });
  assert.equal(f.status, 200);
  assert.equal(f.headers.get('content-type'), 'image/png');
  const outsider = client();
  await outsider.post('/api/auth/signup', { name: 'Eve', email: 'eve@example.com', password: 'OutsiderPass1', acceptTerms: true });
  await outsider.me();
  f = await fetch(base + '/media/' + mediaId, { headers: { cookie: outsider.cookie } });
  assert.equal(f.status, 404);
  r = await outsider.get('/api/designs/' + ownerDesign);
  assert.equal(r.status, 404);

  // brand kit with logo; free outsider limited to 1 kit
  r = await owner.post('/api/brand-kits', { name: 'Olive', color: '#1d7a5f', phone: '0400 000 000', logo_media_id: mediaId });
  assert.equal(r.status, 201);
  r = await owner.post('/api/brand-kits', { name: 'Bad', color: 'red' });
  assert.equal(r.status, 400);
  await outsider.post('/api/brand-kits', { name: 'Eve1', color: '#000000' });
  r = await outsider.post('/api/brand-kits', { name: 'Eve2', color: '#000000' });
  assert.equal(r.status, 402);
  r = await outsider.post('/api/brand-kits', { name: 'x', color: '#000000', logo_media_id: mediaId });
  assert.equal(r.status, 402);
});

test('login lockout and 2-step verification', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) {
    const r = await c.post('/api/auth/login', { email: 'eve@example.com', password: 'wrong-password-1' });
    assert.equal(r.status, 401);
  }
  let r = await c.post('/api/auth/login', { email: 'eve@example.com', password: 'OutsiderPass1' });
  assert.equal(r.status, 429, 'account locked after 5 failures');
  q.run("UPDATE users SET locked_until = NULL WHERE email = 'eve@example.com'");

  // 2FA for the owner
  r = await owner.post('/api/me/2fa/setup');
  assert.equal(r.status, 200);
  const secret = r.data.secret;
  const code = hotp(secret, Math.floor(Date.now() / 30000));
  r = await owner.post('/api/me/2fa/enable', { code });
  assert.equal(r.status, 200);
  const stored = q.get("SELECT totp_secret FROM users WHERE email = 'olivia@example.com'").totp_secret;
  assert.ok(!stored.includes(secret), '2FA secret is encrypted at rest');

  const c2 = client();
  r = await c2.post('/api/auth/login', { email: 'olivia@example.com', password: 'CorrectHorse42' });
  assert.equal(r.data.needTotp, true);
  assert.equal((await c2.me()).status, 401, 'no session before 2FA');
  r = await c2.post('/api/auth/login', { email: 'olivia@example.com', password: 'CorrectHorse42', totp: '000000' });
  assert.equal(r.status, 401);
  r = await c2.post('/api/auth/login', { email: 'olivia@example.com', password: 'CorrectHorse42', totp: hotp(secret, Math.floor(Date.now() / 30000)) });
  assert.equal(r.status, 200);
  assert.equal((await c2.me()).status, 200);
});

test('password reset signs out every session', async () => {
  const r0 = await designer.post('/api/auth/forgot', { email: 'dan@example.com' });
  assert.equal(r0.status, 200);
  const unknown = await designer.post('/api/auth/forgot', { email: 'nobody@example.com' });
  assert.equal(unknown.data.message, r0.data.message, 'no account enumeration');
  const body = q.get("SELECT body FROM outbox WHERE to_email = 'dan@example.com' AND subject LIKE 'Reset%' ORDER BY id DESC").body;
  const token = new URL(body.match(/https?:\/\/\S+token=\S+/)[0]).searchParams.get('token');
  const anon = client();
  let r = await anon.post('/api/auth/reset', { token, password: 'BrandNewPass55' });
  assert.equal(r.status, 200);
  r = await anon.post('/api/auth/reset', { token, password: 'AnotherPass66' });
  assert.equal(r.status, 400, 'token is single-use');
  assert.equal((await designer.me()).status, 401);
});

let adminSecret;
test('platform admin: stats, plan editing, suspension', async () => {
  const a = client();
  let r = await a.post('/api/auth/login', { email: 'root@example.com', password: 'RootPassword123' });
  assert.equal(r.status, 200);
  await a.me();
  // the admin area is locked until the admin turns on 2-step login
  r = await a.get('/api/admin/stats');
  assert.equal(r.status, 403);
  assert.equal(r.data.code, 'admin_2fa_required');
  const page = await fetch(base + '/admin', { headers: { cookie: a.cookie }, redirect: 'manual' });
  assert.match(page.headers.get('location'), /admin2fa=1/);
  const setup = await a.post('/api/me/2fa/setup');
  adminSecret = setup.data.secret;
  r = await a.post('/api/me/2fa/enable', { code: hotp(adminSecret, Math.floor(Date.now() / 30000)) });
  assert.equal(r.status, 200);
  await a.me();
  r = await a.get('/api/admin/stats');
  assert.equal(r.status, 200);
  assert.ok(r.data.users >= 4);
  r = await a.put('/api/admin/plans/starter', { quota_limit: 6 });
  assert.equal(r.status, 200);
  const plans = await a.get('/api/billing/plans');
  assert.equal(plans.data.plans.find(p => p.code === 'starter').quota_limit, 6);
  r = await a.put('/api/admin/plans/starter', { quota_period: 'week' });
  assert.equal(r.status, 400);
  const eve = q.get("SELECT id FROM users WHERE email = 'eve@example.com'").id;
  r = await a.patch('/api/admin/users/' + eve, { status: 'suspended' });
  assert.equal(r.status, 200);
  r = await client().post('/api/auth/login', { email: 'eve@example.com', password: 'OutsiderPass1' });
  assert.equal(r.status, 403);
  r = await a.get('/api/admin/audit');
  assert.ok(r.data.some(x => x.action === 'admin.user_updated'));
});

test('admin login from settings (.env) is applied on restart', async () => {
  const config = require('../server/config.js');
  config.admin.password = 'NewAdminPass456';
  await ensureAdmin();
  let r = await client().post('/api/auth/login', { email: 'root@example.com', password: 'RootPassword123' });
  assert.equal(r.status, 401, 'old password no longer works');
  r = await client().post('/api/auth/login', { email: 'root@example.com', password: 'NewAdminPass456' });
  assert.equal(r.data.needTotp, true, 'admin 2-step login still required');
  // lost phone: ADMIN_RESET_2FA=true clears it on restart
  process.env.ADMIN_RESET_2FA = 'true';
  await ensureAdmin();
  delete process.env.ADMIN_RESET_2FA;
  r = await client().post('/api/auth/login', { email: 'root@example.com', password: 'NewAdminPass456' });
  assert.equal(r.status, 200);
  assert.ok(!r.data.needTotp);
});

test('privacy: download my data + delete account (member and owner)', async () => {
  const JSZip = require('jszip');
  const zoe = client();
  await zoe.post('/api/auth/signup', { name: 'Zoe', business: 'Zoe Bakes', email: 'zoe@example.com', password: 'ZoeBakery2026', acceptTerms: true });
  await zoe.me();
  const fd = new FormData();
  fd.append('file', new Blob([PNG], { type: 'image/png' }), 'cake.png');
  const media = (await zoe.post('/api/media', fd)).data;
  await zoe.post('/api/designs', { name: 'Cake promo' });
  await zoe.post('/api/billing/checkout', { plan: 'starter', seats: 2 });
  await zoe.post('/api/team/invite', { email: 'max@example.com', role: 'designer' });
  const inv = q.get("SELECT body FROM outbox WHERE to_email = 'max@example.com' ORDER BY id DESC").body;
  const max = client();
  await max.post('/api/auth/accept-invite', { token: new URL(inv.match(/https?:\/\/\S+token=\S+/)[0]).searchParams.get('token'), name: 'Max', password: 'MaxDesigns77' });
  await max.me();
  const priv = (await max.post('/api/designs', { name: 'Max private draft' })).data;
  const shared = (await max.post('/api/designs', { name: 'Max shared' })).data;
  await max.put('/api/designs/' + shared.id, { visibility: 'team_view' });

  // member export
  let r = await fetch(base + '/api/me/export', { headers: { cookie: max.cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'application/zip');
  let zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
  let data = JSON.parse(await zip.file('postgenx-data.json').async('string'));
  assert.equal(data.account.email, 'max@example.com');
  assert.equal(data.account.password_hash, undefined, 'no password hash in export');
  assert.equal(data.designs.length, 2);

  // member delete
  r = await max.post('/api/me/delete', { password: 'wrong-password1', confirm: 'DELETE' });
  assert.equal(r.status, 400);
  r = await max.post('/api/me/delete', { password: 'MaxDesigns77', confirm: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal((await max.me()).status, 401);
  assert.equal(q.get("SELECT COUNT(*) n FROM users WHERE email = 'max@example.com'").n, 0);
  const zDesigns = (await zoe.get('/api/designs')).data.map(d => d.name);
  assert.ok(zDesigns.includes('Max shared'), 'shared design stays with the team');
  assert.ok(!zDesigns.includes('Max private draft'), 'private draft deleted');
  assert.equal(q.get('SELECT COUNT(*) n FROM designs WHERE id = ?', priv.id).n, 0);

  // owner export includes uploaded files
  r = await fetch(base + '/api/me/export', { headers: { cookie: zoe.cookie } });
  zip = await JSZip.loadAsync(Buffer.from(await r.arrayBuffer()));
  data = JSON.parse(await zip.file('postgenx-data.json').async('string'));
  assert.ok(zip.file(`files/${media.id}-cake.png`), 'uploaded file included');
  assert.ok(data.designs.length >= 2);

  // owner delete removes the whole workspace
  const wsId = q.get("SELECT workspace_id FROM users WHERE email = 'zoe@example.com'").workspace_id;
  r = await zoe.post('/api/me/delete', { password: 'ZoeBakery2026', confirm: 'nope' });
  assert.equal(r.status, 400);
  r = await zoe.post('/api/me/delete', { password: 'ZoeBakery2026', confirm: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(r.data.workspaceDeleted, true);
  assert.equal(q.get('SELECT COUNT(*) n FROM workspaces WHERE id = ?', wsId).n, 0);
  assert.equal(q.get('SELECT COUNT(*) n FROM media WHERE workspace_id = ?', wsId).n, 0);
  assert.equal(q.get('SELECT COUNT(*) n FROM designs WHERE workspace_id = ?', wsId).n, 0);
  assert.ok(!fs.existsSync(path.join(tmp, 'uploads', String(wsId), media.id)), 'files removed from disk');
});

async function adminClient() {
  const a = client();
  const u = q.get("SELECT id FROM users WHERE email = 'root@example.com'");
  const { encrypt } = require('../server/security.js');
  const secret = 'JBSWY3DPEHPK3PXP';
  q.run('UPDATE users SET totp_enabled = 1, totp_secret = ? WHERE id = ?', encrypt(secret), u.id);
  const pw = require('../server/config.js').admin.password;
  const r = await a.post('/api/auth/login', { email: 'root@example.com', password: pw, totp: hotp(secret, Math.floor(Date.now() / 30000)) });
  assert.equal(r.status, 200);
  await a.me();
  return a;
}

test('closed beta: invite codes, feedback and approved testimonials', async () => {
  const config = require('../server/config.js');
  const a = await adminClient();
  let r = await a.post('/api/admin/beta-codes', { code: 'CAFE-TEST', note: 'Eve Zone cafés', max_uses: 1, plan_code: 'pro', plan_days: 60 });
  assert.equal(r.status, 201);
  config.betaMode = true;
  try {
    const c = client();
    r = await c.post('/api/auth/signup', { name: 'Bea', email: 'bea@example.com', password: 'BetaTester2026', acceptTerms: true });
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'beta_code_required');
    r = await c.post('/api/auth/signup', { name: 'Bea', business: 'Bea Café', email: 'bea@example.com', password: 'BetaTester2026', acceptTerms: true, betaCode: 'cafe-test' });
    assert.equal(r.status, 201);
    const me = (await c.me()).data;
    assert.equal(me.plan.code, 'pro', 'beta code grants Pro');
    r = await client().post('/api/auth/signup', { name: 'Cy', email: 'cy@example.com', password: 'BetaTester2026', acceptTerms: true, betaCode: 'CAFE-TEST' });
    assert.equal(r.status, 403, 'single-use code is used up');

    // feedback
    r = await c.post('/api/feedback', { rating: 5, message: 'Saves me an hour every week on specials posts!', allowQuote: true, displayName: 'Bea', business: 'Bea Café' });
    assert.equal(r.status, 201);
    await c.post('/api/feedback', { rating: 3, message: 'private note' });
    r = await client().get('/api/public/testimonials');
    assert.equal(r.data.length, 0, 'nothing public until approved');
    const fb = (await a.get('/api/admin/feedback')).data;
    const priv = fb.find(f => f.message === 'private note');
    r = await a.patch('/api/admin/feedback/' + priv.id, { approved: true });
    assert.equal(r.status, 400, 'cannot publish without permission');
    r = await a.patch('/api/admin/feedback/' + fb.find(f => f.allow_quote).id, { approved: true });
    assert.equal(r.status, 200);
    r = await client().get('/api/public/testimonials');
    assert.equal(r.data.length, 1);
    assert.equal(r.data[0].business, 'Bea Café');
    assert.equal(r.data[0].email, undefined, 'no emails exposed');
  } finally { config.betaMode = false; }
});

test('reliability: health check, backup and restore test, support inbox, error log', async () => {
  let r = await fetch(base + '/health');
  assert.equal(r.status, 200);
  const h = await r.json();
  assert.equal(h.db, 'ok');
  const a = await adminClient();
  r = await a.post('/api/admin/backups');
  assert.equal(r.status, 200);
  r = await a.post('/api/admin/backups/verify', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.ok, true, JSON.stringify(r.data));
  assert.equal(r.data.integrity, 'ok');
  assert.equal(r.data.missingFiles, 0);
  r = await a.get('/api/admin/backups');
  assert.ok(r.data.backups.length >= 1);
  assert.equal(r.data.lastVerify.ok, true);

  r = await client().post('/api/support', { name: 'Sam', email: 'sam@example.com', topic: 'question', message: 'How do I add my logo to every post?' });
  assert.equal(r.status, 201);
  assert.match(r.data.ref, /^PF-\d{5}$/);
  r = await a.get('/api/admin/support');
  const t = r.data.find(x => x.email === 'sam@example.com');
  assert.ok(t);
  await a.patch('/api/admin/support/' + t.id, { status: 'closed' });
  assert.ok(!(await a.get('/api/admin/support')).data.some(x => x.id === t.id));

  await client().post('/api/client-error', { message: 'TypeError: x is undefined', source: '/js/editor.js:10', page: '/editor' });
  r = await a.get('/api/admin/errors');
  assert.ok(r.data.some(e => e.message.includes('x is undefined')));
  await client().post('/api/pv', { path: '/', ref: 'https://www.facebook.com/groups/x' });
  r = await a.get('/api/admin/analytics');
  assert.ok(r.data.referrers.some(x => x.referrer === 'facebook.com'));
});

test('landing page: SEO tags, sitemap, robots, examples', async () => {
  let r = await fetch(base + '/');
  const html = await r.text();
  assert.match(html, /<link rel="canonical" href="http[^"]+\/">/);
  assert.match(html, /property="og:image" content="http[^"]+\/img\/og\.png"/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.equal(ld['@type'], 'SoftwareApplication');
  assert.ok(ld.offers.every(o => o.priceCurrency === 'USD'));
  assert.ok(!html.includes('{{'), 'no unfilled placeholders');
  r = await fetch(base + '/robots.txt');
  assert.match(await r.text(), /Disallow: \/app/);
  r = await fetch(base + '/sitemap.xml');
  assert.match(await r.text(), /<loc>http[^<]+\/help<\/loc>/);
  r = await fetch(base + '/api/public/examples');
  const ex = await r.json();
  assert.equal(ex.sample, true);
  assert.ok(ex.items.length >= 3);
  for (const u of [ex.items[0].before, ex.items[0].after, '/media-site/demo.mp4', '/img/og.png']) {
    assert.equal((await fetch(base + u)).status, 200, u);
  }
});

test('login / sign-up still work when the browser holds an older session (no "security token" error)', async () => {
  const a = client();
  let r = await a.post('/api/auth/signup', { name: 'Tab One', email: 'tab.one@example.com', password: 'TabOnePass2026', acceptTerms: true });
  assert.equal(r.status, 201);
  // a fresh page has no token yet, but the cookie is still there
  const cookie = a.cookie;
  const raw = (u, b) => fetch(base + u, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(b) });
  r = await raw('/api/auth/login', { email: 'tab.one@example.com', password: 'TabOnePass2026' });
  assert.equal(r.status, 200, 'login works without a token');
  r = await raw('/api/auth/signup', { name: 'Tab Two', email: 'tab.two@example.com', password: 'TabTwoPass2026', acceptTerms: true });
  assert.equal(r.status, 201, 'creating another account works without a token');
  r = await raw('/api/auth/forgot', { email: 'tab.one@example.com' });
  assert.equal(r.status, 200);
  // ordinary actions still need the token
  r = await raw('/api/me/password', { current: 'x', password: 'y' });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'csrf');
  // and a cross-site form is still blocked
  r = await fetch(base + '/api/auth/login', { method: 'POST', headers: { cookie, origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(r.status, 403);
});
