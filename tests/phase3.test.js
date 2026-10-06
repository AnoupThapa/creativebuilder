'use strict';
/* Phase 3: white-label client review portal, developer API (v1) and the embeddable website widget. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-p3-'));
Object.assign(process.env, { DATA_DIR: tmp, NODE_ENV: 'test', ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'RootPassword123' });
delete process.env.GEMINI_API_KEY; delete process.env.OPENAI_API_KEY;
const { app, ensureAdmin } = require('../server/index.js');
const { q } = require('../server/db.js');

let base, server;
const ffmpeg = require('ffmpeg-static');
const jpg = execFileSync(ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=400x300', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-']);

function client() {
  let cookie = '', csrf = '';
  const call = async (method, url, body, opt = {}) => {
    const headers = { ...(opt.headers || {}) };
    if (cookie && !opt.noCookie) headers.cookie = cookie;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    let payload = body;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const v = c.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : ct.startsWith('image/') || ct.includes('zip') ? Buffer.from(await res.arrayBuffer()) : await res.text();
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  };
  return { call, get: (u, o) => call('GET', u, undefined, o), post: (u, b, o) => call('POST', u, b, o), put: (u, b) => call('PUT', u, b), del: u => call('DELETE', u), cookie: () => cookie };
}
async function signup(name, email) {
  const c = client();
  const r = await c.post('/api/auth/signup', { name, email, password: 'PhaseThree2026xx', acceptTerms: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  q.run('UPDATE users SET email_verified = 1 WHERE email = ?', email);
  await c.get('/api/me');
  return c;
}
const setPlan = (email, plan) => q.run("UPDATE workspaces SET plan_code = ?, sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = (SELECT workspace_id FROM users WHERE email = ?)", plan, Date.now() + 864e5, email);
const setType = (email, t) => q.run('UPDATE workspaces SET account_type = ? WHERE id = (SELECT workspace_id FROM users WHERE email = ?)', t, email);
const exportsOf = email => q.get('SELECT COUNT(*) n FROM exports WHERE user_id = (SELECT id FROM users WHERE email = ?)', email).n;
const form = (fields, img = jpg, name = 'p.jpg') => { const f = new FormData(); if (img) f.append('image', new Blob([img], { type: 'image/jpeg' }), name); for (const [k, v] of Object.entries(fields)) f.append(k, v); return f; };

test.before(async () => {
  await ensureAdmin();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('review portal: send sizes, client link, approve / changes, revoke', async () => {
  const a = await signup('Pixel Agency', 'agency@example.com');
  // retail / free accounts are blocked
  let kit = (await a.post('/api/brand-kits', { name: 'Glow Co', color: '#c2185b' })).data;
  let d = (await a.post('/api/designs', { name: 'Serum launch', brand_kit_id: kit.id, data: {} })).data;
  let r = await a.post(`/api/reviews/designs/${d.id}/snapshots`, form({ platform: 'ig_post' }));
  assert.equal(r.status, 400, 'retail account blocked'); assert.equal(r.data.code, 'business_only');
  setType('agency@example.com', 'business');
  r = await a.post(`/api/reviews/designs/${d.id}/snapshots`, form({ platform: 'ig_post' }));
  assert.equal(r.status, 402, 'free plan blocked');
  r = await a.post(`/api/brand-kits/${kit.id}/review-links`, {});
  assert.equal(r.status, 402);
  setPlan('agency@example.com', 'agency');

  // portal look
  r = await a.put('/api/workspace/portal', { portal_name: 'Pixel Studio', portal_color: '#0055aa' });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  // snapshots: bad size, bad file, good ones (each counts as a download)
  r = await a.post(`/api/reviews/designs/${d.id}/snapshots`, form({ platform: 'nope' }));
  assert.equal(r.status, 400);
  r = await a.post(`/api/reviews/designs/${d.id}/snapshots`, form({ platform: 'ig_post' }, Buffer.from('not an image')));
  assert.equal(r.status, 415);
  r = await a.post(`/api/reviews/designs/${d.id}/send`, {});
  assert.equal(r.status, 400, 'needs a size first');
  const before = exportsOf('agency@example.com');
  for (const p of ['ig_post', 'ig_story']) assert.equal((await a.post(`/api/reviews/designs/${d.id}/snapshots`, form({ platform: p }))).status, 201);
  assert.equal(exportsOf('agency@example.com') - before, 2, 'sizes count as downloads');
  // re-sending a size replaces it
  await a.post(`/api/reviews/designs/${d.id}/snapshots`, form({ platform: 'ig_post' }));
  assert.equal(q.get('SELECT COUNT(*) n FROM review_snapshots WHERE design_id = ?', d.id).n, 2);
  r = await a.post(`/api/reviews/designs/${d.id}/send`, { note: 'First draft for you' });
  assert.equal(r.status, 200); assert.equal(r.data.hasLink, false);

  // the link
  r = await a.post(`/api/brand-kits/${kit.id}/review-links`, { days: 30 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const url = r.data.url, token = url.split('/r/')[1], linkId = r.data.id;
  assert.match(token, /^rv_/);
  assert.equal(q.get('SELECT COUNT(*) n FROM review_links WHERE token_hash LIKE ?', token).n, 0, 'token is not stored in plain text');

  // portal page + data (no login)
  const page = await fetch(`${base}/r/${token}`);
  assert.equal(page.status, 200); assert.match(page.headers.get('x-robots-tag'), /noindex/);
  const pc = client();
  r = await pc.get(`/portal-api/${token}`);
  assert.equal(r.status, 200);
  assert.equal(r.data.portal.name, 'Pixel Studio'); assert.equal(r.data.portal.color, '#0055aa');
  assert.ok(!JSON.stringify(r.data).includes('PostForge'), 'white-label: no PostForge branding');
  assert.equal(r.data.designs.length, 1);
  const dd = r.data.designs[0];
  assert.equal(dd.status, 'in_review'); assert.equal(dd.snapshots.length, 2); assert.equal(dd.comments[0].body, 'First draft for you');
  const img = await fetch(base + dd.snapshots[0].url + '?download=1');
  assert.equal(img.status, 200); assert.match(img.headers.get('content-disposition'), /serum-launch-ig_(post|story)\.jpg/);

  // other workspace's design is invisible; bad token 404
  r = await pc.get('/portal-api/rv_' + 'x'.repeat(30));
  assert.equal(r.status, 404);

  // client actions
  r = await pc.post(`/portal-api/${token}/designs/${d.id}/changes`, { name: 'Sita' });
  assert.equal(r.status, 400, 'changes needs a note');
  r = await pc.post(`/portal-api/${token}/designs/${d.id}/approve`, { body: 'ok' });
  assert.equal(r.status, 400, 'needs a name');
  r = await pc.post(`/portal-api/${token}/designs/${d.id}/changes`, { name: 'Sita', body: 'Make the logo bigger' });
  assert.equal(r.status, 201); assert.equal(r.data.status, 'changes');
  r = await pc.post(`/portal-api/${token}/designs/${d.id}/approve`, { name: 'Sita' });
  assert.equal(r.status, 201); assert.equal(r.data.status, 'approved');
  r = await a.get(`/api/reviews/designs/${d.id}`);
  assert.equal(r.data.status, 'approved');
  assert.deepEqual(r.data.comments.map(c => c.action), ['sent', 'changes', 'approved']);
  r = await a.get('/api/designs');
  const listed = (r.data.designs || r.data).find(x => x.id === d.id);
  assert.equal(listed.review_status, 'approved');

  // revoke → link dead
  assert.equal((await a.del(`/api/review-links/${linkId}`)).status, 200);
  assert.equal((await pc.get(`/portal-api/${token}`)).status, 404);

  // expired link → dead
  r = await a.post(`/api/brand-kits/${kit.id}/review-links`, { days: 7 });
  const t2 = r.data.url.split('/r/')[1];
  assert.equal((await pc.get(`/portal-api/${t2}`)).status, 200);
  q.run('UPDATE review_links SET expires_at = ? WHERE id = ?', Date.now() - 1000, r.data.id);
  assert.equal((await pc.get(`/portal-api/${t2}`)).status, 404);

  // downgrade to free → links stop working
  r = await a.post(`/api/brand-kits/${kit.id}/review-links`, {});
  const t3 = r.data.url.split('/r/')[1];
  setPlan('agency@example.com', 'free');
  assert.equal((await pc.get(`/portal-api/${t3}`)).status, 404);
  setPlan('agency@example.com', 'agency');
});

test('developer API: keys, auth, resize, cut-out, captions', async () => {
  const b = await signup('Shop Owner', 'shopapi@example.com');
  let r = await b.post('/api/api-keys', { kind: 'secret' });
  assert.equal(r.status, 402, 'free plan has no API');
  setPlan('shopapi@example.com', 'pro');
  assert.equal((await b.post('/api/api-keys', { kind: 'secret' })).status, 402, 'pro has no API');
  setPlan('shopapi@example.com', 'business');
  r = await b.post('/api/api-keys', { kind: 'secret', name: 'Server' });
  assert.equal(r.status, 201); assert.equal(r.data.shownOnce, true);
  const key = r.data.key; assert.match(key, /^pf_live_/);
  r = await b.get('/api/api-keys');
  assert.equal(r.data.keys[0].key, null, 'secret key is never shown again');
  assert.equal(q.get('SELECT key_enc FROM api_keys WHERE id = ?', r.data.keys[0].id).key_enc, null);

  const v1 = (method, url, body, extra = {}) => client().call(method, url, body, { headers: { authorization: `Bearer ${key}`, ...extra } });
  // auth
  assert.equal((await client().get('/api/v1/me')).status, 401);
  assert.equal((await client().get('/api/v1/me', { headers: { authorization: 'Bearer pf_live_' + 'x'.repeat(30) } })).status, 401);
  assert.equal((await b.get('/api/v1/me')).status, 401, 'cookies are not accepted');
  r = await v1('GET', '/api/v1/me');
  assert.equal(r.status, 200); assert.equal(r.data.plan.code, 'business');
  assert.equal((await v1('GET', '/api/v1/sizes')).data.length, 14);
  assert.equal((await v1('GET', '/api/v1/nope')).status, 404);

  // resize: one size → image of the right size
  const before = exportsOf('shopapi@example.com');
  r = await v1('POST', '/api/v1/resize', form({ sizes: 'ig_story', background: 'blur' }));
  assert.equal(r.status, 200, String(r.data));
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.ok(r.headers.get('x-postforge-downloads-left'));
  const probe = require('../server/imaging').probe;
  const f = path.join(tmp, 'o.jpg'); fs.writeFileSync(f, r.data);
  const pr = await probe(f); assert.equal(pr.w, 1080); assert.equal(pr.h, 1920);
  // several → zip
  r = await v1('POST', '/api/v1/resize', form({ sizes: 'ig_post,fb_cover,yt_thumb', fit: 'cover', format: 'png' }));
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /zip/);
  const zip = await require('jszip').loadAsync(r.data);
  assert.deepEqual(Object.keys(zip.files).sort(), ['fb_cover_851x315.png', 'ig_post_1080x1080.png', 'yt_thumb_1280x720.png']);
  assert.equal(exportsOf('shopapi@example.com') - before, 4, 'each output file counts');
  // validation
  assert.equal((await v1('POST', '/api/v1/resize', form({ sizes: 'bogus' }))).status, 400);
  assert.equal((await v1('POST', '/api/v1/resize', form({}, Buffer.from('hello')))).status, 415);
  assert.equal((await v1('POST', '/api/v1/resize', form({ background: 'transparent' }))).status, 400);
  assert.equal((await v1('POST', '/api/v1/resize', form({ background: 'brand' }))).status, 400);

  // remove background → PNG
  r = await v1('POST', '/api/v1/remove-background', form({}));
  assert.equal(r.status, 200, String(r.data)); assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.data.toString('ascii', 1, 4), 'PNG');

  // captions
  r = await v1('POST', '/api/v1/captions', { product: 'Rose Serum', platforms: ['instagram'] }, { 'content-type': 'application/json' });
  assert.equal(r.status, 200, JSON.stringify(r.data)); assert.ok(r.data.captions.instagram.text);

  // quota: a full allowance returns 402 with code quota
  const ql = q.get("SELECT quota_limit FROM plans WHERE code = 'business'").quota_limit;
  q.run("UPDATE plans SET quota_limit = 1 WHERE code = 'business'");
  try {
    r = await v1('POST', '/api/v1/resize', form({ sizes: 'ig_post' }));
    assert.equal(r.status, 402); assert.equal(r.data.code, 'quota');
  } finally { q.run("UPDATE plans SET quota_limit = ? WHERE code = 'business'", ql); }

  // downgrade → 402, delete → 401
  setPlan('shopapi@example.com', 'pro');
  assert.equal((await v1('GET', '/api/v1/me')).status, 402);
  setPlan('shopapi@example.com', 'business');
  const id = (await b.get('/api/api-keys')).data.keys[0].id;
  assert.equal((await b.del(`/api/api-keys/${id}`)).status, 200);
  assert.equal((await v1('GET', '/api/v1/me')).status, 401);
});

test('website widget: publishable key, framing only on listed sites, downloads counted', async () => {
  const c = await signup('Widget Shop', 'widget@example.com');
  setPlan('widget@example.com', 'agency');
  let r = await c.post('/api/api-keys', { kind: 'publishable', origins: 'not a site' });
  assert.equal(r.status, 400);
  r = await c.post('/api/api-keys', { kind: 'publishable', origins: 'https://www.myshop.com/, https://myshop.com' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const key = r.data.key; assert.match(key, /^pf_pub_/);
  assert.deepEqual(r.data.origins, ['https://www.myshop.com', 'https://myshop.com']);
  assert.equal((await c.get('/api/api-keys')).data.keys[0].key, key, 'publishable key can be shown again');

  // a publishable key can't use the server API
  assert.equal((await client().get('/api/v1/me', { headers: { authorization: `Bearer ${key}` } })).status, 401);

  const js = await fetch(base + '/widget.js');
  assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);

  let p = await fetch(`${base}/embed?key=${key}`);
  assert.equal(p.status, 200);
  const csp = p.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors https:\/\/www\.myshop\.com https:\/\/myshop\.com/);
  assert.equal(p.headers.get('x-frame-options'), null);
  assert.equal((await fetch(`${base}/embed?key=pf_pub_${'x'.repeat(20)}`)).status, 404);
  // the rest of the app still can't be framed
  assert.match((await fetch(base + '/login')).headers.get('content-security-policy'), /frame-ancestors 'none'/);

  r = await client().get(`/embed-api/config?key=${key}`);
  assert.equal(r.status, 200); assert.match(r.data.name, /Widget Shop/); assert.equal(r.data.sizes.length, 14);

  const pub = client();
  const before = exportsOf('widget@example.com');
  r = await pub.post('/embed-api/authorise', { key, sizes: ['ig_post', 'ig_story', 'bogus'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(exportsOf('widget@example.com') - before, 2);
  r = await pub.post('/embed-api/authorise', { key, sizes: ['ig_post'] }, { headers: { origin: 'https://evil.example' } });
  assert.equal(r.status, 403, 'other sites cannot call authorise directly');
  r = await pub.post('/embed-api/authorise', { key, sizes: [] });
  assert.equal(r.status, 400);

  // owner downgrades → widget disappears
  setPlan('widget@example.com', 'starter');
  assert.equal((await fetch(`${base}/embed?key=${key}`)).status, 404);
  assert.equal((await pub.post('/embed-api/authorise', { key, sizes: ['ig_post'] })).status, 404);
});

test('developers page and sitemap', async () => {
  const r = await fetch(base + '/developers');
  assert.equal(r.status, 200); assert.match(await r.text(), /api\/v1\/resize/);
  assert.match(await (await fetch(base + '/sitemap.xml')).text(), /\/developers/);
});
