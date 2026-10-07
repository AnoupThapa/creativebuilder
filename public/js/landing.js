(function () {
  'use strict';
  const { api, esc, money, quotaLabel } = window.PF;
  const $ = id => document.getElementById(id);
  $('yr').textContent = new Date().getFullYear();

  /* ---------- sticky nav shadow ---------- */
  const nav = $('lpNav');
  const onScroll = () => nav && nav.classList.toggle('scrolled', window.scrollY > 12);
  window.addEventListener('scroll', onScroll, { passive: true }); onScroll();

  /* ---------- reveal on scroll ---------- */
  const still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let io = null;
  function reveal() {
    const els = document.querySelectorAll('.reveal:not(.in)');
    if (still || !('IntersectionObserver' in window)) { els.forEach(el => el.classList.add('in')); return; }
    if (!io) io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    els.forEach(el => io.observe(el));
  }
  reveal();

  /* ---------- feature tabs (auto-advance, pause on hover / focus) ---------- */
  const PANELS = [
    ['editor-text', 'The PostGenX editor with Instagram-style text on a coffee photo'],
    ['ai', 'AI product photo studio placing a real product in a professional scene'],
    ['models', 'Choosing a made-up AI model to hold and present a product'],
    ['slideshow', 'Slideshow studio turning three photos into a Reel with music'],
    ['bulk', 'Bulk studio making every size and caption for many products at once'],
  ];
  const tabs = $('lpTabs');
  if (tabs) {
    const btns = [...tabs.querySelectorAll('[role="tab"]')], img = $('lpPanelImg');
    PANELS.forEach(([f]) => { const i = new Image(); i.src = `/img/landing/${f}.webp`; });
    let cur = 0, timer = null; const DUR = 6000;
    tabs.style.setProperty('--dur', DUR + 'ms');
    function show(i, user) {
      cur = (i + btns.length) % btns.length;
      btns.forEach((b, k) => { b.setAttribute('aria-selected', k === cur ? 'true' : 'false'); b.tabIndex = k === cur ? 0 : -1; });
      const [f, alt] = PANELS[cur];
      img.classList.add('swap');
      setTimeout(() => { img.src = `/img/landing/${f}.webp`; img.alt = alt; img.classList.remove('swap'); }, still ? 0 : 180);
      if (user) stop(); else restart();
    }
    function restart() { clearTimeout(timer); if (!still && !tabs.classList.contains('paused')) timer = setTimeout(() => show(cur + 1), DUR); }
    function stop() { clearTimeout(timer); tabs.classList.add('paused'); }
    btns.forEach((b, k) => b.addEventListener('click', () => show(k, true)));
    tabs.querySelector('[role="tablist"]').addEventListener('keydown', e => {
      const d = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
      if (!d) return; e.preventDefault(); show(cur + d, true); btns[cur].focus();
    });
    tabs.addEventListener('mouseenter', () => { if (!tabs.dataset.user) { clearTimeout(timer); tabs.classList.add('paused'); } });
    tabs.addEventListener('mouseleave', () => { if (!tabs.dataset.user) { tabs.classList.remove('paused'); restart(); } });
    btns.forEach(b => b.addEventListener('click', () => { tabs.dataset.user = '1'; }));
    if (still) tabs.classList.add('paused');
    // start auto-advance only once the section is on screen
    if ('IntersectionObserver' in window) {
      const o = new IntersectionObserver(es => { if (es[0].isIntersecting) { restart(); o.disconnect(); } }, { threshold: 0.3 });
      o.observe(tabs);
    } else restart();
  }

  /* ---------- pricing with monthly / yearly toggle ---------- */
  let plans = [], interval = 'month';
  function features(p) {
    const f = [
      [true, quotaLabel(p) + (p.code === 'free' ? '' : ' per user')],
      [true, 'All 14 platform sizes'],
      [true, p.ai_credits_monthly ? `${p.ai_credits_monthly} AI credits a month (1 per AI photo)` : `${p.ai_credits_lifetime || 0} free AI product photos`],
      [p.ai_video, 'AI product videos for Reels & ads'],
      [p.batch_export, 'One-click multi-platform ZIP'],
      [true, `Up to ${p.max_quality}× export quality${p.max_quality >= 3 ? ' (print)' : p.max_quality === 2 ? ' (HD)' : ''}`],
      [p.video_export, p.max_video_seconds ? `Your own video posts (up to ${p.max_video_seconds} s)` : 'MP4 video posts with sound'],
      [p.premium_templates, 'Full template library'],
      [true, `${p.max_brand_kits} brand kit${p.max_brand_kits > 1 ? 's' : ''}`],
      [!p.watermark, p.watermark ? 'Watermarked downloads' : 'No watermark'],
      [p.code !== 'free', 'Invite your team'],
    ];
    return f.map(([ok, t]) => `<li class="${ok ? '' : 'no'}">${esc(t)}</li>`).join('');
  }
  function renderPlans() {
    const shown = plans.filter(p => p.audience === 'both' || p.audience === audience);
    $('pricingGrid').innerHTML = shown.map(p => {
      const hl = p.code === (audience === 'business' ? 'business' : 'pro');
      const yearly = interval === 'year' && p.price_cents_annual;
      const perMonth = yearly ? Math.round(p.price_cents_annual / 12) : p.price_cents;
      const priceLine = !p.price_cents ? 'Free'
        : money(perMonth, p.currency);
      const small = !p.price_cents ? '' : ' / user / month';
      const note = !p.price_cents ? '' : yearly
        ? `<div class="small muted">${money(p.price_cents_annual, p.currency)} billed yearly — save ${money(p.price_cents * 12 - p.price_cents_annual, p.currency)}</div>`
        : '<div class="small muted">Billed monthly</div>';
      const qs = new URLSearchParams();
      if (p.price_cents) { qs.set('plan', p.code); if (yearly) qs.set('interval', 'year'); }
      if (audience === 'business') qs.set('type', 'business');
      const href = `/signup${qs.toString() ? '?' + qs : ''}`;
      return `<div class="plan ${hl ? 'hl' : ''}">
        <div class="nm">${esc(p.name)} ${hl ? '<span class="lp-badge">Most popular</span>' : ''}</div>
        <div class="pr">${priceLine}<small>${small}</small></div>${note}
        <div class="d" style="margin-top:8px">${esc(p.description)}</div>
        <ul>${features(p)}</ul>
        <a class="btn ${hl ? 'btn-primary' : p.price_cents ? 'btn-dark' : 'btn-ghost'} btn-block" href="${href}" data-cta>${p.price_cents ? 'Choose ' + esc(p.name) : 'Start free'}</a>
      </div>`;
    }).join('');
    applyBeta();
  }
  let audience = 'retail';
  $('audToggle').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    audience = b.dataset.aud;
    $('audToggle').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderPlans();
  });
  $('intToggle').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    interval = b.dataset.int;
    $('intToggle').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderPlans();
  });
  api('/billing/plans').then(r => { plans = r.plans; renderPlans(); })
    .catch(() => { $('pricingGrid').innerHTML = '<p class="center muted">Plans could not be loaded right now.</p>'; });

  /* ---------- before / after examples ---------- */
  api('/public/examples').then(r => {
    if (!r.items.length) { $('examples').classList.add('hidden'); return; }
    $('baGrid').innerHTML = r.items.map(e => `<div class="ba">
      <div class="pair">
        <figure><img src="${esc(e.before)}" alt="Original photo${e.industry ? ' — ' + esc(e.industry) : ''}" loading="lazy" width="600" height="600"><figcaption>Before</figcaption></figure>
        <figure class="after"><img src="${esc(e.after)}" alt="Finished social post made in PostGenX" loading="lazy" width="600" height="600"><figcaption>After</figcaption></figure>
      </div>
      <div class="cap">${e.industry ? `<b>${esc(e.industry)}</b> · ` : ''}${esc(e.caption || '')}</div></div>`).join('');
    $('sampleNote').classList.toggle('hidden', !r.sample);
  }).catch(() => $('examples').classList.add('hidden'));

  /* ---------- testimonials (only ones customers agreed to share) ---------- */
  api('/public/testimonials').then(list => {
    if (!list.length) return;
    $('quotes').innerHTML = list.map(t => `<div class="quote"><div class="st">${'★'.repeat(t.rating)}</div>
      <p>“${esc(t.message)}”</p><div class="who"><b>${esc(t.display_name)}</b>${t.business ? ' · ' + esc(t.business) : ''}</div></div>`).join('');
    $('reviews').classList.remove('hidden');
    const f = $('founders'); if (f) f.classList.add('hidden');
    reveal();
  }).catch(() => {});

  /* ---------- demo video + beta mode ---------- */
  let beta = false;
  function applyBeta() {
    if (!beta) return;
    document.querySelectorAll('[data-cta]').forEach(a => {
      if (a.dataset.betaDone) return;
      a.dataset.betaDone = '1';
      a.href = '/help?topic=beta#contact';
      a.textContent = a.closest('.plan') ? 'Apply for the beta' : a.closest('nav') ? 'Join the beta' : 'Apply for the private beta';
    });
  }
  api('/public/config').then(c => {
    if (c.demoVideoUrl) {
      const v = $('demoVideo');
      v.querySelector('source').src = c.demoVideoUrl;
      v.load();
    }
    beta = !!c.betaMode;
    $('betaBand').classList.toggle('hidden', !beta);
    applyBeta();
  }).catch(() => {});
  $('demoVideo').addEventListener('error', () => $('demo').classList.add('hidden'), true);

  // If already signed in, swap nav to "Open app"
  fetch('/api/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(me => {
    if (!me) return;
    $('navLinks').innerHTML = `<span class="lp-me">${esc(me.user.name)}</span><a class="btn btn-primary btn-sm" href="/app">Open app</a>`;
  }).catch(() => {});
})();
