'use strict';
/* AI studio: free 3-image lifetime limit, credits refunded on failure, product links (with private-address
   blocking), results opened as designs, admin kill switch / budget / styles, demo top-up. */
const fs = require('node:fs');
const os = require('node:os');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-ai-'));
Object.assign(process.env, { DATA_DIR: tmp, NODE_ENV: 'test', ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'RootPassword123' });
delete process.env.GEMINI_API_KEY; delete process.env.OPENAI_API_KEY;
const { app, ensureAdmin } = require('../server/index.js');
const { q } = require('../server/db.js');
const { hotp } = require('../server/security.js');
const providers = require('../server/ai/providers.js');
const { buildPrompt } = require('../server/ai/prompts.js');
const ai = require('../server/ai');

let base, server, shop;
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
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b), patch: (u, b) => call('PATCH', u, b) };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitJob(c, id) {
  for (let i = 0; i < 120; i++) {
    const r = await c.get('/api/ai/jobs/' + id);
    if (!['queued', 'running'].includes(r.data.job.status)) return r.data;
    await sleep(250);
  }
  throw new Error('job never finished');
}
async function signup(name, email) {
  const c = client();
  const r = await c.post('/api/auth/signup', { name, email, password: 'AiStudio2026!', acceptTerms: true });
  assert.equal(r.status, 201);
  q.run('UPDATE users SET email_verified = 1 WHERE email = ?', email);
  await c.get('/api/me');
  return c;
}

test.before(async () => {
  await ensureAdmin();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
  // a pretend online shop page for the "paste a link" feature
  shop = http.createServer((req, res) => {
    if (req.url === '/p.png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(PNG); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>Shop</title><meta property="og:image" content="/p.png">
      <script type="application/ld+json">{"@type":"Product","name":"Jasmine Rice 5kg","description":"Fragrant long grain rice.","brand":{"name":"Lotus"},"offers":{"price":"18.50","priceCurrency":"AUD"}}</script></head><body>hi</body></html>`);
  });
  await new Promise(r => shop.listen(0, '127.0.0.1', r));
});
test.after(() => { server.close(); shop.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('prompts never ask for text and keep the real product', () => {
  const tpl = ai.templates().find(t => t.key === 'shop_studio');
  const p = buildPrompt(tpl, { product: 'Mug <script>{x}', details: '', colours: 'teal' }, { hasPhoto: true, aspect: '1:1' });
  assert.match(p, /NO LETTERING/);
  assert.match(p, /only exception: print that is physically on the real product/);
  // no style may invite the model to draw words; without a photo the product must be unbranded
  for (const t of ai.templates()) {
    for (const hasPhoto of [true, false]) {
      const x = buildPrompt(t, { product: 'Rose serum' }, { hasPhoto, aspect: '4:5' });
      assert.ok(!/headline|menu text|offer|label crisp|readable|text will|sale-campaign/i.test(x), t.key + ' invites lettering');
      assert.match(x, /never write them anywhere/);
      if (!hasPhoto) assert.match(x, /must be blank/);
    }
  }
  assert.match(p, /exact/i);
  assert.ok(!p.includes('<script>') && !p.includes('{x}'), 'user words are cleaned');
  assert.ok(!/\{(product|details|setting|colours|mood)\}/.test(p), 'every placeholder is filled');
  assert.equal(providers.active(), 'demo');
});

test('free plan: 5 AI images for life, failures refunded, results open in the editor', { timeout: 120000 }, async () => {
  const c = await signup('Fay', 'fay@example.com');
  let r = await c.get('/api/ai/options');
  assert.equal(r.status, 200);
  assert.ok(r.data.templates.length >= 15);
  assert.equal(r.data.credits.left, 5);
  assert.equal(r.data.demo, true);

  // checks
  r = await c.post('/api/ai/jobs', { template: 'shop_studio' });
  assert.equal(r.status, 400, 'needs a photo or product name');
  r = await c.post('/api/ai/jobs', { template: 'food_menu_board', product: 'Momo' });
  assert.equal(r.status, 400, 'food styles need a real photo');
  r = await c.post('/api/ai/jobs', { template: 'nope', product: 'Momo' });
  assert.equal(r.status, 400);

  // a failure gives the credit back
  const real = providers.generate;
  providers.generate = async () => { throw new providers.AiError('The AI service is busy.', 'busy', 'HTTP 429'); };
  r = await c.post('/api/ai/jobs', { template: 'shop_studio', product: 'Ceramic mug', aspect: '1:1' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  let done = await waitJob(c, r.data.job.id);
  assert.equal(done.job.status, 'failed');
  assert.ok(!done.job.error.includes('429'), 'technical details are hidden from customers');
  assert.equal(done.credits.left, 5, 'failed image is refunded');
  providers.generate = real;

  // two images with a photo upload
  const f = new FormData();
  f.append('photo', new Blob([PNG]), 'mug.png');
  f.append('template', 'shop_studio'); f.append('product', 'Ceramic mug'); f.append('aspect', '4:5'); f.append('count', '2');
  r = await c.post('/api/ai/jobs', f);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  done = await waitJob(c, r.data.job.id);
  assert.equal(done.job.status, 'done', done.job.error);
  assert.equal(done.job.outputs.length, 2);
  assert.equal(done.credits.left, 3);
  const img = await c.get(done.job.outputs[0].url);
  assert.equal(img.status, 200);
  assert.ok(img.data.length > 1000);
  r = await c.get(done.job.outputs[0].url + '?download=1');
  assert.equal(r.status, 402, 'free plan downloads go through the editor (watermark)');

  // someone else can't see it
  const other = await signup('Oz', 'oz@example.com');
  r = await other.get(done.job.outputs[0].url);
  assert.equal(r.status, 404);
  r = await other.get('/api/ai/jobs/' + done.job.id);
  assert.equal(r.status, 404);

  // open in the editor → new design + media
  r = await c.post(`/api/ai/jobs/${done.job.id}/design`, { n: 1 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const d = await c.get('/api/designs/' + r.data.designId);
  assert.equal(d.status, 200);
  const data = typeof d.data.data === 'string' ? JSON.parse(d.data.data) : (d.data.design ? JSON.parse(d.data.design.data) : d.data.data);
  assert.equal(data.mediaId, r.data.mediaId);
  assert.equal(data.platformKey, 'ig_portrait');
  assert.equal(data.headline, 'Ceramic mug');

  // use two more, then the last free image, then the limit
  r = await c.post('/api/ai/jobs', { template: 'festive_lights', product: 'Gift box', count: 2 });
  assert.equal(r.status, 201);
  await waitJob(c, r.data.job.id);
  r = await c.post('/api/ai/jobs', { template: 'festive_lights', product: 'Gift box', count: 2 });
  assert.equal(r.status, 402, 'only 1 left, 2 asked');
  r = await c.post('/api/ai/jobs', { template: 'festive_lights', product: 'Gift box' });
  assert.equal(r.status, 201);
  await waitJob(c, r.data.job.id);
  r = await c.post('/api/ai/jobs', { template: 'festive_lights', product: 'Gift box' });
  assert.equal(r.status, 402);
  assert.equal(r.data.code, 'ai_credits');
  assert.match(r.data.error, /5 free/);

  // credit pack (demo billing adds the credits straight away)
  r = await c.post('/api/billing/ai-topup', {});
  assert.equal(r.status, 200);
  assert.equal(r.data.mode, 'demo');
  r = await c.get('/api/ai/credits');
  assert.equal(r.data.left, 100);
  assert.equal(r.data.topup, 100);
});

test('quality check: images with lettering or a changed product are redone, then refunded', { timeout: 60000 }, async () => {
  // verdict parsing
  assert.deepEqual(providers.parseVerdict('{"text_added":true,"product_ok":true}', false).problems, ['lettering']);
  assert.equal(providers.parseVerdict('```json {"text_added":false,"label_changed":false,"same_product":true,"product_ok":true} ```', true).ok, true);
  assert.deepEqual(providers.parseVerdict('{"text_added":false,"label_changed":true,"same_product":true,"product_ok":true}', true).problems, ['label changed']);
  assert.equal(providers.parseVerdict('no idea', true), null);

  const c = await signup('Quinn', 'quinn@example.com');
  const ws = q.get("SELECT workspace_id FROM users WHERE email = 'quinn@example.com'").workspace_id;
  q.run("UPDATE workspaces SET plan_code = 'pro', sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = ?", Date.now() + 864e5, ws);
  const real = { active: providers.active, generate: providers.generate, checkImage: providers.checkImage };
  let made = 0, verdicts = [];
  providers.active = () => 'gemini';
  providers.generate = async ({ n = 1 }) => { const images = []; for (let i = 0; i < n; i++) { made++; images.push(Buffer.concat([PNG, Buffer.alloc(2000, made)])); } return { images, provider: 'gemini', model: 'test', costUsd: 0.067 * n }; };
  providers.checkImage = async () => verdicts.shift() ?? { ok: true, problems: [] };
  const BAD = { ok: false, problems: ['lettering'] }, GOOD = { ok: true, problems: [] };
  try {
    // first try has writing, the redo is clean → delivered
    verdicts = [BAD, GOOD]; made = 0;
    let r = await c.post('/api/ai/jobs', { template: 'shop_studio', product: 'Lamp' });
    let d = await waitJob(c, r.data.job.id);
    assert.equal(d.job.status, 'done');
    assert.equal(d.job.outputs.length, 1);
    assert.equal(made, 2, 'made again once');
    let row = q.get('SELECT * FROM ai_jobs WHERE id = ?', r.data.job.id);
    assert.equal(row.redone, 1); assert.equal(row.rejected, 0); assert.equal(row.credits, 1);
    assert.equal(d.credits.used, 1);

    // two options: one keeps failing → only the clean one is delivered, 1 credit back
    verdicts = [GOOD, BAD, BAD];
    r = await c.post('/api/ai/jobs', { template: 'shop_studio', product: 'Lamp', count: 2 });
    d = await waitJob(c, r.data.job.id);
    assert.equal(d.job.status, 'done');
    assert.equal(d.job.outputs.length, 1);
    row = q.get('SELECT * FROM ai_jobs WHERE id = ?', r.data.job.id);
    assert.equal(row.credits, 1); assert.equal(row.rejected, 1);
    assert.equal(d.credits.used, 2);

    // never clean → failed with a clear message, all credits back
    verdicts = [BAD, BAD];
    r = await c.post('/api/ai/jobs', { template: 'shop_studio', product: 'Lamp' });
    d = await waitJob(c, r.data.job.id);
    assert.equal(d.job.status, 'failed');
    assert.match(d.job.error, /credits were returned/);
    assert.equal(d.credits.used, 2);

    // checker unavailable → image kept
    verdicts = [null];
    providers.checkImage = async () => null;
    r = await c.post('/api/ai/jobs', { template: 'shop_studio', product: 'Lamp' });
    d = await waitJob(c, r.data.job.id);
    assert.equal(d.job.status, 'done');
  } finally { Object.assign(providers, real); }
});

test('AI video: Pro only, from an AI image or a photo, cropped to the post shape, checked, refunded on failure', { timeout: 180000, skip: !require('../server/video').available() && 'ffmpeg not available here' }, async () => {
  const videogen = require('../server/ai/videogen.js');
  const { buildVideoPrompt } = require('../server/ai/prompts.js');
  const vt = ai.templates(true).filter(t => t.kind === 'video');
  assert.ok(vt.length >= 8);
  for (const t of vt) {
    const p = buildVideoPrompt(t, { product: 'Rose serum' }, { seconds: 6 });
    assert.match(p, /PRODUCT IS RIGID/); assert.match(p, /NO LETTERING/); assert.match(p, /6-second/);
    assert.ok(!/headline|caption it|title card/i.test(p), t.key);
  }

  // free & starter: not allowed
  const f = await signup('Vic', 'vic@example.com');
  let r = await f.post('/api/ai/videos', { template: 'vid_push_in' });
  assert.equal(r.status, 402);
  assert.equal(r.data.code, 'ai_video_plan');
  r = await f.get('/api/ai/options');
  assert.equal(r.data.video.allowed, false);
  assert.ok(!r.data.templates.some(t => t.kind === 'video'), 'image list has no video motions');

  const c = await signup('Val', 'val@example.com');
  const ws = q.get("SELECT workspace_id FROM users WHERE email = 'val@example.com'").workspace_id;
  q.run("UPDATE workspaces SET plan_code = 'pro', sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = ?", Date.now() + 864e5, ws);
  r = await c.get('/api/ai/options');
  assert.equal(r.data.video.allowed, true);
  assert.equal(r.data.video.credits, 10);

  // an AI image first
  r = await c.post('/api/ai/jobs', { template: 'shop_studio', product: 'Desk lamp', aspect: '4:5' });
  const img = await waitJob(c, r.data.job.id);
  assert.equal(img.job.status, 'done');
  // video motions can't be used as image styles and vice versa
  r = await c.post('/api/ai/jobs', { template: 'vid_push_in', product: 'Lamp' });
  assert.equal(r.status, 400);
  r = await c.post('/api/ai/videos', { template: 'shop_studio', fromJob: img.job.id });
  assert.equal(r.status, 400);
  r = await c.post('/api/ai/videos', { template: 'vid_push_in' });
  assert.equal(r.status, 400, 'needs a start picture');
  const other = await signup('Wes', 'wes@example.com');
  q.run("UPDATE workspaces SET plan_code = 'pro', sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = (SELECT workspace_id FROM users WHERE email = 'wes@example.com')", Date.now() + 864e5);
  r = await other.post('/api/ai/videos', { template: 'vid_push_in', fromJob: img.job.id });
  assert.equal(r.status, 404, "can't start from someone else's image");

  // demo video from the AI image, 4:5 feed
  r = await c.post('/api/ai/videos', { template: 'vid_push_in', fromJob: img.job.id, n: 0, aspect: '4:5', seconds: 4 });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.credits.used, 11);
  let d = await waitJob(c, r.data.job.id);
  assert.equal(d.job.status, 'done', d.job.error);
  assert.equal(d.job.kind, 'video');
  assert.equal(d.job.inputs.product, 'Desk lamp', 'product name carried over');
  const mp4 = await c.get(d.job.outputs[0].url);
  assert.equal(mp4.status, 200);
  const probe = require('node:child_process').spawnSync(require('ffmpeg-static'), ['-hide_banner', '-i', 'pipe:0'], { input: mp4.data });
  const info = String(probe.stderr);
  assert.match(info, /h264/); assert.match(info, /1080x1350/); assert.ok(!/Audio:/.test(info), 'silent');
  assert.match(info, /Duration: 00:00:0[34]/);
  const poster = await c.get(d.job.outputs[0].poster);
  assert.equal(poster.status, 200); assert.equal(poster.data[0], 0xff);
  // into the editor as a video design
  r = await c.post(`/api/ai/jobs/${d.job.id}/design`, { n: 0 });
  assert.equal(r.status, 201);
  assert.equal(q.get('SELECT kind FROM media WHERE id = ?', r.data.mediaId).kind, 'video');

  // uploaded photo, story shape; pretend Veo: first clip fails the check, second passes
  const realV = { active: videogen.active, veoStart: videogen.veoStart, veoWait: videogen.veoWait };
  const realCheck = providers.checkImage;
  const keyBefore = require('../server/config').ai.geminiKey;
  const demoRaw = await videogen.demoClip({ png: (await videogen.prepareStart(fs.readFileSync(path.join(__dirname, '..', 'public', 'img', 'favicon.png')), '9:16', tmp)).png, gen: '9:16', seconds: 4, dir: tmp });
  let starts = 0, checks = [];
  videogen.active = () => 'veo';
  videogen.veoStart = async () => `operations/op-${++starts}`;
  videogen.veoWait = async () => demoRaw;
  providers.checkImage = async () => checks.shift() ?? { ok: true, problems: [] };
  require('../server/config').ai.geminiKey = 'test-key';
  try {
    checks = [{ ok: false, problems: ['lettering'] }];
    const fd = new FormData();
    fd.append('photo', new Blob([PNG]), 'lamp.png'); fd.append('template', 'vid_light_sweep'); fd.append('aspect', '9:16'); fd.append('seconds', '4'); fd.append('product', 'Lamp');
    r = await c.post('/api/ai/videos', fd);
    assert.equal(r.status, 201, JSON.stringify(r.data));
    d = await waitJob(c, r.data.job.id);
    assert.equal(d.job.status, 'done', d.job.error);
    assert.equal(starts, 2, 'made again once');
    let row = q.get('SELECT * FROM ai_jobs WHERE id = ?', r.data.job.id);
    assert.equal(row.redone, 1); assert.equal(row.remote_op, '');
    assert.ok(row.cost_usd >= 0.8, 'two 4 s clips counted');

    // keeps failing → refunded, spend still counted for the budget
    const before = (await c.get('/api/ai/credits')).data.used;
    checks = [{ ok: false, problems: ['label changed'] }, { ok: false, problems: ['label changed'] }];
    r = await c.post('/api/ai/videos', { template: 'vid_orbit', fromJob: img.job.id, aspect: '1:1', seconds: 4 });
    d = await waitJob(c, r.data.job.id);
    assert.equal(d.job.status, 'failed');
    assert.match(d.job.error, /credits were returned/);
    assert.equal((await c.get('/api/ai/credits')).data.used, before);
    row = q.get('SELECT * FROM ai_jobs WHERE id = ?', r.data.job.id);
    assert.ok(row.cost_usd > 0);

    // service error → refunded, nothing spent
    videogen.veoStart = async () => { throw new providers.AiError('busy', 'busy'); };
    r = await c.post('/api/ai/videos', { template: 'vid_orbit', fromJob: img.job.id, seconds: 4 });
    d = await waitJob(c, r.data.job.id);
    assert.equal(d.job.status, 'failed');
    assert.equal(q.get('SELECT cost_usd FROM ai_jobs WHERE id = ?', r.data.job.id).cost_usd, 0);
  } finally {
    Object.assign(videogen, realV); providers.checkImage = realCheck; require('../server/config').ai.geminiKey = keyBefore;
  }
});

test('own videos without AI: Starter up to 30 s / 50 MB, Free photos only, AI video stays Pro', { timeout: 90000, skip: !require('../server/video').available() && 'ffmpeg not available here' }, async () => {
  const { spawnSync } = require('node:child_process');
  const mk = secs => { const f = path.join(tmp, `clip-${secs}.mp4`);
    spawnSync(require('ffmpeg-static'), ['-y', '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=5:duration=${secs}`, '-c:v', 'libx264', '-preset', 'ultrafast', f]);
    return fs.readFileSync(f); };
  const short = mk(5), long = mk(32);
  const up = (c, buf) => { const fd = new FormData(); fd.append('file', new Blob([buf], { type: 'video/mp4' }), 'clip.mp4'); return c.post('/api/media', fd); };

  const free = await signup('Fia', 'fia@example.com');
  let r = await up(free, short);
  assert.equal(r.status, 402, 'free plan: photos only');

  const s = await signup('Sam', 'sam@example.com');
  q.run("UPDATE workspaces SET plan_code = 'starter', sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = (SELECT workspace_id FROM users WHERE email = 'sam@example.com')", Date.now() + 864e5);
  r = await up(s, short);
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.kind, 'video');
  r = await up(s, long);
  assert.equal(r.status, 413);
  assert.equal(r.data.code, 'video_too_long');
  assert.match(r.data.error, /30 seconds/);
  assert.equal(q.get("SELECT COUNT(*) n FROM media m JOIN users u ON u.workspace_id = m.workspace_id WHERE u.email = 'sam@example.com'").n, 1, 'too-long file not kept');
  r = await s.post('/api/exports', { items: [{ platform: 'ig_story', kind: 'video' }], quality: 1 });
  assert.equal(r.status, 200, 'Starter can download video posts');
  // AI videos are still Pro / Business
  r = await s.get('/api/ai/options');
  assert.equal(r.data.video.allowed, false);
  r = await s.post('/api/ai/videos', { template: 'vid_push_in' });
  assert.equal(r.status, 402);

  // Pro: longer videos fine
  const p = await signup('Pat', 'pat@example.com');
  q.run("UPDATE workspaces SET plan_code = 'pro', sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = (SELECT workspace_id FROM users WHERE email = 'pat@example.com')", Date.now() + 864e5);
  r = await up(p, long);
  assert.equal(r.status, 201);
});

test('paid plan: monthly credits per seat', async () => {
  const c = await signup('Pia', 'pia@example.com');
  const ws = q.get("SELECT workspace_id FROM users WHERE email = 'pia@example.com'").workspace_id;
  q.run("UPDATE workspaces SET plan_code = 'pro', seats = 2, sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = ?", Date.now() + 864e5, ws);
  const r = await c.get('/api/ai/credits');
  assert.equal(r.data.period, 'month');
  assert.equal(r.data.included, 300);
  const plans = await c.get('/api/billing/plans');
  const biz = plans.data.plans.find(p => p.code === 'business');
  assert.ok(biz, 'business plan exists');
  assert.equal(biz.ai_credits_monthly, 400);
  assert.equal(plans.data.plans.find(p => p.code === 'free').ai_credits_lifetime, 5);
});

test('product link: reads the shop page, blocks private addresses', async () => {
  const c = await signup('Lin', 'lin@example.com');
  const url = `http://127.0.0.1:${shop.address().port}/item`;
  let r = await c.post('/api/ai/from-url', { url });
  assert.equal(r.status, 400, 'private/local addresses are refused');
  r = await c.post('/api/ai/from-url', { url: 'file:///etc/passwd' });
  assert.equal(r.status, 400);
  process.env.AI_URL_ALLOW_PRIVATE = '1';
  try {
    r = await c.post('/api/ai/from-url', { url });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.product, 'Jasmine Rice 5kg');
    assert.match(r.data.details, /Fragrant/);
    assert.match(String(r.data.price), /18\.50/);
    assert.match(r.data.photo || '', /^data:image\/png;base64,/);
  } finally { delete process.env.AI_URL_ALLOW_PRIVATE; }
});

test('admin: kill switch, budget, styles, test, credits', { timeout: 60000 }, async () => {
  const a = client();
  let r = await a.post('/api/auth/login', { email: 'root@example.com', password: 'RootPassword123' });
  assert.equal(r.status, 200);
  await a.get('/api/me');
  const setup = await a.post('/api/me/2fa/setup');
  r = await a.post('/api/me/2fa/enable', { code: hotp(setup.data.secret, Math.floor(Date.now() / 30000)) });
  assert.equal(r.status, 200);
  await a.get('/api/me');

  r = await a.get('/api/admin/ai');
  assert.equal(r.status, 200);
  assert.equal(r.data.provider, 'demo');
  assert.ok(r.data.today.images >= 3);
  const tpl = r.data.templates.find(t => t.key === 'shop_studio');

  // hide a style
  r = await a.put('/api/admin/ai/templates/' + tpl.id, { active: false });
  assert.equal(r.status, 200);
  const u = await signup('Kim', 'kim@example.com');
  r = await u.get('/api/ai/options');
  assert.ok(!r.data.templates.some(t => t.key === 'shop_studio'));
  r = await a.put('/api/admin/ai/templates/' + tpl.id, { active: true, prompt: 'short' });
  assert.equal(r.status, 400);
  r = await a.put('/api/admin/ai/templates/' + tpl.id, { active: true });
  assert.equal(r.status, 200);

  // kill switch
  r = await a.patch('/api/admin/ai/settings', { enabled: false });
  assert.equal(r.status, 200);
  r = await u.post('/api/ai/jobs', { template: 'shop_studio', product: 'Lamp' });
  assert.equal(r.status, 503);
  await a.patch('/api/admin/ai/settings', { enabled: true });

  // budget cap (demo costs nothing, so pretend the AI is a paid one)
  r = await a.patch('/api/admin/ai/settings', { dailyBudget: -1 });
  assert.equal(r.status, 400);
  await a.patch('/api/admin/ai/settings', { dailyBudget: 0 });
  const realCost = providers.COST.demo;
  providers.COST.demo = 0.05;
  r = await u.post('/api/ai/jobs', { template: 'shop_studio', product: 'Lamp' });
  providers.COST.demo = realCost;
  assert.equal(r.status, 503);
  assert.equal(r.data.code, 'ai_budget');
  await a.patch('/api/admin/ai/settings', { dailyBudget: 20 });

  // grant credits
  const ws = q.get("SELECT workspace_id FROM users WHERE email = 'kim@example.com'").workspace_id;
  r = await a.post(`/api/admin/workspaces/${ws}/ai-credits`, { credits: 7 });
  assert.equal(r.status, 200);
  assert.equal(r.data.balance, 7);
  r = await u.get('/api/ai/credits');
  assert.equal(r.data.left, 12);

  // connection test (demo)
  r = await a.post('/api/admin/ai/test', {});
  assert.equal(r.data.ok, true, JSON.stringify(r.data));
  assert.match(r.data.preview, /^data:image\//);

  // AI service keys entered in the admin panel: encrypted, never shown in full, switch the AI on and off
  const config = require('../server/config');
  const fakeGoogle = http.createServer((req, res) => {
    res.writeHead(req.headers['x-goog-api-key'] === 'AIzaTestKey_1234567890abcdWXYZ' ? 200 : 403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ models: [{ name: 'models/gemini-3.1-flash-image' }, { name: 'models/gemini-flash-latest' }] }));
  });
  await new Promise(res => fakeGoogle.listen(0, '127.0.0.1', res));
  const realBase = config.ai.geminiBase;
  config.ai.geminiBase = `http://127.0.0.1:${fakeGoogle.address().port}`;
  try {
    r = await a.get('/api/admin/ai/keys');
    assert.equal(r.data.keys.geminiKey.set, false);
    r = await a.put('/api/admin/ai/keys', { geminiKey: 'short' });
    assert.equal(r.status, 400);
    r = await a.put('/api/admin/ai/keys', { openaiKey: 'not-an-openai-key-1234567890' });
    assert.equal(r.status, 400);
    r = await a.put('/api/admin/ai/keys', { geminiKey: '  AIzaTestKey_1234567890abcdWXYZ ' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.active, 'gemini');
    assert.equal(r.data.videoActive, 'veo');
    assert.equal(r.data.keys.geminiKey.source, 'admin');
    assert.equal(r.data.keys.geminiKey.hint, '…WXYZ');
    assert.ok(!JSON.stringify(r.data).includes('AIzaTestKey'), 'full key never sent back');
    const stored = q.get("SELECT value FROM meta WHERE key = 'ai_settings'").value;
    assert.ok(!stored.includes('AIzaTestKey'), 'stored encrypted');
    assert.ok(!JSON.stringify(q.all("SELECT detail FROM audit_log WHERE action = 'admin.ai_keys'")).includes('AIzaTestKey'), 'not in the audit log');
    assert.equal(config.ai.geminiKey, 'AIzaTestKey_1234567890abcdWXYZ', 'in use straight away');
    r = await u.get('/api/ai/options');
    assert.equal(r.data.demo, false, 'customers now get real AI');
    // free key check lists the models
    r = await a.post('/api/admin/ai/keys/check', { which: 'gemini' });
    assert.equal(r.data.ok, true, JSON.stringify(r.data));
    assert.deepEqual(r.data.models.map(m => m.found), [true, false], 'image model found, Veo model not in this account');
    r = await a.post('/api/admin/ai/keys/check', { which: 'openai' });
    assert.equal(r.data.ok, false);
    // empty box keeps the saved key; model names can be changed
    r = await a.put('/api/admin/ai/keys', { geminiKey: '', veoModel: 'veo-3.1-lite-generate-preview' });
    assert.equal(r.data.keys.geminiKey.set, true);
    assert.equal(config.ai.veoModel, 'veo-3.1-lite-generate-preview');
    r = await a.put('/api/admin/ai/keys', { veoModel: 'bad model; rm' });
    assert.equal(r.status, 400);
    // ordinary users can't see or change keys
    assert.ok([403, 404].includes((await u.get('/api/admin/ai/keys')).status));
    assert.ok([403, 404].includes((await u.put('/api/admin/ai/keys', { geminiKey: 'AIzaOther_1234567890abcdefgh' })).status));
    // remove → back to demo
    r = await a.put('/api/admin/ai/keys', { clear_geminiKey: true, veoModel: '' });
    assert.equal(r.data.active, 'demo');
    assert.equal(config.ai.geminiKey, '');
    assert.equal(config.ai.veoModel, 'veo-3.1-fast-generate-preview', 'default restored');
  } finally { config.ai.geminiBase = realBase; fakeGoogle.close(); }

  // ordinary users can't reach any of it
  r = await u.get('/api/admin/ai');
  assert.ok([403, 404].includes(r.status));
  await new Promise(res => { const t = setInterval(() => { if (ai._queueIdle()) { clearInterval(t); res(); } }, 100); });
});
