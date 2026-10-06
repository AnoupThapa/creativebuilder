'use strict';
/* AI models: made-up presenters with the customer's product (photos) and presenter videos with a script. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-aim-'));
Object.assign(process.env, { DATA_DIR: tmp, NODE_ENV: 'test', ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'RootPassword123' });
delete process.env.GEMINI_API_KEY; delete process.env.OPENAI_API_KEY;
const { app, ensureAdmin } = require('../server/index.js');
const { q } = require('../server/db.js');
const script = require('../server/ai/script.js');
const { buildModelPrompt, buildPresenterPrompt } = require('../server/ai/prompts.js');
const CH = require('../server/ai/characters.js');

let base, server;
const jpg = execFileSync(require('ffmpeg-static'), ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=400x400', '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', '-']);
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
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  };
  return { get: u => call('GET', u), post: (u, b) => call('POST', u, b) };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function waitJob(c, id) {
  for (let i = 0; i < 400; i++) {
    const r = await c.get('/api/ai/jobs/' + id);
    if (!['queued', 'running'].includes(r.data.job.status)) return r.data.job;
    await sleep(250);
  }
  throw new Error('job never finished');
}
async function signup(name, email, plan) {
  const c = client();
  assert.equal((await c.post('/api/auth/signup', { name, email, password: 'Kathmandu-Lights-26', acceptTerms: true })).status, 201);
  q.run('UPDATE users SET email_verified = 1 WHERE email = ?', email);
  if (plan) q.run("UPDATE workspaces SET plan_code = ?, sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = (SELECT workspace_id FROM users WHERE email = ?)", plan, Date.now() + 864e5, email);
  await c.get('/api/me');
  return c;
}
const form = (fields, img = jpg) => { const f = new FormData(); if (img) f.append('photo', new Blob([img], { type: 'image/jpeg' }), 'p.jpg'); for (const [k, v] of Object.entries(fields)) f.append(k, v); return f; };

test.before(async () => {
  await ensureAdmin();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('characters, prompts and the no-fake-testimonial rule', () => {
  assert.ok(CH.CHARACTERS.length >= 12);
  for (const c of CH.CHARACTERS) assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', 'img', 'characters', c.key + '.png')), c.key);
  const groups = new Set(CH.CHARACTERS.map(c => c.group));
  for (const g of ['Young adults', 'Professionals', 'Senior executives']) assert.ok(groups.has(g), g);
  const p = buildModelPrompt(CH.byKey('priya'), CH.ACTIONS.hold, CH.LOOKS.selfie, { product: 'Rose serum' }, { aspect: '9:16', hasPortrait: true });
  assert.match(p, /fictional adult/); assert.match(p, /FIRST attached image is the real PRODUCT/); assert.match(p, /NO LETTERING/);
  const v = buildPresenterPrompt(CH.byKey('robert'), 'studio', 'This is our new serum.', { seconds: 8, language: 'English' });
  assert.match(v, /says: "This is our new serum\."/); assert.match(v, /No on-screen text/); assert.match(v, /male voice/);
  // presenter, not a customer
  for (const bad of ["I've been using this for months", 'I bought three already', 'It changed my life', 'my skin feels great', 'As a happy customer, I love it'])
    assert.ok(CH.testimonialProblem(bad), bad);
  for (const ok of ['This serum has vitamin C and suits every skin type.', 'Your skin will feel fresh — order today!'])
    assert.equal(CH.testimonialProblem(ok), '', ok);
  assert.ok(script.check(['word '.repeat(60)], 8, 'English').problem, 'too long for 8 s');
  assert.deepEqual(script.check(['One. Two. Three. Four.'], 15, 'English').parts.length, 2, '15 s scripts are split into two parts');
});

test('AI model photo (demo): needs a product photo, uses 1 credit, opens in the editor', async () => {
  const c = await signup('Model User', 'model@example.com', 'pro');
  const opt = (await c.get('/api/ai/options')).data;
  assert.ok(opt.models.characters.find(x => x.key === 'helen'));
  assert.equal(opt.models.presenter.allowed, true);
  let r = await c.post('/api/ai/model-jobs', form({ character: 'helen', product: 'Candle' }, null));
  assert.equal(r.status, 400, 'needs a photo');
  r = await c.post('/api/ai/model-jobs', form({ character: 'nobody' }));
  assert.equal(r.status, 400);
  const before = (await c.get('/api/ai/credits')).data.left;
  r = await c.post('/api/ai/model-jobs', form({ character: 'helen', action: 'desk', look: 'selfie', aspect: '9:16', product: 'Amber candle', details: 'soy wax' }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const job = await waitJob(c, r.data.job.id);
  assert.equal(job.status, 'done', job.error);
  assert.equal(job.inputs.character, 'helen');
  assert.equal((await c.get('/api/ai/credits')).data.left, before - 1);
  const img = await c.get(job.outputs[0].url);
  assert.equal(img.status, 200);
  const d = await c.post(`/api/ai/jobs/${job.id}/design`, { n: 0 });
  assert.equal(d.status, 201);
  assert.match(q.get('SELECT name FROM designs WHERE id = ?', d.data.designId).name, /^AI Helen · Amber candle/);
  return job;
});

test('presenter video (demo): plan, start picture, script rules, label, credits', async () => {
  const c = await signup('Pres User', 'pres@example.com', 'pro');
  const r0 = await c.post('/api/ai/model-jobs', form({ character: 'arjun', aspect: '9:16', product: 'Momo box' }));
  const shot = await waitJob(c, r0.data.job.id);
  assert.equal(shot.status, 'done');

  // the script writer (template without a key)
  let r = await c.post('/api/ai/presenter-script', { product: 'Momo box', details: '10 pieces · with achar', price: 'Rs. 250', seconds: 15 });
  assert.equal(r.status, 200); assert.equal(r.data.parts.length, 2);
  assert.equal(CH.testimonialProblem(r.data.parts.join(' ')), '');

  // must start from an AI model photo
  r = await c.post('/api/ai/presenter-videos', { parts: ['Hello'], seconds: 8 });
  assert.equal(r.status, 400);
  // fake-customer wording refused
  r = await c.post('/api/ai/presenter-videos', { fromJob: shot.id, n: 0, parts: ["I've been ordering these every week"], seconds: 8 });
  assert.equal(r.status, 400); assert.equal(r.data.code, 'script');

  const before = (await c.get('/api/ai/credits')).data.left;
  r = await c.post('/api/ai/presenter-videos', { fromJob: shot.id, n: 0, parts: ['Meet our momo box — ten juicy pieces with fresh achar.', 'Just Rs. 250. Order yours today!'], seconds: 15, aspect: '9:16', label: true });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const v = await waitJob(c, r.data.job.id);
  assert.equal(v.status, 'done', v.error);
  assert.equal(v.kind, 'video'); assert.equal(v.inputs.parts.length, 2);
  assert.equal((await c.get('/api/ai/credits')).data.left, before - 28);
  const mp4 = await c.get(v.outputs[0].url);
  assert.equal(mp4.status, 200); assert.equal(mp4.data.toString('ascii', 4, 8), 'ftyp');

  // plans without AI video can't make presenter videos
  const f = await signup('Starter User', 'starterpres@example.com', 'starter');
  const s0 = await f.post('/api/ai/model-jobs', form({ character: 'maya', product: 'Tea' }));
  const s = await waitJob(f, s0.data.job.id);
  r = await f.post('/api/ai/presenter-videos', { fromJob: s.id, n: 0, parts: ['Meet our tea.'], seconds: 8 });
  assert.equal(r.status, 402);
});
