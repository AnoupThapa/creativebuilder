'use strict';
/* Publishing to Facebook Pages and Instagram (Business/Creator) accounts through Meta's official
   Graph API. People connect their accounts with Meta's own login pop-up (OAuth): they type their
   Facebook password on facebook.com, never in PostGenX, and PostGenX only receives a Page token
   with the permissions they approved.

   Without META_APP_ID/META_APP_SECRET the feature runs in DEMO mode: sample accounts can be
   "connected" and posts are simulated (nothing is sent to Meta) so the whole flow can be tried. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('./config');
const S = require('./security');
const { q } = require('./db');

const SOCIAL_DIR = path.join(config.DATA_DIR, 'social');
const SCOPES = [
  'pages_show_list', 'pages_read_engagement', 'pages_manage_posts',
  'instagram_basic', 'instagram_content_publish', 'business_management',
];

const meta = () => config.meta;
const isDemo = () => !(meta().appId && meta().appSecret);
const graph = p => `${meta().graphUrl}/${meta().graphVersion}${p}`;
const redirectUri = () => `${config.appUrl}/api/social/meta/callback`;
const publicBase = () => config.appUrl;
const isLocalUrl = u => /^https?:\/\/(localhost|127\.|\[::1\]|0\.0\.0\.0|192\.168\.|10\.)/i.test(u);

class GraphError extends Error {
  constructor(message, code, sub) { super(message); this.code = code; this.sub = sub; }
}

async function call(url, { method = 'GET', params = {}, form = null, timeoutMs = 120000 } = {}) {
  let res;
  const ctl = AbortSignal.timeout(timeoutMs);
  if (method === 'GET') {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    res = await fetch(u, { signal: ctl });
  } else if (form) {
    res = await fetch(url, { method, body: form, signal: ctl });
  } else {
    res = await fetch(url, { method, body: new URLSearchParams(params), signal: ctl });
  }
  let data;
  try { data = await res.json(); } catch { data = {}; }
  if (!res.ok || data.error) {
    const e = data.error || {};
    throw new GraphError(e.error_user_msg || e.message || `Meta returned HTTP ${res.status}`, e.code, e.error_subcode);
  }
  return data;
}

/* ---------------- connecting accounts (OAuth) ---------------- */
function newState(user) {
  const state = crypto.randomBytes(24).toString('base64url');
  q.run('DELETE FROM oauth_states WHERE created_at < ?', Date.now() - 30 * 60000);
  q.run('INSERT INTO oauth_states (state, user_id, workspace_id, created_at) VALUES (?,?,?,?)', state, user.id, user.workspace_id, Date.now());
  return state;
}
function takeState(state, user) {
  const row = q.get('SELECT * FROM oauth_states WHERE state = ?', String(state || ''));
  if (row) q.run('DELETE FROM oauth_states WHERE state = ?', row.state);
  if (!row || row.user_id !== user.id || Date.now() - row.created_at > 30 * 60000) return null;
  return row;
}
function loginUrl(state) {
  const u = new URL(`${meta().dialogUrl}/${meta().graphVersion}/dialog/oauth`);
  u.searchParams.set('client_id', meta().appId);
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  // Apps using "Facebook Login for Business" pick permissions with a configuration ID instead of a scope list
  if (meta().configId) u.searchParams.set('config_id', meta().configId);
  else u.searchParams.set('scope', SCOPES.join(','));
  return u.toString();
}

function upsertAccount(wsId, userId, a) {
  const now = Date.now();
  const existing = q.get('SELECT id FROM social_accounts WHERE workspace_id = ? AND platform = ? AND external_id = ?', wsId, a.platform, a.external_id);
  if (existing) {
    q.run(`UPDATE social_accounts SET name = ?, username = ?, picture = ?, parent_id = ?, token_enc = ?, demo = ?, status = 'active',
           last_error = '', updated_at = ? WHERE id = ?`, a.name, a.username || '', a.picture || '', a.parent_id || '',
      a.token ? S.encrypt(a.token) : '', a.demo ? 1 : 0, now, existing.id);
    return existing.id;
  }
  return q.run(`INSERT INTO social_accounts (workspace_id, platform, external_id, name, username, picture, parent_id, token_enc, demo,
                connected_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
  wsId, a.platform, a.external_id, a.name, a.username || '', a.picture || '', a.parent_id || '',
  a.token ? S.encrypt(a.token) : '', a.demo ? 1 : 0, userId, now, now).lastInsertRowid;
}

/* Exchange the login code for tokens and save every Page (and its Instagram account) */
async function completeLogin(code, user) {
  const short = await call(graph('/oauth/access_token'), {
    params: { client_id: meta().appId, client_secret: meta().appSecret, redirect_uri: redirectUri(), code },
  });
  // long-lived user token → Page tokens that don't expire
  const long = await call(graph('/oauth/access_token'), {
    params: { grant_type: 'fb_exchange_token', client_id: meta().appId, client_secret: meta().appSecret, fb_exchange_token: short.access_token },
  });
  const pages = [];
  let next = graph('/me/accounts');
  let params = { access_token: long.access_token, limit: '100',
    fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}' };
  for (let i = 0; next && i < 5; i++) {
    const r = await call(next, { params });
    pages.push(...(r.data || []));
    next = r.paging && r.paging.next; params = {};
  }
  const saved = [];
  for (const p of pages) {
    if (!p.access_token) continue;
    saved.push(upsertAccount(user.workspace_id, user.id, {
      platform: 'facebook', external_id: p.id, name: p.name, picture: p.picture?.data?.url || '', token: p.access_token,
    }));
    const ig = p.instagram_business_account;
    if (ig && ig.id) {
      saved.push(upsertAccount(user.workspace_id, user.id, {
        platform: 'instagram', external_id: ig.id, name: ig.name || ig.username || p.name, username: ig.username || '',
        picture: ig.profile_picture_url || '', parent_id: p.id, token: p.access_token,
      }));
    }
  }
  return { pages: pages.length, accounts: saved.length };
}

function connectDemo(user) {
  const ids = [
    upsertAccount(user.workspace_id, user.id, { platform: 'facebook', external_id: `demo-page-${user.workspace_id}`, name: 'Demo Café (Facebook Page)', demo: true }),
    upsertAccount(user.workspace_id, user.id, { platform: 'instagram', external_id: `demo-ig-${user.workspace_id}`, name: 'Demo Café', username: 'democafe', parent_id: `demo-page-${user.workspace_id}`, demo: true }),
  ];
  return { pages: 1, accounts: ids.length };
}

function listAccounts(wsId) {
  return q.all(`SELECT id, platform, external_id, name, username, picture, demo, status, last_error, created_at
                FROM social_accounts WHERE workspace_id = ? ORDER BY platform, name`, wsId)
    .map(a => ({ ...a, demo: !!a.demo }));
}

/* ---------------- storing a post ---------------- */
function saveMedia(buf, ext) {
  fs.mkdirSync(SOCIAL_DIR, { recursive: true });
  const file = `${crypto.randomBytes(16).toString('hex')}.${ext}`;
  fs.writeFileSync(path.join(SOCIAL_DIR, file), buf);
  return file;
}
const mediaPath = file => path.join(SOCIAL_DIR, path.basename(file));
const publicUrl = file => `${publicBase()}/pub/${file}`;

/* ---------------- publishing ---------------- */
const sleep = ms => new Promise(r => setTimeout(r, ms));
const POLL = { interval: 3000, tries: 100 }; // up to ~5 minutes for Reels processing

async function publishFacebook(post, acct, token) {
  const buf = fs.readFileSync(mediaPath(post.file));
  const form = new FormData();
  form.append('access_token', token);
  form.append('source', new Blob([buf], { type: post.mime }), post.file);
  if (post.kind === 'video') {
    if (post.caption) form.append('description', post.caption);
    const r = await call(`${meta().videoUrl}/${meta().graphVersion}/${acct.external_id}/videos`, { method: 'POST', form, timeoutMs: 600000 });
    return { remote_id: r.id, permalink: `https://www.facebook.com/${acct.external_id}/videos/${r.id}` };
  }
  if (post.caption) form.append('message', post.caption);
  form.append('published', 'true');
  const r = await call(graph(`/${acct.external_id}/photos`), { method: 'POST', form });
  const pid = r.post_id || r.id;
  return { remote_id: pid, permalink: `https://www.facebook.com/${pid}` };
}

async function publishInstagram(post, acct, token) {
  if (isLocalUrl(publicBase()))
    throw new Error('Instagram fetches the picture from your PostGenX address, so PostGenX must be online (e.g. on Fly.io) — not on localhost.');
  const url = publicUrl(post.file);
  const params = { access_token: token };
  if (post.ig_placement === 'story') {
    params.media_type = 'STORIES';
    params[post.kind === 'video' ? 'video_url' : 'image_url'] = url;
  } else if (post.kind === 'video') {
    Object.assign(params, { media_type: 'REELS', video_url: url, share_to_feed: 'true', caption: post.caption || '' });
  } else {
    Object.assign(params, { image_url: url, caption: post.caption || '' });
  }
  const container = await call(graph(`/${acct.external_id}/media`), { method: 'POST', params });
  // wait until Instagram has fetched and processed the media
  for (let i = 0; i < POLL.tries; i++) {
    const st = await call(graph(`/${container.id}`), { params: { fields: 'status_code', access_token: token } });
    if (!st.status_code || st.status_code === 'FINISHED') break;
    if (st.status_code === 'ERROR' || st.status_code === 'EXPIRED') throw new Error('Instagram could not process this media. Check the size/format and try again.');
    await sleep(POLL.interval);
  }
  const pub = await call(graph(`/${acct.external_id}/media_publish`), { method: 'POST', params: { creation_id: container.id, access_token: token } });
  let permalink = '';
  try { permalink = (await call(graph(`/${pub.id}`), { params: { fields: 'permalink', access_token: token } })).permalink || ''; } catch { /* optional */ }
  return { remote_id: pub.id, permalink };
}

function friendlyError(e) {
  if (e instanceof GraphError && (e.code === 190 || e.code === 102)) return { msg: 'The connection to this account has expired. Reconnect it in Social accounts.', expired: true };
  if (e instanceof GraphError && (e.code === 10 || e.code === 200)) return { msg: `Meta refused permission: ${e.message}. Reconnect the account and allow all requested permissions.`, expired: true };
  if (e instanceof GraphError && e.code === 368) return { msg: 'Meta temporarily blocked posting from this account (spam protection). Try again later.' };
  if (e instanceof GraphError && e.code === 4) return { msg: 'Posting limit reached for now (Meta rate limit). Try again in an hour.' };
  return { msg: String(e && e.message || e).slice(0, 400) };
}

async function publishTarget(post, target) {
  const acct = q.get('SELECT * FROM social_accounts WHERE id = ? AND workspace_id = ?', target.account_id, post.workspace_id);
  q.run("UPDATE social_post_targets SET status = 'publishing', updated_at = ? WHERE id = ?", Date.now(), target.id);
  try {
    if (!acct) throw new Error('This account was disconnected.');
    let r;
    if (acct.demo) {
      await sleep(300);
      r = { remote_id: `demo-${crypto.randomBytes(4).toString('hex')}`, permalink: '' };
    } else {
      const token = S.decrypt(acct.token_enc);
      r = acct.platform === 'facebook' ? await publishFacebook(post, acct, token) : await publishInstagram(post, acct, token);
    }
    q.run("UPDATE social_post_targets SET status = 'published', remote_id = ?, permalink = ?, error = '', updated_at = ? WHERE id = ?",
      String(r.remote_id || ''), r.permalink || '', Date.now(), target.id);
    return true;
  } catch (e) {
    const f = friendlyError(e);
    q.run("UPDATE social_post_targets SET status = 'failed', error = ?, updated_at = ? WHERE id = ?", f.msg, Date.now(), target.id);
    if (f.expired && acct) q.run("UPDATE social_accounts SET status = 'error', last_error = ?, updated_at = ? WHERE id = ?", f.msg, Date.now(), acct.id);
    if (process.env.NODE_ENV !== 'test') console.warn(`[social] post ${post.id} → ${acct?.platform || '?'} failed: ${f.msg}`);
    return false;
  }
}

const running = new Set();
async function publishPost(postId, { onlyFailed = false } = {}) {
  if (running.has(postId)) return;
  running.add(postId);
  try {
    const post = q.get('SELECT * FROM social_posts WHERE id = ?', postId);
    if (!post) return;
    q.run("UPDATE social_posts SET status = 'publishing' WHERE id = ?", postId);
    const targets = q.all(`SELECT * FROM social_post_targets WHERE post_id = ? AND status ${onlyFailed ? "= 'failed'" : "IN ('pending','failed')"}`, postId);
    for (const t of targets) await publishTarget(post, t);
    const all = q.all('SELECT status FROM social_post_targets WHERE post_id = ?', postId);
    const ok = all.filter(t => t.status === 'published').length;
    const status = ok === all.length ? 'published' : ok ? 'partial' : 'failed';
    q.run('UPDATE social_posts SET status = ?, published_at = ? WHERE id = ?', status, ok ? Date.now() : null, postId);
  } finally { running.delete(postId); }
}

/* ---------------- scheduler ---------------- */
async function runDue() {
  const due = q.all("SELECT id FROM social_posts WHERE status = 'scheduled' AND scheduled_at <= ? ORDER BY scheduled_at LIMIT 10", Date.now());
  for (const p of due) await publishPost(p.id);
}
let timer = null;
function startScheduler() {
  if (timer || process.env.NODE_ENV === 'test') return;
  // a post left "publishing" by a crash/restart is retried
  q.run("UPDATE social_posts SET status = 'scheduled' WHERE status = 'publishing'");
  q.run("UPDATE social_post_targets SET status = 'pending' WHERE status = 'publishing'");
  timer = setInterval(() => runDue().catch(e => console.error('[social] scheduler', e)), 30 * 1000);
  timer.unref();
  setTimeout(() => runDue().catch(() => {}), 5000).unref();
}

function postView(p) {
  const targets = q.all(`SELECT t.id, t.account_id, t.platform, t.status, t.permalink, t.error, a.name, a.username, a.demo
                         FROM social_post_targets t LEFT JOIN social_accounts a ON a.id = t.account_id WHERE t.post_id = ? ORDER BY t.id`, p.id);
  return {
    id: p.id, design_id: p.design_id, design_name: p.design_name, kind: p.kind, width: p.width, height: p.height,
    caption: p.caption, ig_placement: p.ig_placement, scheduled_at: p.scheduled_at, status: p.status,
    created_at: p.created_at, published_at: p.published_at, user_id: p.user_id,
    preview: `/api/social/posts/${p.id}/media`,
    targets: targets.map(t => ({ ...t, demo: !!t.demo })),
  };
}

function deletePostFiles(post) {
  fs.rmSync(mediaPath(post.file), { force: true });
}

module.exports = {
  isDemo, SCOPES, newState, takeState, loginUrl, completeLogin, connectDemo, listAccounts,
  saveMedia, mediaPath, publishPost, runDue, startScheduler, postView, deletePostFiles, isLocalUrl,
  SOCIAL_DIR, POLL, GraphError,
};
