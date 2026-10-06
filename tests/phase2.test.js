'use strict';
/* Phase 2: AI captions per platform, one-click design variations, bulk studio page. */
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-p2-'));
Object.assign(process.env, { DATA_DIR: tmp, NODE_ENV: 'test', ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'RootPassword123' });
delete process.env.GEMINI_API_KEY; delete process.env.OPENAI_API_KEY;
const { app, ensureAdmin } = require('../server/index.js');
const { q } = require('../server/db.js');
const config = require('../server/config.js');
const captions = require('../server/ai/captions.js');

let base, server;
function client() {
  let cookie = '', csrf = '';
  const call = async (method, url, body) => {
    const headers = {};
    if (cookie) headers.cookie = cookie;
    if (csrf && method !== 'GET') headers['x-csrf-token'] = csrf;
    let payload = body;
    if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) { const v = c.split(';')[0]; cookie = v.endsWith('=') ? '' : v; }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b) };
}
async function signup(name, email) {
  const c = client();
  const r = await c.post('/api/auth/signup', { name, email, password: 'PhaseTwo2026xx', acceptTerms: true });
  assert.equal(r.status, 201);
  q.run('UPDATE users SET email_verified = 1 WHERE email = ?', email);
  await c.get('/api/me');
  return c;
}
const upgrade = (email, plan) => q.run("UPDATE workspaces SET plan_code = ?, sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = (SELECT workspace_id FROM users WHERE email = ?)", plan, Date.now() + 864e5, email);

test.before(async () => {
  await ensureAdmin();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('captions: template without a key, AI with a key, free daily limit', async () => {
  const c = await signup('Cap', 'cap@example.com');
  let r = await c.post('/api/ai/captions', { platforms: ['instagram'] });
  assert.equal(r.status, 400, 'needs a product');
  r = await c.post('/api/ai/captions', { product: 'Rose Face Serum', price: 'Rs. 1,250', brand: 'Glow Co', platforms: ['instagram', 'linkedin', 'whatsapp', 'bogus'] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.source, 'template');
  assert.deepEqual(Object.keys(r.data.captions).sort(), ['instagram', 'linkedin', 'whatsapp']);
  assert.match(r.data.captions.instagram.text, /Rose Face Serum/);
  assert.match(r.data.captions.instagram.text, /Rs\. 1,250/);
  assert.equal(r.data.captions.whatsapp.hashtags.length, 0);

  // with a (fake) Gemini key: the AI answer is used, cleaned and capped
  let seen = null;
  const fake = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      seen = JSON.parse(b);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ captions: {
        instagram: { text: 'नयाँ गुलाब सिरम आयो! 🌹', hashtags: ['#GlowCo', 'skin care', '#GlowCo'] },
        linkedin: { text: 'Glow Co now supplies Rose Face Serum to salons.', hashtags: [] } } }) }] } }] }));
    });
  });
  await new Promise(res => fake.listen(0, '127.0.0.1', res));
  Object.assign(config.ai, { geminiKey: 'AIzaFake_1234567890abcdef', geminiBase: `http://127.0.0.1:${fake.address().port}` });
  try {
    r = await c.post('/api/ai/captions', { product: 'Rose Face Serum', language: 'Nepali', tone: 'luxury', platforms: ['instagram', 'linkedin', 'tiktok'] });
    assert.equal(r.data.source, 'gemini');
    assert.match(seen.contents[0].parts[0].text, /Nepali/);
    assert.match(seen.contents[0].parts[0].text, /never invent prices/);
    assert.equal(r.data.captions.instagram.text, 'नयाँ गुलाब सिरम आयो! 🌹');
    assert.deepEqual(r.data.captions.instagram.hashtags, ['#GlowCo', '#skincare']);
    assert.ok(r.data.captions.tiktok.text, 'missing platform filled from the template');
  } finally { Object.assign(config.ai, { geminiKey: '', geminiBase: 'https://generativelanguage.googleapis.com' }); fake.close(); }

  // free plan: 5 a day
  for (let i = 0; i < 2; i++) await c.post('/api/ai/captions', { product: 'Serum' });
  r = await c.post('/api/ai/captions', { product: 'Serum' });
  assert.equal(r.status, 200);
  assert.equal(r.data.left, 0);
  r = await c.post('/api/ai/captions', { product: 'Serum' });
  assert.equal(r.status, 429);
  assert.equal(r.data.code, 'captions_limit');
  assert.equal(captions.parse('nonsense', captions.sanitize({ platforms: ['x'] })), null);
});

test('variations: themed copies keep photo, price and brand', async () => {
  const c = await signup('Var', 'var@example.com');
  upgrade('var@example.com', 'pro');
  const kit = (await c.post('/api/brand-kits', { name: 'Momo House', color: '#c0392b' })).data;
  const src = (await c.post('/api/designs', { name: 'Momo', brand_kit_id: kit.id, data: { v: 1, mediaId: 'abc', headline: 'Chicken Momo', price: 'Rs. 199', theme: 'cafe' } })).data;
  let r = await c.get('/api/design-variations');
  assert.ok(r.data.some(v => v.key === 'flash_sale') && r.data.some(v => v.key === 'hiring'));
  r = await c.post(`/api/designs/${src.id}/variations`, { kinds: ['nope'] });
  assert.equal(r.status, 400);
  r = await c.post(`/api/designs/${src.id}/variations`, { kinds: ['flash_sale', 'review', 'hiring'] });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.designs.length, 3);
  const byName = Object.fromEntries(await Promise.all(r.data.designs.map(async d => [d.name, (await c.get('/api/designs/' + d.id)).data])));
  const flash = byName['Momo · Flash sale'];
  assert.equal(flash.data.headline, 'Flash Sale');
  assert.equal(flash.data.price, 'Rs. 199');
  assert.equal(flash.data.mediaId, 'abc');
  assert.equal(flash.brand_kit_id, kit.id);
  assert.equal(byName['Momo · Customer review'].data.contentType, 'review');
  assert.equal(byName["Momo · We're hiring"].data.price, '');
  // free plan design limit (5)
  const f = await signup('Fre', 'fre@example.com');
  const d1 = (await f.post('/api/designs', { name: 'A' })).data;
  r = await f.post(`/api/designs/${d1.id}/variations`, { kinds: ['flash_sale', 'new_arrival', 'best_seller', 'review', 'hiring'] });
  assert.equal(r.status, 402);
  // someone else's design
  r = await f.post(`/api/designs/${src.id}/variations`, { kinds: ['flash_sale'] });
  assert.equal(r.status, 404);
});

test('bulk studio page: signed-in only, AI link reader and downloads ready', async () => {
  const c = client();
  let r = await c.get('/bulk');
  assert.equal(r.status, 302);
  const u = await signup('Bulk', 'bulk@example.com');
  r = await u.get('/bulk');
  assert.equal(r.status, 200);
  assert.match(r.data, /Bulk studio/);
  const js = await (await fetch(base + '/js/bulk.js')).text();
  assert.match(js, /\/exports/);
  assert.match(js, /ai\/captions/);
});
