'use strict';

/* ============================================================
   POSTFORGE — EDITOR ENGINE v4 (SaaS edition)
   Canvas engine from v3 (multi-platform batch export, customer
   review layout, classical background removal, brand-colour
   extraction) plus: server-saved designs & media, brand kits,
   plan-based feature access, and server-authorised downloads
   that count against each user's plan allowance.
   ============================================================ */

/* ---------------------------------------------------------------
   PLATFORM CONFIG — single source of truth for every dimension
   picker, the batch checklist, and exported filenames. Update
   this table if a platform changes its recommended size.
   --------------------------------------------------------------- */
const PLATFORMS = {
  ig_post:    { label:'Instagram Post',        w:1080, h:1080 },
  ig_portrait:{ label:'Instagram Portrait',    w:1080, h:1350 },
  ig_story:   { label:'Instagram Story/Reels', w:1080, h:1920 },
  fb_post:    { label:'Facebook Post',         w:1080, h:1080 },
  fb_story:   { label:'Facebook Story',        w:1080, h:1920 },
  fb_cover:   { label:'Facebook Cover',        w:851,  h:315  },
  li_post:    { label:'LinkedIn Post',         w:1080, h:1350 },
  li_banner:  { label:'LinkedIn Banner',       w:1584, h:396  },
  pin:        { label:'Pinterest Pin',         w:1000, h:1500 },
  x_post:     { label:'X (Twitter) Post',      w:1080, h:1080 },
  tiktok:     { label:'TikTok',                w:1080, h:1920 },
  yt_thumb:   { label:'YouTube Thumbnail',     w:1280, h:720  },
  yt_shorts:  { label:'YouTube Shorts',        w:1080, h:1920 },
  wa_status:  { label:'WhatsApp Status',       w:1080, h:1920 },
};

/* ---------------------------------------------------------------
   THEMES — overlay type, font, colours, CTA style per look
   --------------------------------------------------------------- */
/* Themes, fonts, layouts and the template library live in /js/content.js */
const { THEMES, TEMPLATES, FONTS, LAYOUTS, CATEGORIES } = window.PF_CONTENT;

/* ---------------------------------------------------------------
   STATE — single source of truth for the canvas render
   --------------------------------------------------------------- */
const state = {
  contentType: 'promo',       // 'promo' | 'review'
  platformKey: 'ig_post',
  platformW:   1080,
  platformH:   1080,

  mediaSrcEl:   null,         // original <img> or <video> element (never mutated)
  mediaProcessed: null,       // background-removed <canvas>, or null
  mediaIsVideo: false,
  bgRemoved:    false,

  logoImg:     null,
  logoPos:     'tr',
  logoSize:    'm',
  logoMargin:  24,

  headline:    'Weekend Special',
  subheadline: 'Limited time only',
  price:       '20% OFF',
  cta:         'Shop Now',
  badge:       '',

  reviewName:  '',
  reviewStars: 5,
  reviewQuote: '',

  theme:       'modern',
  headingFont: '',            // '' = the theme's font
  bodyFont:    '',            // '' = Inter
  layout:      'classic',     // last layout preset applied (classic | centered | top | middle)
  brandColor:  '',            // '' = use the theme's own accent; '#rrggbb' overrides it
  contact:     '',
  layerVis:    { media:true, logo:true, headline:true, sub:true, price:true, cta:true, badge:true, contact:true,
                 rv_mark:true, rv_stars:true, rv_quote:true, rv_name:true, rv_verified:true },
  pos:         {},            // free positioning: { key: { x, y, s } } — fractions of canvas size + scale

  /* server references (persisted with the design) */
  mediaId:     null,
  mediaName:   '',
  bgMaskId:    null,          // saved cut-out mask (greyscale PNG in the media library)
  maskAlpha:   null,          // { alpha, W, H } of the current cut-out (not persisted directly)
  cutoutBg:    'theme',       // backdrop behind a cut-out: theme | gradient | spotlight | blur
  cutoutShadow: true,
  mediaFit:    'auto',        // how a photo/video fits each size: auto | fill (crop) | fit (whole photo)
  fitBg:       'blur',        // what fills the empty space in 'fit': blur | brand | white | black
  focusX:      0.5,           // which part stays in view when cropping (0 = left/top, 1 = right/bottom)
  focusY:      0.5,
  logoMediaId: null,
  logoName:    ''
};

/* Theme with the brand accent applied (fixes: brand colour was never used) */
/* readable text colour (ink or white) on top of a given background colour */
function onColor(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex)); if (!m) return '#1a1a2e';
  const n = parseInt(m[1], 16), lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return L > 0.36 ? '#1a1a2e' : '#ffffff';
}
/* Relative luminance of a #rrggbb colour (0 = black, 1 = white) */
function lum(hex){
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex)); if (!m) return 0.5;
  const n = parseInt(m[1], 16), lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  return 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}
function mixHex(hex, to, t){
  const a = parseInt(String(hex).replace('#', ''), 16), b = parseInt(to.replace('#', ''), 16);
  const ch = (x, y) => Math.round(x + (y - x) * t);
  return '#' + [16, 8, 0].map(sh => ch((a >> sh) & 255, (b >> sh) & 255).toString(16).padStart(2, '0')).join('');
}
/* Accent colour that stays readable on the photo scrim: lightens a dark accent on a dark shade,
   darkens a pale accent on a light shade (e.g. a navy price over a dark photo) */
function readableAccent(accent, onLight){
  if (!/^#?[0-9a-f]{6}$/i.test(String(accent))) return accent;
  let c = accent.startsWith('#') ? accent : '#' + accent;
  for (let i = 0; i < 8; i++){
    const L = lum(c), ratio = onLight ? (1.0 + 0.05) / (L + 0.05) : (L + 0.05) / (0.02 + 0.05);
    if (ratio >= 3.2) break;
    c = mixHex(c, onLight ? '#000000' : '#ffffff', 0.18);
  }
  return c;
}
function activeTheme(){
  const base = THEMES[state.theme] || THEMES.modern;
  return {
    ...base,
    accent: state.brandColor || base.accent,
    font: state.headingFont || base.font,
    bodyFont: state.bodyFont || 'Inter',
  };
}

const $ = id => document.getElementById(id);

/* ---------------------------------------------------------------
   CANVAS REFS
   --------------------------------------------------------------- */
const canvas    = $('canvas');
const stageShell = $('stageShell');
const stageEmptyHint = $('stageEmptyHint');
const stageDims = $('stageDims');

/* ---------------------------------------------------------------
   SMALL DRAWING HELPERS
   --------------------------------------------------------------- */
function roundRectPath(ctx, x, y, w, h, r){
  r = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y,     x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x,     y + h, r);
  ctx.arcTo(x,     y + h, x,     y,     r);
  ctx.arcTo(x,     y,     x + w, y,     r);
  ctx.closePath();
}

function elDims(el){
  if (!el) return { w:0, h:0 };
  if (typeof HTMLVideoElement !== 'undefined' && el instanceof HTMLVideoElement) return { w:el.videoWidth, h:el.videoHeight };
  if (typeof HTMLCanvasElement !== 'undefined' && el instanceof HTMLCanvasElement) return { w:el.width, h:el.height };
  return { w:el.naturalWidth || el.width || 0, h:el.naturalHeight || el.height || 0 };
}

/* Cover-fit: scale to fill target rect, centre-cropping the overflow */
function drawImageCover(ctx, el, dx, dy, dw, dh, fx = 0.5, fy = 0.5){
  const { w:sw, h:sh } = elDims(el);
  if (!sw || !sh) return;
  const imgR = sw / sh, boxR = dw / dh;
  let sx, sy, scW, scH;
  if (imgR > boxR){ scH = sh; scW = scH * boxR; sy = 0; sx = (sw - scW) * fx; }
  else            { scW = sw; scH = scW / boxR; sx = 0; sy = (sh - scH) * fy; }
  ctx.drawImage(el, sx, sy, scW, scH, dx, dy, dw, dh);
}

/* Contain-fit: scale to fit fully inside maxW × maxH, no cropping */
function fitContain(sw, sh, maxW, maxH){
  const s = Math.min(maxW / sw, maxH / sh);
  return { w: sw * s, h: sh * s, s };
}

/* Which fit a size really uses. 'auto' keeps the whole photo when cropping would cut off a lot
   (e.g. a square photo in a 9:16 story), and fills the frame when the shapes are close. */
function resolvedFit(media, w, h){
  if (state.mediaFit === 'fill' || state.mediaFit === 'fit') return state.mediaFit;
  const { w:sw, h:sh } = elDims(media);
  if (!sw || !sh) return 'fill';
  const r = (sw / sh) / (w / h);
  return (r > 1.25 || r < 0.8) ? 'fit' : 'fill';
}

/* Draw the photo/video over the whole canvas: cropped to fill, or whole with a matching background */
function drawMediaFull(ctx, media, w, h, theme){
  if (resolvedFit(media, w, h) === 'fill'){ drawImageCover(ctx, media, 0, 0, w, h, state.focusX, state.focusY); return; }
  const { w:sw, h:sh } = elDims(media);
  if (!sw || !sh) return;
  const bg = state.fitBg;
  if (bg === 'blur'){
    const t = document.createElement('canvas');
    t.width = Math.max(4, Math.round(w / 24)); t.height = Math.max(4, Math.round(h / 24));
    const tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high';
    drawImageCover(tc, media, 0, 0, t.width, t.height);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(t, 0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,.18)'; ctx.fillRect(0, 0, w, h);
    ctx.restore();
  } else {
    ctx.fillStyle = bg === 'white' ? '#ffffff' : bg === 'black' ? '#0d0d12' : (state.brandColor || theme.accent || theme.bg);
    ctx.fillRect(0, 0, w, h);
  }
  const f = fitContain(sw, sh, w, h);
  ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  // a little above centre, so the headline sits in the free space underneath
  ctx.drawImage(media, 0, 0, sw, sh, (w - f.w) / 2, (h - f.h) * 0.3, f.w, f.h);
  ctx.restore();
}

/* ---------------------------------------------------------------
   LANGUAGES — any language can be typed. Each script has a good-looking fallback font, so a
   Latin-only font still shows Nepali, Hindi, Arabic… correctly instead of boxes or a random system font.
   --------------------------------------------------------------- */
const SCRIPTS = [
  { key:'devanagari', label:'Nepali / Hindi / Marathi', re:/[ऀ-ॿ꣠-ꣿ]/, font:'Mukta' },
  { key:'bengali',    label:'Bengali',   re:/[ঀ-৿]/, font:'Hind Siliguri' },
  { key:'gurmukhi',   label:'Punjabi',   re:/[਀-੿]/, font:'Baloo Paaji 2' },
  { key:'gujarati',   label:'Gujarati',  re:/[઀-૿]/, font:'Hind Vadodara' },
  { key:'tamil',      label:'Tamil',     re:/[஀-௿]/, font:'Catamaran' },
  { key:'telugu',     label:'Telugu',    re:/[ఀ-౿]/, font:'Noto Sans Telugu' },
  { key:'kannada',    label:'Kannada',   re:/[ಀ-೿]/, font:'Noto Sans Kannada' },
  { key:'malayalam',  label:'Malayalam', re:/[ഀ-ൿ]/, font:'Noto Sans Malayalam' },
  { key:'sinhala',    label:'Sinhala',   re:/[඀-෿]/, font:'Noto Sans Sinhala' },
  { key:'thai',       label:'Thai',      re:/[฀-๿]/, font:'Kanit' },
  { key:'tibetan',    label:'Tibetan',   re:/[ༀ-࿿]/, font:'Noto Serif Tibetan' },
  { key:'myanmar',    label:'Burmese',   re:/[က-႟]/, font:'Noto Sans Myanmar' },
  { key:'khmer',      label:'Khmer',     re:/[ក-៿]/, font:'Noto Sans Khmer' },
  { key:'arabic',     label:'Arabic / Urdu / Persian', re:/[؀-ۿݐ-ݿﭐ-﷿ﹰ-﻿]/, font:'Cairo', rtl:true },
  { key:'hebrew',     label:'Hebrew',    re:/[֐-׿]/, font:'Noto Sans Hebrew', rtl:true },
  { key:'cyrillic',   label:'Cyrillic (Russian, Ukrainian…)', re:/[Ѐ-ӿ]/, font:'Inter' },
  { key:'greek',      label:'Greek',     re:/[Ͱ-Ͽ]/, font:'Inter' },
  { key:'cjk',        label:'Chinese / Japanese / Korean', re:/[぀-ヿ㐀-鿿가-힯]/, font:'' },
];
const FALLBACK_STACK = [...new Set(SCRIPTS.map(s => s.font).filter(Boolean))].map(f => `"${f}"`).join(', ')
  + ', "Noto Sans CJK SC", "Microsoft YaHei", "PingFang SC", "Hiragino Sans", "Malgun Gothic", sans-serif';
/* CSS font list for the canvas: the chosen font first, then a good font for every other script */
function FF(family){ return `"${family}", ${FALLBACK_STACK}`; }
const FONT_SCRIPTS = window.PF_FONT_SCRIPTS || {};
function textScripts(text){ return SCRIPTS.filter(s => s.re.test(text)); }
function designText(){
  return [state.headline, state.subheadline, state.price, state.cta, state.badge, state.contact, state.reviewQuote, state.reviewName].filter(Boolean).join(' ');
}

/* Download the font files a design's text needs (each script is a separate small file), then redraw */
const scriptFontsLoaded = new Set();
let scriptFontsBusy = false;
function ensureScriptFonts(){
  if (!document.fonts || scriptFontsBusy) return;
  const text = designText();
  const found = textScripts(text);
  if (!found.length) return;
  const t = activeTheme();
  const jobs = [];
  for (const sc of found){
    const sample = (text.match(new RegExp(sc.re.source, 'g')) || []).slice(0, 40).join('');
    for (const fam of [t.font, t.bodyFont, sc.font, 'Space Grotesk'].filter(Boolean)){
      for (const wgt of [400, 500, 700, 800]){
        const key = `${fam}|${wgt}|${sc.key}`;
        if (scriptFontsLoaded.has(key)) continue;
        scriptFontsLoaded.add(key);
        jobs.push(document.fonts.load(`${wgt} 48px "${fam}"`, sample).catch(() => {}));
      }
    }
  }
  if (!jobs.length) return;
  scriptFontsBusy = true;
  Promise.all(jobs).then(() => { scriptFontsBusy = false; render(); });
}

/* Break text into lines. Uses word boundaries for languages written without spaces (Thai, Chinese…) */
function textUnits(text){
  const str = String(text);
  if (/\s/.test(str.trim()) || !/[฀-๿က-႟ក-៿぀-ヿ㐀-鿿]/.test(str)) return null;
  if (typeof Intl !== 'undefined' && Intl.Segmenter){
    return [...new Intl.Segmenter(undefined, { granularity: 'word' }).segment(str)].map(x => x.segment);
  }
  return [...str];
}

function wrapText(ctx, text, maxWidth){
  const units = textUnits(text);
  if (units){
    const out = []; let cur = '';
    for (const u of units){
      if (cur && ctx.measureText(cur + u).width > maxWidth){ out.push(cur); cur = u.trimStart(); } else cur += u;
    }
    if (cur) out.push(cur);
    return out.length ? out : [''];
  }
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words){
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line){
      lines.push(line); line = word;
    } else { line = test; }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
}

function fitText(ctx, text, { maxW, maxH, minSize=14, maxSize=120, family='Space Grotesk', weight=700, lineH=1.18 }){
  let size = maxSize;
  let lines = [text];
  while (size >= minSize){
    ctx.font = `${weight} ${size}px ${FF(family)}`;
    lines = wrapText(ctx, text, maxW);
    const totalH = lines.length * size * lineH;
    const widest = Math.max(...lines.map(l => ctx.measureText(l).width));
    if (totalH <= maxH && widest <= maxW) break;
    size = Math.max(minSize, size - 2);
  }
  return { size, lines, lh: size * lineH };
}

function drawWrapped(ctx, lines, x, y, lh, align='left'){
  ctx.textAlign = align;
  ctx.direction = lines.some(l => /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(l)) ? 'rtl' : 'ltr';
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lh));
}

/* 5-point star, used by the review-card star rating */
function drawStarShape(ctx, cx, cy, outerR, fillColor){
  const innerR = outerR * 0.45;
  const spikes = 5;
  let rot = -Math.PI / 2;
  const step = Math.PI / spikes;
  ctx.beginPath();
  ctx.moveTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
  for (let i = 0; i < spikes; i++){
    rot += step;
    ctx.lineTo(cx + Math.cos(rot) * innerR, cy + Math.sin(rot) * innerR);
    rot += step;
    ctx.lineTo(cx + Math.cos(rot) * outerR, cy + Math.sin(rot) * outerR);
  }
  ctx.closePath();
  ctx.fillStyle = fillColor;
  ctx.fill();
}
function drawStars(ctx, x, y, r, count, onColor, offColor){
  for (let i = 0; i < 5; i++){
    drawStarShape(ctx, x + i * r * 2.5, y, r, i < count ? onColor : offColor);
  }
}

/* ---------------------------------------------------------------
   ACTIVE MEDIA — which element actually gets drawn
   --------------------------------------------------------------- */
function activeMediaEl(){
  if (state.mediaIsVideo) return state.mediaSrcEl;
  if (state.bgRemoved && state.mediaProcessed) return state.mediaProcessed;
  return state.mediaSrcEl;
}

/* ---------------------------------------------------------------
   FREE POSITIONING — every element can be dragged / nudged / resized.
   Offsets are stored as fractions of the canvas (so they carry over to
   every platform size) in state.pos[key] = { x, y, s }.
   --------------------------------------------------------------- */
const POS_LABELS = {
  badge:'Badge', headline:'Headline', sub:'Subheadline', price:'Price / offer', cta:'Call to action', contact:'Contact line',
  logo:'Logo', product:'Product cut-out',
  rv_mark:'Quote mark', rv_stars:'Star rating', rv_quote:'Review text', rv_name:'Customer name', rv_verified:'Verified badge'
};
let HIT = null;          // hit boxes collected during the live preview render
const centeredText = () => state.layout === 'centered' || state.layout === 'middle';
let lastHits = [];
function posOf(key){ const p = state.pos[key]; return p ? { x: p.x || 0, y: p.y || 0, s: p.s || 1 } : { x:0, y:0, s:1 }; }
/* Draw one element with the user's offset + scale applied around its own centre */
function place(ctx, key, box, w, h, draw){
  const p = posOf(key);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const dx = p.x * w, dy = p.y * h;
  ctx.save();
  if (dx || dy || p.s !== 1){ ctx.translate(cx + dx, cy + dy); ctx.scale(p.s, p.s); ctx.translate(-cx, -cy); }
  draw();
  ctx.restore();
  if (HIT) HIT.push({ key, nat: box, x: cx + dx - box.w * p.s / 2, y: cy + dy - box.h * p.s / 2, w: box.w * p.s, h: box.h * p.s });
}

/* ---------------------------------------------------------------
   LOGO LAYER — shared between the promo layout and the review card
   --------------------------------------------------------------- */
function logoBoxPx(canvasW, canvasH){
  const base = Math.min(canvasW, canvasH);
  return base * ({ s:0.09, m:0.14, l:0.21 }[state.logoSize] || 0.14);
}
function drawLogoLayer(ctx, w, h){
  if (!state.logoImg || !state.layerVis.logo) return;
  const box   = logoBoxPx(w, h);
  const ratio = state.logoImg.naturalWidth / state.logoImg.naturalHeight;
  let lw = box, lh = box / ratio;
  if (lh > box){ lh = box; lw = box * ratio; }
  const margin = (state.logoMargin / 1080) * w;
  const lx = state.logoPos.endsWith('l')  ? margin : w - margin - lw;
  const ly = state.logoPos.startsWith('t') ? margin : h - margin - lh;
  place(ctx, 'logo', { x:lx, y:ly, w:lw, h:lh }, w, h, () => {
    ctx.shadowColor = 'rgba(0,0,0,.3)';
    ctx.shadowBlur  = 16;
    ctx.shadowOffsetY = 3;
    ctx.drawImage(state.logoImg, lx, ly, lw, lh);
  });
}

/* ---------------------------------------------------------------
   RENDER — PROMO POST LAYOUT
   --------------------------------------------------------------- */
function renderPromo(ctx, w, h){
  const theme = activeTheme();
  const media = activeMediaEl();
  const cutout = state.bgRemoved && !state.mediaIsVideo && media;
  theme.badgeAccent = theme.accent; // badge is a solid pill with its own contrasting text
  if (media && (!cutout || state.cutoutBg === 'blur')) theme.accent = readableAccent(theme.accent, theme.overlay === 'soft-white');

  /* --- Background --- */
  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  if (media && state.layerVis.media){
    if (cutout){
      /* Cut-out product shot centred on the chosen backdrop, not cropped full-bleed */
      drawCutoutBackdrop(ctx, w, h, theme);
      const pad = Math.min(w, h) * 0.13;
      const { w:sw, h:sh } = elDims(media);
      const fit = fitContain(sw, sh, w - pad * 2, h - pad * 2 * 0.82);
      const dx = (w - fit.w) / 2, dy = (h - fit.h) / 2 - h * 0.045;
      place(ctx, 'product', { x:dx, y:dy, w:fit.w, h:fit.h }, w, h, () => {
        if (state.cutoutShadow){ ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = w * 0.035; ctx.shadowOffsetY = w * 0.014; }
        ctx.drawImage(media, 0, 0, sw, sh, dx, dy, fit.w, fit.h);
      });
    } else {
      drawMediaFull(ctx, media, w, h, theme);
    }
  }

  /* --- Scrim for text legibility (skipped for clean cut-out shots, except on a busy blurred backdrop) --- */
  if (media && (!cutout || state.cutoutBg === 'blur')){
    const grad = ctx.createLinearGradient(0, h * 0.35, 0, h);
    const overlayMap = {
      'gradient':        ['rgba(0,0,0,0)', 'rgba(0,0,0,.72)'],
      'gradient-strong': ['rgba(0,0,0,0)', 'rgba(0,0,0,.86)'],
      'dark':            ['rgba(0,0,0,0)','rgba(0,0,0,.72)'],
      'soft-white':      ['rgba(255,255,255,0)','rgba(255,255,255,.92)']
    };
    const [c0, c1] = overlayMap[theme.overlay] || overlayMap['gradient'];
    if (theme.overlay === 'dark'){ ctx.fillStyle = 'rgba(0,0,0,.14)'; ctx.fillRect(0, 0, w, h); } // even tint, no hard edge
    grad.addColorStop(0, c0); grad.addColorStop(1, c1);
    ctx.fillStyle = grad;
    ctx.fillRect(0, h * 0.35, w, h * 0.65);
  }
  /* Text moved away from the bottom of a photo gets a matching soft shade so it stays readable */
  if (media && !cutout){
    const light = theme.overlay === 'soft-white';
    const shade = a => light ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a})`;
    const ys = ['headline', 'sub', 'price', 'cta'].map(k => posOf(k).y);
    if (state.layout === 'middle' || ys.some(y => y < -0.15 && y > -0.4)){
      ctx.fillStyle = shade(light ? 0.5 : 0.38); ctx.fillRect(0, 0, w, h);
    } else if (ys.some(y => y <= -0.4)){
      const g = ctx.createLinearGradient(0, 0, 0, h * 0.6);
      g.addColorStop(0, shade(light ? 0.85 : 0.6)); g.addColorStop(1, shade(0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h * 0.6);
    }
  }

  const pad = w * 0.065;
  const contentW = w - pad * 2;

  /* --- Badge --- */
  if (state.badge && state.layerVis.badge){
    ctx.save();
    const bFontSize = Math.round(Math.max(18, w * 0.028));
    ctx.font = `800 ${bFontSize}px ${FF('Space Grotesk')}`;
    const bPadX = w * 0.022, bPadY = w * 0.015;
    const bTextW = ctx.measureText(state.badge).width;
    const bW = bTextW + bPadX * 2, bH = bFontSize + bPadY * 2;
    const bx = pad * 0.7, by = pad * 0.7;
    place(ctx, 'badge', { x:bx, y:by, w:bW, h:bH }, w, h, () => {
      ctx.fillStyle = theme.badgeAccent || theme.accent;
      roundRectPath(ctx, bx, by, bW, bH, bH / 2); ctx.fill();
      ctx.fillStyle = onColor(theme.badgeAccent || theme.accent);
      ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
      ctx.fillText(state.badge, bx + bPadX, by + bH / 2 + 1);
    });
    ctx.restore();
  }

  /* --- Text block (bottom-up default layout; every piece can then be moved) --- */
  const bottomPad  = h * 0.075;
  const ctaH       = w * 0.068;
  const ctaFontSz  = Math.round(Math.max(14, w * 0.027));
  const priceFontSz= Math.round(Math.max(18, w * 0.048));
  const subFontSz  = Math.round(Math.max(13, w * 0.028));
  const ctaRowY    = h - bottomPad - ctaH;
  const priceY     = ctaRowY - priceFontSz * 1.3;
  const subY       = priceY  - (state.price && state.layerVis.price ? priceFontSz * 0.95 + subFontSz * 0.55 : subFontSz * 1.45);

  // (fix) leave room for the subheadline's cap height so the last headline line never collides with it
  const subGap       = (state.subheadline && state.layerVis.sub) ? subFontSz * 1.4 : h * 0.01;
  const headlineMaxH = subY - subGap - pad * 0.5 - h * 0.12;
  const headlineFit  = fitText(ctx, state.headline || ' ', {
    maxW: contentW, maxH: Math.max(headlineMaxH, 60),
    minSize: Math.max(20, w * 0.024), maxSize: w * 0.088,
    family: theme.font, weight: 800, lineH: 1.12
  });
  const headlineTopY = subY - subGap - headlineFit.lines.length * headlineFit.lh + (headlineFit.lh - headlineFit.size) - headlineFit.size * 0.22;

  if (state.headline && state.layerVis.headline){
    ctx.save();
    ctx.font = `800 ${headlineFit.size}px ${FF(theme.font)}`;
    const hw = Math.max(...headlineFit.lines.map(l => ctx.measureText(l).width));
    const box = { x:pad, y:headlineTopY, w:hw, h:headlineFit.lines.length * headlineFit.lh };
    place(ctx, 'headline', box, w, h, () => {
      ctx.fillStyle = theme.textMain;
      ctx.shadowColor = (media && !cutout) ? 'rgba(0,0,0,.35)' : 'transparent';
      ctx.shadowBlur  = 12;
      if (centeredText()) drawWrapped(ctx, headlineFit.lines, pad + hw / 2, headlineTopY + headlineFit.size, headlineFit.lh, 'center');
      else drawWrapped(ctx, headlineFit.lines, pad, headlineTopY + headlineFit.size, headlineFit.lh, 'left');
    });
    ctx.restore();
  }
  if (state.subheadline && state.layerVis.sub){
    ctx.save();
    ctx.font = `500 ${subFontSz}px ${FF(theme.bodyFont)}`;
    const sw = ctx.measureText(state.subheadline).width;
    place(ctx, 'sub', { x:pad, y:subY - subFontSz * 0.95, w:sw, h:subFontSz * 1.25 }, w, h, () => {
      ctx.fillStyle = theme.textSub;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(state.subheadline, pad, subY);
    });
    ctx.restore();
  }
  if (state.price && state.layerVis.price){
    ctx.save();
    ctx.font = `700 ${priceFontSz}px ${FF(theme.font)}`;
    const pw = ctx.measureText(state.price).width;
    place(ctx, 'price', { x:pad, y:priceY - priceFontSz * 0.95, w:pw, h:priceFontSz * 1.2 }, w, h, () => {
      ctx.fillStyle = theme.accent;
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.shadowColor = (media && !cutout) ? 'rgba(0,0,0,.25)' : 'transparent';
      ctx.shadowBlur  = 8;
      ctx.fillText(state.price, pad, priceY);
    });
    ctx.restore();
  }
  if (state.cta && state.layerVis.cta){
    ctx.save();
    ctx.font = `700 ${ctaFontSz}px ${FF(theme.font)}`;
    const label   = state.cta + '  →';
    const labelW  = ctx.measureText(label).width;
    const btnPadX = w * 0.045;
    const btnW    = labelW + btnPadX * 2;
    const btnX    = pad, btnY = ctaRowY;
    const cbox = theme.ctaStyle === 'underline' ? { x:btnX, y:btnY + ctaH * 0.2, w:labelW, h:ctaH * 0.7 } : { x:btnX, y:btnY, w:btnW, h:ctaH };
    place(ctx, 'cta', cbox, w, h, () => {
      ctx.shadowColor = 'transparent';
      switch (theme.ctaStyle){
        case 'outline':
          ctx.strokeStyle = theme.accent; ctx.lineWidth = Math.max(2, w * 0.002);
          roundRectPath(ctx, btnX, btnY, btnW, ctaH, ctaH / 2); ctx.stroke();
          ctx.fillStyle = theme.accent;
          ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
          ctx.fillText(label, btnX + btnW / 2, btnY + ctaH / 2 + 1);
          break;
        case 'underline':
          ctx.fillStyle = theme.accent;
          ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
          ctx.fillText(label, btnX, btnY + ctaH * 0.68);
          ctx.fillRect(btnX, btnY + ctaH * 0.8, labelW, Math.max(2, w * 0.002));
          break;
        case 'block':
          ctx.fillStyle = onColor(theme.accent) === '#ffffff' ? '#ffffff' : '#1a1a2e';
          ctx.fillRect(btnX - w*0.003, btnY - w*0.006, btnW + w*0.006, ctaH + w*0.012);
          ctx.fillStyle = theme.accent;
          ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
          ctx.fillText(label, btnX + btnW / 2, btnY + ctaH / 2 + 1);
          break;
        default:
          ctx.fillStyle = theme.accent;
          roundRectPath(ctx, btnX, btnY, btnW, ctaH, ctaH / 2); ctx.fill();
          ctx.fillStyle = onColor(theme.accent);
          ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
          ctx.fillText(label, btnX + btnW / 2, btnY + ctaH / 2 + 1);
      }
    });
    ctx.restore();
  }
  if (state.contact && state.layerVis.contact){
    ctx.save();
    const cFontSz = Math.round(Math.max(12, w * 0.02));
    ctx.font = `500 ${cFontSz}px ${FF(theme.bodyFont)}`;
    const cw = ctx.measureText(state.contact).width;
    const base = h - pad * 0.45;
    place(ctx, 'contact', { x:w - pad - cw, y:base - cFontSz * 0.95, w:cw, h:cFontSz * 1.25 }, w, h, () => {
      ctx.fillStyle = theme.textSub;
      ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
      ctx.fillText(state.contact, w - pad, base);
    });
    ctx.restore();
  }

  drawLogoLayer(ctx, w, h);
}

/* ---------------------------------------------------------------
   RENDER — CUSTOMER REVIEW / TESTIMONIAL LAYOUT
   --------------------------------------------------------------- */
function renderReview(ctx, w, h){
  const theme = activeTheme();
  const media = activeMediaEl();
  const cutout = state.bgRemoved && !state.mediaIsVideo && media;

  ctx.fillStyle = theme.bg;
  ctx.fillRect(0, 0, w, h);

  if (media && state.layerVis.media){
    if (cutout){
      drawCutoutBackdrop(ctx, w, h, theme);
      const { w:sw, h:sh } = elDims(media);
      const fit = fitContain(sw, sh, w * 0.42, h * 0.42);
      const dx = w - fit.w - w * 0.07, dy = h - fit.h - h * 0.07;
      place(ctx, 'product', { x:dx, y:dy, w:fit.w, h:fit.h }, w, h, () => {
        if (state.cutoutShadow){ ctx.shadowColor = 'rgba(0,0,0,.3)'; ctx.shadowBlur = w * 0.03; ctx.shadowOffsetY = w * 0.012; }
        ctx.drawImage(media, 0, 0, sw, sh, dx, dy, fit.w, fit.h);
      });
    } else {
      drawMediaFull(ctx, media, w, h, theme);
      ctx.fillStyle = 'rgba(10,10,18,.5)';
      ctx.fillRect(0, 0, w, h);
    }
  }

  const pad = w * 0.09;
  const contentW = w - pad * 2;
  let y = h * 0.15;

  /* Big decorative quote mark */
  const qmSize = Math.round(w * 0.15);
  if (state.layerVis.rv_mark !== false){
    ctx.save();
    ctx.font = `800 ${qmSize}px Georgia, "Times New Roman", serif`;
    const qx = pad - w * 0.012, qy = y - h * 0.05;
    const qw = ctx.measureText('“').width;
    place(ctx, 'rv_mark', { x:qx, y:qy + qmSize * 0.05, w:qw, h:qmSize * 0.5 }, w, h, () => {
      ctx.fillStyle = theme.accent;
      ctx.textAlign = 'left'; ctx.textBaseline = 'top';
      ctx.fillText('“', qx, qy);
    });
    ctx.restore();
  }
  y += w * 0.075;

  /* Stars */
  const starR = Math.max(11, w * 0.02);
  if (state.layerVis.rv_stars !== false){
    const sy = y;
    place(ctx, 'rv_stars', { x:pad, y:sy - starR, w:starR * 12, h:starR * 2 }, w, h, () => {
      drawStars(ctx, pad + starR, sy, starR, state.reviewStars, theme.accent, 'rgba(255,255,255,.28)');
    });
  }
  y += starR * 2.6;

  /* Quote (auto-fit) */
  const quoteMaxH = h * 0.4;
  const qFit = fitText(ctx, state.reviewQuote || ' ', {
    maxW: contentW, maxH: quoteMaxH,
    minSize: Math.max(16, w * 0.026), maxSize: w * 0.05,
    family: theme.font, weight: 700, lineH: 1.32
  });
  if (state.layerVis.rv_quote !== false){
    ctx.save();
    ctx.font = `700 ${qFit.size}px ${FF(theme.font)}`;
    const qw = Math.max(...qFit.lines.map(l => ctx.measureText(l).width));
    const qy = y;
    place(ctx, 'rv_quote', { x:pad, y:qy, w:qw, h:qFit.lines.length * qFit.lh }, w, h, () => {
      ctx.fillStyle = theme.textMain;
      if (centeredText()) drawWrapped(ctx, qFit.lines, pad + qw / 2, qy + qFit.size, qFit.lh, 'center');
      else drawWrapped(ctx, qFit.lines, pad, qy + qFit.size, qFit.lh, 'left');
    });
    ctx.restore();
  }
  y += qFit.lines.length * qFit.lh + h * 0.035;

  /* Reviewer name */
  if (state.reviewName){
    const nSize = Math.max(15, w * 0.028);
    if (state.layerVis.rv_name !== false){
      ctx.save();
      ctx.font = `700 ${nSize}px ${FF(theme.font)}`;
      const label = '— ' + state.reviewName;
      const nw = ctx.measureText(label).width, ny = y;
      place(ctx, 'rv_name', { x:pad, y:ny + nSize * 0.05, w:nw, h:nSize * 1.2 }, w, h, () => {
        ctx.fillStyle = theme.accent;
        ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(label, pad, ny + nSize);
      });
      ctx.restore();
    }
    y += nSize * 1.9;
  }

  /* Verified-customer pill */
  if (state.layerVis.rv_verified !== false){
    ctx.save();
    const vLabel = '✓ Verified Customer';
    ctx.font = `700 ${Math.max(11, w * 0.017)}px ${FF(theme.bodyFont)}`;
    const vTextW = ctx.measureText(vLabel).width;
    const vPadX = w * 0.022;
    const vW = vTextW + vPadX * 2, vH = Math.max(24, w * 0.042), vy = y;
    place(ctx, 'rv_verified', { x:pad, y:vy, w:vW, h:vH }, w, h, () => {
      ctx.fillStyle = 'rgba(255,255,255,.15)';
      roundRectPath(ctx, pad, vy, vW, vH, vH / 2); ctx.fill();
      ctx.fillStyle = theme.textMain;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(vLabel, pad + vW / 2, vy + vH / 2 + 1);
    });
    ctx.restore();
  }

  drawLogoLayer(ctx, w, h);
}

/* ---------------------------------------------------------------
   RENDER DISPATCH — used for both the live preview AND every
   offscreen export (single or batch), always given explicit w/h
   so exports never depend on the on-screen canvas's own size.
   --------------------------------------------------------------- */
function renderCore(ctx, w, h){
  ctx.clearRect(0, 0, w, h);
  // High-quality resampling for every resize (preview + every export)
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  if (state.contentType === 'review') renderReview(ctx, w, h);
  else renderPromo(ctx, w, h);
}
let recordWithWatermark = false;
/* A layout preset (centred / top / middle) stays "live": when the text, font, theme or size
   changes, the arrangement is recalculated — until the user moves a text element by hand. */
let layoutSig = '';
function refreshLiveLayout(){
  if (!['centered', 'top', 'middle'].includes(state.layout)) { layoutSig = ''; return; }
  const sig = [state.contentType, state.platformW, state.platformH, state.headline, state.subheadline, state.price, state.cta, state.badge,
    state.reviewQuote, state.reviewName, state.theme, state.headingFont, state.bodyFont, state.layout, JSON.stringify(state.layerVis),
    !!(state.bgRemoved && state.mediaProcessed)].join('|');
  if (sig === layoutSig) return;
  layoutSig = sig;
  state.pos = layoutPositions(state.layout, state.platformW, state.platformH);
}
function render(){
  refreshLiveLayout();
  const ctx = canvas.getContext('2d');
  HIT = [];
  renderCore(ctx, canvas.width, canvas.height);
  lastHits = HIT; HIT = null;
  if (recordWithWatermark) drawWatermark(ctx, canvas.width, canvas.height);
  stageEmptyHint.style.display = activeMediaEl() ? 'none' : 'flex';
  if (typeof updateSelectionBox === 'function') updateSelectionBox();
  ensureScriptFonts();
}

/* Free-trial downloads carry a watermark (plan.watermark = true) */
function drawWatermark(ctx, w, h){
  ctx.save();
  const fs = Math.max(14, Math.round(Math.min(w, h) * 0.035));
  ctx.font = `700 ${fs}px ${FF('Space Grotesk')}`;
  ctx.fillStyle = 'rgba(255,255,255,.16)';
  ctx.strokeStyle = 'rgba(0,0,0,.10)';
  ctx.lineWidth = 1;
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-Math.PI / 7);
  const label = 'PostForge · Free trial';
  const step = ctx.measureText(label).width + fs * 3;
  const diag = Math.hypot(w, h);
  for (let y = -diag / 2; y < diag / 2; y += fs * 5){
    for (let x = -diag / 2; x < diag / 2; x += step){
      ctx.fillText(label, x, y); ctx.strokeText(label, x, y);
    }
  }
  ctx.restore();
  // solid footer strip
  const sh = Math.max(24, Math.round(h * 0.045));
  ctx.fillStyle = 'rgba(26,26,46,.82)';
  ctx.fillRect(0, h - sh, w, sh);
  ctx.fillStyle = '#fff';
  ctx.font = `600 ${Math.round(sh * 0.45)}px ${FF('Inter')}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText('Made with PostForge — upgrade to remove this watermark', w / 2, h - sh / 2);
}

/* ---------------------------------------------------------------
   BACKGROUND REMOVAL — see /js/bgremove.js (engine) and
   /js/bgstudio.js (cut-out studio). Classical algorithms only:
   edge-aware flood fill + GrabCut graph-cut, all in the browser.
   --------------------------------------------------------------- */

/* Backdrop painted behind a cut-out product */
function drawCutoutBackdrop(ctx, w, h, theme){
  const mode = state.cutoutBg;
  if (mode === 'gradient'){
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, theme.bg); g.addColorStop(1, mixHex(theme.bg, theme.accent, 0.38));
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  } else if (mode === 'spotlight'){
    const g = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, Math.max(w, h) * 0.7);
    g.addColorStop(0, mixHex(theme.bg, '#ffffff', 0.32)); g.addColorStop(1, theme.bg);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  } else if (mode === 'blur' && state.mediaSrcEl){
    // cheap, portable blur: draw tiny then scale up with smoothing (works in every browser)
    const t = document.createElement('canvas');
    t.width = Math.max(4, Math.round(w / 28)); t.height = Math.max(4, Math.round(h / 28));
    const tc = t.getContext('2d'); tc.imageSmoothingQuality = 'high';
    drawImageCover(tc, state.mediaSrcEl, 0, 0, t.width, t.height);
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(t, 0, 0, w, h);
    ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.fillRect(0, 0, w, h);
    ctx.restore();
  }
}
function mixHex(a, b, t){
  const pa = hexRgb(a), pb = hexRgb(b);
  if (!pa || !pb) return a;
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('');
}
function hexRgb(h){ const m = /^#?([0-9a-f]{6})$/i.exec(String(h)); if (!m) return null; const n = parseInt(m[1], 16); return [n >> 16, (n >> 8) & 255, n & 255]; }

/* ---------------------------------------------------------------
   BRAND-COLOUR EXTRACTION — classical colour quantisation on the
   uploaded logo's pixels (bucket + frequency count). No AI/ML.
   --------------------------------------------------------------- */
function extractPalette(sourceEl, count = 3){
  const { w:sw, h:sh } = elDims(sourceEl);
  if (!sw || !sh) return [];
  const size = 48;
  const tmp = document.createElement('canvas');
  tmp.width = size; tmp.height = size;
  const tctx = tmp.getContext('2d', { willReadFrequently:true });
  tctx.drawImage(sourceEl, 0, 0, size, size);
  const data = tctx.getImageData(0, 0, size, size).data;

  const buckets = new Map();
  for (let i=0; i<data.length; i+=4){
    const a = data[i+3]; if (a < 128) continue;
    const r = data[i], g = data[i+1], b = data[i+2];
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    if (max > 240 && min > 225) continue;   // near-white
    if (max < 28) continue;                  // near-black
    if (max - min < 14) continue;             // greyscale-ish
    const key = Math.round(r/24)+','+Math.round(g/24)+','+Math.round(b/24);
    const cur = buckets.get(key) || { count:0, r:0, g:0, b:0 };
    cur.count++; cur.r += r; cur.g += g; cur.b += b;
    buckets.set(key, cur);
  }
  const sorted = [...buckets.values()].sort((a,b) => b.count - a.count);
  const picked = [];
  for (const c of sorted){
    const avg = [Math.round(c.r/c.count), Math.round(c.g/c.count), Math.round(c.b/c.count)];
    const tooClose = picked.some(p => {
      const dr=p[0]-avg[0], dg=p[1]-avg[1], db=p[2]-avg[2];
      return Math.sqrt(dr*dr+dg*dg+db*db) < 40;
    });
    if (!tooClose) picked.push(avg);
    if (picked.length >= count) break;
  }
  return picked.map(([r,g,b]) => '#' + [r,g,b].map(v => v.toString(16).padStart(2,'0')).join(''));
}

/* ---------------------------------------------------------------
   STAGE SIZE / PLATFORM SWITCHING
   --------------------------------------------------------------- */
function fitStageShell(){
  const wrap = document.querySelector('.stage-wrap');
  const w = state.platformW, h = state.platformH;
  const phone = window.innerWidth <= 900;
  const maxW = wrap.clientWidth - (phone ? 24 : 56), maxH = wrap.clientHeight - (phone ? 104 : 120);
  let cw = maxW, ch = cw * h / w;
  if (ch > maxH){ ch = maxH; cw = ch * w / h; }
  stageShell.style.width  = cw + 'px';
  stageShell.style.height = ch + 'px';
}
function applyPlatform(key){
  const p = PLATFORMS[key]; if (!p) return;
  state.platformKey = key; state.platformW = p.w; state.platformH = p.h;
  canvas.width = p.w; canvas.height = p.h;
  fitStageShell();
  stageDims.textContent = `${p.w} × ${p.h} px`;
  const sel = document.getElementById('platformSelect');
  if (sel && sel.value !== key && sel.querySelector(`option[value="${key}"]`)) sel.value = key;
  if (typeof updateFitUI === 'function') updateFitUI();
  render();
}

/* ---------------------------------------------------------------
   TOAST
   --------------------------------------------------------------- */
let _toastTimer;
function showToast(msg, duration = 2600){
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}
function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.style.display = 'none'; a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 150);
}

/* ---------------------------------------------------------------
   CONTENT TYPE — Promo Post vs Customer Review
   --------------------------------------------------------------- */
function setContentType(type){
  state.contentType = type;
  document.querySelectorAll('#ctToggle .ct-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
  $('secOffer').style.display  = type === 'promo'  ? '' : 'none';
  $('secReview').style.display = type === 'review' ? '' : 'none';
  $('secBadge').style.display  = type === 'promo'  ? '' : 'none';
  $('mediaSecLabel').textContent = type === 'review' ? 'Customer photo or video' : 'Photo or video';
  $('dzMediaText').textContent   = type === 'review' ? 'Drop customer photo or video' : 'Drop image or video here';
  if (typeof syncLayerRows === 'function') syncLayerRows();
  render();
}
function setStars(n){
  state.reviewStars = n;
  document.querySelectorAll('#starRow .star-btn').forEach(b => {
    b.classList.toggle('on', parseInt(b.dataset.star, 10) <= n);
  });
}

/* ---------------------------------------------------------------
   VIDEO PREVIEW LOOP
   --------------------------------------------------------------- */
let videoLoopId = null;
function startVideoLoop(){
  if (videoLoopId) cancelAnimationFrame(videoLoopId);
  function loop(){
    if (state.mediaIsVideo) render();
    videoLoopId = requestAnimationFrame(loop);
  }
  loop();
}

/* ---------------------------------------------------------------
   UPLOAD — media (photo/video) + logo
   --------------------------------------------------------------- */
function setupDZ(zoneId, inputId, onFile){
  const zone = $(zoneId), input = $(inputId);
  // (fix) the transparent <input> already covers the zone — only forward clicks that didn't hit it,
  // otherwise some browsers open the file picker twice
  zone.addEventListener('click', e => { if (e.target !== input && !READONLY) input.click(); });
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('over');
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', e => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; });
}

/* Upload a file to the workspace media library; returns {id,url,kind,...} */
async function uploadToServer(file, label){
  const fd = new FormData();
  fd.append('file', file);
  showToast(`Uploading ${label}…`, 60000);
  try {
    const m = await PF.api('/media', { method:'POST', form: fd });
    showToast(`${label[0].toUpperCase() + label.slice(1)} uploaded ✓`);
    return m;
  } catch (err){
    handleApiError(err);
    return null;
  }
}

/* length of a chosen video file, read in the browser before uploading */
function videoSeconds(file){
  return new Promise(resolve => {
    const v = document.createElement('video'); const url = URL.createObjectURL(file);
    const done = d => { URL.revokeObjectURL(url); resolve(d); };
    v.preload = 'metadata'; v.muted = true;
    v.onloadedmetadata = () => done(Number.isFinite(v.duration) ? v.duration : null);
    v.onerror = () => done(null);
    setTimeout(() => done(null), 8000);
    v.src = url;
  });
}

async function handleMediaFile(file){
  if (READONLY) return;
  const isVideo = file.type.startsWith('video/');
  if (isVideo && !PLAN.video_export){
    showNotice('Videos start on the Starter plan', `Your ${PLAN.name} plan supports photo posts. Upgrade to Starter (videos up to 30 seconds) or Pro to turn your own videos and reels into branded posts for every platform.`);
    return;
  }
  const maxMb = isVideo ? (PLAN.max_video_mb || PLAN.max_upload_mb) : PLAN.max_upload_mb;
  if (file.size > maxMb * 1024 * 1024){
    showNotice('File too large', `Your ${PLAN.name} plan allows ${isVideo ? 'videos' : 'photos'} up to ${maxMb} MB. Try a smaller file${PLAN.code !== 'business' ? ' or upgrade' : ''}.`);
    return;
  }
  if (isVideo && PLAN.max_video_seconds > 0){
    const secs = await videoSeconds(file);
    if (secs && secs > PLAN.max_video_seconds + 0.9){
      showNotice('Video too long', `This video is ${Math.round(secs)} seconds long. Your ${PLAN.name} plan allows videos up to ${PLAN.max_video_seconds} seconds — trim it on your phone first, or upgrade to Pro for longer videos.`);
      return;
    }
  }
  const m = await uploadToServer(file, isVideo ? 'video' : 'photo');
  if (!m) return;
  state.mediaId = m.id;
  state.mediaName = file.name;
  resetCutout(true);
  loadMediaFromUrl(m.url, m.kind, file.name, { warnLowRes: true });
  markDirty();
}

/* Loads the design's photo/video from the server into the canvas */
function loadMediaFromUrl(url, kind, name, { warnLowRes = false, restoreCutout = null } = {}){
  return new Promise(resolve => {
    if (kind === 'video'){
      state.mediaIsVideo = true;
      $('bgRow').style.display = 'none';
      const video = document.createElement('video');
      video.muted = true; video.loop = true; video.playsInline = true; video.preload = 'auto';
      video.setAttribute('muted', ''); video.setAttribute('playsinline', ''); video.setAttribute('loop', '');
      video.addEventListener('loadedmetadata', () => {
        state.mediaSrcEl = video;
        setMediaThumbVideo(name, video);
        video.play().catch(() => {});
        startVideoLoop();
        resolve(true);
      }, { once:true });
      video.addEventListener('error', () => { showToast('Could not load that video'); resolve(false); }, { once:true });
      video.src = url;
    } else {
      state.mediaIsVideo = false;
      const img = new Image();
      img.onload = async () => {
        state.mediaSrcEl = img;
        $('bgRow').style.display = 'flex';
        setMediaThumb(name, url, `${img.naturalWidth}×${img.naturalHeight}`);
        if (restoreCutout) await restoreCutoutFor(img, restoreCutout);
        // Enlarging can't invent detail — warn when the short side is under 1080px
        const shortSide = Math.min(img.naturalWidth, img.naturalHeight);
        if (warnLowRes && shortSide < 1080){
          showToast(`Heads up: this photo is ${img.naturalWidth}×${img.naturalHeight} — under 1080px on its short side, so some sizes may look slightly soft.`, 5000);
        }
        render();
        resolve(true);
      };
      img.onerror = () => { showToast('Could not load that image'); resolve(false); };
      img.src = url;
    }
  });
}

function setMediaThumb(name, src, dims){
  $('mediaThumbRow').style.display = 'flex';
  $('mediaThumb').src = src;
  $('mediaName').textContent = name;
  $('mediaDims').textContent = dims;
  $('dzMedia').classList.add('done');
  setTimeout(updateFitUI, 50);
}
function setMediaThumbVideo(name, video){
  const draw = () => {
    if (video.readyState < 2) { setTimeout(draw, 200); return; }
    const tmp = document.createElement('canvas');
    tmp.width = 64; tmp.height = 64;
    const f = fitContain(video.videoWidth, video.videoHeight, 64, 64);
    tmp.getContext('2d').drawImage(video, (64-f.w)/2, (64-f.h)/2, f.w, f.h);
    setMediaThumb(name, tmp.toDataURL(), `${video.videoWidth}×${video.videoHeight} video`);
  };
  draw();
}

function clearMedia(){
  if (state.mediaIsVideo && state.mediaSrcEl){ try { state.mediaSrcEl.pause(); } catch(e){} }
  resetCutout(true);
  state.mediaSrcEl = null; state.mediaIsVideo = false;
  state.mediaId = null; state.mediaName = '';
  $('mediaThumbRow').style.display = 'none';
  $('dzMedia').classList.remove('done');
  $('bgRow').style.display = 'none';
  updateFitUI();
  render();
}

setupDZ('dzMedia', 'inputMedia', handleMediaFile);
// phones: open the camera straight away
$('inputSnap').addEventListener('change', e => { if (e.target.files[0] && !READONLY) handleMediaFile(e.target.files[0]); e.target.value = ''; });
$('mediaRemove').addEventListener('click', () => { clearMedia(); markDirty(); });

/* ---- Logo ---- */
function showExtractedPalette(img){
  const palette = extractPalette(img, 3);
  const group = $('extractedSwatchGroup');
  const wrap = $('extractedSwatches');
  wrap.innerHTML = '';
  if (!palette.length){ group.style.display = 'none'; return; }
  palette.forEach(hex => {
    const sw = document.createElement('div');
    sw.className = 'swatch extracted';
    sw.style.background = hex;
    sw.dataset.color = hex;
    sw.title = hex;
    wrap.appendChild(sw);
  });
  group.style.display = 'block';
}

function loadLogo(mediaId, name){
  return new Promise(resolve => {
    if (!mediaId){ clearLogo(); resolve(false); return; }
    const url = `/media/${mediaId}`;
    const img = new Image();
    img.onload = () => {
      state.logoImg = img;
      state.logoMediaId = mediaId;
      state.logoName = name || 'Logo';
      $('logoThumb').src = url;
      $('logoName').textContent = state.logoName;
      $('logoThumbRow').style.display = 'flex';
      $('dzLogo').classList.add('done');
      showExtractedPalette(img);
      render();
      resolve(true);
    };
    img.onerror = () => { showToast('Could not load the logo'); resolve(false); };
    img.src = url;
  });
}
function clearLogo(){
  state.logoImg = null; state.logoMediaId = null; state.logoName = '';
  $('logoThumbRow').style.display = 'none';
  $('dzLogo').classList.remove('done');
  $('extractedSwatchGroup').style.display = 'none';
  render();
}

setupDZ('dzLogo', 'inputLogo', async file => {
  if (READONLY) return;
  if (file.type.startsWith('video/')){ showToast('Logos must be an image (PNG, JPG or WEBP)'); return; }
  const m = await uploadToServer(file, 'logo');
  if (!m) return;
  await loadLogo(m.id, file.name);
  markDirty();
});
$('logoRemove').addEventListener('click', () => { clearLogo(); markDirty(); });

/* ---------------------------------------------------------------
   BACKGROUND-REMOVAL TOGGLE
   --------------------------------------------------------------- */
function updateFitUI(){
  const box = $('fitOpts'); if (!box) return;
  const show = !!state.mediaSrcEl && !(state.bgRemoved && !state.mediaIsVideo);
  box.style.display = show ? 'block' : 'none';
  if (!show) return;
  document.querySelectorAll('#fitChips .chip').forEach(c => c.classList.toggle('selected', c.dataset.fit === state.mediaFit));
  document.querySelectorAll('#fitBgChips .chip').forEach(c => c.classList.toggle('selected', c.dataset.fbg === state.fitBg));
  const eff = resolvedFit(state.mediaSrcEl, canvas.width, canvas.height);
  $('fitBgRow').style.display = eff === 'fit' ? '' : 'none';
  $('fitFocusRow').style.display = eff === 'fill' ? '' : 'none';
  $('fitNow').textContent = state.mediaFit === 'auto'
    ? (eff === 'fit' ? 'This size: whole photo shown' : 'This size: photo fills the frame') : '';
  $('focusX').value = Math.round(state.focusX * 100); $('focusY').value = Math.round(state.focusY * 100);
}

function updateCutoutUI(){
  updateFitUI();
  $('bgToggle').checked = !!state.bgRemoved;
  $('cutoutOpts').style.display = state.bgRemoved && !state.mediaIsVideo ? 'block' : 'none';
  document.querySelectorAll('#cutoutBgChips .chip').forEach(c => c.classList.toggle('selected', c.dataset.cbg === state.cutoutBg));
  $('cutoutShadow').checked = state.cutoutShadow !== false;
  $('bgHint').textContent = state.bgRemoved ? 'Not perfect? Touch it up →' : 'One click — or refine it in the studio';
}

/* Forget the current cut-out (new photo / photo removed). Optionally deletes the stored mask file. */
function resetCutout(deleteMask){
  if (deleteMask && state.bgMaskId && !READONLY) PF.api('/media/' + state.bgMaskId, { method:'DELETE' }).catch(() => {});
  state.bgRemoved = false; state.mediaProcessed = null; state.maskAlpha = null; state.bgMaskId = null;
  updateCutoutUI();
}

/* Use a cut-out result (from auto or the studio): show it and save its mask with the design */
async function useCutout(res){
  state.mediaProcessed = res.canvas;
  state.maskAlpha = { alpha: res.alpha, W: res.W, H: res.H };
  state.bgRemoved = true;
  updateCutoutUI();
  render();
  if (READONLY) return;
  try {
    const blob = await BGStudio.maskToBlob(res.alpha, res.W, res.H);
    const fd = new FormData();
    fd.append('file', blob, 'cutout-mask.png');
    const m = await PF.api('/media', { method:'POST', form: fd });
    const old = state.bgMaskId;
    state.bgMaskId = m.id;
    if (old) PF.api('/media/' + old, { method:'DELETE' }).catch(() => {});
    markDirty();
  } catch (err){
    showToast('Cut-out applied, but it could not be saved: ' + err.message, 4500);
  }
}

/* Re-create a saved cut-out when a design is opened */
function restoreCutoutFor(img, { maskId }){
  state.bgMaskId = maskId || null;
  const done = r => { state.mediaProcessed = r.canvas; state.maskAlpha = { alpha: r.alpha, W: r.W, H: r.H }; state.bgRemoved = true; updateCutoutUI(); render(); };
  const auto = () => BGStudio.autoCut(img).then(done).catch(() => {});
  if (!maskId) return auto();
  return new Promise(resolve => {
    const m = new Image();
    m.onload = () => { try { done(BGStudio.applySavedMask(img, m)); resolve(); } catch (e){ auto().then(resolve); } };
    m.onerror = () => auto().then(resolve);
    m.src = '/media/' + maskId;
  });
}

$('bgToggle').addEventListener('change', async e => {
  if (READONLY){ e.target.checked = !!state.bgRemoved; return; }
  if (state.mediaIsVideo){ e.target.checked = false; showToast('Background removal works on photos, not video'); return; }
  if (!state.mediaSrcEl){ e.target.checked = false; return; }
  if (e.target.checked){
    // re-enable an existing cut-out instantly
    if (state.mediaProcessed && state.maskAlpha){ state.bgRemoved = true; updateCutoutUI(); render(); markDirty(); return; }
    showToast('Removing background…', 60000);
    try{
      const r = await BGStudio.autoCut(state.mediaSrcEl);
      await useCutout(r);
      showToast(r.stats && r.stats.method === 'graph'
        ? 'Background removed ✓ (busy-background mode) — use ✨ Refine to touch up'
        : 'Background removed ✓ — use ✨ Refine if anything needs fixing', 4000);
    } catch(err){
      console.error(err);
      showToast('Could not process this photo');
      state.bgRemoved = false; updateCutoutUI();
    }
  } else {
    state.bgRemoved = false;
    updateCutoutUI(); render(); markDirty();
  }
});

$('btnBgStudio').addEventListener('click', () => {
  if (READONLY) return;
  if (!state.mediaSrcEl || state.mediaIsVideo){ showToast('Upload a photo first'); return; }
  BGStudio.open({
    img: state.mediaSrcEl,
    alpha: state.maskAlpha ? state.maskAlpha.alpha : null,
    brandColor: activeTheme().accent,
    onApply: res => { useCutout(res); showToast('Cut-out applied ✓'); }
  });
});

$('cutoutBgChips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c || READONLY) return;
  state.cutoutBg = c.dataset.cbg; updateCutoutUI(); render(); markDirty();
});
$('cutoutShadow').addEventListener('change', e => { state.cutoutShadow = e.target.checked; render(); markDirty(); });
$('fitChips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c || READONLY) return;
  state.mediaFit = c.dataset.fit; updateFitUI(); render(); markDirty();
});
$('fitBgChips').addEventListener('click', e => {
  const c = e.target.closest('.chip'); if (!c || READONLY) return;
  state.fitBg = c.dataset.fbg; updateFitUI(); render(); markDirty();
});
['focusX', 'focusY'].forEach(id => $(id).addEventListener('input', e => {
  if (READONLY) return;
  state[id] = Math.min(1, Math.max(0, e.target.value / 100)); render(); markDirty();
}));

/* ---------------------------------------------------------------
   CONTENT-TYPE TOGGLE + STARS
   --------------------------------------------------------------- */
$('ctToggle').addEventListener('click', e => {
  const b = e.target.closest('.ct-btn'); if (!b) return;
  setContentType(b.dataset.type);
});
$('starRow').addEventListener('click', e => {
  const b = e.target.closest('.star-btn'); if (!b) return;
  setStars(parseInt(b.dataset.star, 10));
  render();
});
$('inputReviewName').addEventListener('input', e => { state.reviewName = e.target.value; render(); });
$('inputReviewQuote').addEventListener('input', e => {
  state.reviewQuote = e.target.value;
  $('reviewQuoteCount').textContent = e.target.value.length;
  render();
});

/* ---------------------------------------------------------------
   LOGO CONTROLS
   --------------------------------------------------------------- */
$('logoPosGrid').addEventListener('click', e => {
  const b = e.target.closest('.seg-b'); if (!b) return;
  $('logoPosGrid').querySelectorAll('.seg-b').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); state.logoPos = b.dataset.pos; render();
});
$('logoSizeGrid').addEventListener('click', e => {
  const b = e.target.closest('.seg-b'); if (!b) return;
  $('logoSizeGrid').querySelectorAll('.seg-b').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); state.logoSize = b.dataset.size; render();
});
$('logoMargin').addEventListener('input', e => {
  state.logoMargin = parseInt(e.target.value, 10);
  $('logoMarginVal').textContent = state.logoMargin;
  render();
});

/* ---------------------------------------------------------------
   TEXT FIELDS (promo)
   --------------------------------------------------------------- */
$('inputHeadline').addEventListener('input', e => {
  state.headline = e.target.value; $('headlineCount').textContent = e.target.value.length; render();
});
$('inputSubheadline').addEventListener('input', e => { state.subheadline = e.target.value; render(); });
$('inputPrice').addEventListener('input',       e => { state.price = e.target.value;       render(); });
$('inputCTA').addEventListener('change',        e => { state.cta   = e.target.value; $('inputCtaCustom').value = ''; render(); });
$('inputCtaCustom').addEventListener('input', e => {
  const v = e.target.value.trim(); if (!v) return;
  state.cta = v;
  if (![...$('inputCTA').options].some(o => o.value === v)) $('inputCTA').add(new Option(v, v));
  $('inputCTA').value = v; render(); markDirty();
});
$('inputContact').addEventListener('input',     e => { state.contact = e.target.value;     render(); });
['inputHeadline', 'inputSubheadline', 'inputPrice', 'inputCtaCustom', 'inputBadgeCustom', 'inputContact', 'inputReviewQuote', 'inputReviewName']
  .forEach(id => { const el = $(id); if (el) el.addEventListener('input', refreshFontOptionsSoon); });
$('headlineCount').textContent = $('inputHeadline').value.length;

/* ---------------------------------------------------------------
   BADGES / THEMES
   --------------------------------------------------------------- */
$('badgeChips').addEventListener('click', e => {
  const b = e.target.closest('.chip'); if (!b) return;
  $('badgeChips').querySelectorAll('.chip').forEach(x => x.classList.remove('selected'));
  b.classList.add('selected'); state.badge = b.dataset.badge; $('inputBadgeCustom').value = ''; render();
});
$('inputBadgeCustom').addEventListener('input', e => {
  state.badge = e.target.value.trim();
  $('badgeChips').querySelectorAll('.chip').forEach(x => x.classList.toggle('selected', x.dataset.badge === state.badge));
  render(); markDirty(); refreshFontOptionsSoon();
});
$('themeChips').addEventListener('click', async e => {
  const b = e.target.closest('.theme-chip'); if (!b) return;
  $('themeChips').querySelectorAll('.theme-chip').forEach(x => x.classList.remove('active'));
  b.classList.add('active'); state.theme = b.dataset.theme;
  await ensureFonts(themeFontsInUse());
  render();
});

/* ---------------------------------------------------------------
   TABS / LAYER TOGGLES
   --------------------------------------------------------------- */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active'); $('tab-' + btn.dataset.tab).classList.add('active');
  });
});
document.querySelectorAll('.lv-toggle').forEach(btn => {
  if (btn.disabled) return;
  btn.addEventListener('click', () => {
    const key = btn.dataset.layer;
    state.layerVis[key] = !state.layerVis[key];
    btn.textContent = state.layerVis[key] ? '👁' : '🙈';
    btn.style.opacity = state.layerVis[key] ? '1' : '0.35';
    render();
  });
});

/* ---------------------------------------------------------------
   BRAND KIT — stored on the server, shared by the whole workspace
   --------------------------------------------------------------- */
let KITS = [];

function selectSwatch(color){
  document.querySelectorAll('.swatch').forEach(x => x.classList.toggle('active', (x.dataset.color || '') === (color || '')));
}
function onSwatchClick(e){
  const s = e.target.closest('.swatch'); if (!s || READONLY) return;
  state.brandColor = s.dataset.color || '';
  selectSwatch(state.brandColor);
  render(); markDirty();
}
$('brandSwatches').addEventListener('click', onSwatchClick);
$('extractedSwatches').addEventListener('click', onSwatchClick);

function renderKitSelect(){
  const sel = $('kitSelect');
  sel.innerHTML = KITS.length
    ? KITS.map(k => `<option value="${k.id}">${PF.esc(k.name)}</option>`).join('')
    : '<option value="">No brand kits yet</option>';
  $('btnApplyKit').disabled = !KITS.length;
  $('kitHint').textContent = KITS.length
    ? 'Apply adds the kit’s logo, colour and contact line to this design.'
    : 'Fill in the fields below and save to create your first brand kit.';
  fillKitFields(KITS.find(k => String(k.id) === sel.value) || null);
}
function fillKitFields(k){
  $('bkName').value = k ? k.name : (ME ? ME.workspace.name : '');
  $('bkPhone').value = k ? k.phone : '';
  $('bkWebsite').value = k ? k.website : '';
}
$('kitSelect').addEventListener('change', () => fillKitFields(KITS.find(k => String(k.id) === $('kitSelect').value) || null));

async function loadKits(){
  try { KITS = await PF.api('/brand-kits'); } catch(e){ KITS = []; }
  renderKitSelect();
}

async function applyKit(k){
  if (!k) return;
  state.brandColor = k.color;
  selectSwatch(k.color);
  const contact = [k.phone && '📞 ' + k.phone, k.website].filter(Boolean).join(' · ');
  if (contact){ state.contact = contact; $('inputContact').value = contact; }
  if (k.logo_media_id) await loadLogo(k.logo_media_id, k.name + ' logo');
  render(); markDirty();
  showToast(`Brand kit “${k.name}” applied ✓`);
}
$('btnApplyKit').addEventListener('click', () => applyKit(KITS.find(k => String(k.id) === $('kitSelect').value)));

$('btnSaveBrandKit').addEventListener('click', async () => {
  if (READONLY) return;
  const cur = KITS.find(k => String(k.id) === $('kitSelect').value);
  const body = {
    name: $('bkName').value.trim() || 'My brand',
    color: state.brandColor || activeTheme().accent,
    phone: $('bkPhone').value.trim(),
    website: $('bkWebsite').value.trim(),
    logo_media_id: state.logoMediaId || (cur ? cur.logo_media_id : null)
  };
  try {
    const saved = cur
      ? await PF.api('/brand-kits/' + cur.id, { method:'PUT', body })
      : await PF.api('/brand-kits', { method:'POST', body });
    await loadKits();
    $('kitSelect').value = String(saved.id);
    fillKitFields(saved);
    showToast('Brand kit saved ✓ — your whole team can use it');
  } catch (err){ handleApiError(err); }
});

/* ---------------------------------------------------------------
   FONTS — loaded on demand from Google Fonts so the canvas can use them
   --------------------------------------------------------------- */
const fontReady = new Set(['Inter', 'Space Grotesk']);
function ensureFonts(names){
  const todo = [...new Set(names.filter(Boolean))].filter(n => !fontReady.has(n));
  if (!todo.length || !document.fonts) return Promise.resolve();
  return Promise.all(todo.map(n => Promise.all([
    document.fonts.load(`800 48px "${n}"`), document.fonts.load(`700 48px "${n}"`), document.fonts.load(`400 48px "${n}"`),
  ]).then(() => fontReady.add(n)).catch(() => {}))).then(() => {});
}
function themeFontsInUse(){ const t = activeTheme(); return [t.font, t.bodyFont]; }

function buildStyleControls(){
  $('themeChips').innerHTML = Object.entries(THEMES).map(([k, t]) =>
    `<button class="chip theme-chip${k === state.theme ? ' active' : ''}" data-theme="${k}" title="${PF.esc(t.label)}"><span class="tc-dot" style="background:${t.bg};box-shadow:inset 0 0 0 3px ${t.accent}"></span>${PF.esc(t.label)}</button>`).join('');
  buildFontOptions();
  $('layoutChips').innerHTML = LAYOUTS.map(l => `<button class="chip${l.key === state.layout ? ' selected' : ''}" data-layout="${l.key}">${PF.esc(l.label)}</button>`).join('');
}
/* Font lists: fonts that support the language being typed come first */
let fontScriptKey = null;
function buildFontOptions(){
  const found = textScripts(designText()).filter(sc => sc.key !== 'cjk');
  const key = found.map(f => f.key).join(',');
  if (key === fontScriptKey) return;
  fontScriptKey = key;
  const o = f => `<option value="${PF.esc(f.name)}">${PF.esc(f.name)} — ${PF.esc(f.kind)}${f.lang ? ' · ' + PF.esc(f.lang) : ''}</option>`;
  let html;
  if (found.length){
    const ok = FONTS.filter(f => found.every(sc => (FONT_SCRIPTS[f.name] || []).includes(sc.key)));
    const rest = FONTS.filter(f => !ok.includes(f));
    html = `<optgroup label="✓ Fonts for ${PF.esc(found.map(f => f.label).join(' + '))}">${ok.map(o).join('')}</optgroup>`
      + `<optgroup label="Other fonts (your ${PF.esc(found[0].label.split(' /')[0])} text uses ${PF.esc(found[0].font)})">${rest.map(o).join('')}</optgroup>`;
  } else {
    const latin = FONTS.filter(f => !f.lang), local = FONTS.filter(f => f.lang);
    html = `<optgroup label="Popular">${latin.map(o).join('')}</optgroup><optgroup label="Local languages">${local.map(o).join('')}</optgroup>`;
  }
  const hv = $('headingFont').value, bv = $('bodyFont').value;
  $('headingFont').innerHTML = '<option value="">Theme default</option>' + html;
  $('bodyFont').innerHTML = '<option value="">Theme default (Inter)</option>' + html;
  $('headingFont').value = state.headingFont || hv || ''; $('bodyFont').value = state.bodyFont || bv || '';
  const hint = $('langHint');
  if (hint) hint.innerHTML = found.length
    ? `🌐 ${PF.esc(found.map(f => f.label).join(' + '))} text detected — fonts that support it are listed first.`
    : '🌐 Type in any language (नेपाली, हिन्दी, العربية, ไทย…) — PostForge picks a matching font automatically.';
}
let fontListTimer;
function refreshFontOptionsSoon(){ clearTimeout(fontListTimer); fontListTimer = setTimeout(buildFontOptions, 400); }

function syncStyleControls(){
  $('headingFont').value = state.headingFont || '';
  $('bodyFont').value = state.bodyFont || '';
  document.querySelectorAll('#layoutChips .chip').forEach(c => c.classList.toggle('selected', c.dataset.layout === state.layout));
  document.querySelectorAll('.theme-chip').forEach(b => b.classList.toggle('active', b.dataset.theme === state.theme));
}
$('headingFont').addEventListener('change', async e => { state.headingFont = e.target.value; await ensureFonts(themeFontsInUse()); render(); markDirty(); });
$('bodyFont').addEventListener('change', async e => { state.bodyFont = e.target.value; await ensureFonts(themeFontsInUse()); render(); markDirty(); });
$('layoutChips').addEventListener('click', e => {
  const c = e.target.closest('[data-layout]'); if (!c || READONLY) return;
  applyLayout(c.dataset.layout); markDirty();
});

/* ---------------------------------------------------------------
   LAYOUT PRESETS — arrange the text block in one click
   (classic = bottom-left, centred, text on top, middle of the design)
   --------------------------------------------------------------- */
function layoutPositions(name, W, H){
  const keys = state.contentType === 'review'
    ? ['rv_mark', 'rv_stars', 'rv_quote', 'rv_name', 'rv_verified']
    : ['badge', 'headline', 'sub', 'price', 'cta'];
  const pos = { ...state.pos };
  keys.forEach(k => delete pos[k]);
  if (name === 'classic') return pos;
  // measure the natural (un-moved) layout off-screen
  const savedPos = state.pos; state.pos = pos;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const prevHit = HIT; HIT = [];
  renderCore(c.getContext('2d'), W, H);
  const hits = HIT; HIT = prevHit; state.pos = savedPos;
  const hs = hits.filter(h => keys.includes(h.key));
  if (!hs.length) return pos;
  const m = Math.min(W, H) * 0.07;
  const block = hs.filter(h => h.key !== 'badge');
  const top = Math.min(...block.map(h => h.nat.y)), bottom = Math.max(...block.map(h => h.nat.y + h.nat.h));
  const badge = hs.find(h => h.key === 'badge');
  let dy = 0;
  if (name === 'top') dy = (m + (badge ? 0 : 0)) - top + (state.contentType === 'review' ? 0 : H * 0.02);
  if (name === 'middle') dy = (H - (bottom - top)) / 2 - top;
  const center = name === 'centered' || name === 'middle';
  for (const h of hs){
    const n = h.nat, p = { x:0, y:0, s:1 };
    if (center) p.x = (W / 2 - (n.x + n.w / 2)) / W;
    if (h.key === 'badge'){
      if (name === 'top') p.y = (H - m - (n.y + n.h)) / H;           // badge moves to the bottom
      if (name === 'middle') p.y = (top + dy - m * 0.4 - (n.y + n.h)) / H; // sits just above the block
    } else p.y = dy / H;
    if (p.x || p.y) pos[h.key] = { x: +p.x.toFixed(4), y: +p.y.toFixed(4), s: 1 };
  }
  return pos;
}
function applyLayout(name){
  state.pos = layoutPositions(name, state.platformW, state.platformH);
  state.layout = name;
  layoutSig = '';
  syncStyleControls();
  render();
}

/* ---------------------------------------------------------------
   TEMPLATE LIBRARY — with live visual previews
   (previews use your own photo and logo when you have uploaded them)
   --------------------------------------------------------------- */
const TPL_KEYS = ['contentType', 'headline', 'subheadline', 'price', 'cta', 'badge', 'theme', 'reviewQuote', 'reviewName', 'reviewStars', 'pos', 'headingFont', 'layout'];
function templateFields(tpl){
  if (tpl.type === 'review') return { contentType:'review', reviewQuote: tpl.quote, reviewName: tpl.reviewer, reviewStars: tpl.stars, theme: tpl.theme, headingFont: tpl.font || '' };
  return { contentType:'promo', headline: tpl.headline, subheadline: tpl.sub, price: tpl.price, cta: tpl.cta, badge: tpl.badge, theme: tpl.theme, headingFont: tpl.font || '' };
}
function renderTemplatePreview(tpl, target){
  const saved = {}; TPL_KEYS.forEach(k => { saved[k] = state[k]; });
  try {
    Object.assign(state, templateFields(tpl));
    const W = 540, H = Math.round(540 * state.platformH / state.platformW);
    state.pos = layoutPositions(tpl.layout || 'classic', W, H);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    renderCore(c.getContext('2d'), W, H);
    target.width = target.clientWidth * 2 || 280; target.height = Math.round(target.width * H / W);
    const tctx = target.getContext('2d'); tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(c, 0, 0, target.width, target.height);
  } finally {
    Object.assign(state, saved);
  }
}

async function applyTemplate(tpl){
  await ensureFonts([tpl.font, (THEMES[tpl.theme] || {}).font]);
  const f = templateFields(tpl);
  if (tpl.type === 'review'){
    setContentType('review');
    state.reviewQuote = f.reviewQuote; state.reviewName = f.reviewName; state.theme = f.theme;
    $('inputReviewQuote').value = f.reviewQuote; $('reviewQuoteCount').textContent = f.reviewQuote.length;
    $('inputReviewName').value = f.reviewName;
    setStars(f.reviewStars);
  } else {
    setContentType('promo');
    state.headline = f.headline; state.subheadline = f.subheadline; state.price = f.price;
    state.cta = f.cta; state.badge = f.badge; state.theme = f.theme;
    $('inputHeadline').value = f.headline; $('headlineCount').textContent = f.headline.length;
    $('inputSubheadline').value = f.subheadline; $('inputPrice').value = f.price;
    if (![...$('inputCTA').options].some(o => o.value === f.cta)) $('inputCTA').add(new Option(f.cta, f.cta));
    $('inputCTA').value = f.cta;
    document.querySelectorAll('#badgeChips .chip').forEach(b => b.classList.toggle('selected', b.dataset.badge === f.badge));
  }
  state.headingFont = f.headingFont;
  applyLayout(tpl.layout || 'classic');
  syncStyleControls();
  render();
  markDirty();
  $('modalTemplates').classList.remove('open');
  showToast(`Template "${tpl.name}" applied ✓ — drag anything to move it`);
}

let tplRenderToken = 0;
async function populateTemplates(filter = ''){
  const container = $('tmplCategories');
  container.innerHTML = '';
  const token = ++tplRenderToken;
  const q = filter.trim().toLowerCase();
  const jobs = [];
  CATEGORIES.forEach(cat => {
    const items = (TEMPLATES[cat.key] || []).filter(t => !q || (cat.label + ' ' + t.name + ' ' + (t.headline || t.quote || '')).toLowerCase().includes(q));
    if (!items.length) return;
    const locked = cat.premium && !PLAN.premium_templates;
    const label = document.createElement('div');
    label.className = 'tmpl-cat-label';
    label.textContent = cat.label + (locked ? '  🔒 paid plans' : '');
    container.appendChild(label);
    const grid = document.createElement('div');
    grid.className = 'tmpl-grid tmpl-grid-visual';
    items.forEach(tpl => {
      const card = document.createElement('button');
      card.className = 'tmpl-card' + (locked ? ' locked' : '');
      const cv = document.createElement('canvas'); cv.className = 'tmpl-thumb';
      const strong = document.createElement('strong');
      strong.textContent = tpl.name;
      if (locked){ const t = document.createElement('span'); t.className = 'pro-tag'; t.textContent = '🔒 PAID'; strong.appendChild(t); }
      card.append(cv, strong);
      card.addEventListener('click', () => {
        if (READONLY) return;
        if (locked){ $('modalTemplates').classList.remove('open'); showNotice('Premium template', `The ${cat.label.replace(/^\S+\s/, '')} templates are included with every paid plan. Upgrade to unlock the full library.`); return; }
        applyTemplate(tpl);
      });
      grid.appendChild(card);
      jobs.push({ tpl, cv });
    });
    container.appendChild(grid);
  });
  if (!jobs.length){ container.innerHTML = '<p class="tmpl-empty">No templates match that search.</p>'; return; }
  // load every font the previews need, then draw them a few at a time so the page stays responsive
  await ensureFonts(jobs.flatMap(j => [j.tpl.font, (THEMES[j.tpl.theme] || {}).font]));
  for (let i = 0; i < jobs.length; i++){
    if (token !== tplRenderToken || !$('modalTemplates').classList.contains('open')) return;
    renderTemplatePreview(jobs[i].tpl, jobs[i].cv);
    if (i % 4 === 3) await new Promise(r => setTimeout(r, 0));
  }
}

$('btnTemplates').addEventListener('click', () => {
  $('modalTemplates').classList.add('open');
  $('tmplSearch').value = '';
  populateTemplates();
  setTimeout(() => $('tmplSearch').focus(), 50);
});
let tplSearchTimer;
$('tmplSearch').addEventListener('input', e => { clearTimeout(tplSearchTimer); tplSearchTimer = setTimeout(() => populateTemplates(e.target.value), 200); });
$('btnBrandKit').addEventListener('click', () => document.querySelector('.tab-btn[data-tab="brand"]').click());
document.querySelector('#modalTemplates .modal-close').addEventListener('click', () => $('modalTemplates').classList.remove('open'));
document.querySelector('#modalTemplates .modal-backdrop').addEventListener('click', () => $('modalTemplates').classList.remove('open'));

/* ---------------------------------------------------------------
   PLATFORM PICKER + BATCH CHECKLIST (built from PLATFORMS)
   --------------------------------------------------------------- */
function buildPlatformUI(){
  $('platformSelect').innerHTML = Object.entries(PLATFORMS).map(([key, p]) =>
    `<option value="${key}">${p.label} · ${p.w}×${p.h}</option>`
  ).join('');
  $('batchPlatList').innerHTML = Object.entries(PLATFORMS).map(([key, p]) =>
    `<label class="batch-row"><input type="checkbox" class="batch-chk" value="${key}" checked>${p.label}<span class="dims">${p.w}×${p.h}</span></label>`
  ).join('');
}
$('platformSelect').addEventListener('change', e => applyPlatform(e.target.value));
$('batchSelectAll').addEventListener('click', () => document.querySelectorAll('.batch-chk').forEach(c => c.checked = true));
$('batchSelectNone').addEventListener('click', () => document.querySelectorAll('.batch-chk').forEach(c => c.checked = false));

/* ---------------------------------------------------------------
   EXPORT — every download is first authorised by the server,
   which checks the plan's features and counts it against the
   user's allowance (5/day, 50/month, trial… set per plan).
   --------------------------------------------------------------- */
let exportFormat = 'png';
document.querySelectorAll('.fmt-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.dataset.fmt === 'video' && !PLAN.video_export){
      showNotice('Video export starts on the Starter plan', `Upgrade to Starter (videos up to 30 seconds) or Pro to export branded videos with sound for Reels, TikTok, Shorts and Stories.`);
      return;
    }
    document.querySelectorAll('.fmt-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active'); exportFormat = btn.dataset.fmt;
    updateRecordButtonLabel();
  });
});
document.querySelectorAll('input[name="q"]').forEach(r => r.addEventListener('change', e => {
  const q = parseInt(e.target.value, 10);
  if (q > PLAN.max_quality){
    document.querySelector(`input[name="q"][value="${PLAN.max_quality}"]`).checked = true;
    showNotice('Higher quality needs an upgrade', `${q}× export isn't included in ${PLAN.name} (max ${PLAN.max_quality}×). ${q === 3 ? 'Pro' : 'Starter and Pro'} include${q === 3 ? 's' : ''} it.`);
  }
}));
const selectedQuality = () => parseInt(document.querySelector('input[name="q"]:checked')?.value || '1', 10);

/* Ask the server for permission to download `items` files. Returns
   { watermark } on success, or null (after telling the user why) on refusal. */
async function authorizeExport(items){
  if (!CAN_EXPORT){ showToast('Viewers can’t download designs'); return null; }
  try {
    const r = await PF.api('/exports', { method:'POST', body:{ designId: DESIGN_ID, items, quality: selectedQuality() } });
    updateUsage(r.usage);
    return r;
  } catch (err){
    handleApiError(err);
    return null;
  }
}

function renderPlatformToCanvas(key, mult, watermark){
  const p = PLATFORMS[key];
  const outW = p.w * mult, outH = p.h * mult;
  const ec = document.createElement('canvas');
  ec.width = outW; ec.height = outH;
  const ctx = ec.getContext('2d');
  renderCore(ctx, outW, outH);
  if (watermark) drawWatermark(ctx, outW, outH);
  return ec;
}

const fileBase = () => (($('designName').value || 'postforge').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'postforge');

async function doExport(){
  if (exportFormat === 'video'){
    if (isRecording){ cancelRecording(); return; }
    exportSingleVideo();
    return;
  }
  if (state.mediaIsVideo){ showToast('Tip: this is a video post — pick “Video” in Export to keep the motion. Saving a still frame…', 4000); }
  const grant = await authorizeExport([{ platform: state.platformKey, kind:'image' }]);
  if (!grant) return;
  const ec = renderPlatformToCanvas(state.platformKey, selectedQuality(), grant.watermark);
  const mime = exportFormat === 'jpg' ? 'image/jpeg' : 'image/png';
  const ext  = exportFormat === 'jpg' ? 'jpg' : 'png';
  ec.toBlob(blob => {
    if (!blob){ showToast('Export failed'); return; }
    downloadBlob(blob, `${fileBase()}_${state.platformKey}_${ec.width}x${ec.height}.${ext}`);
    showToast(grant.watermark ? 'Downloaded (trial watermark) — upgrade to remove it' : 'Download started ✓');
  }, mime, 0.95);
}
$('btnExport').addEventListener('click', doExport);
$('btnExport2').addEventListener('click', doExport);

/* ---------------------------------------------------------------
   VIDEO EXPORT — records the live canvas with the source video's
   own audio (WebM). The video element can only be connected to ONE
   MediaElementAudioSourceNode for its lifetime, so that source is
   created once and reused.
   --------------------------------------------------------------- */
let isRecording = false;
let activeRecorder = null;
let cachedAudioCtx = null;
let cachedAudioSource = null;
let cachedAudioVideo = null;

function getVideoAudioSource(video){
  if (!cachedAudioCtx) cachedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (!cachedAudioSource || cachedAudioVideo !== video){
    video.muted = false; video.volume = 1.0;
    cachedAudioSource = cachedAudioCtx.createMediaElementSource(video);
    cachedAudioSource.connect(cachedAudioCtx.destination);
    cachedAudioVideo = video;
  }
  return { ctx: cachedAudioCtx, source: cachedAudioSource };
}

/* Recording format. When the server can convert (ffmpeg), record the best-quality format the
   browser offers and let the server turn it into a social-ready MP4 (H.264 + AAC). Otherwise
   prefer the browser's own MP4 recording (Chrome 126+, Safari) and fall back to WebM. */
const MP4_TYPES = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4;codecs=avc1', 'video/mp4'];
const WEBM_TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
const canConvert = () => !!(ME && ME.features && ME.features.mp4Convert);
function pickVideoMimeType(){
  if (!window.MediaRecorder) return null;
  const order = canConvert() ? [...WEBM_TYPES, ...MP4_TYPES] : [...MP4_TYPES, ...WEBM_TYPES];
  return order.find(m => MediaRecorder.isTypeSupported(m)) || null;
}

/* Turn a recorded clip into an MP4 that Instagram / Facebook / TikTok accept */
async function finaliseVideo(blob){
  if (canConvert()){
    try {
      showToast('Converting to MP4 for Instagram & Facebook…', 60000);
      const r = await fetch('/api/video/convert', { method:'POST', body: blob, credentials:'same-origin',
        headers: { 'Content-Type': blob.type.split(';')[0] || 'application/octet-stream', 'X-CSRF-Token': PF.csrf() || '' } });
      if (r.ok) return { blob: await r.blob(), ext: 'mp4' };
      console.warn('MP4 conversion failed', r.status);
    } catch (e){ console.warn('MP4 conversion failed', e); }
  }
  const isMp4 = blob.type.startsWith('video/mp4');
  return { blob, ext: isMp4 ? 'mp4' : 'webm', fallback: !isMp4 };
}

function recordCurrentCanvasAsVideo(watermark){
  return new Promise((resolve, reject) => {
    const video = state.mediaSrcEl;
    const mimeType = pickVideoMimeType();
    if (!mimeType){ reject(new Error('Video export not supported in this browser')); return; }

    const { ctx: audioCtx, source: audioSource } = getVideoAudioSource(video);
    const audioDest = audioCtx.createMediaStreamDestination();
    audioSource.connect(audioDest);

    recordWithWatermark = !!watermark;
    const videoStream = canvas.captureStream(30);
    const combined = new MediaStream([...videoStream.getVideoTracks(), ...audioDest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(combined, { mimeType, videoBitsPerSecond: 8000000, audioBitsPerSecond: 192000 });
    activeRecorder = rec;

    const chunks = [];
    const finish = () => { try { audioSource.disconnect(audioDest); } catch(e){} activeRecorder = null; recordWithWatermark = false; };
    rec.ondataavailable = e => { if (e.data && e.data.size > 0) chunks.push(e.data); };
    rec.onstop = () => { finish(); resolve(new Blob(chunks, { type: mimeType })); };
    rec.onerror = err => { finish(); reject(err); };

    const wasLooping = video.loop;
    video.loop = false;
    video.currentTime = 0;
    startVideoLoop();
    video.play();
    rec.start(100);
    video.onended = () => { video.loop = wasLooping; if (rec.state === 'recording') rec.stop(); };
    setTimeout(() => { if (rec.state === 'recording') rec.stop(); }, (video.duration * 1000 || 15000) + 3000);
  });
}

function cancelRecording(){
  if (activeRecorder && activeRecorder.state === 'recording') activeRecorder.stop();
  isRecording = false;
  updateRecordButtonLabel();
}

async function exportSingleVideo(){
  if (!state.mediaIsVideo || !state.mediaSrcEl || state.mediaSrcEl.readyState < 2){
    showToast('Upload a video first to export as video'); return;
  }
  const grant = await authorizeExport([{ platform: state.platformKey, kind:'video' }]);
  if (!grant) return;
  isRecording = true; updateRecordButtonLabel();
  showToast('Recording video with sound — this plays through once…', 4000);
  try{
    const raw = await recordCurrentCanvasAsVideo(grant.watermark);
    const out = await finaliseVideo(raw);
    downloadBlob(out.blob, `${fileBase()}_${state.platformKey}_${state.platformW}x${state.platformH}.${out.ext}`);
    showToast(out.ext === 'mp4' ? 'MP4 video saved with sound ✓' : 'Saved as WebM — this browser/server could not make MP4. Try Chrome or Safari.', 5000);
  } catch(err){
    console.error(err);
    showToast('Video export failed');
  }
  isRecording = false; updateRecordButtonLabel();
  if (state.mediaIsVideo){ state.mediaSrcEl.muted = true; state.mediaSrcEl.loop = true; state.mediaSrcEl.play().catch(()=>{}); }
}

function updateRecordButtonLabel(){
  $('btnExport').innerHTML = isRecording ? '⏹ Stop Recording' : '⬇&nbsp; Download';
  $('btnExport').style.background = isRecording ? '#e63946' : '';
  $('btnExport2').innerHTML = isRecording ? '⏹ Stop Recording' : (exportFormat === 'video' ? '⬇ Download video (MP4)' : '⬇ Download content');
  $('btnExport2').style.background = isRecording ? '#e63946' : '';
}

/* ---------------------------------------------------------------
   BATCH EXPORT — every checked platform, one click, one ZIP
   --------------------------------------------------------------- */
function setBatchProgress(pct, label){
  $('bpLabelText').textContent = label;
  $('bpLabelPct').textContent = Math.round(pct) + '%';
  $('bpFill').style.width = Math.round(pct) + '%';
}

async function runImageBatch(keys, watermark){
  const mult = selectedQuality();
  const mime = exportFormat === 'jpg' ? 'image/jpeg' : 'image/png';
  const ext  = exportFormat === 'jpg' ? 'jpg' : 'png';
  const zip = (typeof JSZip !== 'undefined') ? new JSZip() : null;
  const loose = [];
  const base = fileBase();

  for (let i = 0; i < keys.length; i++){
    const key = keys[i], p = PLATFORMS[key];
    setBatchProgress((i / keys.length) * 100, `Rendering ${p.label} (${i+1}/${keys.length})`);
    await new Promise(r => setTimeout(r, 10));
    const ec = renderPlatformToCanvas(key, mult, watermark);
    const blob = await new Promise(res => ec.toBlob(res, mime, 0.95));
    const fname = `${base}_${key}_${ec.width}x${ec.height}.${ext}`;
    if (zip) zip.file(fname, blob); else loose.push({ blob, fname });
  }

  setBatchProgress(100, 'Packaging…');
  if (zip){
    const content = await zip.generateAsync({ type:'blob' });
    downloadBlob(content, `${base}_all_platforms.zip`);
  } else {
    for (const item of loose){ downloadBlob(item.blob, item.fname); await new Promise(r => setTimeout(r, 150)); }
  }
  showToast(`Generated ${keys.length} platform-ready images ✓`);
}

async function runVideoBatch(keys, watermark){
  if (!state.mediaSrcEl || state.mediaSrcEl.readyState < 2){ showToast('Video not ready yet'); return; }
  const savedKey = state.platformKey, savedW = state.platformW, savedH = state.platformH;
  const zip = (typeof JSZip !== 'undefined') ? new JSZip() : null;
  const base = fileBase();

  for (let i = 0; i < keys.length; i++){
    const key = keys[i], p = PLATFORMS[key];
    setBatchProgress((i / keys.length) * 100, `Recording ${p.label} (${i+1}/${keys.length}) — real time`);
    state.platformW = p.w; state.platformH = p.h;
    canvas.width = p.w; canvas.height = p.h;
    try{
      const raw = await recordCurrentCanvasAsVideo(watermark);
      setBatchProgress(((i + 0.8) / keys.length) * 100, `Converting ${p.label} to MP4…`);
      const out = await finaliseVideo(raw);
      const fname = `${base}_${key}_${p.w}x${p.h}.${out.ext}`;
      if (zip) zip.file(fname, out.blob); else downloadBlob(out.blob, fname);
    } catch(err){
      console.error(err);
      showToast(`Skipped ${p.label} — recording failed`);
    }
  }

  state.platformKey = savedKey; state.platformW = savedW; state.platformH = savedH;
  canvas.width = savedW; canvas.height = savedH;
  fitStageShell(); render();

  setBatchProgress(100, 'Packaging…');
  if (zip){
    const content = await zip.generateAsync({ type:'blob' });
    downloadBlob(content, `${base}_all_platforms_video.zip`);
  }
  showToast(`Rendered ${keys.length} platform videos ✓`);
  if (state.mediaIsVideo){ state.mediaSrcEl.muted = true; state.mediaSrcEl.loop = true; state.mediaSrcEl.play().catch(()=>{}); }
}

async function runBatchExport(){
  if (!PLAN.batch_export){
    showNotice('Multi-platform export', `Generating every platform in one ZIP is included with paid plans. On ${PLAN.name} you can still download one size at a time.`);
    return;
  }
  const keys = [...document.querySelectorAll('.batch-chk:checked')].map(c => c.value);
  if (!keys.length){ showToast('Pick at least one platform'); return; }
  const kind = state.mediaIsVideo && exportFormat === 'video' ? 'video' : 'image';
  if (USAGE && USAGE.remaining < keys.length){
    showNotice('Not enough downloads left', USAGE.remaining
      ? `You have ${USAGE.remaining} download${USAGE.remaining > 1 ? 's' : ''} left and picked ${keys.length} sizes. Untick some sizes, or upgrade for a bigger allowance. (${USAGE.resets})`
      : `You've used your ${USAGE.limit} downloads. ${USAGE.resets}.`);
    return;
  }
  const grant = await authorizeExport(keys.map(platform => ({ platform, kind })));
  if (!grant) return;

  $('batchProgress').classList.add('show');
  $('btnBatchGo').disabled = true;
  setBatchProgress(0, 'Starting…');
  try{
    if (kind === 'video') await runVideoBatch(keys, grant.watermark);
    else await runImageBatch(keys, grant.watermark);
  } catch(err){
    console.error(err);
    showToast('Batch export hit a problem — check the browser console');
  }
  setTimeout(() => { $('batchProgress').classList.remove('show'); $('btnBatchGo').disabled = false; }, 500);
}
$('btnBatchGo').addEventListener('click', runBatchExport);
$('btnGenerateAll').addEventListener('click', () => {
  document.querySelector('.tab-btn[data-tab="export"]').click();
  runBatchExport();
});

/* ===============================================================
   FREE POSITIONING — drag on the canvas, nudge, align, resize
   =============================================================== */
let selKey = null;
const PROMO_KEYS = ['badge', 'headline', 'sub', 'price', 'cta', 'contact', 'logo', 'product'];
const REVIEW_KEYS = ['rv_mark', 'rv_stars', 'rv_quote', 'rv_name', 'rv_verified', 'logo', 'product'];
const keysForType = () => state.contentType === 'review' ? REVIEW_KEYS : PROMO_KEYS;
const hitFor = key => lastHits.find(h => h.key === key);
const INPUT_FOR = { headline:'inputHeadline', sub:'inputSubheadline', price:'inputPrice', cta:'inputCTA', contact:'inputContact',
  rv_quote:'inputReviewQuote', rv_name:'inputReviewName' };

function canvasPoint(e){
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * canvas.width / r.width, y: (e.clientY - r.top) * canvas.height / r.height };
}
function hitTest(pt){
  const pad = canvas.width * 0.01;
  for (let i = lastHits.length - 1; i >= 0; i--){       // topmost (last drawn) first
    const h = lastHits[i];
    if (h.key === 'product') continue;                   // product is checked last so text on top wins
    if (pt.x >= h.x - pad && pt.x <= h.x + h.w + pad && pt.y >= h.y - pad && pt.y <= h.y + h.h + pad) return h;
  }
  const p = hitFor('product');
  if (p && pt.x >= p.x && pt.x <= p.x + p.w && pt.y >= p.y && pt.y <= p.y + p.h) return p;
  return null;
}
function boxStyle(el, b){
  el.style.left = (b.x / canvas.width * 100) + '%';
  el.style.top = (b.y / canvas.height * 100) + '%';
  el.style.width = (b.w / canvas.width * 100) + '%';
  el.style.height = (b.h / canvas.height * 100) + '%';
}

function updateSelectionBox(){
  const box = $('selBox');
  const h = selKey ? hitFor(selKey) : null;
  if (!h){ box.style.display = 'none'; }
  else {
    box.style.display = 'block';
    boxStyle(box, h);
    $('selTag').textContent = POS_LABELS[selKey] || selKey;
    box.classList.toggle('tag-below', h.y < canvas.height * 0.06);
  }
  syncPosPanel();
}

function select(key, { focusPanel = false } = {}){
  if (key && !keysForType().includes(key)) key = null;
  selKey = key;
  document.querySelectorAll('.layer-r[data-sel]').forEach(r => r.classList.toggle('sel', r.dataset.sel === key));
  $('hoverBox').style.display = 'none';
  updateSelectionBox();
  if (key && focusPanel){
    document.querySelector('.tab-btn[data-tab="layers"]').click();
    $('posCard').scrollIntoView({ block:'nearest', behavior:'smooth' });
  }
  if (key && !hitFor(key)){
    const why = key === 'product' ? 'Switch on “Remove background” to move the product on its own.'
      : state.layerVis[key === 'sub' ? 'sub' : key] === false ? 'This layer is hidden — click its 👁 to show it.'
      : 'Add some text for it first, then you can move it.';
    showToast(why, 3500);
  }
}

function syncPosPanel(){
  const has = !!(selKey && hitFor(selKey));
  $('posCard').classList.toggle('has-sel', !!selKey);
  $('posControls').hidden = !has;
  $('posEmpty').hidden = has;
  $('posTitle').textContent = selKey ? (POS_LABELS[selKey] || '') : '';
  if (!has) return;
  const p = posOf(selKey);
  $('posX').value = (p.x * 100).toFixed(1); $('posXVal').textContent = (p.x * 100).toFixed(1) + '%';
  $('posY').value = (p.y * 100).toFixed(1); $('posYVal').textContent = (p.y * 100).toFixed(1) + '%';
  $('posS').value = Math.round(p.s * 100);   $('posSVal').textContent = Math.round(p.s * 100) + '%';
}

function setPos(key, next){
  if (key !== 'logo' && key !== 'product' && state.layout !== 'custom'){ state.layout = 'custom'; syncStyleControls(); }
  const cur = posOf(key);
  const p = { x: next.x ?? cur.x, y: next.y ?? cur.y, s: next.s ?? cur.s };
  p.x = Math.max(-1, Math.min(1, p.x)); p.y = Math.max(-1, Math.min(1, p.y)); p.s = Math.max(0.3, Math.min(4, p.s));
  if (Math.abs(p.x) < 1e-4 && Math.abs(p.y) < 1e-4 && Math.abs(p.s - 1) < 1e-4) delete state.pos[key];
  else state.pos[key] = { x: +p.x.toFixed(4), y: +p.y.toFixed(4), s: +p.s.toFixed(3) };
  render();
}

/* align helpers use the element's natural (un-moved) box */
function alignTo(where){
  const h = hitFor(selKey); if (!h) return;
  const W = canvas.width, H = canvas.height, s = posOf(selKey).s;
  const m = Math.min(W, H) * 0.065;
  const ncx = h.nat.x + h.nat.w / 2, ncy = h.nat.y + h.nat.h / 2;
  const hw = h.nat.w * s / 2, hh = h.nat.h * s / 2;
  const tx = { left: m + hw, hcenter: W / 2, right: W - m - hw };
  const ty = { top: m + hh, vcenter: H / 2, bottom: H - m - hh };
  if (where === 'center-both') setPos(selKey, { x: (W / 2 - ncx) / W, y: (H / 2 - ncy) / H });
  else if (where in tx) setPos(selKey, { x: (tx[where] - ncx) / W });
  else if (where in ty) setPos(selKey, { y: (ty[where] - ncy) / H });
  markDirty();
}

/* ---- canvas pointer interactions ---- */
let drag = null;
const SNAP = 0.012;
function showGuides(v, hz){ $('guideV').style.display = v ? 'block' : 'none'; $('guideH').style.display = hz ? 'block' : 'none'; }

canvas.addEventListener('pointerdown', e => {
  if (READONLY || isRecording) return;
  const pt = canvasPoint(e);
  const h = hitTest(pt);
  if (!h){ select(null); return; }
  e.preventDefault();
  select(h.key);
  canvas.setPointerCapture(e.pointerId);
  drag = { mode:'move', key:h.key, start:pt, from:posOf(h.key), hit:{ ...h, nat:{ ...h.nat } } };
  stageShell.classList.add('dragging');
});
$('selHandle').addEventListener('pointerdown', e => {
  if (READONLY || !selKey) return;
  e.preventDefault(); e.stopPropagation();
  const h = hitFor(selKey); if (!h) return;
  $('selHandle').setPointerCapture(e.pointerId);
  const c = { x: h.x + h.w / 2, y: h.y + h.h / 2 };
  const pt = canvasPoint(e);
  drag = { mode:'scale', key:selKey, center:c, d0: Math.max(8, Math.hypot(pt.x - c.x, pt.y - c.y)), from:posOf(selKey) };
});
function onDragMove(e){
  const pt = canvasPoint(e);
  if (!drag){
    // hover highlight
    if (READONLY || e.target !== canvas) return;
    const h = hitTest(pt);
    canvas.classList.toggle('can-move', !!h);
    const hb = $('hoverBox');
    if (h && h.key !== selKey){ hb.style.display = 'block'; boxStyle(hb, h); } else hb.style.display = 'none';
    return;
  }
  const W = canvas.width, H = canvas.height;
  if (drag.mode === 'move'){
    let nx = drag.from.x + (pt.x - drag.start.x) / W;
    let ny = drag.from.y + (pt.y - drag.start.y) / H;
    // snap the element's centre to the canvas centre lines
    const n = drag.hit.nat, s = drag.from.s;
    const cx = (n.x + n.w / 2) / W + nx, cy = (n.y + n.h / 2) / H + ny;
    let sv = false, sh = false;
    if (!e.altKey){
      if (Math.abs(cx - 0.5) < SNAP){ nx += 0.5 - cx; sv = true; }
      if (Math.abs(cy - 0.5) < SNAP){ ny += 0.5 - cy; sh = true; }
    }
    // keep at least part of it on the canvas
    const halfW = n.w * s / 2 / W, halfH = n.h * s / 2 / H;
    const ccx = (n.x + n.w / 2) / W, ccy = (n.y + n.h / 2) / H;
    nx = Math.max(-ccx - halfW + 0.04, Math.min(1 - ccx + halfW - 0.04, nx));
    ny = Math.max(-ccy - halfH + 0.04, Math.min(1 - ccy + halfH - 0.04, ny));
    showGuides(sv, sh);
    setPos(drag.key, { x:nx, y:ny });
  } else {
    const d = Math.hypot(pt.x - drag.center.x, pt.y - drag.center.y);
    setPos(drag.key, { s: drag.from.s * d / drag.d0 });
  }
}
function onDragEnd(){
  if (!drag) return;
  drag = null;
  stageShell.classList.remove('dragging');
  showGuides(false, false);
  markDirty();
}
window.addEventListener('pointermove', onDragMove);
window.addEventListener('pointerup', onDragEnd);
window.addEventListener('pointercancel', onDragEnd);
canvas.addEventListener('pointerleave', () => { if (!drag) $('hoverBox').style.display = 'none'; });

/* double-click text on the design → jump to its input */
canvas.addEventListener('dblclick', e => {
  const h = hitTest(canvasPoint(e)); if (!h) return;
  const id = INPUT_FOR[h.key];
  if (id){ const el = $(id); el.scrollIntoView({ block:'center', behavior:'smooth' }); setTimeout(() => el.focus(), 250); }
  else if (h.key === 'badge') $('secBadge').scrollIntoView({ block:'center', behavior:'smooth' });
  else if (h.key === 'rv_stars') $('starRow').scrollIntoView({ block:'center', behavior:'smooth' });
});

/* ---- panel controls ---- */
$('posCard').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b || !selKey || READONLY) return;
  if (b.dataset.nudge){
    const [dx, dy] = b.dataset.nudge.split(',').map(Number);
    const step = e.shiftKey ? 0.05 : 0.01, p = posOf(selKey);
    setPos(selKey, { x: p.x + dx * step, y: p.y + dy * step }); markDirty();
  } else if (b.dataset.align) alignTo(b.dataset.align);
});
$('posX').addEventListener('input', e => { if (selKey) setPos(selKey, { x: +e.target.value / 100 }); });
$('posY').addEventListener('input', e => { if (selKey) setPos(selKey, { y: +e.target.value / 100 }); });
$('posS').addEventListener('input', e => { if (selKey) setPos(selKey, { s: +e.target.value / 100 }); });
['posX', 'posY', 'posS'].forEach(id => $(id).addEventListener('change', markDirty));
$('posReset').addEventListener('click', () => { if (selKey){ delete state.pos[selKey]; render(); markDirty(); } });
$('posResetAll').addEventListener('click', () => {
  const keys = keysForType();
  keys.forEach(k => delete state.pos[k]);
  state.layout = 'classic'; syncStyleControls();
  render(); markDirty();
  showToast(`All ${state.contentType === 'review' ? 'review' : 'promo'} elements are back in their default places`);
});
$('posDeselect').addEventListener('click', () => select(null));

/* layer rows + "Move" buttons in the left rail select an element */
document.querySelector('.layer-list').addEventListener('click', e => {
  if (e.target.closest('.lv-toggle')) return;
  const r = e.target.closest('.layer-r[data-sel]'); if (!r) return;
  select(selKey === r.dataset.sel ? null : r.dataset.sel);
});
document.querySelectorAll('.mv-btn').forEach(b => b.addEventListener('click', e => {
  e.preventDefault(); e.stopPropagation();
  select(b.dataset.move, { focusPanel:true });
  stageShell.scrollIntoView({ block:'nearest', behavior:'smooth' });
}));

/* keyboard: arrows nudge, Esc deselects */
document.addEventListener('keydown', e => {
  if (!selKey || READONLY) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
  if (document.querySelector('.bgs-wrap.open') || document.querySelector('.modal-wrap.open')) return;
  const map = { ArrowLeft:[-1,0], ArrowRight:[1,0], ArrowUp:[0,-1], ArrowDown:[0,1] };
  if (map[e.key]){
    e.preventDefault();
    const step = e.shiftKey ? 0.05 : 0.005, p = posOf(selKey);
    setPos(selKey, { x: p.x + map[e.key][0] * step, y: p.y + map[e.key][1] * step });
    markDirty();
  } else if (e.key === 'Escape') select(null);
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selKey){ delete state.pos[selKey]; render(); markDirty(); }
});

/* show only the layers that belong to the current post type */
function syncLayerRows(){
  const t = state.contentType;
  document.querySelectorAll('.layer-r[data-ct]').forEach(r => r.classList.toggle('ct-hidden', r.dataset.ct !== 'both' && r.dataset.ct !== t));
  if (selKey && !keysForType().includes(selKey)) select(null);
}

/* ===============================================================
   SAAS LAYER — account, plan access, design save/load
   =============================================================== */
const DESIGN_ID = new URLSearchParams(location.search).get('id');
let ME = null, PLAN = { name:'Free trial', code:'free', max_quality:1, video_export:false, batch_export:false, premium_templates:false, watermark:true, max_upload_mb:10, max_video_mb:0, max_video_seconds:0 };
let USAGE = null;
let READONLY = true, CAN_EXPORT = false;

/* ---- notices / errors ---- */
function showNotice(title, text, cta = { label:'See plans', href:'/app#billing' }){
  $('noticeTitle').textContent = title;
  $('noticeText').textContent = text;
  const a = $('noticeCta');
  if (cta && (ME?.user.role === 'owner' || cta.href !== '/app#billing')){
    a.style.display = ''; a.textContent = cta.label; a.href = cta.href;
  } else {
    a.style.display = 'none';
    if (cta && cta.href === '/app#billing') $('noticeText').textContent = text + ' Ask your workspace owner to upgrade.';
  }
  $('modalNotice').classList.add('open');
}
document.querySelectorAll('#modalNotice [data-close]').forEach(el => el.addEventListener('click', () => $('modalNotice').classList.remove('open')));

function handleApiError(err){
  const code = err.data && err.data.code;
  if (code === 'verify_email') showNotice('Confirm your email', err.message + ' Check your inbox, or resend the email from your dashboard.', { label:'Go to dashboard', href:'/app' });
  else if (code === 'quota'){ if (err.data.usage) updateUsage(err.data.usage); showNotice('Download limit reached', err.message); }
  else if (err.status === 402) showNotice('Upgrade needed', err.message);
  else showToast(err.message, 4500);
}

/* ---- usage display ---- */
function updateUsage(u){
  if (!u) return;
  USAGE = u;
  const pill = $('usagePill');
  $('usageText').textContent = `${u.remaining} left`;
  pill.title = `${PF.usageText(u)} · ${u.resets}`;
  pill.classList.toggle('out', u.remaining === 0);
  pill.classList.toggle('low', u.remaining > 0 && u.remaining <= Math.max(1, Math.round(u.limit * 0.2)));
  const pct = Math.min(100, u.used / Math.max(1, u.limit) * 100);
  $('quotaBox').innerHTML = `<div class="qb-top"><span>${PF.esc(PLAN.name)}</span><span>${PF.esc(u.day || u.month ? PF.usageText(u) : u.used + ' / ' + u.limit + ' used ' + u.label)}</span></div>
    <div class="qb-bar"><span style="width:${pct}%"></span></div>
    <div class="qb-sub">${PF.esc(u.resets)}${PLAN.code !== 'pro' && ME?.user.role === 'owner' ? ' · <a href="/app#billing">Upgrade</a>' : ''}</div>`;
}

/* ---- apply plan limits to the UI ---- */
function applyPlanUI(){
  document.querySelectorAll('input[name="q"]').forEach(r => {
    const q = parseInt(r.value, 10);
    r.closest('.q-opt').classList.toggle('locked', q > PLAN.max_quality);
  });
  document.querySelectorAll('.lock[data-q]').forEach(l => { l.textContent = parseInt(l.dataset.q, 10) > PLAN.max_quality ? '🔒 upgrade' : ''; });
  $('fmtVideo').classList.toggle('locked', !PLAN.video_export);
  $('fmtVideo').title = PLAN.video_export ? 'Export as MP4 video with sound' : 'Included from the Starter plan';
  $('batchLock').textContent = PLAN.batch_export ? '' : '🔒 paid plans';
  $('inputMedia').accept = PLAN.video_export
    ? 'image/png,image/jpeg,image/webp,video/mp4,video/quicktime,video/webm'
    : 'image/png,image/jpeg,image/webp';
  $('dzMediaSub').textContent = PLAN.video_export ? (PLAN.max_video_seconds ? `JPG · PNG · WEBP · MP4 · MOV (videos up to ${PLAN.max_video_seconds} s)` : 'JPG · PNG · WEBP · MP4 · MOV') : `JPG · PNG · WEBP · up to ${PLAN.max_upload_mb} MB`;
}

/* ---- serialise / restore the design ---- */
function serialize(){
  return {
    v: 1,
    contentType: state.contentType, platformKey: state.platformKey,
    mediaId: state.mediaId, mediaName: state.mediaName, mediaKind: state.mediaIsVideo ? 'video' : 'image', bgRemoved: !!state.bgRemoved, bgMaskId: state.bgMaskId,
    cutoutBg: state.cutoutBg, cutoutShadow: state.cutoutShadow !== false,
    mediaFit: state.mediaFit, fitBg: state.fitBg, focusX: state.focusX, focusY: state.focusY,
    logoMediaId: state.logoMediaId, logoName: state.logoName,
    logoPos: state.logoPos, logoSize: state.logoSize, logoMargin: state.logoMargin,
    headline: state.headline, subheadline: state.subheadline, price: state.price, cta: state.cta, badge: state.badge,
    reviewName: state.reviewName, reviewStars: state.reviewStars, reviewQuote: state.reviewQuote,
    theme: state.theme, brandColor: state.brandColor, contact: state.contact,
    headingFont: state.headingFont, bodyFont: state.bodyFont, layout: state.layout,
    layerVis: { ...state.layerVis },
    pos: JSON.parse(JSON.stringify(state.pos))
  };
}

const str = (v, max, def = '') => typeof v === 'string' ? v.slice(0, max) : def;
async function restore(d){
  if (!d || typeof d !== 'object') d = {};
  state.contentType = d.contentType === 'review' ? 'review' : 'promo';
  state.headline    = str(d.headline, 60, state.headline);
  state.subheadline = str(d.subheadline, 50, state.subheadline);
  state.price       = str(d.price, 20, state.price);
  state.cta         = str(d.cta, 30, state.cta);
  state.badge       = str(d.badge, 30, '');
  state.reviewName  = str(d.reviewName, 40, '');
  state.reviewQuote = str(d.reviewQuote, 180, $('inputReviewQuote').value);
  state.reviewStars = Math.min(5, Math.max(1, parseInt(d.reviewStars, 10) || 5));
  state.theme       = THEMES[d.theme] ? d.theme : 'modern';
  const fontOk = f => typeof f === 'string' && FONTS.some(x => x.name === f);
  state.headingFont = fontOk(d.headingFont) ? d.headingFont : '';
  state.bodyFont    = fontOk(d.bodyFont) ? d.bodyFont : '';
  state.layout      = LAYOUTS.some(l => l.key === d.layout) || d.layout === 'custom' ? d.layout : 'classic';
  state.brandColor  = /^#[0-9a-f]{6}$/i.test(d.brandColor || '') ? d.brandColor : '';
  state.contact     = str(d.contact, 60, '');
  state.cutoutBg    = ['theme','gradient','spotlight','blur'].includes(d.cutoutBg) ? d.cutoutBg : 'theme';
  state.cutoutShadow = d.cutoutShadow !== false;
  state.mediaFit    = ['auto','fill','fit'].includes(d.mediaFit) ? d.mediaFit : 'auto';
  state.fitBg       = ['blur','brand','white','black'].includes(d.fitBg) ? d.fitBg : 'blur';
  const unit = v => { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5; };
  state.focusX = unit(d.focusX); state.focusY = unit(d.focusY);
  state.logoPos     = ['tl','tr','bl','br'].includes(d.logoPos) ? d.logoPos : 'tr';
  state.logoSize    = ['s','m','l'].includes(d.logoSize) ? d.logoSize : 'm';
  state.logoMargin  = Math.min(60, Math.max(0, parseInt(d.logoMargin, 10) || 24));
  state.pos = {};
  if (d.pos && typeof d.pos === 'object'){
    for (const [k, v] of Object.entries(d.pos)){
      if (!(k in POS_LABELS) || !v || typeof v !== 'object') continue;
      const num = (n, lo, hi, def) => Number.isFinite(+n) ? Math.max(lo, Math.min(hi, +n)) : def;
      state.pos[k] = { x: num(v.x, -1, 1, 0), y: num(v.y, -1, 1, 0), s: num(v.s, 0.3, 4, 1) };
    }
  }
  if (d.layerVis && typeof d.layerVis === 'object') for (const k of Object.keys(state.layerVis)) if (k in d.layerVis) state.layerVis[k] = !!d.layerVis[k];

  syncUI();
  applyPlatform(PLATFORMS[d.platformKey] ? d.platformKey : 'ig_post');

  const tasks = [];
  if (d.mediaId && /^[0-9a-f-]{36}$/.test(d.mediaId)){
    state.mediaId = d.mediaId; state.mediaName = str(d.mediaName, 120, 'Photo');
    tasks.push(loadMediaFromUrl(`/media/${d.mediaId}`, d.mediaKind === 'video' ? 'video' : 'image', state.mediaName, { restoreCutout: d.bgRemoved ? { maskId: /^[0-9a-f-]{36}$/.test(d.bgMaskId || '') ? d.bgMaskId : null } : null }));
  }
  if (d.logoMediaId && /^[0-9a-f-]{36}$/.test(d.logoMediaId)) tasks.push(loadLogo(d.logoMediaId, str(d.logoName, 120, 'Logo')));
  tasks.push(ensureFonts(themeFontsInUse()));
  await Promise.all(tasks);
  syncStyleControls();
  render();
}

/* Push state → every control (used after loading a saved design) */
function syncUI(){
  setContentType(state.contentType);
  $('inputHeadline').value = state.headline; $('headlineCount').textContent = state.headline.length;
  $('inputSubheadline').value = state.subheadline;
  $('inputPrice').value = state.price;
  if (![...$('inputCTA').options].some(o => o.value === state.cta)) $('inputCTA').add(new Option(state.cta, state.cta));
  $('inputCTA').value = state.cta;
  $('inputReviewName').value = state.reviewName;
  $('inputReviewQuote').value = state.reviewQuote; $('reviewQuoteCount').textContent = state.reviewQuote.length;
  setStars(state.reviewStars);
  $('inputContact').value = state.contact;
  document.querySelectorAll('#badgeChips .chip').forEach(b => b.classList.toggle('selected', b.dataset.badge === state.badge));
  $('inputBadgeCustom').value = [...document.querySelectorAll('#badgeChips .chip')].some(b => b.dataset.badge === state.badge) ? '' : state.badge;
  fontScriptKey = null; buildFontOptions();
  document.querySelectorAll('.theme-chip').forEach(b => b.classList.toggle('active', b.dataset.theme === state.theme));
  document.querySelectorAll('#logoPosGrid .seg-b').forEach(b => b.classList.toggle('active', b.dataset.pos === state.logoPos));
  document.querySelectorAll('#logoSizeGrid .seg-b').forEach(b => b.classList.toggle('active', b.dataset.size === state.logoSize));
  $('logoMargin').value = state.logoMargin; $('logoMarginVal').textContent = state.logoMargin;
  document.querySelectorAll('.lv-toggle[data-layer]').forEach(btn => {
    const on = state.layerVis[btn.dataset.layer] !== false;
    btn.textContent = on ? '👁' : '🙈'; btn.style.opacity = on ? '1' : '0.35';
  });
  selectSwatch(state.brandColor);
}

/* ---- saving ---- */
let lastSavedJSON = '';
let lastSavedName = '';
let saveTimer = null, checkTimer = null, saving = false, saveQueued = false;

function setSaveStatus(text, err = false){
  const s = $('saveStatus');
  s.textContent = text; s.classList.toggle('err', err);
}
function isDirty(){
  return JSON.stringify(serialize()) !== lastSavedJSON || $('designName').value.trim() !== lastSavedName;
}
/* Called after any user change; autosaves 2.5s after the last edit */
function markDirty(){
  if (READONLY || !DESIGN_ID) return;
  clearTimeout(checkTimer);
  checkTimer = setTimeout(() => {
    if (!isDirty()) return;
    setSaveStatus('Unsaved changes');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveDesign, 2500);
  }, 120);
}

function makeThumbnail(){
  const p = PLATFORMS[state.platformKey];
  const s = 360 / Math.max(p.w, p.h);
  const c = document.createElement('canvas');
  c.width = Math.round(p.w * s); c.height = Math.round(p.h * s);
  const ctx = c.getContext('2d');
  ctx.scale(s, s);
  renderCore(ctx, p.w, p.h);
  try { return c.toDataURL('image/jpeg', 0.72); } catch(e){ return undefined; }
}

async function saveDesign(){
  if (READONLY || !DESIGN_ID) return;
  if (saving){ saveQueued = true; return; }
  clearTimeout(saveTimer);
  saving = true;
  setSaveStatus('Saving…');
  const data = serialize();
  const name = $('designName').value.trim() || 'Untitled design';
  try {
    await PF.api('/designs/' + encodeURIComponent(DESIGN_ID), { method:'PUT', body:{ name, data, thumbnail: makeThumbnail() } });
    lastSavedJSON = JSON.stringify(data); lastSavedName = name;
    setSaveStatus('All changes saved');
    document.title = `${name} — PostForge`;
  } catch (err){
    setSaveStatus('Not saved — retrying', true);
    if (err.status === 403){ setSaveStatus('Read-only', true); READONLY = true; document.body.classList.add('readonly'); }
    else saveTimer = setTimeout(saveDesign, 8000);
  } finally {
    saving = false;
    if (saveQueued){ saveQueued = false; if (isDirty()) saveDesign(); }
  }
}
$('btnSave').addEventListener('click', () => { if (READONLY){ showToast('This design is view-only'); return; } saveDesign(); });
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'){ e.preventDefault(); $('btnSave').click(); }
});
$('designName').addEventListener('input', markDirty);
$('designName').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

// Any interaction with the editing controls may change the design → check & autosave
['input', 'change', 'click'].forEach(ev => {
  document.querySelector('.rail-left').addEventListener(ev, markDirty);
  document.querySelector('.rail-right').addEventListener(ev, markDirty);
});
$('platformSelect').addEventListener('change', markDirty);

window.addEventListener('beforeunload', e => {
  if (!READONLY && DESIGN_ID && isDirty()){ e.preventDefault(); e.returnValue = ''; }
});

/* Discourage right-click "save image" on the preview (downloads go through Export) */
canvas.addEventListener('contextmenu', e => e.preventDefault());

/* ---------------------------------------------------------------
   INIT
   --------------------------------------------------------------- */
async function init(){
  buildPlatformUI();
  buildStyleControls();
  ensureFonts(themeFontsInUse()).then(render);
  // default batch selection: the four most-used sizes (keeps small allowances usable)
  const DEFAULT_BATCH = ['ig_post', 'ig_story', 'fb_post', 'li_post'];
  document.querySelectorAll('.batch-chk').forEach(c => { c.checked = DEFAULT_BATCH.includes(c.value); });
  window.addEventListener('resize', fitStageShell);
  applyPlatform('ig_post');
  syncLayerRows();

  try {
    ME = await PF.loadMe();
  } catch (e){ return; } // api() redirects to login on 401
  PLAN = ME.plan;
  CAN_EXPORT = ME.user.role !== 'viewer';
  applyPlanUI();
  updateUsage(ME.usage);
  loadKits();

  if (!DESIGN_ID){ location.href = '/app'; return; }
  let design;
  try {
    design = await PF.api('/designs/' + encodeURIComponent(DESIGN_ID));
  } catch (err){
    showNotice('Design not available', err.message, { label:'Back to designs', href:'/app' });
    return;
  }
  READONLY = !design.can_edit;
  document.body.classList.toggle('readonly', READONLY);
  document.body.classList.toggle('noexport', !CAN_EXPORT);
  $('btnSave').disabled = READONLY;
  if (READONLY){
    $('readonlyNote').style.display = 'block';
    if (ME.user.role !== 'viewer'){
      $('readonlyNote').innerHTML = '👁 View only — shared with you for viewing. <a href="#" id="dupLink">Make a copy to edit</a>';
      $('dupLink').addEventListener('click', async e => {
        e.preventDefault();
        try { const d = await PF.api('/designs', { method:'POST', body:{ duplicateOf: DESIGN_ID } }); location.href = '/editor?id=' + encodeURIComponent(d.id); }
        catch (err){ handleApiError(err); }
      });
    }
  }
  $('designName').value = design.name;
  document.title = `${design.name} — PostForge`;
  await restore(design.data);
  lastSavedJSON = JSON.stringify(serialize());
  lastSavedName = design.name;
  setSaveStatus(READONLY ? 'View only' : 'All changes saved');
}
document.addEventListener('DOMContentLoaded', init);
