'use strict';
/* Server-side image work for the developer API: fit a photo into any platform size, and remove backgrounds.
   Uses the bundled ffmpeg (no extra install) and the same background-removal engine as the editor,
   run in a worker thread so the server stays responsive. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { Worker } = require('node:worker_threads');
const video = require('./video');

let FFMPEG = null; try { FFMPEG = require('ffmpeg-static'); } catch { /* not installed */ }
const tmp = ext => path.join(video.TMP, `img-${crypto.randomBytes(8).toString('hex')}${ext || ''}`);

/* width × height of an image file (from ffmpeg's stream info) */
function probe(file) {
  return new Promise((resolve, reject) => {
    if (!FFMPEG) return reject(new Error('Image tools are not available on this server.'));
    const p = spawn(FFMPEG, ['-hide_banner', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('close', () => {
      const m = err.match(/Video: [^\n]*?(\d{2,5})x(\d{2,5})/);
      m ? resolve({ w: +m[1], h: +m[2] }) : reject(Object.assign(new Error('That file is not an image we can read.'), { status: 415 }));
    });
    p.on('error', reject);
  });
}
const hex = c => (/^#[0-9a-f]{6}$/i.test(c || '') ? '0x' + c.slice(1) : '0xffffff');

/* Fit one image into W×H.  fit: contain (whole product visible) | cover (fill & crop)
   background (contain only): blur | white | color | transparent */
async function resize(buf, W, H, { fit = 'contain', background = 'blur', color = '#ffffff', format = 'jpg' } = {}) {
  const inF = tmp(), outF = tmp(format === 'png' ? '.png' : '.jpg');
  fs.writeFileSync(inF, buf);
  try {
    await probe(inF);
    const fw = Math.round(W * 0.94) & ~1, fh = Math.round(H * 0.94) & ~1;
    const fg = `[0:v]scale=${fw}:${fh}:force_original_aspect_ratio=decrease[fg]`;
    let args;
    if (fit === 'cover') {
      args = ['-i', inF, '-vf', `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H}`];
    } else if (background === 'blur') {
      args = ['-i', inF, '-filter_complex', `[0:v]scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},boxblur=24:2,eq=brightness=-0.04[bg];${fg};[bg][fg]overlay=(W-w)/2:(H-h)/2`];
    } else {
      const transparent = background === 'transparent' && format === 'png';
      const src = transparent ? `color=c=black@0.0:s=${W}x${H},format=rgba` : `color=c=${background === 'white' ? '0xffffff' : hex(color)}:s=${W}x${H}`;
      args = ['-f', 'lavfi', '-i', src, '-i', inF, '-filter_complex', `${fg.replace('[0:v]', '[1:v]')};[0:v][fg]overlay=(W-w)/2:(H-h)/2${transparent ? ':format=auto' : ''}`];
    }
    args.push('-frames:v', '1');
    if (format === 'png') args.push('-pix_fmt', background === 'transparent' && fit !== 'cover' ? 'rgba' : 'rgb24');
    else args.push('-q:v', '3');
    args.push(outF);
    await video.runFfmpeg(args, 60000);
    return fs.readFileSync(outF);
  } finally { fs.rm(inF, { force: true }, () => {}); fs.rm(outF, { force: true }, () => {}); }
}

/* Background removal → transparent PNG (longest side up to 1200 px) */
function segmentInWorker(rgba, w, h) {
  return new Promise((resolve, reject) => {
    const wk = new Worker(`
      const { parentPort, workerData } = require('node:worker_threads');
      const PFBG = require(workerData.lib);
      const px = new Uint8ClampedArray(workerData.buf);
      const P = PFBG.prepare(px, workerData.w, workerData.h);
      const r = PFBG.segment(P, {});
      parentPort.postMessage(r.alpha, [r.alpha.buffer]);`, { eval: true, workerData: { lib: path.join(__dirname, '..', 'public', 'js', 'bgremove.js'), buf: rgba.buffer, w, h } });
    const t = setTimeout(() => { wk.terminate(); reject(Object.assign(new Error('Background removal took too long.'), { status: 503 })); }, 60000);
    wk.once('message', a => { clearTimeout(t); resolve(a); wk.terminate(); });
    wk.once('error', e => { clearTimeout(t); reject(e); });
  });
}
async function removeBackground(buf) {
  const inF = tmp(), rawF = tmp('.rgba'), outF = tmp('.png');
  fs.writeFileSync(inF, buf);
  try {
    const { w: iw, h: ih } = await probe(inF);
    const s = Math.min(1, 1200 / Math.max(iw, ih));
    const w = Math.max(2, Math.round(iw * s)), h = Math.max(2, Math.round(ih * s));
    await video.runFfmpeg(['-i', inF, '-vf', `scale=${w}:${h}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', rawF], 60000);
    const rgba = new Uint8ClampedArray(fs.readFileSync(rawF));
    const alpha = await segmentInWorker(rgba.slice(), w, h);
    for (let i = 0; i < alpha.length; i++) rgba[i * 4 + 3] = alpha[i];
    fs.writeFileSync(rawF, rgba);
    await video.runFfmpeg(['-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', rawF, '-frames:v', '1', '-pix_fmt', 'rgba', outF], 60000);
    return { png: fs.readFileSync(outF), width: w, height: h };
  } finally { for (const f of [inF, rawF, outF]) fs.rm(f, { force: true }, () => {}); }
}

module.exports = { resize, removeBackground, probe, available: () => !!FFMPEG };
