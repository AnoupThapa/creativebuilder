'use strict';
/* Retail vs Business profiles: account type, multi-brand kits, designs per brand,
   agency client logins (one brand only, free, view + download), activity log export + tamper check, Agency plan. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pf-b2b-'));
Object.assign(process.env, { DATA_DIR: tmp, NODE_ENV: 'test', ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'RootPassword123' });
const { app, ensureAdmin } = require('../server/index.js');
const { q } = require('../server/db.js');
const S = require('../server/security.js');

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
    const data = ct.includes('json') ? await res.json() : ct.startsWith('text/') ? await res.text() : Buffer.from(await res.arrayBuffer());
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  };
  return { cookie: () => cookie, get: u => call('GET', u), post: (u, b) => call('POST', u, b), put: (u, b) => call('PUT', u, b), patch: (u, b) => call('PATCH', u, b), del: u => call('DELETE', u) };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
async function signup(name, email, accountType) {
  const c = client();
  const r = await c.post('/api/auth/signup', { name, email, password: 'BrandsAndClients2026', acceptTerms: true, accountType, business: name + ' Co' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  q.run('UPDATE users SET email_verified = 1 WHERE email = ?', email);
  await c.get('/api/me');
  return c;
}
const wsOf = email => q.get('SELECT workspace_id FROM users WHERE email = ?', email).workspace_id;
const upgrade = (email, plan, seats = 2) => q.run("UPDATE workspaces SET plan_code = ?, seats = ?, sub_status = 'active', billing_mode = 'comp', current_period_end = ? WHERE id = ?",
  plan, seats, Date.now() + 864e5, wsOf(email));

test.before(async () => {
  await ensureAdmin();
  await new Promise(r => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('profiles: retail by default, business on request, owner can switch; plans per audience', async () => {
  const shop = await signup('Rita', 'rita@example.com');
  let r = await shop.get('/api/me');
  assert.equal(r.data.workspace.account_type, 'retail');
  const agency = await signup('Arun', 'arun@example.com', 'business');
  r = await agency.get('/api/me');
  assert.equal(r.data.workspace.account_type, 'business');

  r = await shop.put('/api/workspace/account-type', { account_type: 'nope' });
  assert.equal(r.status, 400);
  r = await shop.put('/api/workspace/account-type', { account_type: 'business' });
  assert.equal(r.status, 200);
  assert.equal((await shop.get('/api/me')).data.workspace.account_type, 'business');
  await shop.put('/api/workspace/account-type', { account_type: 'retail' });

  const plans = (await shop.get('/api/billing/plans')).data.plans;
  const by = Object.fromEntries(plans.map(p => [p.code, p]));
  assert.equal(by.starter.audience, 'retail');
  assert.equal(by.agency.audience, 'business');
  assert.equal(by.agency.max_brand_kits, 50);
  assert.equal(by.pro.audience, 'both');
});

test('agency: rich brand kits, designs per brand, client logins see only their brand', { timeout: 60000 }, async () => {
  const a = client();
  let r = await a.post('/api/auth/login', { email: 'arun@example.com', password: 'BrandsAndClients2026' });
  assert.equal(r.status, 200);
  await a.get('/api/me');
  upgrade('arun@example.com', 'agency', 1);

  // brand kits with palette, fonts, socials
  r = await a.post('/api/brand-kits', { name: 'Momo House', color: '#c0392b', colors: ['#f1c40f', '#2c3e50'], font_heading: 'Baloo 2', font_body: 'Mukta',
    tagline: 'Fresh momos daily', email: 'hi@momo.test', address: 'Bhaktapur', socials: { instagram: '@momohouse', bogus: 'x' } });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const momo = r.data;
  assert.deepEqual(momo.colors, ['#f1c40f', '#2c3e50']);
  assert.deepEqual(momo.socials, { instagram: '@momohouse' });
  assert.equal(momo.font_heading, 'Baloo 2');
  r = await a.post('/api/brand-kits', { name: 'Bad', colors: ['red'] });
  assert.equal(r.status, 400);
  r = await a.post('/api/brand-kits', { name: 'Glow Salon', color: '#8e44ad' });
  const salon = r.data;

  // photo for a design
  const fd = new FormData(); fd.append('file', new Blob([PNG]), 'momo.png');
  const media = (await a.post('/api/media', fd)).data;
  const fd2 = new FormData(); fd2.append('file', new Blob([PNG]), 'secret.png');
  const secretMedia = (await a.post('/api/media', fd2)).data;

  r = await a.post('/api/designs', { name: 'Momo offer', brand_kit_id: momo.id, data: { v: 1, mediaId: media.id } });
  assert.equal(r.status, 201);
  assert.equal(r.data.brand_kit_id, momo.id);
  const shared = r.data;
  await a.put('/api/designs/' + shared.id, { visibility: 'team_view' });
  const draft = (await a.post('/api/designs', { name: 'Momo draft', brand_kit_id: momo.id, data: { v: 1, mediaId: secretMedia.id } })).data; // stays private
  const salonD = (await a.post('/api/designs', { name: 'Salon offer', brand_kit_id: salon.id })).data;
  await a.put('/api/designs/' + salonD.id, { visibility: 'team_view' });
  r = await a.post('/api/designs', { name: 'x', brand_kit_id: 99999 });
  assert.equal(r.status, 400, 'brand must belong to this workspace');
  r = await a.put('/api/designs/' + salonD.id, { brand_kit_id: null });
  assert.equal(r.data.brand_kit_id, null);
  await a.put('/api/designs/' + salonD.id, { brand_kit_id: salon.id });
  r = await a.post('/api/designs', { duplicateOf: shared.id });
  assert.equal(r.data.brand_kit_id, momo.id, 'copies keep their brand');

  // retail workspaces can't invite clients
  const shop = client();
  await shop.post('/api/auth/login', { email: 'rita@example.com', password: 'BrandsAndClients2026' }); await shop.get('/api/me');
  upgrade('rita@example.com', 'pro', 2);
  const rk = (await shop.post('/api/brand-kits', { name: 'Rita Shop' })).data;
  r = await shop.post('/api/team/invite', { email: 'c1@example.com', role: 'client', brand_kit_id: rk.id });
  assert.equal(r.status, 400);

  // client invite: no seat needed (agency has 1 seat, already used by the owner)
  r = await a.post('/api/team/invite', { email: 'designer@example.com', role: 'designer' });
  assert.equal(r.status, 402, 'no seat left for a team member');
  r = await a.post('/api/team/invite', { email: 'client@momo.test', role: 'client', brand_kit_id: salon.id + 1000 });
  assert.equal(r.status, 400);
  r = await a.post('/api/team/invite', { email: 'client@momo.test', role: 'client', brand_kit_id: momo.id });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const token = new URL(r.data.devInviteLink).searchParams.get('token');
  const c = client();
  r = await c.post('/api/auth/accept-invite', { token, name: 'Momo Owner', password: 'ReviewMomos2026' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  r = await c.get('/api/me');
  assert.equal(r.data.user.role, 'viewer');
  assert.equal(r.data.user.client_brand.name, 'Momo House');
  assert.equal(r.data.workspace.members, 1, 'clients do not take seats');

  // the client sees only Momo House's shared designs
  r = await c.get('/api/designs');
  assert.deepEqual(r.data.map(d => d.name), ['Momo offer']);
  assert.equal((await c.get('/api/designs/' + draft.id)).status, 404);
  assert.equal((await c.get('/api/designs/' + salonD.id)).status, 404);
  r = await c.get('/api/brand-kits');
  assert.deepEqual(r.data.map(k => k.name), ['Momo House']);
  assert.equal((await c.put('/api/designs/' + shared.id, { name: 'hacked' })).status, 403);
  // files: only those used by their designs
  assert.equal((await c.get('/media/' + media.id)).status, 200);
  assert.equal((await c.get('/media/' + secretMedia.id)).status, 404);
  assert.deepEqual((await c.get('/api/media')).data, []);
  // nothing else in the workspace
  for (const u of ['/api/team', '/api/ai/options', '/api/social/accounts', '/api/workspace/activity']) {
    const x = await c.get(u);
    assert.ok([403, 404].includes(x.status), u + ' ' + x.status);
  }
  assert.equal((await c.post('/api/designs', { name: 'mine' })).status, 403);
  assert.equal((await c.post('/api/brand-kits', { name: 'mine' })).status, 403);
  // pages for AI / GIF send clients back to the dashboard
  const page = await fetch(base + '/ai', { headers: { cookie: c.cookie() }, redirect: 'manual' });
  assert.ok([302, 303].includes(page.status));
  // downloads: their brand's design yes, anything else no
  r = await c.post('/api/exports', { designId: shared.id, items: [{ platform: 'ig_post', kind: 'image' }], quality: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await c.post('/api/exports', { designId: salonD.id, items: [{ platform: 'ig_post', kind: 'image' }], quality: 1 });
  assert.equal(r.status, 403);
  r = await c.post('/api/exports', { items: [{ platform: 'ig_post', kind: 'image' }], quality: 1 });
  assert.equal(r.status, 403);

  // team list shows the client; their role can't be turned into a team role
  r = await a.get('/api/team');
  const cm = r.data.members.find(m => m.email === 'client@momo.test');
  assert.equal(cm.client_brand, 'Momo House');
  assert.equal(r.data.clients, 1);
  assert.equal((await a.patch('/api/team/' + cm.id, { role: 'designer' })).status, 400);
  // brand with client logins can't be deleted; workspace can't go back to retail
  assert.equal((await a.del('/api/brand-kits/' + momo.id)).status, 409);
  assert.equal((await a.put('/api/workspace/account-type', { account_type: 'retail' })).status, 409);
  // deleting a brand without clients keeps its designs (brand cleared)
  r = await a.del('/api/brand-kits/' + salon.id);
  assert.equal(r.status, 200);
  assert.equal(q.get('SELECT brand_kit_id FROM designs WHERE id = ?', salonD.id).brand_kit_id, null);
  // removing the client
  assert.equal((await a.del('/api/team/' + cm.id)).status, 200);
});

test('activity log: owners download CSV / JSON; tampering is detected', async () => {
  const a = client();
  await a.post('/api/auth/login', { email: 'arun@example.com', password: 'BrandsAndClients2026' }); await a.get('/api/me');
  let r = await a.get('/api/workspace/activity?days=30');
  assert.equal(r.status, 200);
  assert.ok(r.data.some(x => x.action === 'brand.created'));
  assert.ok(r.data.some(x => x.action === 'team.invite'));
  assert.ok(r.data.every(x => /^[0-9a-f]{64}$/.test(x.hash)));
  assert.ok(!r.data.some(x => x.user === 'rita@example.com'), 'only this workspace');
  r = await a.get('/api/workspace/activity?format=csv&days=30');
  assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.headers.get('content-disposition'), /attachment; filename="postgenx-activity-/);
  assert.match(r.data.split('\r\n')[0], /^id,time,user,name,action,ip,detail,hash$/);
  r = await a.get('/api/workspace/activity?format=json');
  assert.ok(Array.isArray(r.data.rows));
  // shop member without admin rights can't read it
  const shop = client();
  await shop.post('/api/auth/login', { email: 'rita@example.com', password: 'BrandsAndClients2026' }); await shop.get('/api/me');
  q.run("UPDATE users SET role = 'designer' WHERE email = 'rita@example.com'");
  assert.equal((await shop.get('/api/workspace/activity')).status, 403);
  q.run("UPDATE users SET role = 'owner' WHERE email = 'rita@example.com'");

  // tamper check
  assert.equal(S.verifyAuditChain().ok, true);
  const row = q.get("SELECT * FROM audit_log WHERE action = 'brand.created' ORDER BY id LIMIT 1");
  q.run('UPDATE audit_log SET detail = ? WHERE id = ?', '{"name":"changed"}', row.id);
  const v = S.verifyAuditChain();
  assert.equal(v.ok, false);
  assert.equal(v.brokenAt, row.id);
  q.run('UPDATE audit_log SET detail = ? WHERE id = ?', row.detail, row.id);
  assert.equal(S.verifyAuditChain().ok, true);
});
