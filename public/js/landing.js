(function () {
  'use strict';
  const { api, esc, money, quotaLabel } = window.PF;
  const $ = id => document.getElementById(id);
  $('yr').textContent = new Date().getFullYear();

  /* ---------- pricing with monthly / yearly toggle ---------- */
  let plans = [], interval = 'month';
  function features(p) {
    const f = [
      [true, quotaLabel(p) + (p.code === 'free' ? '' : ' per user')],
      [true, 'All 14 platform sizes'],
      [true, p.ai_credits_monthly ? `${p.ai_credits_monthly} AI product photos a month` : `${p.ai_credits_lifetime || 0} free AI product photos`],
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
        <div class="nm">${esc(p.name)} ${hl ? '<span class="badge badge-coral">Best value</span>' : ''}</div>
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
    $('navLinks').innerHTML = `<span class="small muted" style="margin-right:6px">${esc(me.user.name)}</span><a class="btn btn-primary btn-sm" href="/app">Open app</a>`;
  }).catch(() => {});
})();
