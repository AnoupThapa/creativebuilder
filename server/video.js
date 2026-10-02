'use strict';
/* Video → Instagram/Facebook-ready MP4 (H.264 video + AAC audio, yuv420p, fast-start).
   Browsers record canvas video as WebM (or MP4 with codecs social apps may reject),
   so recorded clips are normalised here with ffmpeg. ffmpeg comes from the optional
   `ffmpeg-static` package, FFMPEG_PATH, or a system install. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const config = require('./config');

let FFMPEG = null;
(function find() {
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  try { const p = require('ffmpeg-static'); if (p) candidates.push(p); } catch { /* optional */ }
  candidates.push('ffmpeg');
  for (const c of candidates) {
    try {
      const r = spawnSync(c, ['-hide_banner', '-version'], { timeout: 8000 });
      if (r.status === 0) { FFMPEG = c; return; }
    } catch { /* try next */ }
  }
})();

const TMP = path.join(config.DATA_DIR, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

/* conversions wait their turn (see MAX_JOBS) */
/* How many ffmpeg jobs may run at once. Each can use 150+ MB, so on a small server (512 MB)
   one at a time is safest; set FFMPEG_JOBS=2 on a bigger machine. */
const MAX_JOBS = Math.max(1, Math.min(4, parseInt(process.env.FFMPEG_JOBS || '1', 10) || 1));
let running = 0;
const waiting = [];
function slot() {
  if (running < MAX_JOBS) { running++; return Promise.resolve(); }
  return new Promise(r => waiting.push(r));
}
function release() { running--; const n = waiting.shift(); if (n) { running++; n(); } }

async function toMp4(inputBuffer) {
  if (!FFMPEG) throw new Error('Video conversion is not available on this server.');
  await slot();
  const id = crypto.randomUUID();
  const inFile = path.join(TMP, id + '.in');
  const outFile = path.join(TMP, id + '.mp4');
  try {
    fs.writeFileSync(inFile, inputBuffer);
    await new Promise((resolve, reject) => {
      const args = ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile, '-t', '180',
        '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=30',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-level', '4.1', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '160k', '-ar', '48000', '-ac', '2',
        '-movflags', '+faststart', outFile];
      const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error('Conversion took too long.')); }, 150000);
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('close', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.trim().split('\n').pop())); });
    });
    return fs.readFileSync(outFile);
  } finally {
    fs.rm(inFile, { force: true }, () => {});
    fs.rm(outFile, { force: true }, () => {});
    release();
  }
}

/* Run ffmpeg with the shared 2-at-a-time limit (used by the GIF maker too) */
async function runFfmpeg(args, timeoutMs = 150000) {
  if (!FFMPEG) throw new Error('Video tools are not available on this server.');
  await slot();
  try {
    await new Promise((resolve, reject) => {
      const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      p.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
      const timer = setTimeout(() => { p.kill('SIGKILL'); reject(Object.assign(new Error('This took too long — try a shorter clip or fewer sizes.'), { reason: 'timeout' })); }, timeoutMs);
      p.on('error', e => { clearTimeout(timer); reject(e); });
      p.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve();
        const e = new Error('ffmpeg failed: ' + (err.trim().split('\n').pop() || signal || code));
        // killed by the system with no message = it ran out of memory
        e.reason = signal === 'SIGKILL' || code === 137 ? 'memory' : /Invalid data|could not find codec|moov atom|Error opening input|does not contain any stream/i.test(err) ? 'unreadable' : 'failed';
        reject(e);
      });
    });
  } finally { release(); }
}

/* Length of a video file in seconds (null if unknown). Reads the header only — fast, no conversion. */
function probeDuration(file) {
  if (!FFMPEG) return Promise.resolve(null);
  return new Promise(resolve => {
    const p = spawn(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    const t = setTimeout(() => p.kill('SIGKILL'), 15000);
    p.on('close', () => {
      clearTimeout(t);
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      resolve(m ? (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]) : null);
    });
    p.on('error', () => { clearTimeout(t); resolve(null); });
  });
}

module.exports = { toMp4, runFfmpeg, probeDuration, TMP, busy: () => ({ running, waiting: waiting.length }), available: () => !!FFMPEG };
