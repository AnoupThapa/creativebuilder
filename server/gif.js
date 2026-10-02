'use strict';
/* GIF maker — a product video, an existing GIF, or a few photos → looping GIFs (plus optional
   lightweight MP4s) in the sizes online shops use. Everything runs on our own server with ffmpeg:
   high-quality palette per clip, no third-party service. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const video = require('./video');

const SIZES = {
  product_800:   { label: 'Product image', note: 'Shopify, WooCommerce, Amazon', w: 800,  h: 800 },
  square_1080:   { label: 'Square',        note: 'Instagram & Facebook post',     w: 1080, h: 1080 },
  thumb_400:     { label: 'Thumbnail',     note: 'Collections & listings',        w: 400,  h: 400 },
  portrait_1080: { label: 'Portrait 4:5',  note: 'Instagram feed',                w: 1080, h: 1350 },
  story_720:     { label: 'Story 9:16',    note: 'Stories, Reels, TikTok',        w: 720,  h: 1280 },
  banner_1200:   { label: 'Website banner', note: 'Home page & sale banner',      w: 1200, h: 400 },
  wide_1280:     { label: 'Wide 16:9',     note: 'Hero section, YouTube',         w: 1280, h: 720 },
  email_600:     { label: 'Email header',  note: 'Newsletters (600 px wide)',     w: 600,  h: 300 },
};
/* GIFs are kept small so they load fast on websites: each quality has a longest-side limit and a
   file-size target. If a GIF comes out bigger, it is remade a little smaller until it fits.
   (The optional MP4 keeps the full size — it is tiny anyway.) */
const KB = 1024;
const QUALITY = {
  small:    { colors: 64,  dither: 'bayer:bayer_scale=4', maxSide: 480, target: 500 * KB },
  balanced: { colors: 96,  dither: 'bayer:bayer_scale=4', maxSide: 640, target: 900 * KB },
  best:     { colors: 160, dither: 'bayer:bayer_scale=3', maxSide: 800, target: 1000 * KB },
};
const LIMITS = { maxSeconds: 20, maxPhotos: 30, maxSizes: 8, maxSide: 1920, minSide: 64 };

/* What kind of file is this (by its first bytes, never by its name)? */
function sniff(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { kind: 'image', ext: 'jpg' };
  if (buf.readUInt32BE(0) === 0x89504e47) return { kind: 'image', ext: 'png' };
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { kind: 'image', ext: 'webp' };
  if (buf.toString('ascii', 0, 4) === 'GIF8') return { kind: 'video', ext: 'gif' };
  if (buf.toString('ascii', 4, 8) === 'ftyp') return { kind: 'video', ext: buf.toString('ascii', 8, 10) === 'qt' ? 'mov' : 'mp4' };
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return { kind: 'video', ext: 'webm' };
  return null;
}

const num = (v, min, max, def) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def; };
const even = n => Math.max(2, Math.round(n / 2) * 2);

/* Turn the user's choices into safe, checked settings */
function cleanOptions(o = {}) {
  const sizes = [];
  for (const k of Array.isArray(o.sizes) ? o.sizes : []) {
    if (SIZES[k]) sizes.push({ key: k, ...SIZES[k] });
  }
  if (o.custom && o.custom.w && o.custom.h) {
    const w = even(num(o.custom.w, LIMITS.minSide, LIMITS.maxSide, 800)), h = even(num(o.custom.h, LIMITS.minSide, LIMITS.maxSide, 800));
    sizes.push({ key: `custom_${w}x${h}`, label: 'Custom', note: `${w} × ${h}`, w, h });
  }
  const bg = /^#[0-9a-f]{6}$/i.test(o.background || '') ? o.background : (['blur', 'white', 'black'].includes(o.background) ? o.background : 'blur');
  return {
    sizes: [...new Map(sizes.map(s => [s.key, s])).values()].slice(0, LIMITS.maxSizes),
    fit: o.fit === 'fill' ? 'fill' : 'fit',
    background: bg,
    fps: Math.round(num(o.fps, 5, 25, 12)),
    speed: num(o.speed, 0.25, 4, 1.5),
    start: num(o.start, 0, 3600, 0),
    duration: num(o.duration, 0.5, LIMITS.maxSeconds, 4),
    slide: num(o.slide, 0.3, 6, 1.5),
    quality: QUALITY[o.quality] ? o.quality : 'balanced',
    loop: o.loop !== false,
    mp4: !!o.mp4,
  };
}

/* ffmpeg filter that makes one input exactly W×H */
function shapeFilter(inp, out, W, H, fit, bg, i) {
  const S = 'flags=lanczos';
  if (fit === 'fill') return `[${inp}]scale=${W}:${H}:force_original_aspect_ratio=increase:${S},crop=${W}:${H},setsar=1[${out}]`;
  if (bg === 'blur') {
    // blur a tiny copy (fast, little memory); the radius must fit the tiny copy's smallest side
    const bw = Math.max(8, even(W / 8)), bh = Math.max(8, even(H / 8));
    const rad = Math.max(1, Math.min(6, Math.floor(Math.min(bw, bh) / 4) - 1));
    return `[${inp}]split=2[a${i}][b${i}];` +
      `[a${i}]scale=${bw}:${bh}:force_original_aspect_ratio=increase,crop=${bw}:${bh},boxblur=${rad}:2,scale=${W}:${H},eq=brightness=-0.04[bg${i}];` +
      `[b${i}]scale=${W}:${H}:force_original_aspect_ratio=decrease:${S}[fg${i}];` +
      `[bg${i}][fg${i}]overlay=(W-w)/2:(H-h)/2,setsar=1[${out}]`;
  }
  const color = bg === 'white' ? '0xffffff' : bg === 'black' ? '0x000000' : '0x' + bg.slice(1);
  return `[${inp}]scale=${W}:${H}:force_original_aspect_ratio=decrease:${S},pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=${color},setsar=1[${out}]`;
}

/* The part shared by every pass: read the input(s) and turn them into W×H frames labelled [final].
   Returns { args, graph, next } — next = index for the next extra input. */
function sourceGraph({ inputs, kind, opts, size, watermark }) {
  const { w: W, h: H } = size;
  const args = [];
  const parts = [];
  if (kind === 'video') {
    args.push('-ss', String(opts.start), '-t', String(opts.duration * opts.speed), '-i', inputs[0]);
    parts.push(`[0:v]setpts=PTS/${opts.speed},fps=${opts.fps}[src]`);
    parts.push(shapeFilter('src', 'base', W, H, opts.fit, opts.background, 0));
  } else {
    inputs.forEach(f => args.push('-loop', '1', '-framerate', String(opts.fps), '-t', String(opts.slide), '-i', f));
    inputs.forEach((_, i) => parts.push(shapeFilter(`${i}:v`, `s${i}`, W, H, opts.fit, opts.background, i) + `;[s${i}]fps=${opts.fps},format=rgb24[v${i}]`));
    parts.push(`${inputs.map((_, i) => `[v${i}]`).join('')}concat=n=${inputs.length}:v=1:a=0[base]`);
  }
  let next = kind === 'video' ? 1 : inputs.length;
  if (watermark) {
    args.push('-i', watermark);
    parts.push(`[${next}:v]scale=${Math.round(Math.min(W * 0.42, H * 0.9))}:-1[wm];[base][wm]overlay=W-w-${Math.round(W * 0.03)}:H-h-${Math.round(H * 0.03)}[final]`);
    next++;
  } else {
    parts.push('[base]null[final]');
  }
  return { args, graph: parts.join(';'), next };
}

/* Three small ffmpeg runs per size instead of one big one. A one-pass GIF has to keep every frame in
   memory until its colour palette is known (up to ~900 MB for a 1080 px clip); in two passes the palette
   is worked out first and the GIF is then written frame by frame (~150 MB). */
function buildPasses({ inputs, kind, opts, size, gifSize, colors, fps, watermark, outGif, outMp4, palette }) {
  const Q = QUALITY[opts.quality];
  colors = colors || Q.colors;
  const gOpts = { ...opts, fps: fps || opts.fps };
  const gs = gifSize || size;
  const src = (sz = gs, o = gOpts) => sourceGraph({ inputs, kind, opts: o, size: sz, watermark });
  const passes = [];
  let g = src();
  passes.push([...g.args, '-filter_complex', `${g.graph};[final]palettegen=max_colors=${colors}:stats_mode=diff[pal]`,
    '-map', '[pal]', '-frames:v', '1', palette]);
  g = src();
  passes.push([...g.args, '-i', palette, '-filter_complex', `${g.graph};[final][${g.next}:v]paletteuse=dither=${Q.dither}:diff_mode=rectangle[gif]`,
    '-map', '[gif]', '-loop', opts.loop ? '0' : '-1', '-f', 'gif', outGif]);
  if (opts.mp4 && outMp4) {
    g = src(size, opts);
    passes.push([...g.args, '-filter_complex', `${g.graph};[final]format=yuv420p[mp4]`, '-map', '[mp4]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-threads', '2', '-x264-params', 'rc-lookahead=10:ref=2', '-movflags', '+faststart', '-an', outMp4]);
  }
  return passes;
}

/* Finished files are kept for an hour so the user can preview and download them */
const OUT_DIR = path.join(video.TMP, 'gif');
fs.mkdirSync(OUT_DIR, { recursive: true });
const jobs = new Map(); // id → { userId, dir, files, expires }
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) if (j.expires < now) { fs.rm(j.dir, { recursive: true, force: true }, () => {}); jobs.delete(id); }
}, 10 * 60 * 1000).unref();

async function make({ userId, files, opts, watermarkPath }) {
  const id = crypto.randomBytes(12).toString('hex');
  const dir = path.join(OUT_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const kind = files[0].type.kind;
    const inputs = files.map((f, i) => { const p = path.join(dir, `in${i}.${f.type.ext}`); fs.writeFileSync(p, f.buffer); return p; });
    const results = [];
    for (const size of opts.sizes) {
      const Q = QUALITY[opts.quality];
      const base = `${size.key}-${size.w}x${size.h}`;
      const outGif = path.join(dir, base + '.gif'), outMp4 = path.join(dir, base + '.mp4');
      const palette = path.join(dir, base + '.palette.png');
      // first try: fit inside the quality's longest-side limit, keeping the shape
      let k = Math.min(1, Q.maxSide / Math.max(size.w, size.h));
      let fps = opts.fps, colors = Q.colors, bytes = 0;
      for (let attempt = 0; attempt < 5; attempt++) {
        const gifSize = { w: even(size.w * k), h: even(size.h * k) };
        const passes = buildPasses({ inputs, kind, opts, size, gifSize, colors, fps, watermark: watermarkPath, outGif, outMp4: attempt === 0 ? outMp4 : null, palette });
        for (const args of passes) await video.runFfmpeg(args, 120000);
        bytes = fs.statSync(outGif).size;
        var made = gifSize;
        if (bytes <= Q.target || Math.min(gifSize.w, gifSize.h) <= 160) break;
        // too big: shrink by about what's needed, and from the 2nd retry also lower the frame rate / colours
        k *= Math.max(0.55, Math.min(0.9, Math.sqrt(Q.target / bytes) * 0.95));
        if (attempt >= 1) { fps = Math.max(8, fps - 2); colors = Math.max(48, Math.round(colors * 0.8)); }
      }
      fs.rm(palette, { force: true }, () => {});
      const r = { key: size.key, label: size.label, w: size.w, h: size.h, gif: base + '.gif', gifBytes: bytes,
        gifW: made.w, gifH: made.h, target: Q.target };
      if (opts.mp4 && fs.existsSync(outMp4)) { r.mp4 = base + '.mp4'; r.mp4Bytes = fs.statSync(outMp4).size; }
      results.push(r);
    }
    inputs.forEach(p => fs.rm(p, { force: true }, () => {}));
    jobs.set(id, { userId, dir, files: new Set(results.flatMap(r => [r.gif, r.mp4].filter(Boolean))), expires: Date.now() + 3600 * 1000 });
    return { id, results };
  } catch (e) {
    fs.rm(dir, { recursive: true, force: true }, () => {});
    throw e;
  }
}

/* Path of a finished file — only for the person who made it */
function outputPath(userId, id, file) {
  const j = jobs.get(String(id));
  if (!j || j.userId !== userId || !j.files.has(String(file))) return null;
  return path.join(j.dir, String(file));
}

module.exports = { SIZES, LIMITS, sniff, cleanOptions, buildPasses, make, outputPath, available: video.available };
