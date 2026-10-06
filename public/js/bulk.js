/* Bulk studio — up to 50 product photos (or product links) → branded posts in every size → one ZIP.
   Everything is drawn in the browser; each size of each product counts as one download. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = PF.esc;
  const MAX = 50;
  const SIZES = {
    ig_post: ['Instagram Post', 1080, 1080], ig_portrait: ['Instagram Portrait', 1080, 1350], ig_story: ['Instagram Story / Reels', 1080, 1920],
    fb_post: ['Facebook Post', 1080, 1080], fb_story: ['Facebook Story', 1080, 1920], fb_cover: ['Facebook Cover', 851, 315],
    li_post: ['LinkedIn Post', 1080, 1350], li_banner: ['LinkedIn Banner', 1584, 396], pin: ['Pinterest Pin', 1000, 1500],
    x_post: ['X (Twitter) Post', 1080, 1080], tiktok: ['TikTok', 1080, 1920], yt_thumb: ['YouTube Thumbnail', 1280, 720],
    yt_shorts: ['YouTube Shorts', 1080, 1920], wa_status: ['WhatsApp Status', 1080, 1920],
  };
  const BG_NOTE = { blur: 'Your photo, softly blurred behind the product.', brand: 'Your brand colour behind a framed product photo.',
    light: 'Clean light studio background — great for catalogues.', cutout: 'Removes the photo background and places the product on your brand colour (works best on plain backgrounds).' };
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  let ME = null, KITS = [], kit = null, logoImg = null, items = [], uid = 0, current = 0;
  const opts = { bg: 'blur', sizes: new Set((store.get('pf-bulk-sizes') || 'ig_post,ig_story,fb_post').split(',').filter(k => SIZES[k])) };

  /* ---------------- start ---------------- */
  async function init() {
    try { ME = await PF.loadMe(); } catch { return; }
    if (!ME.plan.batch_export || ME.user.role === 'viewer') { $('lock').classList.remove('hidden'); $('main').classList.add('hidden'); return; }
    showUsage(ME.usage);
    try { KITS = await PF.api('/brand-kits'); } catch { KITS = []; }
    const saved = store.get('pf-bulk-kit');
    $('kit').innerHTML = (KITS.length ? '' : '<option value="">No brand kit yet — default colours</option>') + KITS.map(k => `<option value="${k.id}">${esc(k.name)}</option>`).join('');
    if (saved && KITS.some(k => String(k.id) === saved)) $('kit').value = saved;
    await pickKit();
    $('sizes').innerHTML = Object.entries(SIZES).map(([k, [l, w, h]]) => `<button type="button" data-k="${k}" class="${opts.sizes.has(k) ? 'on' : ''}">${esc(l)}<small>${w}×${h}</small></button>`).join('');
    fillPreviewSizes();
    update();
  }
  function showUsage(u) {
    if (!u) return;
    $('usage').textContent = u.remaining > 99999 ? 'Unlimited downloads' : `⬇ ${u.remaining} downloads left ${u.label || ''}`;
  }

  async function pickKit() {
    kit = KITS.find(k => String(k.id) === $('kit').value) || { name: ME.workspace.name, color: '#ff6b4a', colors: [], socials: {} };
    store.set('pf-bulk-kit', $('kit').value);
    logoImg = null;
    if (kit.logo_url) logoImg = await loadImage(kit.logo_url).catch(() => null);
    await loadFonts();
    preview();
  }
  $('kit').addEventListener('change', pickKit);

  /* ---------------- fonts ---------------- */
  const headFont = () => kit.font_heading || 'Space Grotesk';
  const bodyFont = () => kit.font_body || 'Inter';
  const stack = f => `"${f}", "Mukta", "Noto Sans Devanagari", "Noto Sans Bengali", "Noto Sans Thai", "Noto Sans Arabic", "Noto Sans", sans-serif`;
  async function loadFonts() {
    if (!document.fonts) return;
    const sample = items.map(i => i.name + i.price).join(' ') + ($('offer').value || '') + 'Aa';
    const fams = [headFont(), bodyFont(), 'Mukta', 'Space Grotesk', 'Inter'];
    try { await Promise.all(fams.flatMap(f => [document.fonts.load(`800 40px "${f}"`, sample), document.fonts.load(`500 20px "${f}"`, sample)])); } catch { /* fallback fonts */ }
  }

  /* ---------------- adding products ---------------- */
  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  }
  function shrink(img, max = 1600) {
    const s = Math.min(1, max / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
    const c = document.createElement('canvas');
    c.width = Math.round((img.naturalWidth || img.width) * s); c.height = Math.round((img.naturalHeight || img.height) * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  }
  const niceName = f => String(f || 'Product').replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^\w/, c => c.toUpperCase()).slice(0, 60);
  async function addImage(src, name, price = '') {
    if (items.length >= MAX) return false;
    const img = await loadImage(src);
    const photo = shrink(img);
    const t = shrink(photo, 120);
    items.push({ id: ++uid, name, price, photo, cut: null, thumb: t.toDataURL('image/jpeg', 0.8) });
    return true;
  }
  async function addFiles(list) {
    const files = [...list].filter(f => /^image\/(jpeg|png|webp)$/.test(f.type));
    let skipped = 0;
    for (const f of files) {
      if (items.length >= MAX) { skipped++; continue; }
      const url = URL.createObjectURL(f);
      try { await addImage(url, niceName(f.name)); } catch { skipped++; } finally { URL.revokeObjectURL(url); }
    }
    if (skipped) PF.toast(`${skipped} file${skipped > 1 ? 's were' : ' was'} skipped (max ${MAX} photos, JPG/PNG/WEBP only).`, { error: true, ms: 5000 });
    afterAdd();
  }
  async function afterAdd() { await loadFonts(); renderRows(); update(); if (opts.bg === 'cutout') await cutAll(); preview(); }
  $('files').addEventListener('change', e => { addFiles(e.target.files); e.target.value = ''; });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', e => { e.preventDefault(); addFiles(e.dataTransfer.files); });

  $('linksGo').addEventListener('click', async () => {
    const urls = $('links').value.split(/\s+/).map(s => s.trim()).filter(s => /^https?:\/\//i.test(s)).slice(0, 20);
    if (!urls.length) { PF.toast('Paste one product link per line (starting with https://).', { error: true }); return; }
    const b = $('linksGo'); b.disabled = true;
    let ok = 0, noPhoto = 0, failed = 0;
    for (const [i, url] of urls.entries()) {
      if (items.length >= MAX) break;
      $('linksNote').textContent = `Reading ${i + 1} of ${urls.length}…`;
      try {
        const r = await PF.api('/ai/from-url', { method: 'POST', body: { url } });
        if (!r.photo) { noPhoto++; continue; }
        await addImage(r.photo, (r.product || 'Product').slice(0, 60), (r.price || '').slice(0, 20));
        ok++;
      } catch { failed++; }
    }
    $('linksNote').textContent = `Added ${ok} product${ok === 1 ? '' : 's'}${noPhoto ? ` · ${noPhoto} without a usable photo` : ''}${failed ? ` · ${failed} couldn’t be read` : ''}.`;
    if (ok) $('links').value = '';
    b.disabled = false;
    afterAdd();
  });

  /* ---------------- product list ---------------- */
  function renderRows() {
    $('count').textContent = `(${items.length} / ${MAX})`;
    $('clearAll').classList.toggle('hidden', !items.length);
    $('rows').innerHTML = items.length ? items.map((it, i) => `<div class="b-row ${i === current ? 'on' : ''}" data-id="${it.id}">
      <img src="${it.thumb}" alt="" data-pick>
      <input class="input" data-f="name" value="${esc(it.name)}" maxlength="60" aria-label="Product name">
      <input class="input b-price" data-f="price" value="${esc(it.price)}" maxlength="20" placeholder="Price" aria-label="Price">
      <button class="btn btn-ghost btn-sm" type="button" data-del title="Remove">✕</button></div>`).join('')
      : '<p class="muted small">No products yet.</p>';
  }
  let pvTimer;
  $('rows').addEventListener('input', e => {
    const row = e.target.closest('.b-row'); if (!row) return;
    const it = items.find(x => x.id === +row.dataset.id);
    it[e.target.dataset.f] = e.target.value;
    current = items.indexOf(it);
    clearTimeout(pvTimer); pvTimer = setTimeout(preview, 250);
  });
  $('rows').addEventListener('click', e => {
    const row = e.target.closest('.b-row'); if (!row) return;
    const i = items.findIndex(x => x.id === +row.dataset.id);
    if (e.target.closest('[data-del]')) { items.splice(i, 1); current = Math.min(current, Math.max(0, items.length - 1)); renderRows(); update(); preview(); return; }
    if (e.target.closest('[data-pick]') || e.target === row) { current = i; renderRows(); preview(); }
  });
  $('clearAll').addEventListener('click', () => { items = []; current = 0; renderRows(); update(); preview(); });

  /* ---------------- options ---------------- */
  $('bg').addEventListener('click', async e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    opts.bg = b.dataset.v;
    $('bg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    $('bgNote').textContent = BG_NOTE[opts.bg];
    if (opts.bg === 'cutout') await cutAll();
    preview();
  });
  $('sizes').addEventListener('click', e => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    if (opts.sizes.has(b.dataset.k)) { if (opts.sizes.size > 1) opts.sizes.delete(b.dataset.k); } else opts.sizes.add(b.dataset.k);
    b.classList.toggle('on', opts.sizes.has(b.dataset.k));
    store.set('pf-bulk-sizes', [...opts.sizes].join(','));
    fillPreviewSizes(); update();
  });
  function fillPreviewSizes() {
    const cur = $('pvSize').value;
    $('pvSize').innerHTML = [...opts.sizes].map(k => `<option value="${k}">${esc(SIZES[k][0])}</option>`).join('');
    if (opts.sizes.has(cur)) $('pvSize').value = cur;
    preview();
  }
  $('pvSize').addEventListener('change', preview);
  ['offer', 'showPrice', 'showContact', 'showLogo'].forEach(id => $(id).addEventListener('input', () => { clearTimeout(pvTimer); pvTimer = setTimeout(preview, 200); }));
  $('captions').addEventListener('change', () => { $('capOpts').classList.toggle('hidden', !$('captions').checked); update(); });

  function update() {
    const n = items.length * opts.sizes.size;
    const left = ME && ME.usage ? ME.usage.remaining : 0;
    $('go').disabled = !items.length;
    $('goNote').textContent = !items.length ? 'Add some product photos to start.'
      : `${items.length} product${items.length === 1 ? '' : 's'} × ${opts.sizes.size} size${opts.sizes.size === 1 ? '' : 's'} = ${n} images (uses ${n} downloads${left < 99999 ? `, you have ${left}` : ''})${$('captions').checked ? ' + captions' : ''}.`;
  }

  /* ---------------- background removal (in the browser, off the main thread) ---------------- */
  let worker = null, wid = 0;
  function segment(canvas) {
    if (!worker) worker = new Worker('/js/bgremove.worker.js');
    const s = Math.min(1, 900 / Math.max(canvas.width, canvas.height));
    const c = document.createElement('canvas'); c.width = Math.round(canvas.width * s); c.height = Math.round(canvas.height * s);
    const cx = c.getContext('2d'); cx.drawImage(canvas, 0, 0, c.width, c.height);
    const data = cx.getImageData(0, 0, c.width, c.height);
    const id = ++wid;
    return new Promise((resolve, reject) => {
      const on = e => {
        const m = e.data; if (m.id !== id) return;
        if (m.type === 'ready') worker.postMessage({ type: 'segment', id, opts: {} });
        else if (m.type === 'segment') {
          worker.removeEventListener('message', on);
          // apply the mask and trim empty space around the product (so it sits and casts its shadow correctly)
          let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
          for (let i = 0; i < m.alpha.length; i++) {
            data.data[i * 4 + 3] = m.alpha[i];
            if (m.alpha[i] > 24) { const x = i % c.width, y = (i / c.width) | 0; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
          }
          cx.putImageData(data, 0, 0);
          if (x1 < 0 || (x1 - x0) * (y1 - y0) < c.width * c.height * 0.02) return reject(new Error('nothing found'));
          const out = document.createElement('canvas'); out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
          out.getContext('2d').drawImage(c, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
          resolve(out);
        } else if (m.type === 'error') { worker.removeEventListener('message', on); reject(new Error(m.message)); }
      };
      worker.addEventListener('message', on);
      const copy = new Uint8ClampedArray(data.data);
      worker.postMessage({ type: 'init', id, buffer: copy.buffer, width: c.width, height: c.height }, [copy.buffer]);
    });
  }
  async function cutAll() {
    const todo = items.filter(i => !i.cut);
    if (!todo.length) return;
    busy(true, 'Removing backgrounds…');
    for (const [n, it] of todo.entries()) {
      progress(n / todo.length, `${n + 1} of ${todo.length}`);
      try { it.cut = await segment(it.photo); } catch { it.cut = null; }
      if (n === 0) preview();
    }
    busy(false);
  }

  /* ---------------- drawing ---------------- */
  const hexRgb = h => { const m = /^#?([0-9a-f]{6})$/i.exec(h || ''); const n = m ? parseInt(m[1], 16) : 0xff6b4a; return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const lum = h => { const [r, g, b] = hexRgb(h).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const mix = (h, w, t) => { const a = hexRgb(h), b = hexRgb(w); return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`; };
  function rr(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }
  function cover(ctx, img, x, y, w, h) {
    const s = Math.max(w / img.width, h / img.height), dw = img.width * s, dh = img.height * s;
    ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  }
  function contain(img, w, h) { const s = Math.min(w / img.width, h / img.height); return [img.width * s, img.height * s]; }
  function wrap(ctx, text, maxW, maxLines, weight, fam, size, min) {
    for (let s = size; s >= min; s -= 2) {
      ctx.font = `${weight} ${s}px ${stack(fam)}`;
      const words = String(text).split(/\s+/), lines = [];
      let line = '';
      for (const w of words) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width <= maxW || !line) line = t; else { lines.push(line); line = w; } }
      if (line) lines.push(line);
      if (lines.length <= maxLines && lines.every(l => ctx.measureText(l).width <= maxW)) return { lines, size: s };
    }
    ctx.font = `${weight} ${min}px ${stack(fam)}`;
    const lines = []; let line = '';
    for (const w of String(text).split(/\s+/)) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width <= maxW || !line) line = t; else { lines.push(line); line = w; } }
    if (line) lines.push(line);
    const out = lines.slice(0, maxLines);
    if (lines.length > maxLines) out[maxLines - 1] = out[maxLines - 1].replace(/\s*\S*$/, '') + '…';
    return { lines: out, size: min };
  }
  function contactLine() {
    const ig = kit.socials && kit.socials.instagram ? '@' + String(kit.socials.instagram).replace(/^@/, '').replace(/^https?:\/\/(www\.)?instagram\.com\//, '').replace(/\/$/, '') : '';
    return [kit.phone && '📞 ' + kit.phone, kit.website || ig].filter(Boolean).join('  ·  ');
  }

  function draw(canvas, it, key) {
    const [, W, H] = SIZES[key];
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const c1 = kit.color || '#ff6b4a', c2 = (kit.colors && kit.colors[0]) || mix(c1, '#000000', 0.35);
    const u = Math.min(W, H) / 1080;          // scale unit
    const wide = W / H >= 1.6;
    const useCut = opts.bg === 'cutout' && it.cut;
    const photo = useCut ? it.cut : it.photo;

    // background
    if (opts.bg === 'blur') {
      // smooth blur: real blur filter where the browser has it, otherwise a gentle multi-step downscale
      const t = document.createElement('canvas'); t.width = Math.round(W / 4); t.height = Math.round(H / 4);
      const tx = t.getContext('2d');
      if ('filter' in tx) { tx.filter = 'blur(10px)'; cover(tx, it.photo, -20, -20, t.width + 40, t.height + 40); }
      else {
        const s1 = document.createElement('canvas'); s1.width = Math.max(8, Math.round(W / 16)); s1.height = Math.max(8, Math.round(H / 16));
        cover(s1.getContext('2d'), it.photo, 0, 0, s1.width, s1.height); tx.imageSmoothingQuality = 'high'; tx.drawImage(s1, 0, 0, t.width, t.height);
      }
      ctx.imageSmoothingQuality = 'high'; ctx.drawImage(t, 0, 0, W, H);
      ctx.fillStyle = 'rgba(15,15,25,.28)'; ctx.fillRect(0, 0, W, H);
    } else if (opts.bg === 'light') {
      const g = ctx.createRadialGradient(W / 2, H * 0.4, 10, W / 2, H * 0.45, Math.max(W, H) * 0.8);
      g.addColorStop(0, '#ffffff'); g.addColorStop(1, '#ecebe7'); ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    } else if (useCut) {
      const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, mix(c1, '#ffffff', 0.78)); g.addColorStop(1, mix(c1, '#ffffff', 0.55));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    } else {
      const g = ctx.createLinearGradient(0, 0, W, H); g.addColorStop(0, c1); g.addColorStop(1, mix(c1, '#000000', 0.3));
      ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    }

    // areas
    const pad = Math.round(48 * u);
    const logoH = $('showLogo').checked && logoImg ? Math.round(Math.min(H * 0.09, 96 * u)) : 0;
    let img, txt;
    if (wide) {
      img = { x: pad, y: pad, w: W * 0.5 - pad * 1.5, h: H - pad * 2 };
      txt = { x: W * 0.5 + pad * 0.5, y: pad + (logoH ? logoH + pad * 0.4 : 0), w: W * 0.5 - pad * 1.5, h: H - pad * 2 - (logoH ? logoH + pad * 0.4 : 0) };
    } else {
      const panelH = Math.round(H * (H / W > 1.5 ? 0.24 : H / W > 1.15 ? 0.27 : 0.3));
      const top = pad + (logoH ? logoH + pad * 0.5 : 0);
      img = { x: pad, y: top, w: W - pad * 2, h: H - panelH - top - pad * 1.4 };
      txt = { x: pad, y: H - panelH - pad * 0.6, w: W - pad * 2, h: panelH };
    }

    // product
    if (useCut) {
      const [dw, dh] = contain(photo, img.w * 0.92, img.h * 0.95);
      const x = img.x + (img.w - dw) / 2, y = img.y + (img.h - dh) / 2;
      ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.16)'; ctx.filter = `blur(${Math.round(14 * u)}px)`;
      ctx.beginPath(); ctx.ellipse(x + dw / 2, y + dh - dh * 0.02, dw * 0.42, Math.max(8, dh * 0.05), 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
      ctx.drawImage(photo, x, y, dw, dh);
    } else {
      const [dw, dh] = contain(photo, img.w, img.h);
      const x = img.x + (img.w - dw) / 2, y = img.y + (img.h - dh) / 2, r = Math.round(26 * u);
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.28)'; ctx.shadowBlur = 40 * u; ctx.shadowOffsetY = 14 * u;
      rr(ctx, x, y, dw, dh, r); ctx.fillStyle = '#fff'; ctx.fill(); ctx.restore();
      ctx.save(); rr(ctx, x, y, dw, dh, r); ctx.clip(); ctx.drawImage(photo, x, y, dw, dh); ctx.restore();
    }

    // logo
    if (logoH) {
      const [lw, lh] = contain(logoImg, W * 0.32, logoH);
      ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.18)'; ctx.shadowBlur = 10 * u;
      ctx.drawImage(logoImg, wide ? txt.x : pad, pad, lw, lh); ctx.restore();
    }

    // text panel
    const darkBg = opts.bg === 'blur' || (opts.bg === 'brand' && !useCut) || (opts.bg === 'cutout' && !it.cut);
    const panelFill = wide ? null : darkBg ? 'rgba(10,10,20,.42)' : c1;
    const textCol = (panelFill && panelFill === c1) ? (lum(c1) > 0.55 ? '#1a1a2e' : '#ffffff') : (wide && !darkBg ? '#1a1a2e' : '#ffffff');
    if (panelFill) { ctx.save(); rr(ctx, txt.x, txt.y, txt.w, txt.h, Math.round(28 * u)); ctx.fillStyle = panelFill; ctx.fill(); ctx.restore(); }
    const ip = wide ? 0 : Math.round(34 * u);
    const tx = txt.x + ip, tw = txt.w - ip * 2;
    const priceOn = $('showPrice').checked && it.price.trim();
    const offer = $('offer').value.trim();
    const contact = $('showContact').checked ? contactLine() : '';
    const priceW = priceOn && !wide ? Math.min(tw * 0.34, 300 * u) : 0;
    const head = wrap(ctx, it.name || 'Product', tw - (priceW ? priceW + 20 * u : 0), wide ? 3 : 2, 800, headFont(), Math.round((wide ? 76 : 70) * u), Math.round(30 * u));
    const lh = head.size * 1.12;
    const block = head.lines.length * lh + (offer ? 46 * u : 0) + (contact ? 38 * u : 0) + (wide && priceOn ? 86 * u : 0);
    let y = txt.y + (txt.h - block) / 2 + head.size * 0.85;
    ctx.fillStyle = textCol; ctx.textBaseline = 'alphabetic';
    ctx.font = `800 ${head.size}px ${stack(headFont())}`;
    for (const l of head.lines) { ctx.fillText(l, tx, y); y += lh; }
    y -= lh - head.size * 0.25;
    if (offer) {
      ctx.font = `600 ${Math.round(32 * u)}px ${stack(bodyFont())}`;
      ctx.fillStyle = textCol; ctx.globalAlpha = 0.92; ctx.fillText(offer.slice(0, 40), tx, y + 40 * u); ctx.globalAlpha = 1; y += 46 * u;
    }
    if (wide && priceOn) {
      drawPrice(ctx, it.price, tx, y + 22 * u, null, 58 * u, c1, c2, u); y += 86 * u;
    }
    if (contact) {
      ctx.font = `500 ${Math.round(26 * u)}px ${stack(bodyFont())}`;
      ctx.fillStyle = textCol; ctx.globalAlpha = 0.85;
      let t = contact; while (ctx.measureText(t).width > tw && t.length > 4) t = t.slice(0, -2);
      ctx.fillText(t, tx, y + 40 * u); ctx.globalAlpha = 1;
    }
    if (priceOn && !wide) drawPrice(ctx, it.price, txt.x + txt.w - ip - priceW, txt.y + txt.h / 2 - 46 * u, priceW, 92 * u, c1, c2, u, panelFill === c1);
  }
  function drawPrice(ctx, price, x, y, w, h, c1, c2, u, onBrand) {
    const p = String(price).slice(0, 20);
    let size = Math.round(h * 0.5);
    ctx.font = `800 ${size}px ${stack(headFont())}`;
    const maxW = w ? w - 30 * u : 520 * u;
    while (ctx.measureText(p).width > maxW && size > 18) { size -= 2; ctx.font = `800 ${size}px ${stack(headFont())}`; }
    const pw = w || ctx.measureText(p).width + 50 * u;
    ctx.save(); rr(ctx, x, y, pw, h, h / 2);
    ctx.fillStyle = onBrand ? '#ffffff' : (lum(c1) > 0.6 ? '#1a1a2e' : c1); ctx.fill(); ctx.restore();
    ctx.fillStyle = onBrand ? '#1a1a2e' : '#ffffff';
    ctx.textAlign = 'center'; ctx.fillText(p, x + pw / 2, y + h / 2 + size * 0.36); ctx.textAlign = 'left';
  }

  function preview() {
    const box = $('preview');
    if (!items.length || !kit) { box.innerHTML = '<div class="muted small center" style="padding:60px 10px">Your first product will appear here.</div>'; return; }
    const key = $('pvSize').value || [...opts.sizes][0];
    const c = document.createElement('canvas');
    draw(c, items[Math.min(current, items.length - 1)], key);
    box.innerHTML = ''; box.appendChild(c);
  }

  /* ---------------- make the ZIP ---------------- */
  function busy(on, title) {
    $('busy').classList.toggle('hidden', !on);
    if (title) $('busyTitle').textContent = title;
    $('go').disabled = on || !items.length;
    if (!on) progress(0, '');
  }
  function progress(f, note) { $('bar').style.width = Math.round(f * 100) + '%'; $('busyNote').textContent = note || ''; }
  const slug = s => String(s || 'product').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 40) || 'product';
  const toBlob = c => new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));

  $('go').addEventListener('click', async () => {
    const sizes = [...opts.sizes];
    const total = items.length * sizes.length;
    try {
      const u = await PF.api('/usage'); ME.usage = u; showUsage(u);
      if (u.remaining < total) {
        PF.toast(`This needs ${total} downloads but you have ${u.remaining} left ${u.label || ''}. Pick fewer sizes or products${ME.plan.code !== 'agency' ? ', or upgrade' : ''}.`, { error: true, ms: 7000 });
        return;
      }
    } catch (e) { PF.toast(e.message, { error: true }); return; }
    if (opts.bg === 'cutout') await cutAll();
    busy(true, 'Making your posts…');
    const zip = new JSZip();
    const all = items.flatMap(it => sizes.map(k => ({ it, k })));
    try {
      // 1. record the downloads (20 at a time)
      for (let i = 0; i < all.length; i += 20) {
        progress(i / all.length * 0.1, 'Checking your allowance…');
        const r = await PF.api('/exports', { method: 'POST', body: { items: all.slice(i, i + 20).map(x => ({ platform: x.k, kind: 'image' })), quality: 1 } });
        if (r.usage) { ME.usage = r.usage; showUsage(r.usage); }
      }
      // 2. draw every image
      const canvas = document.createElement('canvas');
      for (const [n, { it, k }] of all.entries()) {
        progress(0.1 + (n / all.length) * 0.65, `Image ${n + 1} of ${all.length}`);
        draw(canvas, it, k);
        const folder = `${String(items.indexOf(it) + 1).padStart(2, '0')}-${slug(it.name)}`;
        zip.folder(folder).file(`${folder}-${k}.jpg`, await toBlob(canvas));
        if (n % 4 === 3) await new Promise(r => setTimeout(r, 0));
      }
      // 3. captions (optional)
      let capNote = '';
      if ($('captions').checked) {
        for (const [n, it] of items.entries()) {
          progress(0.75 + (n / items.length) * 0.2, `Writing captions ${n + 1} of ${items.length}`);
          try {
            const r = await PF.api('/ai/captions', { method: 'POST', body: { product: it.name, price: $('showPrice').checked ? it.price : '', offer: $('offer').value,
              brand: kit.name, contact: contactLine().replace(/📞\s*/, ''), language: $('capLang').value, tone: $('capTone').value,
              platforms: ['instagram', 'facebook', 'tiktok', 'linkedin', 'whatsapp'] } });
            const txt = Object.entries(r.captions).map(([p, c]) => `=== ${p.toUpperCase()} ===\n${c.text}${c.hashtags.length ? '\n\n' + c.hashtags.join(' ') : ''}\n`).join('\n');
            zip.folder(`${String(n + 1).padStart(2, '0')}-${slug(it.name)}`).file('captions.txt', txt);
          } catch (e) { capNote = e.message; break; }
        }
      }
      progress(0.97, 'Packing the ZIP…');
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `postforge-bulk-${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      PF.toast(`Done ✓ ${all.length} images downloaded${capNote ? ' — captions stopped: ' + capNote : ''}`, { ms: 6000 });
    } catch (e) {
      PF.toast(e.message, { error: true, ms: 7000 });
    } finally { busy(false); update(); }
  });

  init();
})();
