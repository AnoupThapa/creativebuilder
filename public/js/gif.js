/* GIF maker page */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = PF.esc;
  let SIZES = {}, LIMITS = {};
  let files = [], kind = null, videoDur = 0;
  const chosen = new Set(['product_800', 'square_1080']);
  const seg = { speed: '1.5', fit: 'fit', bg: 'blur', fps: '12', quality: 'balanced' };
  let last = null;

  const left = u => !u ? '' : u.remaining > 99999 ? 'Unlimited downloads' : `⬇ ${u.remaining} download${u.remaining === 1 ? '' : 's'} left`;
  const kb = n => n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';

  async function init() {
    try {
      const me = await PF.loadMe();
      $('usage').textContent = left(me.usage);
    } catch { return; }
    const o = await PF.api('/gif/options');
    SIZES = o.sizes; LIMITS = o.limits;
    if (!o.available) { $('go').disabled = true; $('goNote').textContent = 'The GIF maker is not available on this server yet.'; }
    $('dur').max = LIMITS.maxSeconds;
    renderSizes();
  }

  function renderSizes() {
    $('sizes').innerHTML = Object.entries(SIZES).map(([k, s]) => {
      const r = s.w / s.h, bw = r >= 1 ? 26 : Math.round(26 * r), bh = r >= 1 ? Math.round(26 / r) : 26;
      return `<button type="button" class="g-size${chosen.has(k) ? ' on' : ''}" data-k="${k}">
        <span class="shape"><i style="width:${bw}px;height:${bh}px"></i></span>
        <span><b>${esc(s.label)}</b><small>${s.w}×${s.h} · ${esc(s.note)}</small></span></button>`;
    }).join('');
    updateCount();
  }
  $('sizes').addEventListener('click', e => {
    const b = e.target.closest('[data-k]'); if (!b) return;
    const k = b.dataset.k;
    if (chosen.has(k)) chosen.delete(k); else chosen.add(k);
    b.classList.toggle('on', chosen.has(k)); updateCount();
  });
  ['cw', 'ch'].forEach(id => $(id).addEventListener('input', updateCount));
  function custom() { const w = +$('cw').value, h = +$('ch').value; return w >= 64 && h >= 64 ? { w, h } : null; }
  function sizeTotal() { return chosen.size + (custom() ? 1 : 0); }
  function updateCount() {
    const n = sizeTotal();
    $('sizeCount').textContent = n ? `· ${n} selected` : '';
    $('go').textContent = n > 1 ? `🎞 Make ${n} GIFs` : '🎞 Make GIF';
    $('goNote').textContent = n ? `Uses ${n} download${n > 1 ? 's' : ''} from your plan.` : 'Pick at least one size.';
    $('go').disabled = !files.length || !n;
  }

  // segmented buttons
  Object.keys(seg).forEach(id => $(id).addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b || e.target.type === 'color') return;
    seg[id] = b.dataset.v;
    $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (id === 'fit') $('bgRow').classList.toggle('hidden', seg.fit === 'fill');
  }));
  $('bgColor').addEventListener('input', () => { seg.bg = 'custom'; $('bg').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === 'custom')); });

  // sliders
  const fmt = v => (+v).toFixed(1) + ' s';
  $('start').addEventListener('input', () => { $('startV').textContent = fmt($('start').value); clampDur(); seekPreview(); });
  $('dur').addEventListener('input', () => { clampDur(); });
  $('slide').addEventListener('input', () => { $('slideV').textContent = fmt($('slide').value); });
  function clampDur() {
    if (videoDur) { const left = Math.max(0.5, videoDur - +$('start').value); if (+$('dur').value > left) $('dur').value = Math.min(left, LIMITS.maxSeconds); }
    $('durV').textContent = fmt($('dur').value);
  }
  function seekPreview() { const v = $('srcMedia').querySelector('video'); if (v) { try { v.currentTime = +$('start').value; } catch {} } }

  // files
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', e => { e.preventDefault(); take([...e.dataTransfer.files]); });
  $('files').addEventListener('change', e => take([...e.target.files]));
  $('srcClear').addEventListener('click', () => { files = []; kind = null; $('files').value = ''; showSource(); });

  function take(list) {
    list = list.filter(f => /^(video\/(mp4|quicktime|webm)|image\/(gif|jpeg|png|webp))$/.test(f.type));
    if (!list.length) return PF.toast('Use MP4, MOV, WEBM or GIF videos, or JPG, PNG or WEBP photos.', { error: true });
    const vids = list.filter(f => f.type.startsWith('video/') || f.type === 'image/gif');
    if (vids.length) { files = [vids[0]]; kind = 'video'; if (list.length > 1) PF.toast('Using the first video only.'); }
    else {
      files = list.slice(0, LIMITS.maxPhotos || 30); kind = 'image';
      if (files.length < 2) PF.toast('Add at least 2 photos for a slideshow (you can pick several at once).');
    }
    showSource();
  }

  function showSource() {
    const has = files.length > 0;
    $('drop').classList.toggle('hidden', has); $('src').classList.toggle('hidden', !has);
    $('clipStep').classList.toggle('hidden', kind !== 'video'); $('slideStep').classList.toggle('hidden', kind !== 'image');
    const box = $('srcMedia'); box.innerHTML = ''; box.className = 'g-src-media';
    videoDur = 0;
    if (kind === 'video') {
      box.classList.add('one');
      const f = files[0], url = URL.createObjectURL(f);
      $('srcName').textContent = f.name;
      if (f.type === 'image/gif') {
        box.innerHTML = `<img src="${url}" alt="">`; $('srcMeta').textContent = 'GIF · ' + kb(f.size);
        $('start').max = 0; $('dur').value = Math.min(+$('dur').value, LIMITS.maxSeconds); clampDur();
      } else {
        const v = document.createElement('video'); v.src = url; v.muted = true; v.loop = true; v.playsInline = true; v.autoplay = true;
        v.addEventListener('loadedmetadata', () => {
          videoDur = v.duration || 0;
          $('srcMeta').textContent = `${v.videoWidth}×${v.videoHeight} · ${videoDur.toFixed(1)} s · ${kb(f.size)}`;
          $('start').max = Math.max(0, videoDur - 0.5).toFixed(1); $('start').value = 0; $('startV').textContent = fmt(0);
          $('dur').value = Math.min(4, videoDur || 4, LIMITS.maxSeconds); clampDur();
        });
        box.appendChild(v);
      }
    } else if (kind === 'image') {
      files.slice(0, 9).forEach(f => { const i = document.createElement('img'); i.src = URL.createObjectURL(f); box.appendChild(i); });
      $('srcName').textContent = `${files.length} photo${files.length > 1 ? 's' : ''}`;
      $('srcMeta').textContent = 'Slideshow · ' + kb(files.reduce((a, f) => a + f.size, 0));
    }
    updateCount();
  }

  // make
  $('go').addEventListener('click', async () => {
    if (kind === 'image' && files.length < 2) return PF.toast('Add at least 2 photos.', { error: true });
    const n = sizeTotal();
    const opts = {
      sizes: [...chosen], custom: custom(),
      fit: seg.fit, background: seg.bg === 'custom' ? $('bgColor').value : seg.bg,
      fps: +seg.fps, speed: +seg.speed, quality: seg.quality,
      start: +$('start').value, duration: +$('dur').value, slide: +$('slide').value,
      loop: $('loop').checked, mp4: $('mp4').checked,
    };
    const form = new FormData();
    files.forEach(f => form.append('files', f, f.name));
    form.append('options', JSON.stringify(opts));
    $('go').disabled = true; $('empty').classList.add('hidden'); $('out').classList.add('hidden'); $('busy').classList.remove('hidden');
    $('busyNote').textContent = `Making ${n} size${n > 1 ? 's' : ''} — about ${Math.max(5, n * 5)} seconds.`;
    try {
      const r = await PF.api('/gif/make', { method: 'POST', form });
      last = r;
      showResults(r);
      if (r.usage) $('usage').textContent = left(r.usage);
      if (r.watermark) PF.toast('Free trial GIFs carry a small watermark — upgrade to remove it.');
    } catch (e) {
      $('busy').classList.add('hidden'); $('empty').classList.remove('hidden');
      PF.toast(e.message, { error: true, ms: 6000 });
    } finally { $('go').disabled = false; updateCount(); }
  });

  function showResults(r) {
    const url = (f, dl) => `/api/gif/out/${r.id}/${encodeURIComponent(f)}${dl ? '?download=1' : ''}`;
    $('grid').innerHTML = r.results.map(x => `<div class="g-card">
      <div class="pv"><img src="${url(x.gif)}" alt="${esc(x.label)} GIF" loading="lazy"></div>
      <div class="bd"><div class="t">${esc(x.label)} <span>GIF ${x.gifW || x.w}×${x.gifH || x.h}${x.mp4 ? ` · MP4 ${x.w}×${x.h}` : ''}</span></div>
        <div class="g-weight ${x.gifBytes <= 1100 * 1024 ? 'ok' : 'warn'}">${x.gifBytes <= 1100 * 1024 ? '⚡ ' + kb(x.gifBytes) + ' — fast-loading, great for websites' : '⚠ ' + kb(x.gifBytes) + ' — try a shorter clip or “Smallest” for a lighter GIF'}</div>
        <div class="acts"><a class="btn btn-primary btn-sm" href="${url(x.gif, 1)}">⬇ GIF · ${kb(x.gifBytes)}</a>
        ${x.mp4 ? `<a class="btn btn-ghost btn-sm" href="${url(x.mp4, 1)}">⬇ MP4 · ${kb(x.mp4Bytes)}</a>` : ''}</div></div></div>`).join('');
    $('busy').classList.add('hidden'); $('out').classList.remove('hidden');
    $('out').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  $('zipAll').addEventListener('click', async () => {
    if (!last) return;
    const b = $('zipAll'); b.disabled = true; b.textContent = 'Preparing…';
    try {
      const zip = new JSZip();
      for (const x of last.results) for (const f of [x.gif, x.mp4].filter(Boolean)) {
        const res = await fetch(`/api/gif/out/${last.id}/${encodeURIComponent(f)}`, { credentials: 'same-origin' });
        if (!res.ok) throw new Error('These files have expired — make them again.');
        zip.file('postforge-' + f, await res.blob());
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'postforge-gifs.zip'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) { PF.toast(e.message, { error: true }); }
    b.disabled = false; b.textContent = '⬇ Download all (ZIP)';
  });

  init();
})();
