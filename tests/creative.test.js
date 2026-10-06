'use strict';
/* Creative tools: slideshow video studio, built-in music library, text overlay saved with designs. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-cr-'));
Object.assign(process.env, { DATA_DIR: tmp, NODE_ENV: 'test', ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'RootPassword123' });
const { app, ensureAdmin } = require('../server/index.js');
const { q } = require('../server/db.js');

let base, server;
function client() {
  let cookie = '', csrf = '';
  const call = async (method, url, body) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const v = c.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : await res.text();
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b), patch: (u, b) => call('PATCH', u, b) };
}
test.before(async () => {
  await ensureAdmin();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('music library: 12 original tracks, all served as MP3', async () => {
  const lib = await (await fetch(base + '/music/library.json')).json();
  assert.ok(lib.length >= 10, 'at least 10 tracks');
  for (const t of lib) {
    assert.match(t.file, /^\/music\/[a-z-]+\.mp3$/);
    assert.ok(t.name && t.mood && t.description);
    const r = await fetch(base + t.file, { method: 'HEAD' });
    assert.equal(r.status, 200, t.file);
    assert.match(r.headers.get('content-type'), /audio\/mpeg/);
  }
});

test('slideshow studio page: signed-in only; video download is counted like other videos', async () => {
  let r = await fetch(base + '/slideshow', { redirect: 'manual' });
  assert.ok([302, 303].includes(r.status), 'redirects to login');
  const c = client();
  assert.equal((await c.post('/api/auth/signup', { name: 'Slide', email: 'slide@example.com', password: 'MovingPictures2026', acceptTerms: true })).status, 201);
  q.run('UPDATE users SET email_verified = 1 WHERE email = ?', 'slide@example.com');
  await c.get('/api/me');
  r = await c.get('/slideshow');
  assert.equal(r.status, 200); assert.match(r.data, /slideshow\.js/);
  // free plan: no video downloads
  r = await c.post('/api/exports', { items: [{ platform: 'ig_story', kind: 'video' }], quality: 1 });
  assert.equal(r.status, 402);
  q.run("UPDATE workspaces SET plan_code = 'starter', sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = (SELECT workspace_id FROM users WHERE email = ?)", Date.now() + 864e5, 'slide@example.com');
  r = await c.post('/api/exports', { items: [{ platform: 'ig_story', kind: 'video' }], quality: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const js = await (await fetch(base + '/js/slideshow.js')).text();
  assert.equal((js.match(/\{ key: '[a-z]+', name: /g) || []).length, 12, '12 templates');
});

test('editor: text overlay and text effects are saved with the design', async () => {
  const c = client();
  await c.post('/api/auth/signup', { name: 'Fx', email: 'fx@example.com', password: 'TextEffects2026', acceptTerms: true });
  await c.get('/api/me');
  const data = { v: 1, headline: 'Hello', textFx: 'neon', fxColor: '#ff3da5', overlayText: 'Fresh coffee\nevery morning', overlayFx: 'highlight', overlayFont: 'Courier Prime', overlaySize: 'l' };
  const d = (await c.post('/api/designs', { name: 'Fx', data })).data;
  const back = (await c.get('/api/designs/' + d.id)).data;
  const saved = typeof back.data === 'string' ? JSON.parse(back.data) : (back.data || back.design.data);
  assert.equal(saved.overlayText, 'Fresh coffee\nevery morning');
  assert.equal(saved.textFx, 'neon');
  const css = await (await fetch(base + '/css/fonts.css')).text();
  assert.match(css, /Courier Prime/, 'typewriter font is served');
});

test('pages link scripts and styles with a version, so an update never runs old scripts', async () => {
  for (const u of ['/', '/login', '/help']) {
    const html = await (await fetch(base + u)).text();
    const refs = html.match(/(?:src|href)="\/(?:js|css)\/[^"]+"/g) || [];
    assert.ok(refs.length > 0, u);
    for (const r of refs) assert.match(r, /\?v=[0-9a-f]{10}"$/, `${u}: ${r}`);
  }
});

test('brand name is PostGenX on every public page', async () => {
  for (const u of ['/', '/help', '/privacy', '/login', '/developers']) {
    const html = await (await fetch(base + u)).text();
    assert.ok(!/postforge/i.test(html), `${u} still mentions the old name`);
    assert.match(html, /PostGenX/, u);
  }
});
