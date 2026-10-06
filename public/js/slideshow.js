/* Slideshow video — 3 (up to 5) photos + a template (motion, transition, text style) + music → a 10–15 s MP4.
   One renderer draws any moment of the video (frame(t)); the preview plays it live and the export records the
   very same frames at full size together with the music, then the server turns the recording into an MP4. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = PF.esc;
  const MAX = 5, MIN = 2;
  const SIZES = { ig_story: ['Story / Reels 9:16', 1080, 1920], ig_portrait: ['Portrait 4:5', 1080, 1350], ig_post: ['Square 1:1', 1080, 1080], yt_thumb: ['Landscape 16:9', 1280, 720] };
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  /* ------------------------------------------------------------------ templates */
  // text: font, weight, fx (shadow|outline|highlight|box|neon|retro|none), color, accent ('brand' = brand colour), pos, anim, upper
  const TEMPLATES = [
    { key: 'smooth', name: 'Smooth Fade', len: 12, trans: 'fade', td: 0.8, motion: 'zoomin', tint: 'grad',
      text: { font: 'Poppins', weight: 700, fx: 'shadow', color: '#ffffff', pos: 'bottom', anim: 'rise' } },
    { key: 'swipe', name: 'Swipe Shop', len: 10, trans: 'slide', td: 0.55, motion: 'panleft', tint: 'grad',
      text: { font: 'Anton', weight: 400, fx: 'retro', color: '#ffffff', accent: 'brand', pos: 'bottom', anim: 'slide', upper: true } },
    { key: 'flash', name: 'Flash Sale', len: 10, trans: 'flash', td: 0.45, motion: 'punch', tint: 'dark',
      text: { font: 'Archivo Black', weight: 400, fx: 'highlight', accent: 'brand', pos: 'center', anim: 'pop', upper: true } },
    { key: 'circle', name: 'Circle Reveal', len: 12, trans: 'circle', td: 0.8, motion: 'zoomout', tint: 'grad',
      text: { font: 'Courier Prime', weight: 700, fx: 'highlight', accent: '#ffffff', pos: 'bottom', anim: 'type' } },
    { key: 'elegant', name: 'Elegant', len: 15, trans: 'fade', td: 1.1, motion: 'slowzoom', tint: 'grad', bars: true, filter: 'warm',
      text: { font: 'Playfair Display', weight: 700, fx: 'box', color: '#ffffff', pos: 'bottom', anim: 'fade' } },
    { key: 'polaroid', name: 'Polaroid Pop', len: 12, trans: 'drop', td: 0.7, motion: 'still', fit: 'polaroid',
      text: { font: 'Caveat', weight: 700, fx: 'none', color: '#1a1a2e', pos: 'polaroid', anim: 'fade' } },
    { key: 'neon', name: 'Neon Night', len: 12, trans: 'wipe', td: 0.6, motion: 'zoomin', tint: 'night', filter: 'cool',
      text: { font: 'Pacifico', weight: 400, fx: 'neon', color: '#ffffff', accent: '#ff3da5', pos: 'center', anim: 'pop' } },
    { key: 'spin', name: 'Spin It', len: 10, trans: 'spin', td: 0.7, motion: 'zoomout', tint: 'grad',
      text: { font: 'Bebas Neue', weight: 400, fx: 'outline', color: '#ffffff', pos: 'center', anim: 'pop', upper: true } },
    { key: 'blinds', name: 'Blinds', len: 12, trans: 'blinds', td: 0.7, motion: 'panright', tint: 'top',
      text: { font: 'Montserrat', weight: 800, fx: 'highlight', accent: 'brand', pos: 'top', anim: 'slide' } },
    { key: 'reels', name: 'Reels Captions', len: 12, trans: 'slideup', td: 0.5, motion: 'zoomin',
      text: { font: 'Poppins', weight: 800, fx: 'highlight', accent: '#ffffff', pos: 'center', anim: 'pop' } },
    { key: 'festive', name: 'Festive Sparkle', len: 14, trans: 'circle', td: 0.8, motion: 'zoomin', tint: 'grad', filter: 'warm', sparkle: true,
      text: { font: 'Lobster', weight: 400, fx: 'shadow', color: '#ffd166', pos: 'bottom', anim: 'rise' } },
    { key: 'catalogue', name: 'Clean Catalogue', len: 15, trans: 'doors', td: 0.8, motion: 'still', fit: 'white',
      text: { font: 'Inter', weight: 700, fx: 'none', color: '#1a1a2e', pos: 'bottom', anim: 'fade' } },
  ];
  const tplOf = k => TEMPLATES.find(t => t.key === k) || TEMPLATES[0];

  /* ------------------------------------------------------------------ state */
  let ME = null, KITS = [], kit = null, logoImg = null;
  const slots = [null, null, null];          // { img, name, prep:{...} }
  const caps = ['', '', '', '', ''];
  let tpl = tplOf(store.get('pf-ss-tpl'));
  let sizeKey = SIZES[store.get('pf-ss-size')] ? store.get('pf-ss-size') : 'ig_story';
  let lenSec = tpl.len, musicKey = store.get('pf-ss-music') || 'sunny-market', LIB = [], userMusic = null;
  let SAMPLE = [];

  /* ------------------------------------------------------------------ helpers */
  const clamp = (v, a = 0, b = 1) => Math.max(a, Math.min(b, v));
  const ease = p => p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
  const easeOut = p => 1 - Math.pow(1 - p, 3);
  const easeBack = p => { const c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(p - 1, 3) + c1 * Math.pow(p - 1, 2); };
  const bounce = p => { const n = 7.5625, d = 2.75;
    if (p < 1 / d) return n * p * p; if (p < 2 / d) return n * (p -= 1.5 / d) * p + 0.75;
    if (p < 2.5 / d) return n * (p -= 2.25 / d) * p + 0.9375; return n * (p -= 2.625 / d) * p + 0.984375; };
  const stack = f => `"${f}", "Mukta", "Noto Sans Devanagari", "Noto Sans Bengali", "Noto Sans Thai", "Noto Sans Arabic", sans-serif`;
  const brand = () => (kit && /^#[0-9a-f]{6}$/i.test(kit.color || '') ? kit.color : '#ff6b4a');
  function onColor(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex)); if (!m) return '#1a1a2e';
    const n = parseInt(m[1], 16), lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) > 0.36 ? '#1a1a2e' : '#ffffff';
  }
  function rr(ctx, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2); ctx.beginPath(); ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  const loadImage = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  function wrap(ctx, text, maxW) {
    const words = String(text).split(/\s+/).filter(Boolean), out = []; let line = '';
    for (const w of words) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
    if (line) out.push(line); return out.length ? out : [''];
  }

  /* text effects — same looks as the editor */
  function fxDraw(ctx, lines, x, y, lh, size, color, fx, accent) {
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    const widths = lines.map(l => ctx.measureText(l).width);
    const plain = () => { ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetX = 0; ctx.shadowOffsetY = 0; };
    const each = (c, dx = 0, dy = 0) => { ctx.fillStyle = c; lines.forEach((l, i) => ctx.fillText(l, x + dx, y + i * lh + dy)); };
    plain();
    if (fx === 'highlight') {
      const px = size * 0.3, py = size * 0.16; ctx.fillStyle = accent;
      lines.forEach((l, i) => { if (!l.trim()) return; rr(ctx, x - widths[i] / 2 - px, y + i * lh - size * 0.84 - py, widths[i] + px * 2, size * 1.1 + py * 2, size * 0.2); ctx.fill(); });
      each(onColor(accent));
    } else if (fx === 'box') {
      const bw = Math.max(...widths), px = size * 0.6, py = size * 0.45; ctx.fillStyle = 'rgba(0,0,0,.5)';
      rr(ctx, x - bw / 2 - px, y - size * 0.84 - py, bw + px * 2, (lines.length - 1) * lh + size * 1.1 + py * 2, size * 0.4); ctx.fill(); each(color);
    } else if (fx === 'shadow') {
      ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = size * 0.25; ctx.shadowOffsetY = size * 0.07; each(color);
    } else if (fx === 'outline') {
      ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, size * 0.1); ctx.strokeStyle = '#111111';
      lines.forEach((l, i) => ctx.strokeText(l, x, y + i * lh)); each(color);
    } else if (fx === 'neon') {
      ctx.shadowColor = accent; ctx.shadowBlur = size * 0.45; each(accent); ctx.shadowBlur = size * 0.18; each(accent);
      ctx.shadowBlur = size * 0.05; each('#ffeefa');
    } else if (fx === 'retro') {
      each(accent, size * 0.07, size * 0.07); ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = size * 0.1; each(color);
    } else each(color);
    plain();
  }

  /* ------------------------------------------------------------------ photo preparation (filters + blurred backdrops, once) */
  function prepare(img, filter) {
    const max = 1600, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    const x = c.getContext('2d');
    x.filter = filter === 'warm' ? 'saturate(1.12) sepia(.14) contrast(1.04)' : filter === 'cool' ? 'saturate(1.15) hue-rotate(-10deg) contrast(1.06)' : 'none';
    x.drawImage(img, 0, 0, c.width, c.height);
    const b = document.createElement('canvas'); b.width = 160; b.height = Math.round(160 * c.height / c.width);
    const bx = b.getContext('2d'); bx.filter = 'blur(6px)'; bx.drawImage(c, -10, -10, b.width + 20, b.height + 20);
    return { c, b };
  }
  function prepFor(slot) {
    const f = tpl.filter || 'none';
    slot.prep = slot.prep || {};
    if (!slot.prep[f]) slot.prep[f] = prepare(slot.img, f);
    return slot.prep[f];
  }
  function cover(ctx, src, W, H, z = 1, ox = 0, oy = 0) {
    const s = Math.max(W / src.width, H / src.height) * z, w = src.width * s, h = src.height * s;
    ctx.drawImage(src, (W - w) / 2 + ox * W, (H - h) / 2 + oy * H, w, h);
  }

  /* ------------------------------------------------------------------ timeline */
  const photos = () => slots.filter(Boolean);
  const hasOutro = () => !!($('closing').value.trim() || $('contact').value.trim() || (logoImg && $('showLogo').checked));
  function timeline() {
    const list = photos().length ? photos() : SAMPLE;
    const n = list.length, segs = n + (hasOutro() ? 1 : 0), T = tpl.td;
    const outro = hasOutro() ? 2.6 : 0;
    const s = (lenSec - outro + (segs - 1) * T) / n;
    const out = []; let t = 0;
    for (let i = 0; i < segs; i++) { const len = i < n ? s : outro; out.push({ i, start: t, len, outro: i >= n, slot: list[i] }); t += len - T; }
    return { segs: out, list };
  }

  /* ------------------------------------------------------------------ drawing one segment */
  function motion(lt, len, idx) {
    const p = clamp(lt / len), m = tpl.motion;
    if (m === 'zoomin') return { z: 1 + 0.12 * p, ox: 0, oy: 0 };
    if (m === 'slowzoom') return { z: 1.02 + 0.08 * p, ox: 0, oy: 0 };
    if (m === 'zoomout') return { z: 1.14 - 0.12 * p, ox: 0, oy: 0 };
    if (m === 'panleft') return { z: 1.14, ox: 0.05 - 0.1 * p, oy: 0 };
    if (m === 'panright') return { z: 1.14, ox: -0.05 + 0.1 * p, oy: 0 };
    if (m === 'punch') return { z: 1 + 0.18 * (1 - easeOut(clamp(lt / 0.5))) + 0.03 * p, ox: 0, oy: 0 };
    return { z: 1, ox: 0, oy: 0, rot: ((idx % 2) ? 1 : -1) * 0.035 };
  }
  function textAnim(ctx, lt, len, draw) {
    const a = tpl.text.anim, start = 0.25, p = clamp((lt - start) / 0.5), out = clamp((len - lt - 0.05) / 0.35);
    if (lt < start) return;
    ctx.save();
    ctx.globalAlpha = Math.min(a === 'type' ? 1 : easeOut(p), out);
    if (a === 'rise') ctx.translate(0, (1 - easeOut(p)) * 40 * (ctx.canvas.height / 1920));
    if (a === 'slide') ctx.translate(-(1 - easeOut(p)) * ctx.canvas.width * 0.25, 0);
    if (a === 'pop') { const s = 0.6 + 0.4 * easeBack(p); const W = ctx.canvas.width, H = ctx.canvas.height; ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2); }
    draw(a === 'type' ? clamp((lt - start) / 1.1) : 1);
    ctx.restore();
  }
  function drawWords(ctx, W, H, title, cap, lt, len) {
    const st = tpl.text, base = Math.min(W, H);
    const accent = st.accent === 'brand' ? brand() : (st.accent || brand());
    const upper = s => st.upper ? s.toUpperCase() : s;
    const blocks = [];
    if (title) blocks.push({ text: upper(title), size: base * (st.pos === 'polaroid' ? 0.075 : 0.085) });
    if (cap) blocks.push({ text: upper(cap), size: base * (st.pos === 'polaroid' ? 0.058 : 0.056) });
    if (!blocks.length) return;
    textAnim(ctx, lt, len, reveal => {
      let laid = blocks.map(b => {
        ctx.font = `${st.weight} ${Math.round(b.size)}px ${stack(st.font)}`;
        const lines = wrap(ctx, b.text, W * 0.82).slice(0, 4);
        return { ...b, lines, lh: b.size * (st.fx === 'highlight' ? 1.45 : 1.18) };
      });
      const gap = base * 0.03;
      const total = laid.reduce((s, b) => s + (b.lines.length - 1) * b.lh + b.size * 1.05, 0) + gap * (laid.length - 1);
      let y;
      if (st.pos === 'top') y = H * 0.1;
      else if (st.pos === 'center') y = (H - total) / 2;
      else if (st.pos === 'polaroid') y = H * 0.5 + polaroidBox(W, H).h / 2 - polaroidBox(W, H).pad * 0.2 - total;
      else y = H * (tpl.bars ? 0.84 : 0.88) - total;
      for (const b of laid) {
        ctx.font = `${st.weight} ${Math.round(b.size)}px ${stack(st.font)}`;
        let lines = b.lines;
        if (reveal < 1) { const all = lines.join('\n'); const cut = all.slice(0, Math.round(all.length * reveal)); lines = cut.split('\n'); }
        fxDraw(ctx, lines, W / 2, y + b.size * 0.86, b.lh, b.size, st.color || '#ffffff', st.fx, accent);
        y += (b.lines.length - 1) * b.lh + b.size * 1.05 + gap;
      }
    });
  }
  function polaroidBox(W, H) {
    const pad = Math.min(W, H) * 0.035, w = Math.min(W * 0.78, H * 0.62), h = w * 1.18;
    return { w, h, pad };
  }
  function drawSlide(ctx, W, H, seg, lt, idx, title) {
    const slot = seg.slot, pr = prepFor(slot), m = motion(lt, seg.len, idx);
    if (tpl.fit === 'polaroid') {
      cover(ctx, pr.b, W, H, 1.1); ctx.fillStyle = 'rgba(255,255,255,.18)'; ctx.fillRect(0, 0, W, H);
      const { w, h, pad } = polaroidBox(W, H);
      ctx.save(); ctx.translate(W / 2, H / 2); ctx.rotate(m.rot || 0);
      ctx.shadowColor = 'rgba(0,0,0,.35)'; ctx.shadowBlur = W * 0.04; ctx.shadowOffsetY = W * 0.015;
      ctx.fillStyle = '#fffdf8'; ctx.fillRect(-w / 2, -h / 2, w, h); ctx.shadowColor = 'transparent';
      const iw = w - pad * 2, ih = iw;
      ctx.save(); ctx.beginPath(); ctx.rect(-w / 2 + pad, -h / 2 + pad, iw, ih); ctx.clip();
      ctx.translate(-w / 2 + pad, -h / 2 + pad); cover(ctx, pr.c, iw, ih, 1 + 0.05 * clamp(lt / seg.len)); ctx.restore();
      ctx.restore();
    } else if (tpl.fit === 'white') {
      ctx.fillStyle = '#f7f5f0'; ctx.fillRect(0, 0, W, H);
      const s = Math.min(W * 0.84 / pr.c.width, H * 0.66 / pr.c.height) * (1 + 0.04 * clamp(lt / seg.len));
      const w = pr.c.width * s, h = pr.c.height * s, x = (W - w) / 2, y = H * 0.43 - h / 2;
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = W * 0.04; ctx.shadowOffsetY = W * 0.012;
      rr(ctx, x, y, w, h, W * 0.02); ctx.fillStyle = '#fff'; ctx.fill(); ctx.shadowColor = 'transparent'; ctx.clip();
      ctx.drawImage(pr.c, x, y, w, h); ctx.restore();
      ctx.fillStyle = brand(); ctx.fillRect(W * 0.42, H * 0.43 + h / 2 + H * 0.035, W * 0.16, Math.max(3, H * 0.004));
    } else {
      cover(ctx, pr.c, W, H, m.z, m.ox, m.oy);
      if (tpl.tint === 'grad' || tpl.tint === 'top') {
        const g = tpl.tint === 'top' ? ctx.createLinearGradient(0, 0, 0, H * 0.45) : ctx.createLinearGradient(0, H * 0.45, 0, H);
        g.addColorStop(tpl.tint === 'top' ? 1 : 0, 'rgba(0,0,0,0)'); g.addColorStop(tpl.tint === 'top' ? 0 : 1, 'rgba(0,0,0,.6)');
        ctx.fillStyle = g; ctx.fillRect(0, tpl.tint === 'top' ? 0 : H * 0.45, W, H * 0.55);
      } else if (tpl.tint === 'dark') { ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(0, 0, W, H); }
      else if (tpl.tint === 'night') { ctx.fillStyle = 'rgba(10,0,40,.42)'; ctx.fillRect(0, 0, W, H); }
    }
    if (tpl.bars) { ctx.fillStyle = '#0d0d12'; ctx.fillRect(0, 0, W, H * 0.07); ctx.fillRect(0, H * 0.93, W, H * 0.07); }
    drawWords(ctx, W, H, title, caps[idx] || '', lt, seg.len);
  }
  function drawOutro(ctx, W, H, lt, len) {
    const b = brand(), base = Math.min(W, H);
    const light = tpl.fit === 'white';
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, light ? '#ffffff' : b); g.addColorStop(1, light ? '#f1ede6' : shade(b, -0.35));
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    const ink = light ? '#1a1a2e' : onColor(b);
    const p = clamp(lt / 0.6), s = 0.7 + 0.3 * easeBack(p);
    ctx.save(); ctx.translate(W / 2, H / 2); ctx.scale(s, s); ctx.translate(-W / 2, -H / 2); ctx.globalAlpha = easeOut(p);
    let y = H * 0.5;
    const closing = $('closing').value.trim(), contact = $('contact').value.trim();
    const logo = logoImg && $('showLogo').checked ? logoImg : null;
    const lsz = base * 0.22, csz = base * 0.085, ksz = base * 0.042, nsz = base * 0.04;
    const bname = !logo ? ((kit && kit.name) || (ME && ME.workspace && ME.workspace.name) || '') : '';
    const total = (logo ? lsz + base * 0.05 : 0) + (bname ? nsz * 2.6 : 0) + (closing ? csz * 1.3 : 0) + (contact ? ksz * 2 : 0);
    y = (H - total) / 2;
    if (bname) {
      ctx.font = `700 ${Math.round(nsz)}px ${stack('Inter')}`;
      if ('letterSpacing' in ctx) ctx.letterSpacing = `${Math.round(nsz * 0.18)}px`;
      fxDraw(ctx, [bname.toUpperCase().slice(0, 40)], W / 2, y + nsz, nsz, nsz, ink, 'none', b);
      if ('letterSpacing' in ctx) ctx.letterSpacing = '0px';
      ctx.fillStyle = ink; ctx.globalAlpha *= 0.6; ctx.fillRect(W / 2 - base * 0.06, y + nsz * 1.7, base * 0.12, Math.max(2, base * 0.004)); ctx.globalAlpha = easeOut(p);
      y += nsz * 2.6;
    }
    if (logo) {
      const r = logo.naturalWidth / logo.naturalHeight; let lw = lsz * Math.max(1, r), lh = lw / r; if (lh > lsz) { lh = lsz; lw = lh * r; }
      if (lw > W * 0.6) { lw = W * 0.6; lh = lw / r; }
      ctx.drawImage(logo, (W - lw) / 2, y + (lsz - lh) / 2, lw, lh); y += lsz + base * 0.05;
    }
    if (closing) {
      ctx.font = `800 ${Math.round(csz)}px ${stack(tpl.text.font === 'Courier Prime' ? 'Poppins' : tpl.text.font)}`;
      const lines = wrap(ctx, closing, W * 0.84).slice(0, 2);
      fxDraw(ctx, lines, W / 2, y + csz * 0.86, csz * 1.15, csz, ink, 'none', b); y += csz * 1.3 + (lines.length - 1) * csz * 1.15;
    }
    if (contact) {
      ctx.font = `600 ${Math.round(ksz)}px ${stack('Inter')}`;
      ctx.globalAlpha *= 0.85; fxDraw(ctx, [contact], W / 2, y + ksz * 1.3, ksz, ksz, ink, 'none', b);
    }
    ctx.restore();
  }
  function shade(hex, amt) {
    const n = parseInt(hex.slice(1), 16); const f = c => Math.round(clamp(c + amt * (amt < 0 ? c : 255 - c), 0, 255));
    return '#' + [n >> 16, (n >> 8) & 255, n & 255].map(f).map(v => v.toString(16).padStart(2, '0')).join('');
  }
  function sparkles(ctx, W, H, t) {
    const base = Math.min(W, H);
    for (let k = 0; k < 34; k++) {
      const hx = (Math.sin(k * 127.1) * 43758.5453) % 1, hy = (Math.sin(k * 311.7) * 12543.123) % 1;
      const x = Math.abs(hx) * W, y = (Math.abs(hy) * H + t * base * 0.04 * (1 + (k % 3))) % H;
      const tw = 0.5 + 0.5 * Math.sin(t * 4 + k), r = base * (0.006 + 0.008 * ((k % 4) / 3)) * (0.6 + tw * 0.6);
      ctx.save(); ctx.globalAlpha = 0.35 + 0.6 * tw; ctx.fillStyle = k % 5 ? '#ffd166' : '#ffffff';
      ctx.shadowColor = '#ffd166'; ctx.shadowBlur = r * 3; ctx.translate(x, y); ctx.beginPath();
      for (let j = 0; j < 8; j++) { const a = j * Math.PI / 4, rad = j % 2 ? r * 0.35 : r * 1.6; ctx.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); }
      ctx.closePath(); ctx.fill(); ctx.restore();
    }
  }

  /* ------------------------------------------------------------------ transitions (A → B) */
  function transition(ctx, A, B, p, W, H) {
    const e = ease(p);
    switch (tpl.trans) {
      case 'slide': ctx.drawImage(A, -e * W, 0); ctx.drawImage(B, W * (1 - e), 0); break;
      case 'slideup': ctx.drawImage(A, 0, -e * H); ctx.drawImage(B, 0, H * (1 - e)); break;
      case 'flash':
        ctx.drawImage(p < 0.5 ? A : B, 0, 0);
        ctx.fillStyle = `rgba(255,255,255,${p < 0.5 ? p * 2 : (1 - p) * 2})`; ctx.fillRect(0, 0, W, H); break;
      case 'circle': {
        ctx.drawImage(A, 0, 0); ctx.save(); ctx.beginPath(); ctx.arc(W / 2, H / 2, e * Math.hypot(W, H) / 2, 0, Math.PI * 2); ctx.clip();
        ctx.drawImage(B, 0, 0); ctx.restore(); break;
      }
      case 'wipe': {
        ctx.drawImage(A, 0, 0); const k = H * 0.35, x = -k + e * (W + k * 2);
        ctx.save(); ctx.beginPath(); ctx.moveTo(-1, 0); ctx.lineTo(x + k, 0); ctx.lineTo(x - k, H); ctx.lineTo(-1, H); ctx.closePath(); ctx.clip();
        ctx.drawImage(B, 0, 0); ctx.restore(); break;
      }
      case 'blinds': {
        ctx.drawImage(A, 0, 0); ctx.save(); ctx.beginPath(); const n = 8, sw = W / n;
        for (let i = 0; i < n; i++) ctx.rect(i * sw, 0, sw * clamp(e * 1.15 - i * 0.02), H);
        ctx.clip(); ctx.drawImage(B, 0, 0); ctx.restore(); break;
      }
      case 'spin': {
        ctx.drawImage(A, 0, 0); ctx.fillStyle = `rgba(0,0,0,${0.4 * e})`; ctx.fillRect(0, 0, W, H);
        ctx.save(); ctx.globalAlpha = clamp(p * 1.6); ctx.translate(W / 2, H / 2); ctx.rotate((1 - e) * -0.6); const s = 0.5 + 0.5 * easeOut(p); ctx.scale(s, s);
        ctx.drawImage(B, -W / 2, -H / 2); ctx.restore(); break;
      }
      case 'doors': {
        ctx.drawImage(B, 0, 0);
        ctx.drawImage(A, 0, 0, W / 2, H, -e * W / 2, 0, W / 2, H);
        ctx.drawImage(A, W / 2, 0, W / 2, H, W / 2 + e * W / 2, 0, W / 2, H); break;
      }
      case 'drop': {
        ctx.drawImage(A, 0, 0); ctx.fillStyle = `rgba(0,0,0,${0.3 * p})`; ctx.fillRect(0, 0, W, H);
        ctx.drawImage(B, 0, -H * (1 - bounce(p))); break;
      }
      default: ctx.drawImage(A, 0, 0); ctx.globalAlpha = e; ctx.drawImage(B, 0, 0); ctx.globalAlpha = 1;
    }
  }

  /* ------------------------------------------------------------------ one frame */
  const layers = new Map();
  function layer(name, W, H) {
    let c = layers.get(name);
    if (!c || c.width !== W || c.height !== H) { c = document.createElement('canvas'); c.width = W; c.height = H; layers.set(name, c); }
    const x = c.getContext('2d'); x.setTransform(1, 0, 0, 1, 0, 0); x.globalAlpha = 1; x.clearRect(0, 0, W, H); return c;
  }
  function drawSeg(ctx, W, H, seg, t) {
    const lt = t - seg.start;
    if (seg.outro) drawOutro(ctx, W, H, lt, seg.len);
    else drawSlide(ctx, W, H, seg, lt, seg.i, seg.i === 0 ? $('title').value.trim() : '');
  }
  function frame(ctx, W, H, t) {
    const { segs } = timeline();
    ctx.save(); ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    let cur = segs.findIndex(s => t >= s.start && t < s.start + s.len);
    if (cur < 0) cur = segs.length - 1;
    const next = segs[cur + 1];
    if (next && t >= next.start) {
      const A = layer('a', W, H), B = layer('b', W, H);
      drawSeg(A.getContext('2d'), W, H, segs[cur], t); drawSeg(B.getContext('2d'), W, H, next, t);
      transition(ctx, A, B, clamp((t - next.start) / tpl.td), W, H);
    } else drawSeg(ctx, W, H, segs[cur], t);
    if (tpl.sparkle) sparkles(ctx, W, H, t);
    if (ME && ME.plan && ME.plan.watermark) watermark(ctx, W, H);
    ctx.restore();
  }
  function watermark(ctx, W, H) {
    const s = Math.min(W, H) * 0.03; ctx.font = `700 ${s}px ${stack('Space Grotesk')}`; ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(255,255,255,.75)'; ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 6; ctx.fillText('Made with PostForge', W - s, H - s); ctx.shadowColor = 'transparent';
  }

  /* ------------------------------------------------------------------ preview playback */
  const pv = $('pv');
  let playing = false, t0 = 0, tNow = 1.2, raf = 0;
  function sizePreview() {
    const [, W, H] = SIZES[sizeKey]; const s = Math.min(1, 720 / Math.max(W, H));
    pv.width = Math.round(W * s); pv.height = Math.round(H * s);
    $('stage').style.aspectRatio = `${W} / ${H}`;
  }
  function draw() { frame(pv.getContext('2d'), pv.width, pv.height, tNow); showTime(); }
  function showTime() { $('tbar').style.width = (tNow / lenSec * 100) + '%'; $('tlabel').textContent = `${tNow.toFixed(1)} / ${lenSec} s`; }
  function tick() {
    if (!playing) return;
    tNow = (performance.now() - t0) / 1000;
    if (tNow >= lenSec) { tNow = lenSec - 0.001; stop(); draw(); return; }
    draw(); raf = requestAnimationFrame(tick);
  }
  async function play() {
    if (playing) { stop(); return; }
    if (tNow >= lenSec - 0.05) tNow = 0;
    playing = true; $('play').textContent = '⏸ Pause';
    await startMusic(tNow, false);
    t0 = performance.now() - tNow * 1000; tick();
  }
  function stop() { playing = false; cancelAnimationFrame(raf); stopMusic(); $('play').textContent = '▶ Play'; }
  $('play').addEventListener('click', play);
  $('stage').addEventListener('click', e => { if (!e.target.closest('.ss-rec')) play(); });
  document.querySelector('.ss-time').addEventListener('click', e => {
    const r = e.currentTarget.getBoundingClientRect(); const was = playing; stop();
    tNow = clamp((e.clientX - r.left) / r.width) * lenSec; draw(); if (was) play();
  });
  const redraw = () => { if (!playing) draw(); };

  /* ------------------------------------------------------------------ music (Web Audio) */
  let actx = null, buffers = new Map(), src = null, gain = null;
  const audioCtx = () => (actx = actx || new (window.AudioContext || window.webkitAudioContext)());
  async function bufferFor(key) {
    if (key === 'none') return null;
    if (key === 'mine') return userMusic ? userMusic.buf : null;
    if (buffers.has(key)) return buffers.get(key);
    const tr = LIB.find(x => x.key === key); if (!tr) return null;
    const ab = await (await fetch(tr.file)).arrayBuffer();
    const buf = await audioCtx().decodeAudioData(ab); buffers.set(key, buf); return buf;
  }
  /* start the music at offset (s); connect to speakers and/or a recording stream */
  async function startMusic(offset, toDest, speakers = true) {
    stopMusic();
    let buf = null; try { buf = await bufferFor(musicKey); } catch { buf = null; }
    if (!buf) return null;
    const ctx = audioCtx(); if (ctx.state === 'suspended') await ctx.resume();
    src = ctx.createBufferSource(); src.buffer = buf; src.loop = true;
    gain = ctx.createGain(); const v = +$('vol').value / 100, now = ctx.currentTime, end = lenSec - offset;
    gain.gain.setValueAtTime(offset < 0.05 ? 0 : v, now); if (offset < 0.05) gain.gain.linearRampToValueAtTime(v, now + 0.25);
    gain.gain.setValueAtTime(v, now + Math.max(0, end - 1.6)); gain.gain.linearRampToValueAtTime(0, now + Math.max(0.05, end));
    src.connect(gain);
    if (speakers) gain.connect(ctx.destination);
    if (toDest) gain.connect(toDest);
    src.start(now, offset % buf.duration);
    return src;
  }
  function stopMusic() { try { src && src.stop(); } catch {} src = null; }

  async function loadLibrary() {
    try { LIB = await (await fetch('/music/library.json')).json(); } catch { LIB = []; }
    if (musicKey !== 'none' && musicKey !== 'mine' && !LIB.some(x => x.key === musicKey)) musicKey = LIB[0] ? LIB[0].key : 'none';
    if (musicKey === 'mine') musicKey = LIB[0] ? LIB[0].key : 'none';
    renderMusic();
  }
  let auditionKey = null;
  function renderMusic() {
    const row = (key, name, sub) => `<div class="ss-track${musicKey === key ? ' on' : ''}" data-k="${esc(key)}">
      ${key !== 'none' ? `<button type="button" class="ss-aud" data-aud="${esc(key)}" title="Listen">${auditionKey === key ? '⏸' : '▶'}</button>` : '<span class="ss-aud off">∅</span>'}
      <div class="ss-tn"><b>${esc(name)}</b><small>${esc(sub)}</small></div></div>`;
    $('music').innerHTML = row('none', 'No music', 'Silent video')
      + (userMusic ? row('mine', userMusic.name, 'Your music') : '')
      + LIB.map(tr => row(tr.key, tr.name, `${tr.mood} · ${tr.description}`)).join('');
  }
  $('music').addEventListener('click', async e => {
    const a = e.target.closest('[data-aud]');
    if (a) {
      e.stopPropagation(); stop();
      if (auditionKey === a.dataset.aud) { auditionKey = null; stopMusic(); renderMusic(); return; }
      auditionKey = a.dataset.aud; renderMusic();
      const keep = musicKey; musicKey = auditionKey; const saveLen = lenSec; lenSec = 30;
      await startMusic(0, null); musicKey = keep; lenSec = saveLen; return;
    }
    const r = e.target.closest('[data-k]'); if (!r) return;
    musicKey = r.dataset.k; if (musicKey !== 'mine') store.set('pf-ss-music', musicKey);
    auditionKey = null; stopMusic(); renderMusic();
  });
  $('musicUp').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    if (f.size > 15 * 1024 * 1024) { toast('That music file is over 15 MB.'); return; }
    try {
      const buf = await audioCtx().decodeAudioData(await f.arrayBuffer());
      userMusic = { name: f.name.replace(/\.[^.]+$/, '').slice(0, 40), buf }; musicKey = 'mine'; renderMusic();
      toast('Your music is ready ✓');
    } catch { toast('We could not read that music file — try an MP3.'); }
  });
  $('vol').addEventListener('input', e => { $('volVal').textContent = e.target.value + '%'; if (gain) gain.gain.value = e.target.value / 100; });

  /* ------------------------------------------------------------------ photos */
  function renderSlots() {
    $('slots').innerHTML = slots.map((s, i) => `<div class="ss-slot${s ? ' has' : ''}" data-i="${i}" draggable="${s ? 'true' : 'false'}">
      ${s ? `<img src="${s.thumb}" alt=""><button type="button" class="ss-x" data-x="${i}" title="Remove">✕</button>` : '<span class="ss-plus">＋</span>'}
      <span class="ss-num">${i + 1}</span>
      <input type="file" accept="image/jpeg,image/png,image/webp,image/*" multiple data-in="${i}" ${s ? 'hidden' : ''}></div>`).join('')
      + (slots.length < MAX ? '<button type="button" class="ss-slot ss-more" id="addSlot" title="Add another photo">＋<small>Add</small></button>' : '');
    $('caps').innerHTML = slots.map((s, i) => `<div class="field"><label for="cap${i}">Text on photo ${i + 1} <span class="muted small">(optional)</span></label>
      <input class="input" id="cap${i}" data-cap="${i}" maxlength="60" value="${esc(caps[i] || '')}" placeholder="${i === 0 ? 'e.g. Handmade with love' : i === 1 ? 'e.g. Rs. 1,250 only' : 'e.g. Free delivery in town'}"></div>`).join('');
    const n = photos().length;
    $('go').disabled = n < MIN;
    $('goNote').textContent = n < MIN ? (n ? 'Add at least one more photo.' : 'Add 3 photos to start — the preview shows sample pictures until then.') : (ME && !ME.plan.video_export ? 'Preview is free — downloading videos is included from the Starter plan.' : `${n} photos · ${lenSec} s · ${SIZES[sizeKey][0]}`);
    redraw(); clearTimeout(thumbTimer); thumbTimer = setTimeout(thumbs, 250);
  }
  let thumbTimer;
  async function addFile(i, f) {
    if (!f || !/^image\//.test(f.type)) { toast('Please choose a photo (JPG, PNG or WEBP).'); return; }
    if (f.size > 25 * 1024 * 1024) { toast('That photo is over 25 MB.'); return; }
    const url = URL.createObjectURL(f);
    try {
      const img = await loadImage(url);
      const t = document.createElement('canvas'); const s = 160 / Math.max(img.naturalWidth, img.naturalHeight);
      t.width = Math.round(img.naturalWidth * s); t.height = Math.round(img.naturalHeight * s); t.getContext('2d').drawImage(img, 0, 0, t.width, t.height);
      slots[i] = { img, name: f.name, thumb: t.toDataURL('image/jpeg', 0.8) };
    } catch { toast('We could not open that photo.'); }
    renderSlots();
  }
  $('slots').addEventListener('change', e => {
    const inp = e.target.closest('[data-in]'); if (!inp) return;
    const files = [...inp.files]; let i = +inp.dataset.in;
    files.slice(0, MAX).forEach(f => { while (i < slots.length && slots[i]) i++; if (i >= slots.length && slots.length < MAX) slots.push(null); if (i < slots.length) addFile(i++, f); });
  });
  $('slots').addEventListener('click', e => {
    const x = e.target.closest('[data-x]');
    if (x) { e.preventDefault(); const i = +x.dataset.x; slots[i] = null; if (slots.length > 3) { slots.splice(i, 1); caps.splice(i, 1); caps.push(''); } renderSlots(); return; }
    if (e.target.closest('#addSlot')) { slots.push(null); renderSlots(); }
  });
  // drag to reorder
  let dragFrom = null;
  $('slots').addEventListener('dragstart', e => { const s = e.target.closest('.ss-slot.has'); if (s) dragFrom = +s.dataset.i; });
  $('slots').addEventListener('dragover', e => { if (dragFrom !== null && e.target.closest('.ss-slot[data-i]')) e.preventDefault(); });
  $('slots').addEventListener('drop', e => {
    const s = e.target.closest('.ss-slot[data-i]'); if (dragFrom === null || !s) return; e.preventDefault();
    const to = +s.dataset.i; [slots[dragFrom], slots[to]] = [slots[to], slots[dragFrom]]; [caps[dragFrom], caps[to]] = [caps[to], caps[dragFrom]]; dragFrom = null; renderSlots();
  });
  $('caps').addEventListener('input', e => { const c = e.target.closest('[data-cap]'); if (c) { caps[+c.dataset.cap] = c.value; redraw(); } });
  ['title', 'closing', 'contact'].forEach(id => $(id).addEventListener('input', () => { loadFonts(); redraw(); }));
  $('showLogo').addEventListener('change', redraw);

  /* ------------------------------------------------------------------ templates picker (small animated previews) */
  function renderTemplates() {
    $('tpls').innerHTML = TEMPLATES.map(t => `<button type="button" class="ss-tpl${t.key === tpl.key ? ' on' : ''}" data-t="${t.key}">
      <canvas width="90" height="160" data-c="${t.key}"></canvas><span>${esc(t.name)}</span><small>${t.len}s</small></button>`).join('');
    $('tplName').textContent = '· ' + tpl.name;
    thumbs();
  }
  function thumbs() {
    const keep = tpl, keepLen = lenSec;
    document.querySelectorAll('#tpls canvas').forEach(c => {
      tpl = tplOf(c.dataset.c); lenSec = tpl.len;
      const { segs } = timeline();
      const at = segs[1] ? segs[1].start + tpl.td * (tpl.trans === 'flash' ? 0.92 : 0.5) : 1.2; // mid-transition shows the effect
      frame(c.getContext('2d'), c.width, c.height, at);
    });
    tpl = keep; lenSec = keepLen;
  }
  let hoverAnim = 0;
  $('tpls').addEventListener('mouseover', e => {
    const b = e.target.closest('[data-t]'); if (!b || b._anim) return;
    b._anim = true; const c = b.querySelector('canvas'), T = tplOf(b.dataset.t), start = performance.now();
    const step = () => {
      if (!b._anim) return;
      const keep = tpl, keepLen = lenSec; tpl = T; lenSec = T.len;
      frame(c.getContext('2d'), c.width, c.height, ((performance.now() - start) / 1000) % T.len);
      tpl = keep; lenSec = keepLen; hoverAnim = requestAnimationFrame(step);
    };
    step();
    b.addEventListener('mouseleave', () => { b._anim = false; }, { once: true });
  });
  $('tpls').addEventListener('click', e => {
    const b = e.target.closest('[data-t]'); if (!b) return;
    tpl = tplOf(b.dataset.t); store.set('pf-ss-tpl', tpl.key);
    lenSec = tpl.len; $('len').value = lenSec; $('lenVal').textContent = lenSec + ' s';
    document.querySelectorAll('.ss-tpl').forEach(x => x.classList.toggle('on', x === b)); $('tplName').textContent = '· ' + tpl.name;
    loadFonts().then(() => { stop(); tNow = Math.min(1.2, lenSec); draw(); play(); });
  });
  $('len').addEventListener('input', e => { lenSec = +e.target.value; $('lenVal').textContent = lenSec + ' s'; if (tNow > lenSec) tNow = 0; renderSlots(); });

  function renderSizes() {
    $('sizes').innerHTML = Object.entries(SIZES).map(([k, [l]]) => `<button type="button" data-k="${k}" class="${k === sizeKey ? 'on' : ''}">${esc(l)}</button>`).join('');
  }
  $('sizes').addEventListener('click', e => {
    const b = e.target.closest('[data-k]'); if (!b) return; sizeKey = b.dataset.k; store.set('pf-ss-size', sizeKey);
    renderSizes(); sizePreview(); renderSlots();
  });

  /* ------------------------------------------------------------------ brand kit + fonts */
  async function pickKit() {
    kit = KITS.find(k => String(k.id) === $('kit').value) || null;
    store.set('pf-ss-kit', $('kit').value);
    logoImg = null;
    if (kit && kit.logo_url) logoImg = await loadImage(kit.logo_url).catch(() => null);
    const contact = kit ? [kit.phone, kit.website || (kit.socials && kit.socials.instagram)].filter(Boolean).join(' · ') : '';
    if (!$('contact').dataset.touched) $('contact').value = contact;
    redraw(); thumbs();
  }
  $('contact').addEventListener('input', () => { $('contact').dataset.touched = '1'; });
  $('kit').addEventListener('change', pickKit);
  async function loadFonts() {
    if (!document.fonts) return;
    const sample = [$('title').value, $('closing').value, $('contact').value, ...caps].join(' ') + 'Aa';
    const fams = [...new Set(TEMPLATES.map(t => t.text.font).concat(['Poppins', 'Inter', 'Space Grotesk', 'Mukta']))];
    try { await Promise.all(fams.map(f => document.fonts.load(`700 40px "${f}"`, sample))); } catch { /* fallbacks */ }
  }

  /* ------------------------------------------------------------------ export */
  const MP4_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4'];
  const WEBM_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  function mime() {
    if (!window.MediaRecorder) return null;
    const conv = ME && ME.features && ME.features.mp4Convert;
    return (conv ? [...WEBM_TYPES, ...MP4_TYPES] : [...MP4_TYPES, ...WEBM_TYPES]).find(m => MediaRecorder.isTypeSupported(m)) || null;
  }
  async function makeVideo() {
    if (photos().length < MIN) return;
    if (!ME.plan.video_export) { notice('Downloading videos is included from the Starter plan', 'You can try every template and song for free. Upgrade to download your slideshow as an MP4.'); return; }
    const type = mime();
    if (!type) { notice('Your browser can’t record video', 'Please use the latest Chrome, Edge or Safari.'); return; }
    let grant;
    try { grant = await PF.api('/exports', { method: 'POST', body: { items: [{ platform: sizeKey, kind: 'video' }], quality: 1 } }); }
    catch (e) { notice('Can’t download right now', e.message); return; }
    showUsage(grant.usage);
    stop(); auditionKey = null; renderMusic();
    const out = $('out'), [, W, H] = SIZES[sizeKey]; out.width = W; out.height = H;
    const octx = out.getContext('2d');
    await loadFonts();
    timeline().list.forEach(prepFor);
    frame(octx, W, H, 0);
    $('rec').classList.remove('hidden'); $('go').disabled = true; $('done').classList.add('hidden');
    const stream = out.captureStream(30);
    let dest = null;
    if (musicKey !== 'none') { dest = audioCtx().createMediaStreamDestination(); }
    const tracks = [...stream.getVideoTracks(), ...(dest ? dest.stream.getAudioTracks() : [])];
    const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: type, videoBitsPerSecond: 9000000, audioBitsPerSecond: 192000 });
    const chunks = []; rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
    const done = new Promise(r => { rec.onstop = r; });
    rec.start(200);
    if (dest) await startMusic(0, dest, true);
    const start = performance.now();
    await new Promise(resolve => {
      const iv = setInterval(() => {
        const t = (performance.now() - start) / 1000;
        frame(octx, W, H, Math.min(t, lenSec - 0.001));
        $('bar').style.width = Math.min(100, t / lenSec * 100) + '%';
        if (t >= lenSec + 0.15) { clearInterval(iv); resolve(); }
      }, 1000 / 30);
    });
    rec.stop(); stopMusic(); await done;
    let blob = new Blob(chunks, { type }), ext = type.startsWith('video/mp4') ? 'mp4' : 'webm';
    $('recTitle').textContent = 'Making your MP4…'; $('recNote').textContent = 'Almost done.';
    if (ME.features && ME.features.mp4Convert) {
      try {
        const r = await fetch('/api/video/convert', { method: 'POST', body: blob, credentials: 'same-origin',
          headers: { 'Content-Type': type.split(';')[0], 'X-CSRF-Token': PF.csrf() || '' } });
        if (r.ok) { blob = await r.blob(); ext = 'mp4'; }
      } catch { /* keep the browser recording */ }
    }
    $('rec').classList.add('hidden'); $('recTitle').textContent = 'Recording your video…'; $('recNote').textContent = 'Keep this tab open — it takes as long as the video.';
    $('go').disabled = false;
    const name = `${(($('title').value || tpl.name).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'slideshow')}-${sizeKey}.${ext}`;
    const url = URL.createObjectURL(blob);
    $('done').innerHTML = `<video src="${url}" controls playsinline></video><div><b>Your video is ready ✓</b><p class="small muted">${(blob.size / 1048576).toFixed(1)} MB · ${ext.toUpperCase()} · ${W}×${H}${ext === 'webm' ? ' — this browser saved WebM; Instagram prefers MP4 (try Chrome or Safari)' : ''}</p>
      <a class="btn btn-primary" href="${url}" download="${esc(name)}">⬇ Download video</a></div>`;
    $('done').classList.remove('hidden');
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  }
  $('go').addEventListener('click', makeVideo);

  /* ------------------------------------------------------------------ ui bits */
  let tmo;
  function toast(t) {
    let el = document.querySelector('.ss-toast');
    if (!el) { el = document.createElement('div'); el.className = 'ss-toast'; document.body.appendChild(el); }
    el.textContent = t; el.style.display = 'block'; clearTimeout(tmo); tmo = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }
  function notice(title, text) {
    $('done').innerHTML = `<div><b>${esc(title)}</b><p class="small muted">${esc(text)}</p>${/Starter/.test(title) ? '<a class="btn btn-primary" href="/app#billing">See plans</a>' : ''}</div>`;
    $('done').classList.remove('hidden');
  }
  function showUsage(u) { if (u) $('usage').textContent = u.remaining > 99999 ? 'Unlimited downloads' : `⬇ ${u.remaining} downloads left ${u.label || ''}`; }

  /* sample photos so the templates show something before any upload */
  function samplePhoto(colors, emoji) {
    const c = document.createElement('canvas'); c.width = 600; c.height = 800; const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, 600, 800); g.addColorStop(0, colors[0]); g.addColorStop(1, colors[1]); x.fillStyle = g; x.fillRect(0, 0, 600, 800);
    x.globalAlpha = 0.18; x.fillStyle = '#fff'; x.beginPath(); x.arc(420, 220, 180, 0, 7); x.fill(); x.globalAlpha = 1;
    x.font = '220px "Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji",sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(emoji, 300, 400);
    c.naturalWidth = c.width; c.naturalHeight = c.height;
    return { img: c, name: 'sample', thumb: '' };
  }

  async function init() {
    try { ME = await PF.loadMe(); } catch { return; }
    showUsage(ME.usage);
    SAMPLE = [samplePhoto(['#ff9a76', '#c2185b'], '🛍️'), samplePhoto(['#4facfe', '#2a3eb1'], '👟'), samplePhoto(['#43e97b', '#0f766e'], '🎁')];
    try { KITS = await PF.api('/brand-kits'); } catch { KITS = []; }
    $('kit').innerHTML = '<option value="">No brand kit — default colours</option>' + KITS.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('');
    const saved = store.get('pf-ss-kit'); if (saved && KITS.some(k => String(k.id) === saved)) $('kit').value = saved; else if (KITS.length) $('kit').value = String(KITS[0].id);
    $('len').value = lenSec; $('lenVal').textContent = lenSec + ' s';
    await loadFonts();
    renderSizes(); sizePreview(); renderSlots(); renderTemplates();
    await pickKit();
    loadLibrary();
    draw();
  }
  window.PFSlideshow = { seek: t => { stop(); tNow = clamp(t, 0, lenSec - 0.001); draw(); }, length: () => lenSec };
  init();
})();
