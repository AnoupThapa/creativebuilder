/* AI Studio page */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = PF.esc;
  let OPT = null, industry = null, style = null, photoFile = null, photoData = null, src = 'photo';
  const seg = { aspect: '4:5', count: '1' };
  const vseg = { vaspect: '9:16', vsec: '6' };
  let credits = null, mode = 'image', vstyle = null, vfrom = null, vphotoFile = null, recentJobs = [];

  function showCredits(c) {
    if (!c) return;
    credits = c;
    $('credits').textContent = '✨ ' + c.label;
    $('credits').dataset.short = `✨ ${c.left} credit${c.left === 1 ? '' : 's'}`;
    $('credits').classList.toggle('low', c.left <= 2);
    const box = $('topupBox');
    if (c.plan !== 'free' && OPT) {
      box.classList.remove('hidden');
      $('topupText').textContent = `${OPT.topup.credits} credits for ${PF.money(OPT.topup.price_cents, 'usd')} — never expire, shared with your team.`;
    } else if (c.plan === 'free') {
      box.classList.toggle('hidden', c.left > 0);
      $('topupText').textContent = 'Paid plans include AI images every month.';
      $('topupBtn').classList.add('hidden');
    }
    updateGo(); updateVGo();
  }

  async function init() {
    try { await PF.loadMe(); } catch { return; }
    OPT = await PF.api('/ai/options');
    $('offBar').classList.toggle('hidden', OPT.enabled);
    $('vstyles').innerHTML = OPT.videoTemplates.map(t => `<button type="button" class="a-style" data-k="${t.key}">
      <span class="em">${t.emoji}</span><span><b>${esc(t.name)}</b><small>${esc(t.description)}</small></span></button>`).join('');
    if (OPT.videoTemplates[0]) pickVStyle(OPT.videoTemplates[0].key);
    $('vlock').classList.toggle('hidden', OPT.video.allowed);
    $('vform').classList.toggle('hidden', !OPT.video.allowed);
    $('inds').innerHTML = OPT.industries.map(i => `<button type="button" data-k="${i.key}">${i.emoji} ${esc(i.label)}</button>`).join('');
    showCredits(OPT.credits);
    pickIndustry(OPT.industries[0].key);
    const p = new URLSearchParams(location.search);
    if (p.get('topup') === 'success') PF.toast('Payment received — your AI credits will appear in a moment.');
    setMode(p.get('mode') === 'video' ? 'video' : 'image');
    loadRecent();
  }

  /* ---------- Photo ad / Video ad ---------- */
  function setMode(m) {
    mode = m;
    $('mode').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.v === m));
    $('imgPanel').classList.toggle('hidden', m !== 'image');
    $('vidPanel').classList.toggle('hidden', m !== 'video');
    $('demoBar').classList.toggle('hidden', !(OPT && OPT.demo && m === 'image'));
    $('vdemoBar').classList.toggle('hidden', !(OPT && OPT.video.demo && m === 'video' && OPT.video.allowed));
    updateVGo();
  }
  $('mode').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) setMode(b.dataset.v); });

  function pickVStyle(k) {
    vstyle = OPT.videoTemplates.find(t => t.key === k);
    $('vstyles').querySelectorAll('.a-style').forEach(b => b.classList.toggle('on', b.dataset.k === k));
    updateVGo();
  }
  $('vstyles').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) pickVStyle(b.dataset.k); });
  let vsrc = 'ai';
  function setVSrc(v) {
    vsrc = v;
    $('vsrcTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x.dataset.v === v));
    document.querySelectorAll('.a-vsrc').forEach(d => d.classList.toggle('hidden', d.dataset.vsrc !== v));
    updateVGo();
  }
  $('vsrcTabs').addEventListener('click', e => { const b = e.target.closest('[data-v]'); if (b) setVSrc(b.dataset.v); });
  function renderPick() {
    const items = [];
    recentJobs.filter(j => j.status === 'done' && j.kind !== 'video').forEach(j => j.outputs.forEach(o => items.push({ j, o })));
    $('vpick').innerHTML = items.slice(0, 24).map(({ j, o }) => `<button type="button" data-job="${j.id}" data-n="${o.n}" data-product="${esc(j.inputs.product || '')}"
      class="${vfrom && vfrom.id === j.id && vfrom.n === o.n ? 'on' : ''}" title="${esc(j.inputs.product || 'AI image')}"><img src="${o.url}" alt="" loading="lazy"></button>`).join('');
    $('vpickEmpty').classList.toggle('hidden', items.length > 0);
  }
  function pickFrom(id, n, product) {
    vfrom = { id, n: +n };
    if (product && !$('vproduct').value.trim()) $('vproduct').value = product;
    renderPick(); updateVGo();
  }
  $('vpick').addEventListener('click', e => { const b = e.target.closest('[data-job]'); if (b) pickFrom(b.dataset.job, b.dataset.n, b.dataset.product); });
  function setVPhoto(file) {
    vphotoFile = file || null;
    $('vphotoBox').classList.toggle('hidden', !file); $('vdrop').classList.toggle('hidden', !!file); $('vsnap').classList.toggle('hidden', !!file);
    if (file) $('vphotoImg').src = URL.createObjectURL(file);
    updateVGo();
  }
  $('vphoto').addEventListener('change', e => { const f = e.target.files[0]; if (f) setVPhoto(f); });
  $('vphotoSnap').addEventListener('change', e => { const f = e.target.files[0]; if (f) setVPhoto(f); e.target.value = ''; });
  const vdrop = $('vdrop');
  ['dragenter', 'dragover'].forEach(t => vdrop.addEventListener(t, e => { e.preventDefault(); vdrop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => vdrop.addEventListener(t, () => vdrop.classList.remove('over')));
  vdrop.addEventListener('drop', e => { e.preventDefault(); const f = [...e.dataTransfer.files].find(x => /^image\//.test(x.type)); if (f) setVPhoto(f); });
  $('vphotoClear').addEventListener('click', () => { $('vphoto').value = ''; setVPhoto(null); });
  Object.keys(vseg).forEach(id => $(id).addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    vseg[id] = b.dataset.v; $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); updateVGo();
  }));
  function updateVGo() {
    if (!OPT) return;
    const need = OPT.video.credits;
    const hasStart = vsrc === 'ai' ? !!vfrom : !!vphotoFile;
    let ok = true, note;
    if (!OPT.video.allowed) { ok = false; note = ''; }
    else if (!hasStart) { ok = false; note = vsrc === 'ai' ? 'Pick one of your AI images to start from.' : 'Add a photo to start from.'; }
    else if (!vstyle) { ok = false; note = 'Pick a motion.'; }
    else if (credits && credits.left < need) { ok = false; note = `A video uses ${need} AI credits — you have ${credits.left}. Buy a pack below.`; }
    else note = `Uses ${need} AI credits · takes about 1–4 minutes. Failed videos are refunded.`;
    $('vgo').disabled = !ok || !OPT.enabled;
    $('vgoNote').textContent = note;
  }
  $('vgo').addEventListener('click', async () => {
    const fd = new FormData();
    fd.append('template', vstyle.key); fd.append('aspect', vseg.vaspect); fd.append('seconds', vseg.vsec);
    fd.append('product', $('vproduct').value.trim());
    if (vsrc === 'ai') { fd.append('fromJob', vfrom.id); fd.append('n', String(vfrom.n)); }
    else fd.append('photo', vphotoFile, vphotoFile.name || 'photo.jpg');
    $('vgo').disabled = true;
    busy('video');
    try {
      const r = await PF.api('/ai/videos', { method: 'POST', form: fd });
      showCredits(r.credits);
      watch(r.job.id, 'video');
    } catch (e) {
      $('busy').classList.add('hidden'); $('empty').classList.remove('hidden');
      PF.toast(e.message, { error: true, ms: 6000 }); updateVGo();
    }
  });
  function busy(kind) {
    $('empty').classList.add('hidden'); $('busy').classList.remove('hidden');
    $('busyTitle').textContent = kind === 'video' ? 'Creating your video…' : 'Creating your image…';
    $('busyNote').textContent = kind === 'video' ? 'Usually 1–4 minutes. You can leave this page — it will appear under Recent.'
      : seg.count === '2' ? 'Making 2 options — usually 20–80 seconds.' : 'This usually takes 10–40 seconds.';
  }

  function pickIndustry(k) {
    industry = k;
    $('inds').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.k === k));
    const list = OPT.templates.filter(t => t.industry === k);
    $('styles').innerHTML = list.map(t => `<button type="button" class="a-style" data-k="${t.key}">
      <span class="em">${t.emoji}</span><span><b>${esc(t.name)}</b><small>${esc(t.description)}</small>${t.needsPhoto ? '<span class="tag">Needs your photo</span>' : ''}</span></button>`).join('');
    style = null;
    if (list[0]) pickStyle(list[0].key);
  }
  function pickStyle(k) {
    style = OPT.templates.find(t => t.key === k);
    $('styles').querySelectorAll('.a-style').forEach(b => b.classList.toggle('on', b.dataset.k === k));
    updateGo();
  }
  $('inds').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) pickIndustry(b.dataset.k); });
  $('styles').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (b) pickStyle(b.dataset.k); });

  // source tabs
  $('srcTabs').addEventListener('click', e => {
    const b = e.target.closest('[data-v]'); if (!b) return;
    src = b.dataset.v;
    $('srcTabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    document.querySelectorAll('.a-src').forEach(d => d.classList.toggle('hidden', d.dataset.src !== (src === 'text' ? 'none' : src)));
    if (src === 'link' && photoData) {/* keep the photo read from the link */}
    updateGo();
  });

  // photo
  function setPhoto(file, dataUrl) {
    photoFile = file || null; photoData = dataUrl || null;
    const has = !!(photoFile || photoData);
    $('photoBox').classList.toggle('hidden', !has); $('drop').classList.toggle('hidden', has); $('snapAi').classList.toggle('hidden', has);
    if (has) $('photoImg').src = photoData || URL.createObjectURL(photoFile);
    if (has && src !== 'photo') { $('srcTabs').querySelector('[data-v=photo]').click(); }
    updateGo();
  }
  $('photo').addEventListener('change', e => { const f = e.target.files[0]; if (f) setPhoto(f, null); });
  $('photoSnap').addEventListener('change', e => { const f = e.target.files[0]; if (f) setPhoto(f, null); e.target.value = ''; });
  const drop = $('drop');
  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, e => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, () => drop.classList.remove('over')));
  drop.addEventListener('drop', e => { e.preventDefault(); const f = [...e.dataTransfer.files].find(x => /^image\//.test(x.type)); if (f) setPhoto(f, null); });
  $('photoClear').addEventListener('click', () => { $('photo').value = ''; setPhoto(null, null); });

  // link
  $('urlGo').addEventListener('click', async () => {
    const url = $('url').value.trim(); if (!url) return;
    const b = $('urlGo'); b.disabled = true; b.textContent = 'Reading…';
    try {
      const r = await PF.api('/ai/from-url', { method: 'POST', body: { url } });
      if (r.product) $('product').value = r.product;
      if (r.details) $('details').value = r.details.slice(0, 400);
      if (r.photo) setPhoto(null, r.photo);
      $('urlNote').textContent = r.photo ? '✓ Got the name, details and photo from that page. Check them below.' : '✓ Got the name and details. No usable photo on that page — add one, or use a style without “Needs your photo”.';
      if (r.price) $('details').dataset.price = r.price;
    } catch (e) { PF.toast(e.message, { error: true }); }
    b.disabled = false; b.textContent = 'Read';
    updateGo();
  });
  ['product', 'details'].forEach(id => $(id).addEventListener('input', updateGo));

  // shape & count
  Object.keys(seg).forEach(id => $(id).addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b) return;
    seg[id] = b.dataset.v; $(id).querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); updateGo();
  }));

  function updateGo() {
    const hasPhoto = !!(photoFile || photoData), hasName = !!$('product').value.trim();
    let note = '', ok = true;
    if (!style) { ok = false; note = 'Pick a style to start.'; }
    else if (style.needsPhoto && !hasPhoto) { ok = false; note = `“${style.name}” uses your real photo — add one (or paste a product link).`; }
    else if (!hasPhoto && !hasName) { ok = false; note = 'Add a photo, a product link, or at least the product name.'; }
    else if (credits && credits.left < +seg.count) { ok = false; note = credits.plan === 'free' ? 'You’ve used your free AI images — upgrade for more every month.' : 'Not enough AI credits — buy a pack below.'; }
    else note = `Uses ${seg.count} AI credit${seg.count === '1' ? '' : 's'}. Failed images are refunded.`;
    $('go').disabled = !ok || (OPT && !OPT.enabled);
    $('goNote').textContent = note;
  }

  // create
  let polling = null;
  $('go').addEventListener('click', async () => {
    const fd = new FormData();
    fd.append('template', style.key); fd.append('aspect', seg.aspect); fd.append('count', seg.count);
    ['product', 'details', 'colours', 'mood', 'setting'].forEach(id => fd.append(id, $(id).value.trim()));
    if ($('details').dataset.price) fd.append('price', $('details').dataset.price);
    if (photoFile) fd.append('photo', photoFile, photoFile.name || 'photo.jpg');
    else if (photoData) fd.append('photoData', photoData);
    $('go').disabled = true;
    busy('image');
    try {
      const r = await PF.api('/ai/jobs', { method: 'POST', form: fd });
      showCredits(r.credits);
      watch(r.job.id);
    } catch (e) {
      $('busy').classList.add('hidden'); $('empty').classList.remove('hidden');
      PF.toast(e.message, { error: true, ms: 6000 }); updateGo();
    }
  });

  function watch(id, kind = 'image') {
    clearTimeout(polling);
    const started = Date.now();
    const tick = async () => {
      try {
        const r = await PF.api('/ai/jobs/' + id);
        const j = r.job;
        if (j.status === 'done') { polling = null; $('busy').classList.add('hidden'); showJob(j); if (r.credits) showCredits(r.credits); loadRecent(); updateGo(); updateVGo(); return; }
        if (j.status === 'failed') {
          polling = null;
          $('busy').classList.add('hidden'); $('empty').classList.remove('hidden');
          PF.toast(j.error || 'The AI could not make this.', { error: true, ms: 8000 });
          if (r.credits) showCredits(r.credits); loadRecent(); updateGo(); updateVGo(); return;
        }
        const secs = Math.round((Date.now() - started) / 1000);
        $('busyNote').textContent = j.status === 'queued' ? 'Waiting for a free AI slot…'
          : kind === 'video' ? `Filming… ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} — usually 1–4 minutes. You can leave this page.` : `Creating… ${secs} s`;
      } catch { /* keep trying */ }
      polling = setTimeout(tick, kind === 'video' ? 5000 : 2500);
    };
    tick();
  }

  function showJob(j) {
    const paid = credits && credits.plan !== 'free';
    const isVideo = j.kind === 'video';
    $('outTitle').textContent = isVideo ? 'Your video' : 'Your images';
    $('grid').innerHTML = j.outputs.map(o => `<div class="g-card">
      <div class="pv">${isVideo ? `<video src="${o.url}" poster="${o.poster}" controls muted loop playsinline autoplay></video>` : `<img src="${o.url}" alt="AI image ${o.n + 1}">`}</div>
      <div class="bd">${j.demo ? `<span class="a-card-demo">${isVideo ? 'Demo video' : 'Demo placeholder'}</span>` : ''}
        <div class="acts"><button class="btn btn-primary btn-sm" type="button" data-design="${j.id}" data-n="${o.n}">✏️ Add text & logo</button>
        ${!isVideo && OPT && OPT.video.allowed ? `<button class="btn btn-dark btn-sm" type="button" data-vid="${j.id}" data-n="${o.n}" data-product="${esc(j.inputs.product || '')}">🎬 Make a video</button>` : ''}
        ${paid ? `<a class="btn btn-ghost btn-sm" href="${o.url}?download=1">⬇ Download</a>` : ''}</div></div></div>`).join('');
    $('out').classList.remove('hidden');
    $('out').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  $('grid').addEventListener('click', async e => {
    const v = e.target.closest('[data-vid]');
    if (v) { setMode('video'); setVSrc('ai'); pickFrom(v.dataset.vid, v.dataset.n, v.dataset.product); $('vidPanel').scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    const b = e.target.closest('[data-design]'); if (!b) return;
    b.disabled = true; b.textContent = 'Opening…';
    try {
      const r = await PF.api(`/ai/jobs/${b.dataset.design}/design`, { method: 'POST', body: { n: +b.dataset.n } });
      location.href = '/editor?id=' + encodeURIComponent(r.designId);
    } catch (err) { PF.toast(err.message, { error: true }); b.disabled = false; b.textContent = '✏️ Add text & logo'; }
  });

  async function loadRecent() {
    try {
      const r = await PF.api('/ai/jobs');
      recentJobs = r.jobs;
      renderPick();
      const items = r.jobs.filter(j => j.status === 'done' || j.status === 'failed').slice(0, 12);
      $('recentWrap').classList.toggle('hidden', !items.length);
      $('recent').innerHTML = items.map(j => j.status === 'done' && j.outputs[0]
        ? `<a href="#" class="${j.kind === 'video' ? 'vid' : ''}" data-job='${esc(JSON.stringify(j))}'><img src="${j.kind === 'video' ? j.outputs[0].poster : j.outputs[0].url}" alt="" loading="lazy"><span>${esc(j.inputs.product || (j.kind === 'video' ? 'AI video' : 'AI image'))}</span></a>`
        : `<div class="failed">⚠️ ${esc(j.inputs.product || 'Failed')}<br>credits returned</div>`).join('');
      // a video still being made (e.g. after leaving the page) — keep watching it
      const live = r.jobs.find(j => j.kind === 'video' && (j.status === 'queued' || j.status === 'running'));
      if (live && $('busy').classList.contains('hidden') && !polling) { busy('video'); watch(live.id, 'video'); }
    } catch { /* ignore */ }
  }
  $('recent').addEventListener('click', e => {
    const a = e.target.closest('[data-job]'); if (!a) return;
    e.preventDefault(); showJob(JSON.parse(a.dataset.job));
  });

  $('topupBtn').addEventListener('click', async () => {
    const b = $('topupBtn'); b.disabled = true;
    try {
      const r = await PF.api('/billing/ai-topup', { method: 'POST', body: {} });
      if (r.url) { location.href = r.url; return; }
      PF.toast(`Added ${r.credits} AI credits (demo billing — no payment taken).`);
      showCredits(await PF.api('/ai/credits'));
    } catch (e) { PF.toast(e.message, { error: true }); }
    b.disabled = false;
  });

  init();
})();
