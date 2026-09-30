/* =====================================================================
   DEPRECATED — NOT USED BY index.html
   =====================================================================
   This file was an earlier draft engine (v2) that was never wired up to
   index.html (there was no <script src="app.js"> tag referencing it).

   Its best ideas — the auto-fit text sizing, per-theme CTA button
   rendering, and the richer template library — have all been merged
   into the single consolidated engine now inlined inside index.html,
   along with everything else: multi-platform batch export, classical
   (non-AI) background removal, automatic brand-color extraction,
   the Customer Review/testimonial content type, and real video export
   with audio.

   This file is kept only for reference and is safe to delete whenever
   you like — nothing loads it.
   ===================================================================== */

/* =====================================================================
   POSTFORGE — CANVAS CONTENT ENGINE v2
   All 15 features scaffolded. Fully working: upload, logo, text-fit,
   platform resize, themes, badges, brand kit, PNG/JPG export.
   Stubbed (Phase 2): video export, QR code, carousel multi-export.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------
   CONSTANTS — Platform sizes
   --------------------------------------------------------------- */
const PLATFORMS = {
  ig_post:    { label:'Instagram Post',      w:1080, h:1080 },
  ig_portrait:{ label:'Instagram Portrait',  w:1080, h:1350 },
  ig_story:   { label:'Instagram Story',     w:1080, h:1920 },
  fb_post:    { label:'Facebook Post',       w:1200, h:630  },
  fb_story:   { label:'Facebook Story',      w:1080, h:1920 },
  li_post:    { label:'LinkedIn Post',       w:1200, h:1200 },
  li_banner:  { label:'LinkedIn Banner',     w:1584, h:396  },
  pin:        { label:'Pinterest Pin',       w:1000, h:1500 },
  x_post:     { label:'X Post',             w:1600, h:900  },
  yt_thumb:   { label:'YouTube Thumbnail',   w:1280, h:720  },
  wa_status:  { label:'WhatsApp Status',     w:1080, h:1920 }
};

/* ---------------------------------------------------------------
   THEMES (Feature 8)
   Each theme drives: overlay type, font, text colour, accent colour,
   CTA button style, headline position variant, price badge style.
   --------------------------------------------------------------- */
const THEMES = {
  modern:  { bg:'#1a1a2e', accent:'#ff6b4a', textMain:'#ffffff', textSub:'rgba(255,255,255,.78)',
             font:'Space Grotesk', ctaStyle:'pill',      overlay:'gradient',        priceStyle:'accent' },
  minimal: { bg:'#f7f5f1', accent:'#1a1a2e', textMain:'#1a1a2e', textSub:'rgba(26,26,46,.65)',
             font:'Inter',         ctaStyle:'outline',    overlay:'soft-white',      priceStyle:'dark'   },
  luxury:  { bg:'#0d0d0d', accent:'#d4af37', textMain:'#f5f0e6', textSub:'rgba(245,240,230,.6)',
             font:'Space Grotesk', ctaStyle:'underline',  overlay:'dark',            priceStyle:'gold'   },
  bold:    { bg:'#e63946', accent:'#ffd23f', textMain:'#ffffff', textSub:'rgba(255,255,255,.85)',
             font:'Space Grotesk', ctaStyle:'block',      overlay:'gradient-strong', priceStyle:'yellow' },
  premium: { bg:'#1a2e2a', accent:'#3ecf8e', textMain:'#ffffff', textSub:'rgba(255,255,255,.72)',
             font:'Space Grotesk', ctaStyle:'pill',       overlay:'gradient',        priceStyle:'green'  },
  festive: { bg:'#7a1d3d', accent:'#ffd23f', textMain:'#ffffff', textSub:'rgba(255,255,255,.8)',
             font:'Space Grotesk', ctaStyle:'pill',       overlay:'gradient-strong', priceStyle:'yellow' }
};

/* ---------------------------------------------------------------
   TEMPLATE LIBRARY (Feature 7) — industry presets that auto-fill
   the text fields and pick a sensible theme.
   --------------------------------------------------------------- */
const TEMPLATES = {
  restaurant: [
    { name:"Today's Special",   headline:"Today's Special", sub:"Chef's recommendation",    price:"Rs. 199",   cta:"Order Now",   badge:"HOT",         theme:"modern"  },
    { name:"Weekend Offer",     headline:"Weekend Feast",   sub:"Available Sat & Sun only", price:"20% OFF",   cta:"Book Today",  badge:"LIMITED OFFER",theme:"bold"    },
    { name:"Lunch Combo",       headline:"Lunch Combo Deal",sub:"Mon–Fri 12–3 PM",          price:"Rs. 299",   cta:"Order Now",   badge:"BEST SELLER", theme:"premium" },
    { name:"New Menu Item",     headline:"New On The Menu", sub:"Try it before it's gone",  price:"",          cta:"Explore Now", badge:"NEW",          theme:"minimal" }
  ],
  cafe: [
    { name:"Coffee Promo",      headline:"Start Your Day Right",sub:"Freshly brewed daily", price:"20% OFF",   cta:"Order Now",   badge:"HOT",         theme:"modern"  },
    { name:"Happy Hour",        headline:"Happy Hour",      sub:"2 PM – 5 PM every day",    price:"Buy 1 Get 1",cta:"Visit Store", badge:"LIMITED OFFER",theme:"festive" },
    { name:"New Beverage",      headline:"New Sip Arrived", sub:"Try our latest creation",  price:"",          cta:"Explore Now", badge:"NEW",          theme:"minimal" }
  ],
  retail: [
    { name:"Flash Sale",        headline:"Flash Sale",      sub:"Ends midnight tonight",     price:"50% OFF",   cta:"Shop Now",    badge:"50% OFF",     theme:"bold"    },
    { name:"New Arrival",       headline:"Just Arrived",    sub:"Fresh styles in store",     price:"",          cta:"Explore Now", badge:"NEW",          theme:"minimal" },
    { name:"Clearance Sale",    headline:"Clearance Sale",  sub:"While stocks last",         price:"Up to 70% OFF",cta:"Shop Now", badge:"SALE",         theme:"festive" }
  ],
  clothing: [
    { name:"New Collection",    headline:"New Collection",  sub:"Drop 2025",                 price:"",          cta:"Explore Now", badge:"NEW",          theme:"luxury"  },
    { name:"Flat Discount",     headline:"Flat 30% Off",    sub:"All clothing this week",    price:"30% OFF",   cta:"Shop Now",    badge:"SALE",         theme:"bold"    },
    { name:"Festive Collection",headline:"Festive Picks",   sub:"Dress for the season",      price:"",          cta:"Shop Now",    badge:"HOT",          theme:"festive" }
  ],
  salon: [
    { name:"Bridal Package",    headline:"Bridal Package",  sub:"Complete bridal makeover",  price:"Book Now",  cta:"Book Today",  badge:"LIMITED OFFER",theme:"luxury"  },
    { name:"Hair Treatment",    headline:"Hair Treatment",  sub:"Nourish & restore shine",   price:"20% OFF",   cta:"Book Today",  badge:"HOT",          theme:"premium" },
    { name:"Beauty Package",    headline:"Beauty Special",  sub:"Pamper yourself today",     price:"Rs. 999",   cta:"Reserve Now", badge:"NEW",          theme:"modern"  }
  ],
  service: [
    { name:"Special Offer",     headline:"Special Offer",   sub:"For new customers",         price:"20% OFF",   cta:"Get Quote",   badge:"LIMITED OFFER",theme:"modern"  },
    { name:"Book Appointment",  headline:"Book Now",        sub:"Limited slots available",   price:"",          cta:"Book Today",  badge:"",             theme:"minimal" },
    { name:"Seasonal Promo",    headline:"Season Special",  sub:"Offer ends soon",           price:"",          cta:"Call Now",    badge:"HOT",          theme:"bold"    }
  ],
  festival: [
    { name:"New Year",          headline:"Happy New Year!", sub:"Wishing you joy & success", price:"",          cta:"Shop Now",    badge:"",             theme:"festive" },
    { name:"Dashain",           headline:"Shubha Dashain", sub:"Celebrating togetherness",   price:"30% OFF",   cta:"Shop Now",    badge:"SALE",         theme:"festive" },
    { name:"Tihar",             headline:"Shubha Tihar",   sub:"Light up your celebrations", price:"",          cta:"Shop Now",    badge:"HOT",          theme:"festive" },
    { name:"Valentine's Day",   headline:"Share the Love", sub:"For someone special",        price:"",          cta:"Shop Now",    badge:"HOT",          theme:"bold"    },
    { name:"Christmas",         headline:"Merry Christmas",sub:"Season's greetings",         price:"",          cta:"Shop Now",    badge:"",             theme:"festive" }
  ]
};

/* ---------------------------------------------------------------
   STATE — single source of truth for the canvas render
   --------------------------------------------------------------- */
const state = {
  platformKey: 'ig_post',
  platformW:   1080,
  platformH:   1080,
  mediaImg:    null,
  mediaIsVideo:false,
  logoImg:     null,
  logoPos:     'tr',
  logoSize:    'm',
  logoMargin:  24,
  headline:    'Weekend Special',
  subheadline: 'Limited time only',
  price:       '20% OFF',
  cta:         'Shop Now',
  badge:       '',
  theme:       'modern',
  brandColor:  '#ff6b4a',
  contact:     '',
  layerVis:    { media:true, logo:true, headline:true, price:true, cta:true, badge:true }
};

/* ---------------------------------------------------------------
   CANVAS REFS
   --------------------------------------------------------------- */
const canvas    = document.getElementById('canvas');
const stageShell = document.getElementById('stageShell');
const stageEmptyHint = document.getElementById('stageEmptyHint');
const stageDims = document.getElementById('stageDims');

/* ---------------------------------------------------------------
   HELPER — round rect path
   --------------------------------------------------------------- */
function roundRectPath(ctx, x, y, w, h, r){
  r = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+r, y);
  ctx.arcTo(x+w, y,   x+w, y+h, r);
  ctx.arcTo(x+w, y+h, x,   y+h, r);
  ctx.arcTo(x,   y+h, x,   y,   r);
  ctx.arcTo(x,   y,   x+w, y,   r);
  ctx.closePath();
}

/* ---------------------------------------------------------------
   FEATURE 4 — SMART COVER-FIT CROP
   Scales image to fill the target rect without distorting, then
   center-crops (the "smart center alignment" spec requires).
   --------------------------------------------------------------- */
function drawImageCover(ctx, img, dx, dy, dw, dh){
  const imgR = img.naturalWidth / img.naturalHeight;
  const boxR = dw / dh;
  let sx, sy, sw, sh;
  if (imgR > boxR){          // image wider → crop left/right
    sh = img.naturalHeight;
    sw = sh * boxR;
    sy = 0;
    sx = (img.naturalWidth - sw) / 2;
  } else {                   // image taller → crop top/bottom
    sw = img.naturalWidth;
    sh = sw / boxR;
    sx = 0;
    sy = (img.naturalHeight - sh) / 2;
  }
  ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
}

/* ---------------------------------------------------------------
   FEATURE 5 — RESPONSIVE TEXT ENGINE
   wrapText: splits a string into lines that each fit maxWidth.
   fitText:  binary-searches the largest font size where wrapped
             lines fit inside maxWidth × maxHeight.
   --------------------------------------------------------------- */
function wrapText(ctx, text, maxWidth){
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
    ctx.font = `${weight} ${size}px "${family}", sans-serif`;
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
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => ctx.fillText(line, x, y + i * lh));
}

/* ---------------------------------------------------------------
   LOGO DIMENSIONS — maps size key → % of min(w,h)
   --------------------------------------------------------------- */
function logoBoxPx(canvasW, canvasH){
  const base = Math.min(canvasW, canvasH);
  return base * ({ s:0.09, m:0.14, l:0.21 }[state.logoSize] || 0.14);
}

/* ---------------------------------------------------------------
   CORE RENDER FUNCTION
   Takes any canvas 2d context + target dimensions so we can call
   it both for the live preview canvas AND for offscreen export
   at 1× / 2× / 3× without touching the preview canvas.
   --------------------------------------------------------------- */
function renderCore(ctx, w, h){
  const theme = THEMES[state.theme] || THEMES.modern;
  ctx.clearRect(0, 0, w, h);

  /* --- Layer: background image or theme colour fill --- */
  if (state.mediaImg && state.layerVis.media){
    drawImageCover(ctx, state.mediaImg, 0, 0, w, h);
  } else {
    ctx.fillStyle = theme.bg;
    ctx.fillRect(0, 0, w, h);
  }

  /* --- Scrim: gradient overlay for text legibility --- */
  if (state.mediaImg){
    const grad = ctx.createLinearGradient(0, h * 0.35, 0, h);
    const overlayMap = {
      'gradient':        ['rgba(0,0,0,0)', 'rgba(0,0,0,.72)'],
      'gradient-strong': ['rgba(0,0,0,0)', 'rgba(0,0,0,.86)'],
      'dark':            ['rgba(0,0,0,.12)','rgba(0,0,0,.78)'],
      'soft-white':      ['rgba(255,255,255,0)','rgba(255,255,255,.92)']
    };
    const [c0, c1] = overlayMap[theme.overlay] || overlayMap['gradient'];
    grad.addColorStop(0, c0);
    grad.addColorStop(1, c1);
    ctx.fillStyle = grad;
    ctx.fillRect(0, h * 0.35, w, h * 0.65);
  }

  const pad   = w * 0.065;
  const contentW = w - pad * 2;

  /* --- Layer: badge (top-left corner, Feature 10) --- */
  if (state.badge && state.layerVis.badge){
    ctx.save();
    const bFontSize = Math.round(Math.max(18, w * 0.028));
    ctx.font = `800 ${bFontSize}px "Space Grotesk", sans-serif`;
    const bPadX = w * 0.022, bPadY = w * 0.015;
    const bTextW = ctx.measureText(state.badge).width;
    const bW = bTextW + bPadX * 2, bH = bFontSize + bPadY * 2;
    const bx = pad * 0.7, by = pad * 0.7;
    ctx.fillStyle = theme.accent;
    roundRectPath(ctx, bx, by, bW, bH, bH / 2); ctx.fill();
    ctx.fillStyle = '#1a1a2e';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(state.badge, bx + bPadX, by + bH / 2 + 1);
    ctx.restore();
  }

  /* --- Measure and position headline block --- */
  /* We lay out bottom-up: CTA row → price → subheadline → headline */
  const bottomPad  = h * 0.075;
  const ctaH       = w * 0.068;
  const ctaFontSz  = Math.round(Math.max(14, w * 0.027));
  const priceFontSz= Math.round(Math.max(18, w * 0.048));
  const subFontSz  = Math.round(Math.max(13, w * 0.028));
  const ctaRowY    = h - bottomPad - ctaH;
  const priceY     = ctaRowY - priceFontSz * 1.3;
  const subY       = priceY  - subFontSz   * 1.45;

  /* --- Headline fit in the space above subheadline --- */
  const headlineMaxH = subY - pad * 0.5 - h * 0.12;
  const headlineFit  = fitText(ctx, state.headline || ' ', {
    maxW: contentW, maxH: Math.max(headlineMaxH, 60),
    minSize: Math.max(20, w * 0.024), maxSize: w * 0.088,
    family: theme.font, weight: 800, lineH: 1.12
  });
  const headlineTopY = subY - headlineFit.lines.length * headlineFit.lh - h * 0.018;

  /* --- Layer: headline --- */
  if (state.headline && state.layerVis.headline){
    ctx.save();
    ctx.font = `800 ${headlineFit.size}px "${theme.font}", sans-serif`;
    ctx.fillStyle = theme.textMain;
    ctx.shadowColor = state.mediaImg ? 'rgba(0,0,0,.35)' : 'transparent';
    ctx.shadowBlur  = 12;
    drawWrapped(ctx, headlineFit.lines, pad, headlineTopY + headlineFit.size, headlineFit.lh, 'left');
    ctx.restore();
  }

  /* --- Layer: subheadline --- */
  if (state.subheadline){
    ctx.save();
    ctx.font = `500 ${subFontSz}px "Inter", sans-serif`;
    ctx.fillStyle = theme.textSub;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(state.subheadline, pad, subY);
    ctx.restore();
  }

  /* --- Layer: price / offer --- */
  if (state.price && state.layerVis.price){
    ctx.save();
    ctx.font = `700 ${priceFontSz}px "${theme.font}", sans-serif`;
    ctx.fillStyle = theme.accent;
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.shadowColor = state.mediaImg ? 'rgba(0,0,0,.25)' : 'transparent';
    ctx.shadowBlur  = 8;
    ctx.fillText(state.price, pad, priceY);
    ctx.restore();
  }

  /* --- Layer: CTA button (Feature 2) --- */
  if (state.cta && state.layerVis.cta){
    ctx.save();
    ctx.font = `700 ${ctaFontSz}px "${theme.font}", sans-serif`;
    const label   = state.cta + '  →';
    const labelW  = ctx.measureText(label).width;
    const btnPadX = w * 0.045;
    const btnW    = labelW + btnPadX * 2;
    const btnX    = pad;
    const btnY    = ctaRowY;
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
        ctx.fillStyle = '#1a1a2e';
        ctx.fillRect(btnX - w*0.003, btnY - w*0.006, btnW + w*0.006, ctaH + w*0.012);
        ctx.fillStyle = theme.accent;
        ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        ctx.fillText(label, btnX + btnW / 2, btnY + ctaH / 2 + 1);
        break;
      default: /* pill */
        ctx.fillStyle = theme.accent;
        roundRectPath(ctx, btnX, btnY, btnW, ctaH, ctaH / 2); ctx.fill();
        ctx.fillStyle = '#1a1a2e';
        ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
        ctx.fillText(label, btnX + btnW / 2, btnY + ctaH / 2 + 1);
    }
    ctx.restore();
  }

  /* --- Layer: contact line --- */
  if (state.contact){
    ctx.save();
    const cFontSz = Math.round(Math.max(12, w * 0.02));
    ctx.font = `500 ${cFontSz}px "Inter", sans-serif`;
    ctx.fillStyle = theme.textSub;
    ctx.textAlign = 'right'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(state.contact, w - pad, h - pad * 0.45);
    ctx.restore();
  }

  /* --- Layer: logo (Feature 1) — always on top of text --- */
  if (state.logoImg && state.layerVis.logo){
    ctx.save();
    const box   = logoBoxPx(w, h);
    const ratio = state.logoImg.naturalWidth / state.logoImg.naturalHeight;
    let lw = box, lh = box / ratio;
    if (lh > box){ lh = box; lw = box * ratio; }
    const margin = (state.logoMargin / 1080) * w;
    let lx = state.logoPos.endsWith('l')  ? margin      : w - margin - lw;
    let ly = state.logoPos.startsWith('t') ? margin      : h - margin - lh;
    ctx.shadowColor = 'rgba(0,0,0,.3)';
    ctx.shadowBlur  = 16;
    ctx.shadowOffsetY = 3;
    ctx.drawImage(state.logoImg, lx, ly, lw, lh);
    ctx.restore();
  }
}

/* ---------------------------------------------------------------
   LIVE RENDER — writes to the on-screen canvas
   --------------------------------------------------------------- */
function render(){
  renderCore(canvas.getContext('2d'), canvas.width, canvas.height);
  stageEmptyHint.style.display = (state.mediaImg) ? 'none' : 'flex';
}

/* ---------------------------------------------------------------
   STAGE SIZE — morph animation via CSS transition
   --------------------------------------------------------------- */
function setStageSize(w, h){
  state.platformW = w;
  state.platformH = h;
  canvas.width  = w;
  canvas.height = h;

  const wrap = document.querySelector('.stage-wrap');
  const maxW = wrap.clientWidth  - 80;
  const maxH = wrap.clientHeight - 80;
  const scale = Math.min(maxW / w, maxH / h, 1);
  const dispW = Math.round(w * scale);
  const dispH = Math.round(h * scale);

  stageShell.style.width  = dispW + 'px';
  stageShell.style.height = dispH + 'px';
  stageDims.textContent   = `${w} × ${h} px`;
  render();
}

document.getElementById('platformSelect').addEventListener('change', (e) => {
  const opt = e.target.selectedOptions[0];
  setStageSize(parseInt(opt.dataset.w), parseInt(opt.dataset.h));
});
window.addEventListener('resize', () => setStageSize(state.platformW, state.platformH));

/* ---------------------------------------------------------------
   UPLOAD — drag-and-drop + click  (Features 1 & 4)
   --------------------------------------------------------------- */
function setupDZ(zoneId, inputId, onFile){
  const zone  = document.getElementById(zoneId);
  const input = document.getElementById(inputId);
  zone.addEventListener('dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', ()=> zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', e => { if (e.target.files[0]) onFile(e.target.files[0]); });
}

function readAsImage(file, cb){
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => cb(img, e.target.result);
    img.src    = e.target.result;
  };
  reader.readAsDataURL(file);
}

/* Media upload */
setupDZ('dzMedia','inputMedia', file => {
  if (file.type.startsWith('video/')){
    state.mediaIsVideo = true;
    showToast('📽 Video uploaded — preview shows first frame. MP4 overlay export is Phase 2.');
    // Extract first frame for live preview
    const url = URL.createObjectURL(file);
    const vid = document.createElement('video');
    vid.muted = true; vid.src = url;
    vid.addEventListener('loadeddata', () => { vid.currentTime = 0.1; });
    vid.addEventListener('seeked', () => {
      const tmp = document.createElement('canvas');
      tmp.width = vid.videoWidth; tmp.height = vid.videoHeight;
      tmp.getContext('2d').drawImage(vid, 0, 0);
      const img = new Image();
      img.onload = () => { state.mediaImg = img; render(); };
      img.src = tmp.toDataURL();
      setMediaThumb(file.name, tmp.toDataURL(), `${vid.videoWidth}×${vid.videoHeight}`);
    });
    return;
  }
  state.mediaIsVideo = false;
  readAsImage(file, (img, dataUrl) => {
    state.mediaImg = img;
    render();
    setMediaThumb(file.name, dataUrl, `${img.naturalWidth}×${img.naturalHeight}`);
  });
});

function setMediaThumb(name, src, dims){
  document.getElementById('mediaThumbRow').style.display = 'flex';
  document.getElementById('mediaThumb').src  = src;
  document.getElementById('mediaName').textContent  = name;
  document.getElementById('mediaDims').textContent  = dims;
  document.getElementById('dzMedia').classList.add('has-file');
}
document.getElementById('mediaRemove').addEventListener('click', () => {
  state.mediaImg = null; state.mediaIsVideo = false;
  document.getElementById('mediaThumbRow').style.display = 'none';
  document.getElementById('dzMedia').classList.remove('has-file');
  document.getElementById('inputMedia').value = '';
  render();
});

/* Logo upload */
setupDZ('dzLogo','inputLogo', file => {
  readAsImage(file, (img, dataUrl) => {
    state.logoImg = img;
    render();
    document.getElementById('logoThumbRow').style.display = 'flex';
    document.getElementById('logoThumb').src  = dataUrl;
    document.getElementById('logoName').textContent = file.name;
    document.getElementById('dzLogo').classList.add('has-file');
    try { localStorage.setItem('pf_logo', dataUrl); } catch(e){}
    document.getElementById('bkSavedPill').style.display = 'flex';
  });
});
document.getElementById('logoRemove').addEventListener('click', () => {
  state.logoImg = null;
  document.getElementById('logoThumbRow').style.display = 'none';
  document.getElementById('dzLogo').classList.remove('has-file');
  document.getElementById('inputLogo').value = '';
  try { localStorage.removeItem('pf_logo'); } catch(e){}
  render();
});

/* ---------------------------------------------------------------
   LOGO CONTROLS (position / size / margin)
   --------------------------------------------------------------- */
document.getElementById('logoPosGrid').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  document.querySelectorAll('#logoPosGrid .seg-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  state.logoPos = b.dataset.pos;
  render();
});
document.getElementById('logoSizeGrid').addEventListener('click', e => {
  const b = e.target.closest('.seg-btn'); if (!b) return;
  document.querySelectorAll('#logoSizeGrid .seg-btn').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  state.logoSize = b.dataset.size;
  render();
});
document.getElementById('logoMargin').addEventListener('input', e => {
  state.logoMargin = parseInt(e.target.value);
  document.getElementById('logoMarginVal').textContent = e.target.value;
  render();
});

/* ---------------------------------------------------------------
   TEXT FIELDS — live preview (Feature 2)
   --------------------------------------------------------------- */
const ql = id => document.getElementById(id);

ql('inputHeadline').addEventListener('input', e => {
  state.headline = e.target.value;
  ql('headlineCount').textContent = e.target.value.length;
  render();
});
ql('inputSubheadline').addEventListener('input', e => { state.subheadline = e.target.value; render(); });
ql('inputPrice').addEventListener('input',       e => { state.price = e.target.value;       render(); });
ql('inputCTA').addEventListener('change',        e => { state.cta   = e.target.value;       render(); });
ql('inputContact').addEventListener('input',     e => { state.contact = e.target.value;     render(); });

/* Char count init */
ql('headlineCount').textContent = ql('inputHeadline').value.length;

/* ---------------------------------------------------------------
   BADGES (Feature 10)
   --------------------------------------------------------------- */
document.getElementById('badgeChips').addEventListener('click', e => {
  const b = e.target.closest('.chip-btn[data-badge]'); if (!b) return;
  document.querySelectorAll('#badgeChips .chip-btn').forEach(x => x.classList.remove('selected'));
  b.classList.add('selected');
  state.badge = b.dataset.badge;
  render();
});

/* ---------------------------------------------------------------
   THEMES (Feature 8)
   --------------------------------------------------------------- */
document.getElementById('themeChips').addEventListener('click', e => {
  const b = e.target.closest('.theme-chip'); if (!b) return;
  document.querySelectorAll('.theme-chip').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  state.theme = b.dataset.theme;
  render();
});

/* ---------------------------------------------------------------
   TABS (right rail)
   --------------------------------------------------------------- */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    ql('tab-' + btn.dataset.tab).classList.add('active');
  });
});

/* Layer visibility toggles */
document.querySelectorAll('.lv-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const key = btn.dataset.layer;
    state.layerVis[key] = !state.layerVis[key];
    btn.textContent = state.layerVis[key] ? '👁' : '🚫';
    render();
  });
});

/* ---------------------------------------------------------------
   BRAND KIT (Feature 9) — persist logo + color + meta
   --------------------------------------------------------------- */
document.getElementById('brandSwatches').addEventListener('click', e => {
  const s = e.target.closest('.swatch'); if (!s) return;
  document.querySelectorAll('.swatch').forEach(x => x.classList.remove('active'));
  s.classList.add('active');
  state.brandColor = s.dataset.color;
});

document.getElementById('btnSaveBrandKit').addEventListener('click', () => {
  const kit = {
    name:    ql('bkName').value.trim(),
    color:   state.brandColor,
    website: ql('bkWebsite').value.trim(),
    phone:   ql('bkPhone').value.trim(),
    logoUrl: ql('logoThumbRow').style.display !== 'none' ? (localStorage.getItem('pf_logo')||null) : null
  };
  try { localStorage.setItem('pf_brandkit', JSON.stringify(kit)); } catch(e){}
  ql('bkSavedPill').style.display = 'flex';
  showToast('Brand kit saved ✓ — logo & colors will load next visit');
});

function loadBrandKit(){
  /* Restore persisted logo */
  try {
    const saved = localStorage.getItem('pf_logo');
    if (saved){
      const img = new Image();
      img.onload = () => {
        state.logoImg = img;
        ql('logoThumbRow').style.display = 'flex';
        ql('logoThumb').src = saved;
        ql('logoName').textContent = 'Saved logo';
        ql('dzLogo').classList.add('has-file');
        render();
      };
      img.src = saved;
    }
  } catch(e){}

  /* Restore brand kit meta */
  try {
    const raw = localStorage.getItem('pf_brandkit');
    if (!raw) return;
    const kit = JSON.parse(raw);
    if (kit.name)    ql('bkName').value    = kit.name;
    if (kit.website) ql('bkWebsite').value = kit.website;
    if (kit.phone){
      ql('bkPhone').value = kit.phone;
      state.contact = kit.phone;
      ql('inputContact').value = kit.phone;
    }
    if (kit.color){
      state.brandColor = kit.color;
      document.querySelectorAll('.swatch').forEach(s => {
        s.classList.toggle('active', s.dataset.color === kit.color);
      });
    }
    ql('bkSavedPill').style.display = 'flex';
  } catch(e){}
}

/* ---------------------------------------------------------------
   TEMPLATE LIBRARY (Feature 7)
   --------------------------------------------------------------- */
function applyTemplate(tpl){
  state.headline    = tpl.headline;
  state.subheadline = tpl.sub;
  state.price       = tpl.price;
  state.cta         = tpl.cta;
  state.badge       = tpl.badge;
  state.theme       = tpl.theme;

  ql('inputHeadline').value    = tpl.headline;
  ql('inputSubheadline').value = tpl.sub;
  ql('inputPrice').value       = tpl.price;
  ql('inputCTA').value         = tpl.cta;
  ql('headlineCount').textContent = tpl.headline.length;

  document.querySelectorAll('#badgeChips .chip-btn').forEach(b => {
    b.classList.toggle('selected', b.dataset.badge === tpl.badge);
  });
  document.querySelectorAll('.theme-chip').forEach(b => {
    b.classList.toggle('active', b.dataset.theme === tpl.theme);
  });
  render();
  closeModal('modalTemplates');
  showToast(`Template "${tpl.name}" applied ✓`);
}

function buildTemplateModal(){
  const container = ql('tmplCategories');
  if (!container) return;
  container.innerHTML = '';
  const cats = [
    { key:'restaurant', label:'🍽 Restaurant'  },
    { key:'cafe',       label:'☕ Cafe'         },
    { key:'retail',     label:'🛍 Retail'       },
    { key:'clothing',   label:'👗 Clothing'     },
    { key:'salon',      label:'💅 Salon'        },
    { key:'service',    label:'🔧 Service'      },
    { key:'festival',   label:'🎉 Festival'     }
  ];
  cats.forEach(cat => {
    const group = document.createElement('div');
    group.innerHTML = `<div class="tmpl-cat-label">${cat.label}</div><div class="tmpl-grid"></div>`;
    const grid = group.querySelector('.tmpl-grid');
    (TEMPLATES[cat.key] || []).forEach(tpl => {
      const card = document.createElement('button');
      card.className = 'tmpl-card';
      card.innerHTML = `<strong>${tpl.name}</strong><span>${tpl.headline}</span>`;
      card.addEventListener('click', () => applyTemplate(tpl));
      grid.appendChild(card);
    });
    container.appendChild(group);
  });
}

/* ---------------------------------------------------------------
   EXPORT (Feature 15) — real PNG / JPG at 1x / 2x / 3x
   --------------------------------------------------------------- */
let exportFormat = 'png';

document.querySelectorAll('.format-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.disabled){ showToast('MP4 export is a Phase 2 feature'); return; }
    document.querySelectorAll('.format-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    exportFormat = btn.dataset.fmt;
  });
});

function doExport(){
  const mult = parseInt(document.querySelector('input[name="q"]:checked')?.value || '1');
  const outW  = state.platformW * mult;
  const outH  = state.platformH * mult;

  const exportCanvas = document.createElement('canvas');
  exportCanvas.width  = outW;
  exportCanvas.height = outH;

  // renderCore handles all drawing — just pass the export context & size.
  renderCore(exportCanvas.getContext('2d'), outW, outH);

  const mime  = exportFormat === 'jpg' ? 'image/jpeg' : 'image/png';
  const ext   = exportFormat;
  const fname = `postforge-${state.platformW}x${state.platformH}-${Date.now()}.${ext}`;
  const a     = document.createElement('a');
  a.href     = exportCanvas.toDataURL(mime, 0.95);
  a.download  = fname;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast(`Downloaded ${outW}×${outH} ${ext.toUpperCase()} ✓`);
}

document.getElementById('btnExport').addEventListener('click',  doExport);
document.getElementById('btnExport2').addEventListener('click', doExport);

/* ---------------------------------------------------------------
   MODAL SYSTEM (Templates, Brand Kit shortcut from topbar)
   --------------------------------------------------------------- */
function openModal(id){
  const m = ql(id);
  if (!m) return;
  m.classList.add('open');
  if (id === 'modalTemplates') buildTemplateModal();
}
function closeModal(id){
  const m = ql(id);
  if (m) m.classList.remove('open');
}
document.querySelectorAll('.modal-close, .modal-backdrop').forEach(el => {
  el.addEventListener('click', e => {
    const modal = e.target.closest('.modal-wrap');
    if (modal || e.target.classList.contains('modal-backdrop'))
      document.querySelectorAll('.modal-wrap').forEach(m => m.classList.remove('open'));
  });
});
ql('btnTemplates').addEventListener('click', () => openModal('modalTemplates'));
ql('btnBrandKit').addEventListener('click',  () => {
  document.querySelector('.tab-btn[data-tab="brand"]').click();
});

/* ---------------------------------------------------------------
   TOAST
   --------------------------------------------------------------- */
let _toastTimer;
function showToast(msg, duration = 2800){
  const t = ql('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove('show'), duration);
}

/* ---------------------------------------------------------------
   INIT
   --------------------------------------------------------------- */
loadBrandKit();
setStageSize(1080, 1080);
render();
