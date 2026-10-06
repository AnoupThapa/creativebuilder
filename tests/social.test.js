'use strict';
/* Social publishing tests — a fake Meta Graph API stands in for Facebook/Instagram. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-social-'));
process.env.DATA_DIR = tmp;
process.env.NODE_ENV = 'test';
process.env.ADMIN_EMAIL = 'root@example.com';
process.env.ADMIN_PASSWORD = 'RootPassword123';
process.env.APP_URL = 'https://postgenx.example';
process.env.SOCIAL_POSTING = 'on'; // posting is switched off by default in the beta

/* ---------------- fake Meta ---------------- */
const calls = [];
let failPhotosWith = null;
const meta = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const form = (req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded') ? Object.fromEntries(new URLSearchParams(body.toString())) : null;
  calls.push({ method: req.method, path: u.pathname, query: Object.fromEntries(u.searchParams), form, body });
  const send = (o, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const p = u.pathname.replace(/^\/v[\d.]+/, '');
  if (p === '/oauth/access_token') return send({ access_token: u.searchParams.get('fb_exchange_token') ? 'LONG_USER' : 'SHORT_USER' });
  if (p === '/me/accounts') return send({ data: [{ id: 'PAGE1', name: 'Sunrise Café', access_token: 'PAGE_TOKEN', picture: { data: { url: 'https://x/p.jpg' } },
    instagram_business_account: { id: 'IG1', username: 'sunrisecafe', name: 'Sunrise Café' } }] });
  if (p === '/PAGE1/photos') {
    if (failPhotosWith) return send({ error: { message: 'Error validating access token', code: failPhotosWith } }, 400);
    return send({ id: 'PH1', post_id: 'PAGE1_POST1' });
  }
  if (p === '/PAGE1/videos') return send({ id: 'VID1' });
  if (p === '/IG1/media') return send({ id: 'CONTAINER1' });
  if (p === '/CONTAINER1') return send({ status_code: 'FINISHED', id: 'CONTAINER1' });
  if (p === '/IG1/media_publish') return send({ id: 'IGMEDIA1' });
  if (p === '/IGMEDIA1') return send({ permalink: 'https://www.instagram.com/p/abc/' });
  send({ error: { message: 'unknown ' + p, code: 100 } }, 404);
});

const { app, ensureAdmin } = require('../server/index.js');
const { q } = require('../server/db.js');
const config = require('../server/config.js');
const social = require('../server/social.js');
let base, server, metaUrl;

function client() {
  let cookie = '', csrf = '';
  const call = async (method, url, body) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const v = c.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b), patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u), me: () => call('GET', '/api/me') };
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 7)]);
function postForm(ids, extra = {}) {
  const fd = new FormData();
  fd.append('file', new Blob([extra.buf || JPEG], { type: 'image/jpeg' }), 'post.jpg');
  fd.append('accountIds', JSON.stringify(ids));
  fd.append('caption', extra.caption ?? 'Weekend special ☕ #coffee');
  fd.append('platform', extra.platform || 'ig_post');
  fd.append('width', String(extra.width || 1080)); fd.append('height', String(extra.height || 1080));
  if (extra.igPlacement) fd.append('igPlacement', extra.igPlacement);
  if (extra.scheduledAt) fd.append('scheduledAt', String(extra.scheduledAt));
  return fd;
}
async function waitDone(c, id) {
  for (let i = 0; i < 50; i++) {
    const r = await c.get('/api/social/posts/' + id);
    if (!['scheduled', 'publishing'].includes(r.data.status)) return r.data;
    await new Promise(r2 => setTimeout(r2, 50));
  }
  throw new Error('post never finished');
}

let owner, designer, viewer;
test.before(async () => {
  await new Promise(r => meta.listen(0, '127.0.0.1', r));
  metaUrl = `http://127.0.0.1:${meta.address().port}`;
  Object.assign(config.meta, { graphUrl: metaUrl, videoUrl: metaUrl, dialogUrl: 'https://www.facebook.com' });
  social.POLL.interval = 10;
  await ensureAdmin();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;

  owner = client();
  await owner.post('/api/auth/signup', { name: 'Maya', business: 'Sunrise Café', email: 'maya@example.com', password: 'SunrisePass2026', acceptTerms: true });
  q.run("UPDATE users SET email_verified = 1 WHERE email = 'maya@example.com'");
  const ws = q.get("SELECT workspace_id FROM users WHERE email = 'maya@example.com'").workspace_id;
  q.run("UPDATE workspaces SET plan_code = 'pro', seats = 5, sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = ?", Date.now() + 86400000 * 30, ws);
  await owner.me();
  for (const [email, role] of [['dan@example.com', 'designer'], ['vic@example.com', 'viewer']]) {
    await owner.post('/api/team/invite', { email, role });
    const body = q.get('SELECT body FROM outbox WHERE to_email = ? ORDER BY id DESC', email).body;
    const c = client();
    await c.post('/api/auth/accept-invite', { token: new URL(body.match(/https?:\/\/\S+token=\S+/)[0]).searchParams.get('token'), name: role, password: 'TeamMember2026' });
    q.run('UPDATE users SET email_verified = 1 WHERE email = ?', email);
    await c.me();
    if (role === 'designer') designer = c; else viewer = c;
  }
});
test.after(() => { server.close(); meta.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('demo mode: connect sample accounts and simulate a post', async () => {
  Object.assign(config.meta, { appId: '', appSecret: '' });
  let r = await owner.get('/api/social/status');
  assert.equal(r.data.demo, true);
  assert.equal(r.data.accounts.length, 0);
  r = await owner.get('/api/social/meta/start');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/social/connect-demo');
  r = await designer.post('/api/social/meta/demo');
  assert.equal(r.status, 403, 'designers cannot connect accounts');
  r = await owner.post('/api/social/meta/demo');
  assert.equal(r.data.accounts, 2);
  const accts = (await owner.get('/api/social/status')).data.accounts;
  assert.ok(accts.every(a => a.demo));
  r = await owner.post('/api/social/posts', postForm(accts.map(a => a.id)));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const done = await waitDone(owner, r.data.post.id);
  assert.equal(done.status, 'published');
  assert.equal(calls.length, 0, 'nothing sent to Meta in demo mode');
  for (const a of accts) await owner.del('/api/social/accounts/' + a.id);
});

test('real mode: Facebook login pop-up connects the Page and its Instagram account', async () => {
  Object.assign(config.meta, { appId: 'APPID', appSecret: 'APPSECRET' });
  let r = await designer.get('/api/social/meta/start');
  assert.match(r.headers.get('location'), /^\/social\/done\?error=/, 'only owner/admin can connect');
  r = await owner.get('/api/social/meta/start');
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.host, 'www.facebook.com');
  assert.match(loc.pathname, /\/dialog\/oauth$/);
  assert.equal(loc.searchParams.get('client_id'), 'APPID');
  assert.equal(loc.searchParams.get('redirect_uri'), 'https://postgenx.example/api/social/meta/callback');
  assert.match(loc.searchParams.get('scope'), /instagram_content_publish/);
  const state = loc.searchParams.get('state');
  r = await owner.get('/api/social/meta/callback?code=CODE&state=wrong');
  assert.match(r.headers.get('location'), /error=/, 'bad state is rejected');
  r = await owner.get(`/api/social/meta/callback?code=CODE&state=${state}`);
  assert.equal(r.headers.get('location'), '/social/done?ok=1&n=2');
  r = await owner.get(`/api/social/meta/callback?code=CODE&state=${state}`);
  assert.match(r.headers.get('location'), /error=/, 'state is single-use');
  const accts = (await owner.get('/api/social/status')).data.accounts;
  assert.deepEqual(accts.map(a => a.platform).sort(), ['facebook', 'instagram']);
  const row = q.get("SELECT token_enc FROM social_accounts WHERE platform = 'facebook' AND demo = 0");
  assert.ok(!row.token_enc.includes('PAGE_TOKEN'), 'page token is stored encrypted');
  assert.equal(calls.find(c => c.path.endsWith('/oauth/access_token') && c.query.code).query.client_secret, 'APPSECRET');
});

test('post now to Facebook + Instagram', async () => {
  calls.length = 0;
  const accts = (await owner.get('/api/social/status')).data.accounts;
  const usageBefore = (await designer.get('/api/usage')).data.used;
  let r = await viewer.post('/api/social/posts', postForm(accts.map(a => a.id)));
  assert.equal(r.status, 403, 'viewers cannot post');
  r = await designer.post('/api/social/posts', postForm(accts.map(a => a.id)));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await designer.get('/api/usage')).data.used, usageBefore + 1, 'counts as one download');
  const done = await waitDone(designer, r.data.post.id);
  assert.equal(done.status, 'published', JSON.stringify(done.targets));
  const fb = done.targets.find(t => t.platform === 'facebook');
  const ig = done.targets.find(t => t.platform === 'instagram');
  assert.equal(fb.permalink, 'https://www.facebook.com/PAGE1_POST1');
  assert.equal(ig.permalink, 'https://www.instagram.com/p/abc/');
  const photo = calls.find(c => c.path.endsWith('/PAGE1/photos'));
  assert.ok(photo.body.includes(Buffer.from('Weekend special')), 'caption sent to Facebook');
  assert.ok(photo.body.includes(Buffer.from('PAGE_TOKEN')), 'uses the Page token');
  const media = calls.find(c => c.path.endsWith('/IG1/media'));
  assert.match(media.form.image_url, /^https:\/\/postgenx\.example\/pub\/[0-9a-f]{32}\.jpg$/);
  assert.equal(media.form.caption, 'Weekend special ☕ #coffee');
  assert.ok(calls.some(c => c.path.endsWith('/IG1/media_publish') && c.form.creation_id === 'CONTAINER1'));
  // Instagram can fetch the picture from the public link
  const file = new URL(media.form.image_url).pathname;
  const pub = await fetch(base + file);
  assert.equal(pub.status, 200);
  assert.equal(pub.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(base + '/pub/' + 'a'.repeat(32) + '.jpg')).status, 404);
  // preview for the history list needs login
  assert.equal((await fetch(base + done.preview)).status, 401);
  assert.equal((await viewer.get('/api/social/posts')).data.length >= 1, true, 'team can see the history');
});

test('video post goes to Facebook videos and Instagram Reels', async () => {
  calls.length = 0;
  const accts = (await owner.get('/api/social/status')).data.accounts;
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypisom'), Buffer.alloc(300, 1)]);
  const fd = new FormData();
  fd.append('file', new Blob([mp4], { type: 'video/mp4' }), 'post.mp4');
  fd.append('accountIds', JSON.stringify(accts.map(a => a.id)));
  fd.append('caption', 'Our new latte art');
  fd.append('platform', 'ig_story'); fd.append('width', '1080'); fd.append('height', '1920');
  const r = await owner.post('/api/social/posts', fd);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const done = await waitDone(owner, r.data.post.id);
  assert.equal(done.status, 'published', JSON.stringify(done.targets));
  assert.ok(calls.some(c => c.path.endsWith('/PAGE1/videos')));
  const media = calls.find(c => c.path.endsWith('/IG1/media'));
  assert.equal(media.form.media_type, 'REELS');
  assert.match(media.form.video_url, /\/pub\/[0-9a-f]{32}\.mp4$/);
});

test('Instagram rules: feed size check and stories', async () => {
  calls.length = 0;
  const ig = (await owner.get('/api/social/status')).data.accounts.find(a => a.platform === 'instagram');
  let r = await owner.post('/api/social/posts', postForm([ig.id], { platform: 'ig_story', width: 1080, height: 1920 }));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /4:5/);
  r = await owner.post('/api/social/posts', postForm([ig.id], { platform: 'ig_story', width: 1080, height: 1920, igPlacement: 'story' }));
  assert.equal(r.status, 201);
  await waitDone(owner, r.data.post.id);
  assert.equal(calls.find(c => c.path.endsWith('/IG1/media')).form.media_type, 'STORIES');
});

test('schedule, reschedule, cancel and the scheduler', async () => {
  const accts = (await owner.get('/api/social/status')).data.accounts;
  let r = await owner.post('/api/social/posts', postForm([accts[0].id], { scheduledAt: Date.now() + 10 * 1000 }));
  assert.equal(r.status, 400, 'too soon');
  r = await owner.post('/api/social/posts', postForm([accts[0].id], { scheduledAt: Date.now() + 3600 * 1000 }));
  assert.equal(r.status, 201);
  const id = r.data.post.id;
  assert.equal(r.data.post.status, 'scheduled');
  r = await designer.patch('/api/social/posts/' + id, { scheduledAt: Date.now() + 7200 * 1000 });
  assert.equal(r.status, 403, "designers can't change other people's posts");
  r = await owner.patch('/api/social/posts/' + id, { scheduledAt: Date.now() + 7200 * 1000, caption: 'Updated caption' });
  assert.equal(r.data.caption, 'Updated caption');
  await social.runDue();
  assert.equal((await owner.get('/api/social/posts/' + id)).data.status, 'scheduled', 'not due yet');
  q.run('UPDATE social_posts SET scheduled_at = ? WHERE id = ?', Date.now() - 1000, id);
  await social.runDue();
  assert.equal((await owner.get('/api/social/posts/' + id)).data.status, 'published');
  // cancel
  r = await owner.post('/api/social/posts', postForm([accts[0].id], { scheduledAt: Date.now() + 3600 * 1000 }));
  await owner.post(`/api/social/posts/${r.data.post.id}/cancel`);
  q.run('UPDATE social_posts SET scheduled_at = ? WHERE id = ?', Date.now() - 1000, r.data.post.id);
  await social.runDue();
  assert.equal((await owner.get('/api/social/posts/' + r.data.post.id)).data.status, 'cancelled');
  assert.equal((await owner.get('/api/social/posts?filter=scheduled')).data.length, 0);
});

test('expired connection: post fails clearly, account flagged, retry after reconnect', async () => {
  const accts = (await owner.get('/api/social/status')).data.accounts;
  const fb = accts.find(a => a.platform === 'facebook');
  failPhotosWith = 190;
  let r = await owner.post('/api/social/posts', postForm([fb.id]));
  let done = await waitDone(owner, r.data.post.id);
  assert.equal(done.status, 'failed');
  assert.match(done.targets[0].error, /expired.*Reconnect/);
  const status = (await owner.get('/api/social/status')).data.accounts.find(a => a.id === fb.id);
  assert.equal(status.status, 'error');
  r = await owner.post('/api/social/posts', postForm([fb.id]));
  assert.equal(r.status, 400, 'cannot post to a broken account');
  // reconnect + retry
  failPhotosWith = null;
  const loc = new URL((await owner.get('/api/social/meta/start')).headers.get('location'));
  await owner.get(`/api/social/meta/callback?code=CODE&state=${loc.searchParams.get('state')}`);
  assert.equal((await owner.get('/api/social/status')).data.accounts.find(a => a.id === fb.id).status, 'active');
  await owner.post(`/api/social/posts/${done.id}/retry`);
  await new Promise(r2 => setTimeout(r2, 200));
  done = await waitDone(owner, done.id);
  assert.equal(done.status, 'published');
});

test('allowance is enforced and deleting the workspace removes social data', async () => {
  const accts = (await owner.get('/api/social/status')).data.accounts;
  const ws = q.get("SELECT workspace_id FROM users WHERE email = 'maya@example.com'").workspace_id;
  q.run("UPDATE workspaces SET plan_code = 'free', sub_status = 'none', billing_mode = 'none' WHERE id = ?", ws);
  let last;
  for (let i = 0; i < 5; i++) { last = await owner.post('/api/social/posts', postForm([accts[0].id], { scheduledAt: Date.now() + 3600e3 })); if (last.status !== 201) break; }
  assert.equal(last.status, 402, 'free trial allowance runs out');
  const files = fs.readdirSync(path.join(tmp, 'social')).length;
  assert.ok(files > 0);
  const r = await owner.post('/api/me/delete', { password: 'SunrisePass2026', confirm: 'DELETE' });
  assert.equal(r.status, 200);
  assert.equal(q.get('SELECT COUNT(*) n FROM social_accounts WHERE workspace_id = ?', ws).n, 0);
  assert.equal(q.get('SELECT COUNT(*) n FROM social_posts WHERE workspace_id = ?', ws).n, 0);
  assert.equal(fs.readdirSync(path.join(tmp, 'social')).length, 0, 'post files removed');
});
