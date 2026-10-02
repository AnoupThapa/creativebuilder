'use strict';
/* AI image providers behind one small interface:  generate({ prompt, photo, aspect, n }) → { images: [Buffer], model, costUsd }
   - gemini : Google "Nano Banana" image models (Gemini API)
   - openai : OpenAI GPT Image models
   - demo   : no key needed — makes a free placeholder (your photo on a styled background) so everything can be tested. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const config = require('../config');
const video = require('../video');

const SIZE = { '4:5': [1080, 1350], '1:1': [1080, 1080], '9:16': [1080, 1920], '16:9': [1600, 900] };
const COST = { gemini: 0.067, openai: 0.05, demo: 0 }; // estimated USD per image (Sep 2026 list prices, 1K / medium)

class AiError extends Error {
  constructor(message, reason = 'failed', detail = '') { super(message); this.reason = reason; this.detail = String(detail).slice(0, 500); }
}

function active() {
  const a = config.ai;
  if (a.provider === 'gemini' && a.geminiKey) return 'gemini';
  if (a.provider === 'openai' && a.openaiKey) return 'openai';
  if (a.provider === 'demo') return 'demo';
  if (a.geminiKey) return 'gemini';
  if (a.openaiKey) return 'openai';
  return 'demo';
}

/* Find base64 image bytes anywhere in a provider response (their JSON shapes change over time) */
function findImages(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => findImages(n, out)); return out; }
  const mime = node.mime_type || node.mimeType || '';
  const data = node.data || node.bytesBase64Encoded || node.b64_json;
  if (typeof data === 'string' && data.length > 200 && (/^image\//.test(mime) || node.b64_json || node.bytesBase64Encoded)) {
    out.push(Buffer.from(data, 'base64'));
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') findImages(v, out);
  return out;
}
function findText(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { node.forEach(n => findText(n, out)); return out; }
  if (typeof node.text === 'string') out.push(node.text);
  for (const v of Object.values(node)) if (v && typeof v === 'object') findText(v, out);
  return out;
}

async function postJson(url, body, headers, timeoutMs = 120000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, json, text };
  } catch (e) {
    if (e.name === 'AbortError') throw new AiError('The AI took too long to answer. Please try again.', 'timeout');
    throw new AiError('Could not reach the AI service. Please try again in a minute.', 'network', e.message);
  } finally { clearTimeout(t); }
}

function providerError(status, json, text) {
  const msg = json?.error?.message || json?.message || text || '';
  if (status === 429) return new AiError('The AI service is busy right now. Please try again in a minute.', 'busy', msg);
  if (status === 401 || status === 403) return new AiError('The AI service rejected our key. (Admin: check the API key.)', 'auth', msg);
  if (/safety|policy|blocked|moderation/i.test(msg)) return new AiError('The AI refused this request for safety reasons. Try a different photo or description.', 'blocked', msg);
  return new AiError('The AI could not make this image. Please try again or pick another style.', 'failed', `${status} ${msg}`);
}

/* ---------------- Google Gemini ---------------- */
async function geminiOnce({ prompt, photo, aspect }) {
  const a = config.ai, key = a.geminiKey, model = a.geminiImageModel;
  const headers = { 'x-goog-api-key': key };
  // Current Gemini API (Interactions)
  const input = [{ type: 'text', text: prompt }];
  if (photo) input.push({ type: 'image', mime_type: photo.mime, data: photo.buffer.toString('base64') });
  let r = await postJson(`${a.geminiBase}/v1beta/interactions`, { model, input, response_format: { type: 'image', aspect_ratio: aspect, image_size: '1K' } }, headers);
  let imgs = r.status < 300 ? findImages(r.json) : [];
  // Older generateContent endpoint as a fallback
  if (!imgs.length && (r.status === 404 || r.status === 400 || r.status < 300)) {
    const parts = [{ text: prompt }];
    if (photo) parts.push({ inline_data: { mime_type: photo.mime, data: photo.buffer.toString('base64') } });
    const r2 = await postJson(`${a.geminiBase}/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      { contents: [{ parts }], generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: aspect } } }, headers);
    if (r2.status < 300) imgs = findImages(r2.json); else if (r.status >= 300 || r2.status !== 404) r = r2;
    if (!imgs.length && r2.status < 300) {
      const said = findText(r2.json).join(' ').slice(0, 300);
      throw new AiError('The AI did not return an image for this request. Try a different description or style.', 'no_image', said);
    }
  }
  if (!imgs.length) throw providerError(r.status, r.json, r.text);
  return imgs[0];
}

/* ---------------- OpenAI ---------------- */
async function openaiOnce({ prompt, photo, aspect }) {
  const a = config.ai;
  const size = aspect === '1:1' ? '1024x1024' : aspect === '16:9' ? '1536x1024' : '1024x1536';
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 180000);
  try {
    let r;
    if (photo) {
      const fd = new FormData();
      fd.append('model', a.openaiImageModel); fd.append('prompt', prompt); fd.append('size', size); fd.append('quality', a.openaiQuality); fd.append('n', '1');
      fd.append('image[]', new Blob([photo.buffer], { type: photo.mime }), 'product.' + (photo.mime.split('/')[1] || 'png'));
      r = await fetch(`${a.openaiBase}/v1/images/edits`, { method: 'POST', headers: { Authorization: `Bearer ${a.openaiKey}` }, body: fd, signal: ctl.signal });
    } else {
      r = await fetch(`${a.openaiBase}/v1/images/generations`, { method: 'POST', signal: ctl.signal,
        headers: { Authorization: `Bearer ${a.openaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: a.openaiImageModel, prompt, size, quality: a.openaiQuality, n: 1 }) });
    }
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    const imgs = r.status < 300 ? findImages(json) : [];
    if (!imgs.length) throw providerError(r.status, json, text);
    return imgs[0];
  } catch (e) {
    if (e instanceof AiError) throw e;
    if (e.name === 'AbortError') throw new AiError('The AI took too long to answer. Please try again.', 'timeout');
    throw new AiError('Could not reach the AI service. Please try again in a minute.', 'network', e.message);
  } finally { clearTimeout(t); }
}

/* ---------------- Demo (free placeholder) ---------------- */
const PALETTES = [['0xf6d365', '0xfda085'], ['0x84fab0', '0x8fd3f4'], ['0xa18cd1', '0xfbc2eb'], ['0x2b5876', '0x4e4376'], ['0xfccb90', '0xd57eeb'], ['0x0f2027', '0x2c5364']];
async function demoOnce({ photo, aspect, seed = 0, tmpDir }) {
  const [W, H] = SIZE[aspect] || SIZE['4:5'];
  const id = crypto.randomBytes(6).toString('hex');
  const out = path.join(tmpDir, `demo-${id}.png`);
  const [c0, c1] = PALETTES[seed % PALETTES.length];
  const args = ['-f', 'lavfi', '-i', `gradients=s=${W}x${H}:c0=${c0}:c1=${c1}:x0=0:y0=0:x1=${W}:y1=${H}:d=1`];
  let graph = '[0:v]vignette=PI/5[bg]';
  if (photo) {
    const inFile = path.join(tmpDir, `demo-${id}-in`);
    fs.writeFileSync(inFile, photo.buffer);
    args.push('-i', inFile);
    graph += `;[1:v]scale=${Math.round(W * 0.62)}:${Math.round(H * 0.55)}:force_original_aspect_ratio=decrease[p];[bg][p]overlay=(W-w)/2:H*0.62-h/2`;
  } else {
    graph += `;[bg]drawbox=x=${Math.round(W * 0.3)}:y=${Math.round(H * 0.45)}:w=${Math.round(W * 0.4)}:h=${Math.round(W * 0.4)}:color=white@0.35:t=fill`;
  }
  args.push('-filter_complex', graph, '-frames:v', '1', out);
  await video.runFfmpeg(args, 60000);
  const buf = fs.readFileSync(out);
  fs.rm(out, { force: true }, () => {});
  return buf;
}

async function generate({ prompt, photo, aspect, n = 1, tmpDir, provider = active() }) {
  const one = i => provider === 'gemini' ? geminiOnce({ prompt, photo, aspect })
    : provider === 'openai' ? openaiOnce({ prompt, photo, aspect })
    : demoOnce({ photo, aspect, seed: Date.now() % 7 + i, tmpDir });
  const images = [];
  for (let i = 0; i < n; i++) images.push(await one(i)); // one after another: kinder to rate limits & memory
  return { images, provider, model: provider === 'gemini' ? config.ai.geminiImageModel : provider === 'openai' ? config.ai.openaiImageModel : 'demo', costUsd: COST[provider] * images.length };
}

module.exports = { generate, active, AiError, COST, SIZE, findImages };
