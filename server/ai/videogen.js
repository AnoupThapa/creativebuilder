'use strict';
/* AI product videos (image → short clip).
   - veo  : Google Veo 3.1 (same GEMINI_API_KEY as the images). Long-running: start → poll → download.
   - demo : free placeholder (slow zoom on the start picture) so everything can be tested without a key.
   Every clip is finished here with ffmpeg: cropped to the post shape, 1080 px wide, silent H.264 MP4 + poster. */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');
const video = require('../video');
const { AiError } = require('./providers');

// Veo makes 9:16 or 16:9 only; feed/square posts are cut from the middle of a 9:16 clip.
const GEN = { '9:16': { gen: '9:16', W: 720, H: 1280, cw: 720, ch: 1280 },
  '4:5': { gen: '9:16', W: 720, H: 1280, cw: 720, ch: 900 },
  '1:1': { gen: '9:16', W: 720, H: 1280, cw: 720, ch: 720 },
  '16:9': { gen: '16:9', W: 1280, H: 720, cw: 1280, ch: 720 } };
const OUT = { '9:16': [1080, 1920], '4:5': [1080, 1350], '1:1': [1080, 1080], '16:9': [1280, 720] };
const SECONDS = [4, 6, 8];

function active() {
  const a = config.ai;
  if (a.provider === 'demo') return 'demo';
  return a.geminiKey ? 'veo' : 'demo';
}

/* Start picture placed inside the area that will survive the final crop; the rest is a soft blurred extension,
   so the product is never cut off whatever post shape is chosen. */
async function prepareStart(buf, aspect, dir) {
  const g = GEN[aspect] || GEN['9:16'];
  const inF = path.join(dir, 'start-src'), out = path.join(dir, 'start.png');
  fs.writeFileSync(inF, buf);
  const fw = Math.round(g.cw * 0.96) & ~1, fh = Math.round(g.ch * 0.96) & ~1;
  await video.runFfmpeg(['-i', inF, '-filter_complex',
    `[0:v]scale=${g.W}:${g.H}:force_original_aspect_ratio=increase,crop=${g.W}:${g.H},boxblur=28:2,eq=brightness=0.02[bg];` +
    `[0:v]scale=${fw}:${fh}:force_original_aspect_ratio=decrease[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,format=rgb24`,
    '-frames:v', '1', out], 60000);
  fs.rm(inF, { force: true }, () => {});
  return { png: fs.readFileSync(out), gen: g.gen };
}

/* ---------------- Google Veo ---------------- */
async function call(url, { method = 'GET', body, timeoutMs = 60000 } = {}) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, signal: ctl.signal, headers: { 'x-goog-api-key': config.ai.geminiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } catch (e) {
    if (e.name === 'AbortError') throw new AiError('The video service took too long to answer. Please try again.', 'timeout');
    throw new AiError('Could not reach the video service. Please try again in a minute.', 'network', e.message);
  } finally { clearTimeout(t); }
}
function veoError(r) {
  const msg = r.json?.error?.message || r.text || '';
  if (require('./providers').isQuota(r.status, msg)) return new AiError('AI videos aren’t available right now — the AI account behind PostGenX needs attention (Veo needs a paid Google AI plan). Your credits were returned; please try again later.', 'quota', `${r.status} ${msg}`);
  if (r.status === 429) return new AiError('The video service is busy right now. Please try again in a few minutes.', 'busy', msg);
  if (r.status === 401 || r.status === 403) return new AiError('The video service rejected our key. (Admin: check the Gemini key and that Veo is enabled with billing.)', 'auth', msg);
  if (/safety|policy|blocked|responsible/i.test(msg)) return new AiError('The video AI refused this picture for safety reasons. Try another start picture.', 'blocked', msg);
  return new AiError('The AI could not make this video. Please try again or pick another motion.', 'failed', `${r.status} ${msg}`);
}

/* Start a Veo job → operation name. Parameter names have changed between Veo versions,
   so on "bad request" we retry with fewer / older-style fields. */
async function veoStart({ prompt, negative, png, gen, seconds, audio = false }) {
  const a = config.ai;
  const url = `${a.geminiBase}/v1beta/models/${encodeURIComponent(a.veoModel)}:predictLongRunning`;
  const b64 = png.toString('base64');
  // Veo 3.1 always makes sound; older versions accept generateAudio. Presenter videos keep the voice.
  const full = { aspectRatio: gen, durationSeconds: seconds, resolution: a.videoResolution, negativePrompt: negative, personGeneration: 'allow_adult', ...(audio ? {} : { generateAudio: false }) };
  const attempts = [
    { image: { inlineData: { mimeType: 'image/png', data: b64 } }, parameters: full },
    { image: { inlineData: { mimeType: 'image/png', data: b64 } }, parameters: { aspectRatio: gen, durationSeconds: seconds, negativePrompt: negative } },
    { image: { bytesBase64Encoded: b64, mimeType: 'image/png' }, parameters: { aspectRatio: gen, durationSeconds: String(seconds), negativePrompt: negative } },
    { image: { bytesBase64Encoded: b64, mimeType: 'image/png' }, parameters: { aspectRatio: gen } },
  ];
  let r;
  for (const at of attempts) {
    r = await call(url, { method: 'POST', body: { instances: [{ prompt, image: at.image }], parameters: at.parameters }, timeoutMs: 90000 });
    if (r.status < 300 && r.json?.name) return r.json.name;
    if (r.status !== 400) break;
  }
  throw veoError(r);
}

/* Continue a finished Veo clip by ~7 s (same person, voice and place). Returns the operation name,
   or null when this model/version can't extend — the caller then starts a new clip from the last frame. */
async function veoExtend({ prompt, mp4 }) {
  const a = config.ai;
  const url = `${a.geminiBase}/v1beta/models/${encodeURIComponent(a.veoModel)}:predictLongRunning`;
  const r = await call(url, { method: 'POST', timeoutMs: 120000, body: {
    instances: [{ prompt, video: { inlineData: { mimeType: 'video/mp4', data: mp4.toString('base64') } } }],
    parameters: { numberOfVideos: 1, resolution: '720p', personGeneration: 'allow_adult' } } });
  if (r.status < 300 && r.json?.name) return r.json.name;
  if (r.status === 400 || r.status === 404) { console.warn('[veo] extend not available:', (r.json?.error?.message || r.text || '').slice(0, 200)); return null; }
  throw veoError(r);
}

function findVideoUri(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.uri === 'string' && /^https?:/.test(node.uri)) return node.uri;
  if (typeof node.videoUri === 'string') return node.videoUri;
  for (const v of Object.values(node)) { const f = findVideoUri(v); if (f) return f; }
  return null;
}
function findVideoBytes(node) {
  if (!node || typeof node !== 'object') return null;
  if (typeof node.bytesBase64Encoded === 'string' && node.bytesBase64Encoded.length > 1000) return Buffer.from(node.bytesBase64Encoded, 'base64');
  for (const v of Object.values(node)) { const f = findVideoBytes(v); if (f) return f; }
  return null;
}

/* Poll until done (Veo usually needs 1–4 minutes), then download the clip. */
async function veoWait(opName, { deadline, everyMs = 10000 }) {
  const a = config.ai;
  const opUrl = `${a.geminiBase}/v1beta/${opName.replace(/^\/+/, '')}`;
  for (;;) {
    const r = await call(opUrl);
    if (r.status >= 300) {
      if (r.status === 404) throw new AiError('The video job was lost by the AI service. Your credits were returned — please try again.', 'failed', r.text);
      if (r.status >= 500 || r.status === 429) { /* temporary — keep waiting */ } else throw veoError(r);
    } else if (r.json?.done) {
      if (r.json.error) throw veoError({ status: 500, json: { error: r.json.error }, text: '' });
      const resp = r.json.response || {};
      const filtered = JSON.stringify(resp).match(/raiMediaFilteredReasons"\s*:\s*\[\s*"([^"]+)/);
      const bytes = findVideoBytes(resp);
      if (bytes) return bytes;
      const uri = findVideoUri(resp);
      if (!uri) throw new AiError(filtered ? 'The video AI refused this picture for safety reasons. Try another start picture.' : 'The video AI finished without a video. Please try again.', filtered ? 'blocked' : 'no_video', filtered ? filtered[1] : JSON.stringify(resp).slice(0, 300));
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 120000);
      try {
        const d = await fetch(uri, { headers: { 'x-goog-api-key': a.geminiKey }, redirect: 'follow', signal: ctl.signal });
        if (!d.ok) throw new AiError('Could not download the finished video. Please try again.', 'failed', `download ${d.status}`);
        const buf = Buffer.from(await d.arrayBuffer());
        if (buf.length > 200 * 1024 * 1024) throw new AiError('The finished video was unexpectedly large.', 'failed');
        return buf;
      } catch (e) {
        if (e instanceof AiError) throw e;
        throw new AiError('Could not download the finished video. Please try again.', 'network', e.message);
      } finally { clearTimeout(t); }
    }
    if (Date.now() > deadline) throw new AiError('The video took too long to make. Your credits were returned — please try again later.', 'timeout');
    await new Promise(res => setTimeout(res, everyMs));
  }
}

/* ---------------- Demo (free placeholder) ---------------- */
async function demoClip({ png, gen, seconds, dir }) {
  const g = gen === '16:9' ? [1280, 720] : [720, 1280];
  const inF = path.join(dir, 'demo-in.png'), out = path.join(dir, 'demo-raw.mp4');
  fs.writeFileSync(inF, png);
  const frames = seconds * 25;
  await video.runFfmpeg(['-loop', '1', '-i', inF, '-filter_complex',
    `[0:v]scale=${g[0] * 2}:${g[1] * 2},zoompan=z='min(1+0.10*on/${frames},1.10)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${g[0]}x${g[1]}:fps=25,format=yuv420p`,
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', out], 120000);
  const buf = fs.readFileSync(out);
  fs.rm(inF, { force: true }, () => {}); fs.rm(out, { force: true }, () => {});
  return buf;
}

/* ---------------- presenter helpers ---------------- */
function hasAudio(file) {
  const ff = require('ffmpeg-static');
  return new Promise(resolve => {
    const p = require('node:child_process').spawn(ff, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('close', () => resolve(/Stream #.*Audio:/.test(err))); p.on('error', () => resolve(false));
  });
}
/* last frame of a clip as PNG → start picture for the next part */
async function lastFrame(mp4, dir) {
  const inF = path.join(dir, 'lf-in.mp4'), out = path.join(dir, 'lf.png');
  fs.writeFileSync(inF, mp4);
  await video.runFfmpeg(['-sseof', '-0.15', '-i', inF, '-frames:v', '1', '-update', '1', out], 60000);
  const png = fs.readFileSync(out); fs.rm(inF, { force: true }, () => {}); fs.rm(out, { force: true }, () => {});
  return png;
}
/* join two parts (each with or without sound) into one clip with sound */
async function joinParts(a, b, dir) {
  const fa = path.join(dir, 'part-a.mp4'), fb = path.join(dir, 'part-b.mp4'), out = path.join(dir, 'joined.mp4');
  fs.writeFileSync(fa, a); fs.writeFileSync(fb, b);
  const [sa, sb] = [await hasAudio(fa), await hasAudio(fb)];
  const [da, db] = [await video.probeDuration(fa) || 8, await video.probeDuration(fb) || 8];
  // normalise both videos to the same size/fps, and add silence where a part has no sound
  const fc = `[0:v]scale=720:-2,setsar=1,fps=30,format=yuv420p[v0];[1:v]scale=720:-2,setsar=1,fps=30,format=yuv420p[v1];` +
    (sa ? '[0:a]aresample=48000,aformat=channel_layouts=stereo[a0];' : `anullsrc=r=48000:cl=stereo,atrim=0:${da}[a0];`) +
    (sb ? '[1:a]aresample=48000,aformat=channel_layouts=stereo[a1];' : `anullsrc=r=48000:cl=stereo,atrim=0:${db}[a1];`) +
    '[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]';
  await video.runFfmpeg(['-i', fa, '-i', fb, '-filter_complex', fc, '-map', '[v]', '-map', '[a]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-c:a', 'aac', '-shortest', out], 240000);
  const buf = fs.readFileSync(out);
  for (const f of [fa, fb, out]) fs.rm(f, { force: true }, () => {});
  return buf;
}
/* demo presenter: slow zoom on the start picture (no voice without a real AI key) */
async function demoPresenter({ png, gen, seconds, dir }) { return demoClip({ png, gen, seconds, dir }); }

/* ---------------- finishing ---------------- */
/* Crop the middle to the post shape, 1080 wide, silent, web-friendly MP4 + a poster frame. */
async function finish(raw, aspect, dir, n = 0, { audio = false, label = false } = {}) {
  const [W, H] = OUT[aspect] || OUT['9:16'];
  const R = (W / H).toFixed(5);
  const inF = path.join(dir, `raw-${n}.mp4`), out = path.join(dir, `video-${n}.mp4`), poster = path.join(dir, `poster-${n}.jpg`);
  fs.writeFileSync(inF, raw);
  try {
    const crop = `crop='min(iw,ih*${R})':'min(ih,iw/${R})',scale=${W}:${H}:flags=lanczos,setsar=1,fps=30,format=yuv420p`;
    const keepSound = audio && await hasAudio(inF);
    const labelFile = path.join(config.ROOT, 'public', 'img', 'ai-label.png');
    const useLabel = label && fs.existsSync(labelFile);
    const args = ['-i', inF];
    if (useLabel) args.push('-i', labelFile, '-filter_complex', `[0:v]${crop}[v];[1:v]scale=${Math.round(W * 0.26)}:-1[l];[v][l]overlay=W-w-${Math.round(W * 0.035)}:${Math.round(H * 0.03)}[o]`, '-map', '[o]');
    else args.push('-vf', crop);
    if (keepSound) args.push(...(useLabel ? ['-map', '0:a'] : []), '-c:a', 'aac', '-b:a', '160k'); else args.push('-an');
    await video.runFfmpeg([...args, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-movflags', '+faststart', out], 180000);
    await video.runFfmpeg(['-ss', '0.4', '-i', out, '-frames:v', '1', '-q:v', '4', poster], 30000);
  } catch (e) {
    throw new AiError('The finished video could not be prepared. Your credits were returned — please try again.', e.reason || 'failed', e.message);
  } finally { fs.rm(inF, { force: true }, () => {}); }
  return { file: path.basename(out), poster: path.basename(poster) };
}

/* Three still frames (early, middle, end) for the quality check. */
async function sampleFrames(mp4Path, seconds, dir) {
  const out = [];
  for (const [i, f] of [0.3, 0.65, 0.95].entries()) {
    const jp = path.join(dir, `check-${i}.jpg`);
    try {
      await video.runFfmpeg(['-ss', (seconds * f).toFixed(2), '-i', mp4Path, '-frames:v', '1', '-q:v', '3', jp], 30000);
      out.push(fs.readFileSync(jp));
    } catch { /* skip */ } finally { fs.rm(jp, { force: true }, () => {}); }
  }
  return out;
}

module.exports = { active, prepareStart, veoStart, veoExtend, veoWait, demoClip, demoPresenter, lastFrame, joinParts, hasAudio, finish, sampleFrames, GEN, OUT, SECONDS };
