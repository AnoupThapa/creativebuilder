/* Website widget: resize a photo for social platforms, right in the visitor's browser. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const key = new URLSearchParams(location.search).get('key') || '';
  const POPULAR = ['ig_post', 'ig_portrait', 'ig_story', 'fb_post', 'tiktok', 'yt_thumb'];
  let SIZES = [], chosen = new Set(['ig_post', 'ig_story']), img = null, bg = 'blur';
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const msg = t => { $('msg').textContent = t; $('msg').classList.toggle('hidden', !t); tellHeight(); };
  const tellHeight = () => { try { parent.postMessage({ pfHeight: document.documentElement.scrollHeight + 4 }, '*'); } catch {} };
  new ResizeObserver(tellHeight).observe(document.body);

  fetch('/embed-api/config?key=' + encodeURIComponent(key)).then(r => r.json().then(j => ({ ok: r.ok, j }))).then(({ ok, j }) => {
    if (!ok) { msg(j.error || 'This tool is not available.'); $('drop').classList.add('hidden'); return; }
    document.documentElement.style.setProperty('--acc', j.color);
    $('wName').textContent = j.name;
    SIZES = j.sizes;
    $('sizes').innerHTML = SIZES.filter(s => POPULAR.includes(s.key)).map(s => `<button type="button" data-k="${s.key}" class="${chosen.has(s.key) ? 'on' : ''}" title="${s.width}×${s.height}">${esc(s.label)}</button>`).join('');
  }).catch(() => msg('This tool is not available right now.'));

  function cover(ctx, im, x, y, w, h) { const s = Math.max(w / im.width, h / im.height); ctx.drawImage(im, x + (w - im.width * s) / 2, y + (h - im.height * s) / 2, im.width * s, im.height * s); }
  function draw(c, s) {
    c.width = s.width; c.height = s.height;
    const ctx = c.getContext('2d'), W = s.width, H = s.height;
    if (bg === 'fill') { cover(ctx, img, 0, 0, W, H); return; }
    if (bg === 'white') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H); }
    else { ctx.save(); if ('filter' in ctx) ctx.filter = 'blur(36px)'; cover(ctx, img, -40, -40, W + 80, H + 80); ctx.restore(); ctx.fillStyle = 'rgba(0,0,0,.12)'; ctx.fillRect(0, 0, W, H); }
    const k = Math.min(W * 0.94 / img.width, H * 0.94 / img.height), w = img.width * k, h = img.height * k;
    ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
  }
  function preview() { if (!img) return; const first = SIZES.find(s => chosen.has(s.key)) || SIZES[0]; draw($('pv'), first); tellHeight(); }

  $('file').addEventListener('change', e => {
    const f = e.target.files[0]; if (!f) return;
    if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { msg('Please choose a JPG, PNG or WEBP photo.'); return; }
    const im = new Image();
    im.onload = () => { img = im; msg(''); $('drop').classList.add('hidden'); $('body').classList.remove('hidden'); preview(); };
    im.onerror = () => msg('That photo could not be opened.');
    im.src = URL.createObjectURL(f);
  });
  $('again').addEventListener('click', () => { img = null; $('file').value = ''; $('body').classList.add('hidden'); $('drop').classList.remove('hidden'); tellHeight(); });
  $('bg').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (!b) return; bg = b.dataset.v; $('bg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); preview(); });
  $('sizes').addEventListener('click', e => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    if (chosen.has(b.dataset.k)) { if (chosen.size > 1) chosen.delete(b.dataset.k); } else chosen.add(b.dataset.k);
    b.classList.toggle('on', chosen.has(b.dataset.k)); preview();
  });
  $('go').addEventListener('click', async () => {
    const list = SIZES.filter(s => chosen.has(s.key));
    $('go').disabled = true; msg('');
    try {
      const r = await fetch('/embed-api/authorise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, sizes: list.map(s => s.key) }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Please try again later.');
      const c = document.createElement('canvas');
      const blobs = [];
      for (const s of list) { draw(c, s); blobs.push({ name: `${s.key}_${s.width}x${s.height}.jpg`, blob: await new Promise(res => c.toBlob(res, 'image/jpeg', 0.92)) }); }
      let out = blobs[0].blob, name = blobs[0].name;
      if (blobs.length > 1) { const z = new JSZip(); blobs.forEach(b => z.file(b.name, b.blob)); out = await z.generateAsync({ type: 'blob' }); name = 'photo-sizes.zip'; }
      const a = document.createElement('a'); a.href = URL.createObjectURL(out); a.download = name; document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { msg(e.message); }
    $('go').disabled = false;
  });
})();
