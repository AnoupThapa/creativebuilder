'use strict';
/* GIF maker: options are sanitised, files type-checked, every size counted as a download,
   and outputs are only visible to the person who made them. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-gif-'));
Object.assign(process.env, { DATA_DIR: tmp, NODE_ENV: 'test', ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'RootPassword123' });
const { app, ensureAdmin } = require('../server/index.js');
const { q } = require('../server/db.js');
const gif = require('../server/gif.js');

let base, server;
function client() {
  let cookie = '', csrf = '';
  const call = async (method, url, body) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    let payload = body;
    if (body !== undefined && !(body instanceof FormData)) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload });
    for (const c of res.headers.getSetCookie()) { const v = c.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b) };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.before(async () => {
  await ensureAdmin();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('options are cleaned and limited', () => {
  const o = gif.cleanOptions({ sizes: ['product_800', 'nope', 'product_800'], custom: { w: 99999, h: 33 }, fps: 500, duration: 999, background: 'red;rm -rf', quality: 'x' });
  assert.deepEqual(o.sizes.map(s => s.key), ['product_800', 'custom_1920x64']);
  assert.equal(o.fps, 25); assert.equal(o.duration, gif.LIMITS.maxSeconds);
  assert.equal(o.background, 'blur'); assert.equal(o.quality, 'balanced');
  assert.equal(gif.cleanOptions({ background: '#00aa11' }).background, '#00aa11');
  assert.equal(gif.sniff(PNG).kind, 'image');
  assert.equal(gif.sniff(Buffer.from('GIF89a......')).ext, 'gif');
  assert.equal(gif.sniff(Buffer.from('<html><body>x')), null);
});

test('GIF maker: checks, makes every size, counts downloads, private files', { skip: !gif.available() && 'ffmpeg not available here' }, async () => {
  const c = client();
  let r = await c.post('/api/auth/signup', { name: 'Gia', email: 'gia@example.com', password: 'GifMaker2026', acceptTerms: true });
  assert.equal(r.status, 201);
  q.run("UPDATE users SET email_verified = 1 WHERE email = 'gia@example.com'");
  const ws = q.get("SELECT workspace_id FROM users WHERE email = 'gia@example.com'").workspace_id;
  q.run("UPDATE workspaces SET plan_code = 'pro', sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = ?", Date.now() + 864e5, ws);
  await c.get('/api/me');

  const form = (bufs, opts) => { const f = new FormData(); bufs.forEach((b, i) => f.append('files', new Blob([b]), 'f' + i)); f.append('options', JSON.stringify(opts)); return f; };
  // wrong file type
  r = await c.post('/api/gif/make', form([Buffer.from('<html>hello</html>')], { sizes: ['thumb_400'] }));
  assert.equal(r.status, 415);
  // one photo is not a slideshow
  r = await c.post('/api/gif/make', form([PNG], { sizes: ['thumb_400'] }));
  assert.equal(r.status, 400);

  const before = q.get("SELECT COUNT(*) n FROM exports e JOIN users u ON u.id = e.user_id WHERE u.email = 'gia@example.com'").n;
  const webm = fs.readFileSync(path.join(__dirname, 'fixture.webm'));
  r = await c.post('/api/gif/make', form([webm], { sizes: ['thumb_400', 'email_600'], duration: 1, fps: 8, mp4: true }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.results.length, 2);
  const after = q.get("SELECT COUNT(*) n FROM exports e JOIN users u ON u.id = e.user_id WHERE u.email = 'gia@example.com'").n;
  assert.equal(after - before, 2, 'each size is one download');
  const first = r.data.results[0];
  const file = await c.get(`/api/gif/out/${r.data.id}/${first.gif}`);
  assert.equal(file.status, 200);
  assert.equal(file.data.toString('ascii', 0, 4), 'GIF8');
  assert.ok(first.mp4 && first.mp4Bytes > 0);

  // slideshow from photos
  r = await c.post('/api/gif/make', form([PNG, PNG, PNG], { sizes: ['thumb_400'], slide: 0.5, fit: 'fit', background: '#ffcc00' }));
  assert.equal(r.status, 200, JSON.stringify(r.data));

  // someone else cannot open the files
  const other = client();
  await other.post('/api/auth/signup', { name: 'Ozzy', email: 'ozzy@example.com', password: 'OtherUser2026', acceptTerms: true });
  const peek = await other.get(`/api/gif/out/${r.data.id}/${r.data.results[0].gif}`);
  assert.equal(peek.status, 404);
});
