/* Editor: "Post to social media" — publish the current design to Facebook / Instagram now or later.
   Uses editor.js globals: state, PLATFORMS, PLAN, ME, DESIGN_ID, renderPlatformToCanvas,
   recordCurrentCanvasAsVideo, finaliseVideo, showToast, showNotice, handleApiError, updateUsage. */
(function () {
  'use strict';
  const { api, esc } = window.PF;
  const S = window.PFSocial;
  const $ = id => document.getElementById(id);
  let status = null, busy = false;

  /* ---------- modal markup ---------- */
  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap'; wrap.id = 'modalPost';
  wrap.innerHTML = `
    <div class="modal-backdrop" data-pm-close></div>
    <div class="modal">
      <div class="modal-head"><span>📣 Post to social media</span><button class="modal-close" data-pm-close aria-label="Close">✕</button></div>
      <div class="modal-body" id="pmBody"></div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.addEventListener('click', e => { if (e.target.closest('[data-pm-close]') && !busy) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && wrap.classList.contains('open') && !busy) close(); });
  const close = () => wrap.classList.remove('open');

  function defaultCaption() {
    if (state.contentType === 'review') {
      const q = (state.reviewQuote || '').trim();
      return q ? `“${q}”${state.reviewName ? `\n— ${state.reviewName}` : ''}\n\nThank you for the kind words! 💛` : '';
    }
    const lines = [state.headline, state.subheadline, state.price && `👉 ${state.price}`].map(x => (x || '').trim()).filter(Boolean);
    const contact = (state.contact || '').trim();
    return lines.join('\n') + (contact ? `\n\n${contact}` : '');
  }
  const isVideo = () => !!(state.mediaIsVideo && state.mediaSrcEl);

  function previewDataUrl() {
    const c = renderPlatformToCanvas(state.platformKey, 1, PLAN.watermark);
    const t = document.createElement('canvas');
    const scale = 360 / Math.max(c.width, c.height);
    t.width = Math.round(c.width * scale); t.height = Math.round(c.height * scale);
    t.getContext('2d').drawImage(c, 0, 0, t.width, t.height);
    return t.toDataURL('image/jpeg', 0.8);
  }

  async function open() {
    if (typeof CAN_EXPORT !== 'undefined' && !CAN_EXPORT) { showToast('Viewers can’t post designs'); return; }
    wrap.classList.add('open');
    $('pmBody').innerHTML = '<p class="muted">Loading your accounts…</p>';
    try { status = await api('/social/status'); } catch (e) { $('pmBody').innerHTML = `<p>${esc(e.message)}</p>`; return; }
    render();
  }

  function render() {
    const p = PLATFORMS[state.platformKey];
    const accounts = status.accounts;
    const ratio = state.platformW / state.platformH;
    const igFeedOk = ratio >= 0.79 && ratio <= 1.92;
    const video = isVideo();
    const minWhen = S.localInput(Date.now() + 5 * 60000);

    const acctHtml = accounts.length ? accounts.map(a => `
      <label class="soc-acct soc-pick ${a.status !== 'active' ? 'err' : ''}">
        <input type="checkbox" class="pm-acct" value="${a.id}" data-platform="${a.platform}" ${a.status !== 'active' ? 'disabled' : ''}>
        <span class="grow">${S.accountLabel(a)}</span>
        ${a.status !== 'active' ? '<span class="soc-badge bad">Reconnect</span>' : ''}
      </label>`).join('')
      : `<div class="soc-acct" style="display:block"><b>No accounts connected yet.</b><br><span class="muted" style="font-size:13px">${status.canManage
        ? 'Connect your Facebook Page and Instagram account — Facebook opens its own login window, and PostForge never sees your password.'
        : 'Ask your workspace owner or admin to connect your Facebook Page and Instagram account.'}</span></div>`;

    $('pmBody').innerHTML = `
      ${status.demo ? '<div class="soc-demo"><b>Demo mode:</b> Meta isn’t set up on this server yet, so posts are simulated — nothing reaches real Facebook or Instagram.</div>' : ''}
      <div class="pm-grid">
        <div>
          <img class="pm-prev" src="${previewDataUrl()}" alt="Preview of the post">
          <div class="pm-info">${esc(p.label)} · ${p.w}×${p.h} · ${video ? 'video (MP4)' : 'image'}</div>
          ${video && !PLAN.video_export ? '<div class="pm-warn">Video posts are a Pro feature — this will post a still image instead.</div>' : ''}
        </div>
        <div>
          <div class="pm-sec">
            <span class="pm-lbl">Post to</span>
            ${acctHtml}
            ${status.canManage ? `<button class="pill" id="pmConnect" type="button">＋ ${accounts.length ? 'Connect more accounts' : 'Connect Facebook &amp; Instagram'}</button>` : ''}
          </div>
          <div class="pm-sec hidden" id="pmIgOpts">
            <span class="pm-lbl">Instagram as</span>
            <div class="pm-seg">
              <label><input type="radio" name="pmPlace" value="feed" ${igFeedOk ? 'checked' : 'disabled'}> ${video ? 'Reel' : 'Feed post'}</label>
              <label><input type="radio" name="pmPlace" value="story" ${igFeedOk ? '' : 'checked'}> Story</label>
            </div>
            ${igFeedOk ? '' : '<div class="pm-warn">This size is too tall/wide for an Instagram feed post, so it will go to your Story. For a feed post choose the “Instagram Post” or “Instagram Portrait” size.</div>'}
            ${!status.instagramReady ? '<div class="pm-warn">Instagram can only receive posts when PostForge is online (e.g. on Fly.io), not on localhost. Facebook works from here.</div>' : ''}
          </div>
          <div class="pm-sec" id="pmCapSec">
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap"><label for="pmCap" style="margin-right:auto">Caption</label>
              <select id="pmAiLang" class="pm-ai-sel" aria-label="Caption language"><option>English</option><option>Nepali</option><option>Hindi</option><option>Bengali</option><option>Urdu</option><option>Tamil</option><option>Sinhala</option><option>Thai</option><option>Arabic</option><option>Spanish</option><option>French</option></select>
              <select id="pmAiTone" class="pm-ai-sel" aria-label="Tone"><option value="friendly">Friendly</option><option value="professional">Professional</option><option value="fun">Fun</option><option value="luxury">Luxury</option><option value="urgent">Urgent sale</option></select>
              <button class="pill" type="button" id="pmAi">✨ Write with AI</button></div>
            <textarea class="pm-cap" id="pmCap" maxlength="2200" placeholder="Write a caption… #hashtags work too">${esc(defaultCaption())}</textarea>
            <div class="pm-count" id="pmCount"></div>
          </div>
          <div class="pm-sec pm-when">
            <span class="pm-lbl">When</span>
            <div class="pm-seg">
              <label><input type="radio" name="pmWhen" value="now" checked> Post now</label>
              <label><input type="radio" name="pmWhen" value="later"> Schedule</label>
            </div>
            <input type="datetime-local" id="pmAt" class="hidden" min="${minWhen}" value="${S.localInput(Date.now() + 60 * 60000)}">
          </div>
          <div class="pm-foot">
            <span class="note">Counts as 1 download from your allowance.</span>
            <button class="pill" type="button" data-pm-close>Cancel</button>
            <button class="btn-export" type="button" id="pmGo" disabled>Post now</button>
          </div>
        </div>
      </div>`;

    const sync = () => {
      const chosen = [...document.querySelectorAll('.pm-acct:checked')];
      const hasIg = chosen.some(c => c.dataset.platform === 'instagram');
      $('pmIgOpts').classList.toggle('hidden', !hasIg);
      const story = hasIg && document.querySelector('input[name=pmPlace]:checked')?.value === 'story';
      const onlyStory = story && chosen.every(c => c.dataset.platform === 'instagram');
      $('pmCapSec').classList.toggle('hidden', onlyStory);
      const later = document.querySelector('input[name=pmWhen]:checked').value === 'later';
      $('pmAt').classList.toggle('hidden', !later);
      $('pmGo').disabled = !chosen.length;
      $('pmGo').textContent = later ? 'Schedule post' : (chosen.length > 1 ? `Post to ${chosen.length} accounts` : 'Post now');
      $('pmCount').textContent = `${$('pmCap').value.length} / 2200${story ? ' · Stories don’t show captions' : ''}`;
    };
    $('pmBody').addEventListener('change', sync);
    $('pmCap').addEventListener('input', sync);
    /* AI captions: written for the platform being posted to (Instagram style when Instagram is ticked) */
    $('pmAi').addEventListener('click', async () => {
      const b = $('pmAi'); b.disabled = true; b.textContent = '✨ Writing…';
      const chosen = [...document.querySelectorAll('.pm-acct:checked')].map(c => c.dataset.platform);
      const platform = chosen.includes('instagram') ? 'instagram' : 'facebook';
      try {
        const r = await api('/ai/captions', { method: 'POST', body: {
          product: state.contentType === 'review' ? `Customer review: ${state.reviewQuote || ''}` : (state.headline || ''),
          details: state.subheadline || '', price: state.price || '', contact: (state.contact || '').replace(/📞\s*/, ''),
          brand: (typeof ME !== 'undefined' && ME && ME.workspace && ME.workspace.name) || '', language: $('pmAiLang').value, tone: $('pmAiTone').value, platforms: [platform] } });
        const c = r.captions[platform];
        $('pmCap').value = (c.text + (c.hashtags.length ? '\n\n' + c.hashtags.join(' ') : '')).slice(0, 2200);
        sync();
        showToast(r.source === 'template' ? (r.note || 'Caption written — edit it as you like') : `Caption written ✓ (${r.left} left today)`);
      } catch (e) { showToast(e.message); }
      b.disabled = false; b.textContent = '✨ Write with AI';
    });
    const first = document.querySelector('.pm-acct:not(:disabled)');
    if (accounts.filter(a => a.status === 'active').length === 1 && first) first.checked = true;
    sync();
    $('pmConnect')?.addEventListener('click', async () => {
      const r = await S.connect();
      if (r && r.ok) { showToast(`Connected ${r.n} account${r.n === 1 ? '' : 's'} ✓`); status = await api('/social/status'); render(); }
      else if (r && r.error) showToast(r.error, 5000);
    });
    $('pmGo').addEventListener('click', submit);
  }

  async function makeFile() {
    const usePostVideo = isVideo() && PLAN.video_export;
    if (usePostVideo) {
      showToast('Recording your video post — it plays through once…', 6000);
      const raw = await recordCurrentCanvasAsVideo(PLAN.watermark);
      const out = await finaliseVideo(raw);
      if (out.ext !== 'mp4') throw new Error('This browser couldn’t make an MP4 video. Try Chrome or Safari.');
      if (state.mediaSrcEl) { state.mediaSrcEl.muted = true; state.mediaSrcEl.loop = true; state.mediaSrcEl.play().catch(() => {}); }
      return { blob: out.blob, name: 'post.mp4' };
    }
    const c = renderPlatformToCanvas(state.platformKey, 1, PLAN.watermark);
    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.92));
    if (!blob) throw new Error('Could not create the image.');
    return { blob, name: 'post.jpg' };
  }

  async function submit() {
    const ids = [...document.querySelectorAll('.pm-acct:checked')].map(c => +c.value);
    if (!ids.length) return;
    const later = document.querySelector('input[name=pmWhen]:checked').value === 'later';
    let at = null;
    if (later) {
      at = new Date($('pmAt').value).getTime();
      if (!at || at < Date.now() + 60000) { showToast('Pick a time at least a few minutes from now'); return; }
    }
    busy = true;
    $('pmGo').disabled = true; $('pmGo').textContent = 'Preparing…';
    try {
      const f = await makeFile();
      const fd = new FormData();
      fd.append('file', f.blob, f.name);
      fd.append('accountIds', JSON.stringify(ids));
      fd.append('caption', $('pmCap').value);
      fd.append('igPlacement', document.querySelector('input[name=pmPlace]:checked')?.value || 'feed');
      fd.append('platform', state.platformKey);
      fd.append('width', String(state.platformW)); fd.append('height', String(state.platformH));
      if (DESIGN_ID) fd.append('designId', DESIGN_ID);
      fd.append('designName', $('designName')?.value || '');
      if (at) fd.append('scheduledAt', String(at));
      $('pmGo').textContent = 'Uploading…';
      const r = await api('/social/posts', { method: 'POST', form: fd });
      if (r.usage) updateUsage(r.usage);
      if (at) { showResult(r.post, true); busy = false; return; }
      showResult(r.post, false);
      await follow(r.post.id);
    } catch (e) {
      handleApiError(e);
      $('pmGo').disabled = false; $('pmGo').textContent = later ? 'Schedule post' : 'Post now';
    }
    busy = false;
  }

  function showResult(post, scheduled) {
    $('pmBody').innerHTML = `
      <div class="pm-result">
        <p style="margin-bottom:10px;font-size:15px">${scheduled
          ? `🗓 Scheduled for <b>${esc(S.when(post.scheduled_at))}</b>. PostForge will publish it automatically — you can change or cancel it in <a href="/app#social" target="_blank">Social posts</a>.`
          : '📣 Posting… you can keep working, this only takes a moment.'}</p>
        <div id="pmTargets">${targetsHtml(post)}</div>
        <div class="pm-foot"><a class="pill" href="/app#social" target="_blank">See all posts</a><button class="btn-export" type="button" data-pm-close>Done</button></div>
      </div>`;
  }
  const targetsHtml = post => post.targets.map(t => `
    <div class="row">${S.ICON[t.platform] || ''}<span>${esc(t.name || '')}</span> ${S.badge(t.status)}
      ${t.permalink ? `<a href="${esc(t.permalink)}" target="_blank" rel="noopener">View post ↗</a>` : ''}</div>
    ${t.error ? `<div class="soc-err">${esc(t.error)}</div>` : ''}`).join('');

  async function follow(id) {
    for (let i = 0; i < 150; i++) {
      await new Promise(r => setTimeout(r, i < 5 ? 1200 : 3000));
      let p; try { p = await api('/social/posts/' + id); } catch { continue; }
      const el = $('pmTargets'); if (el) el.innerHTML = targetsHtml(p);
      if (!['scheduled', 'publishing'].includes(p.status)) {
        const head = document.querySelector('#pmBody .pm-result p');
        if (head) head.textContent = p.status === 'published' ? '✅ Posted!' : p.status === 'partial' ? '⚠️ Posted to some accounts — see below.' : '⚠️ Posting failed — see below. You can retry from Social posts.';
        showToast(p.status === 'published' ? 'Posted ✓' : p.status === 'partial' ? 'Posted to some accounts — see details' : 'Posting failed — see details', 5000);
        return;
      }
    }
  }

  /* ---------- caption writer (used while posting is switched off: write + copy, post it yourself) ---------- */
  const CAP_PLATFORMS = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['tiktok', 'TikTok'], ['linkedin', 'LinkedIn'], ['x', 'X (Twitter)'], ['whatsapp', 'WhatsApp'], ['pinterest', 'Pinterest'], ['youtube', 'YouTube']];
  function guessPlatform() {
    const k = String(state.platformKey || '');
    const m = [['ig', 'instagram'], ['instagram', 'instagram'], ['fb', 'facebook'], ['facebook', 'facebook'], ['tiktok', 'tiktok'], ['li', 'linkedin'], ['linkedin', 'linkedin'], ['x_', 'x'], ['twitter', 'x'], ['wa', 'whatsapp'], ['whatsapp', 'whatsapp'], ['pin', 'pinterest'], ['yt', 'youtube'], ['youtube', 'youtube']].find(([a]) => k.toLowerCase().startsWith(a));
    return m ? m[1] : 'instagram';
  }
  function openCaption() {
    wrap.classList.add('open');
    wrap.querySelector('.modal-head span').textContent = '💬 Write a caption';
    const plat = guessPlatform();
    $('pmBody').innerHTML = `
      <p class="pm-info" style="margin:0 0 12px;font-size:13px">Write a ready-to-post caption, copy it, then post your downloaded image or video from your phone or computer.</p>
      <div class="pm-sec">
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <select id="pmAiPlat" class="pm-ai-sel" aria-label="Platform">${CAP_PLATFORMS.map(([k, l]) => `<option value="${k}" ${k === plat ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <select id="pmAiLang" class="pm-ai-sel" aria-label="Caption language"><option>English</option><option>Nepali</option><option>Hindi</option><option>Bengali</option><option>Urdu</option><option>Tamil</option><option>Sinhala</option><option>Thai</option><option>Arabic</option><option>Spanish</option><option>French</option></select>
          <select id="pmAiTone" class="pm-ai-sel" aria-label="Tone"><option value="friendly">Friendly</option><option value="professional">Professional</option><option value="fun">Fun</option><option value="luxury">Luxury</option><option value="urgent">Urgent sale</option></select>
          <button class="pill" type="button" id="pmAi">✨ Write with AI</button></div>
        <textarea class="pm-cap" id="pmCap" maxlength="2200" style="margin-top:8px" placeholder="Write a caption… #hashtags work too">${esc(defaultCaption())}</textarea>
        <div class="pm-count" id="pmCount"></div>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button class="btn-export" type="button" id="pmCopy" style="width:auto;padding:10px 18px">📋 Copy caption</button></div>`;
    const count = () => { $('pmCount').textContent = `${$('pmCap').value.length} / 2200`; };
    $('pmCap').addEventListener('input', count); count();
    $('pmAi').addEventListener('click', async () => {
      const b = $('pmAi'); b.disabled = true; b.textContent = '✨ Writing…';
      const platform = $('pmAiPlat').value;
      try {
        const r = await api('/ai/captions', { method: 'POST', body: {
          product: state.contentType === 'review' ? `Customer review: ${state.reviewQuote || ''}` : (state.headline || ''),
          details: state.subheadline || '', price: state.price || '', contact: (state.contact || '').replace(/📞\s*/, ''),
          brand: (typeof ME !== 'undefined' && ME && ME.workspace && ME.workspace.name) || '', language: $('pmAiLang').value, tone: $('pmAiTone').value, platforms: [platform] } });
        const c = r.captions[platform];
        $('pmCap').value = (c.text + (c.hashtags.length ? '\n\n' + c.hashtags.join(' ') : '')).slice(0, 2200);
        count();
        showToast(r.source === 'template' ? (r.note || 'Caption written — edit it as you like') : `Caption written ✓ (${r.left} left today)`);
      } catch (e) { showToast(e.message); }
      b.disabled = false; b.textContent = '✨ Write with AI';
    });
    $('pmCopy').addEventListener('click', async () => {
      const t = $('pmCap').value.trim(); if (!t) { showToast('Write a caption first'); return; }
      try { await navigator.clipboard.writeText(t); showToast('Caption copied ✓'); }
      catch { $('pmCap').select(); showToast('Press Ctrl+C (or ⌘C) to copy'); }
    });
  }

  /* ---------- buttons ---------- */
  function addButtons() {
    const posting = !!(ME && ME.features && ME.features.socialPosting);
    const handler = posting ? open : openCaption;
    const bar = document.querySelector('.stage-bar-bottom');
    if (bar && !$('btnPostSocial')) {
      const b = document.createElement('button');
      b.className = 'btn-export btn-post'; b.id = 'btnPostSocial'; b.type = 'button';
      b.innerHTML = posting ? '📣&nbsp; Post' : '💬&nbsp; Caption';
      bar.insertBefore(b, $('btnGenerateAll'));
      b.addEventListener('click', handler);
    }
    const ex = $('btnExport2');
    if (ex && !$('btnPostSocial2')) {
      const b2 = document.createElement('button');
      b2.className = 'btn-export btn-wide btn-post'; b2.id = 'btnPostSocial2'; b2.type = 'button';
      b2.style.marginTop = '8px';
      b2.innerHTML = posting ? '📣 Post to Facebook / Instagram' : '💬 Write a caption';
      ex.insertAdjacentElement('afterend', b2);
      b2.addEventListener('click', handler);
    }
  }
  // wait until the editor has loaded the account (ME) so we know whether posting is switched on
  (function whenReady(n) { if (typeof ME !== 'undefined' && ME) addButtons(); else if (n < 100) setTimeout(() => whenReady(n + 1), 100); })(0);
  window.PFPost = { open, openCaption };
})();
