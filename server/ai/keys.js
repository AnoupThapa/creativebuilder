'use strict';
/* AI service keys entered by the platform admin (Admin → AI studio → AI service keys).
   - Stored encrypted (AES-256-GCM with APP_SECRET) in the database, never in code or logs.
   - Never sent back to the browser in full — only "saved · ends in …abcd".
   - Fly.io secrets (GEMINI_API_KEY / OPENAI_API_KEY) still work; a key saved here takes priority. */
const config = require('../config');
const { metaGet, metaSet } = require('../db');
const S = require('../security');

const KEY_FIELDS = ['geminiKey', 'openaiKey'];
const MODEL_FIELDS = ['geminiImageModel', 'openaiImageModel', 'veoModel'];
const ENV = { ...config.ai }; // values from Fly.io secrets / .env at start-up

function read() {
  try { return JSON.parse(metaGet('ai_settings') || '{}'); } catch { return {}; }
}
function plainKey(saved, field) {
  if (!saved[field]) return '';
  try { return S.decrypt(saved[field]); } catch { console.error(`[ai-keys] could not decrypt ${field} (APP_SECRET changed?) — using the server setting instead`); return ''; }
}

/* Put the effective settings into config.ai, where every AI module reads them. */
function apply() {
  const saved = read();
  for (const f of KEY_FIELDS) config.ai[f] = plainKey(saved, f) || ENV[f] || '';
  for (const f of MODEL_FIELDS) config.ai[f] = saved[f] || ENV[f];
  config.ai.provider = saved.provider != null ? saved.provider : ENV.provider;
}

const hint = k => (k ? `…${k.slice(-4)}` : '');
function status() {
  const saved = read();
  const keys = {};
  for (const f of KEY_FIELDS) {
    const mine = plainKey(saved, f);
    keys[f] = { set: !!(mine || ENV[f]), source: mine ? 'admin' : ENV[f] ? 'server' : 'none', hint: hint(mine || ENV[f]) };
  }
  return {
    keys, provider: config.ai.provider || '',
    models: Object.fromEntries(MODEL_FIELDS.map(f => [f, config.ai[f]])),
    defaults: Object.fromEntries(MODEL_FIELDS.map(f => [f, ENV[f]])),
    updatedAt: saved.updatedAt || null,
  };
}

const bad = msg => Object.assign(new Error(msg), { status: 400 });
function save(body = {}) {
  const saved = read();
  for (const f of KEY_FIELDS) {
    if (body['clear_' + f]) { delete saved[f]; continue; }
    const v = typeof body[f] === 'string' ? body[f].trim() : '';
    if (!v) continue; // empty box = keep what is saved
    if (!/^[\x21-\x7e]{20,300}$/.test(v)) throw bad(`That ${f === 'geminiKey' ? 'Gemini' : 'OpenAI'} key doesn’t look right — copy it again without spaces.`);
    if (f === 'openaiKey' && !/^sk-/.test(v)) throw bad('OpenAI keys start with “sk-”.');
    saved[f] = S.encrypt(v);
  }
  if (body.provider !== undefined) {
    if (!['', 'gemini', 'openai', 'demo'].includes(body.provider)) throw bad('Unknown AI service.');
    saved.provider = body.provider;
  }
  for (const f of MODEL_FIELDS) {
    if (body[f] === undefined) continue;
    const v = String(body[f] || '').trim();
    if (!v) { delete saved[f]; continue; } // empty = back to the default
    if (!/^[A-Za-z0-9._:\-\/]{3,100}$/.test(v)) throw bad('Model names only use letters, numbers, dots and dashes.');
    saved[f] = v;
  }
  saved.updatedAt = Date.now();
  metaSet('ai_settings', JSON.stringify(saved));
  apply();
  return status();
}

/* Free check: list the service's models with the key (no image is made, nothing is charged). */
async function check(which) {
  const a = config.ai;
  const key = which === 'gemini' ? a.geminiKey : a.openaiKey;
  if (!key) return { ok: false, error: 'No key saved yet.' };
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const url = which === 'gemini' ? `${a.geminiBase}/v1beta/models?pageSize=1000` : `${a.openaiBase}/v1/models`;
    const headers = which === 'gemini' ? { 'x-goog-api-key': key } : { Authorization: `Bearer ${key}` };
    const r = await fetch(url, { headers, signal: ctl.signal });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || r.status === 403 || r.status === 400) return { ok: false, error: 'The key was rejected. Copy it again, and check billing is switched on for that account.', detail: j?.error?.message || '' };
    if (!r.ok) return { ok: false, error: `The service answered with an error (${r.status}). Try again in a minute.`, detail: j?.error?.message || '' };
    const names = (which === 'gemini' ? (j.models || []).map(m => String(m.name || '').replace(/^models\//, '')) : (j.data || []).map(m => m.id));
    const wanted = which === 'gemini' ? [a.geminiImageModel, a.veoModel] : [a.openaiImageModel];
    const models = wanted.map(m => ({ name: m, found: names.includes(m) }));
    return { ok: true, count: names.length, models };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'The service took too long to answer.' : 'Could not reach the service.' };
  } finally { clearTimeout(t); }
}

apply();
module.exports = { apply, status, save, check };
