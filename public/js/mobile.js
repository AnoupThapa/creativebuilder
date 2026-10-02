/* PostForge — phone helpers: bottom navigation (dashboard), panel bar (editor),
   brand header (sign-in pages) and a "Start free" bar (landing page).
   Everything here only shows on small screens (see mobile.css / editor-mobile.css). */
(function () {
  'use strict';
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  /* ---------- landing page ---------- */
  if (document.body.classList.contains('m-landing')) {
    const bar = el('div', 'm-cta-bar', '<span><b>Make your first post free</b>No card needed</span><a class="btn btn-primary btn-sm" href="/signup">Start free</a>');
    document.body.appendChild(bar);
    const hero = $('.hero');
    const onScroll = () => {
      const past = window.scrollY > (hero ? hero.offsetTop + hero.offsetHeight - 120 : 600);
      const nearEnd = window.innerHeight + window.scrollY > document.body.scrollHeight - 140;
      bar.classList.toggle('show', past && !nearEnd);
      const cta = $('[data-cta]');
      if (cta) {
        const href = cta.getAttribute('href'), isBeta = href.includes('topic=beta');
        const a = bar.querySelector('a');
        a.href = href;
        a.textContent = isBeta ? 'Apply' : 'Start free';
        bar.querySelector('span').innerHTML = isBeta ? '<b>Private beta</b>Apply for an invite' : '<b>Make your first post free</b>No card needed';
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  /* ---------- log in / sign up ---------- */
  if (document.body.classList.contains('m-auth')) {
    const box = $('.box');
    if (box) {
      const head = el('div', 'm-auth-brand', '<a class="brand" href="/"><span class="brand-mark">P</span>PostForge</a><p>Social media posts for your business in minutes.</p>');
      box.insertBefore(head, box.firstChild);
    }
  }

  /* ---------- dashboard ---------- */
  if (document.body.classList.contains('m-app')) {
    const sidebar = $('#sidebar');
    const scrim = el('div', 'm-scrim');
    document.body.appendChild(scrim);
    const syncScrim = () => {
      const open = !!sidebar && sidebar.classList.contains('open');
      scrim.classList.toggle('show', open);
      document.body.classList.toggle('m-menu-open', open);
      if (open) sidebar.scrollTop = 0;
    };
    // a "Log out" item high up in the menu, so it is always reachable on phones
    const navList = $('#nav'), logoutBtn = $('#btnLogout');
    if (navList && logoutBtn) {
      const out = el('a', 'm-logout', '<span>🚪</span>Log out');
      out.href = '#'; out.setAttribute('role', 'button');
      out.addEventListener('click', e => { e.preventDefault(); logoutBtn.click(); });
      const help = navList.querySelector('a[href="/help"]');
      navList.insertBefore(out, help || null);
    }
    scrim.addEventListener('click', () => { sidebar.classList.remove('open'); syncScrim(); });
    if (sidebar) new MutationObserver(syncScrim).observe(sidebar, { attributes: true, attributeFilter: ['class'] });

    const nav = el('nav', 'm-nav', `
      <a href="#designs" data-v="designs"><span class="ic">🖼</span>Designs</a>
      <a href="#social" data-v="social"><span class="ic">📣</span>Posts</a>
      <button type="button" class="m-new" aria-label="New design"><span class="ic">＋</span>Create</button>
      <a href="#brand" data-v="brand"><span class="ic">🎨</span>Brand</a>
      <button type="button" class="m-more" aria-label="Menu"><span class="ic">☰</span>More</button>`);
    nav.setAttribute('aria-label', 'Main');
    document.body.appendChild(nav);
    nav.querySelector('.m-new').addEventListener('click', () => {
      const b = $('#btnNewDesign');
      if (b && !b.classList.contains('hidden') && !b.disabled) { if (!location.hash.startsWith('#designs') && location.hash) location.hash = 'designs'; b.click(); }
      else if (window.PF && PF.toast) PF.toast('Your role can view designs but not create new ones.');
    });
    nav.querySelector('.m-more').addEventListener('click', () => { sidebar.classList.add('open'); syncScrim(); });
    const mark = () => {
      const v = (location.hash || '#designs').slice(1).split(/[?&]/)[0] || 'designs';
      nav.querySelectorAll('[data-v]').forEach(a => a.classList.toggle('on', a.dataset.v === v));
      nav.querySelector('.m-more').classList.toggle('on', !['designs', 'social', 'brand'].includes(v));
    };
    window.addEventListener('hashchange', mark);
    mark();
  }

  /* ---------- editor ---------- */
  if ($('.rail-left') && $('.stage-wrap')) {
    const GROUP = { 1: 'photo', 2: 'photo', 3: 'photo', 4: 'text', 5: 'text', 6: 'style' };
    $$('.rail-left > .section').forEach(sec => {
      const n = parseInt(sec.querySelector('.sec-label .n')?.textContent, 10);
      sec.dataset.m = GROUP[n] || 'style';
    });
    const TITLES = { photo: 'Photo & logo', text: 'Words on your post', style: 'Style & position', brand: 'Brand kit', export: 'Download' };
    const rl = $('.rail-left'), rr = $('.rail-right');
    const tl = el('div', 'm-panel-title'); const tr = el('div', 'm-panel-title');
    tl.style.display = 'none'; tr.style.display = 'none';
    rl.insertBefore(tl, rl.firstChild); rr.insertBefore(tr, rr.firstChild);

    const bar = el('nav', 'm-ebar', `
      <button type="button" data-t="photo"><span class="ic">📷</span>Photo</button>
      <button type="button" data-t="text"><span class="ic">✏️</span>Text</button>
      <button type="button" data-t="style"><span class="ic">✨</span>Style</button>
      <button type="button" data-t="brand"><span class="ic">🎨</span>Brand</button>
      <button type="button" data-t="export"><span class="ic">⬇️</span>Download</button>`);
    bar.setAttribute('aria-label', 'Editor panels');
    document.body.appendChild(bar);

    const RIGHT = { style: 'layers', brand: 'brand', export: 'export' };
    const FROM_RIGHT = { layers: 'style', brand: 'brand', export: 'export' };
    const small = () => window.matchMedia('(max-width: 900px)').matches;
    let syncing = false;
    function setTab(t, { scroll = true } = {}) {
      document.body.dataset.mtab = t;
      bar.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.t === t));
      const showLeft = t === 'photo' || t === 'text' || t === 'style';
      tl.textContent = TITLES[t]; tr.textContent = TITLES[t];
      tl.style.display = small() && showLeft ? '' : 'none';
      tr.style.display = small() && !showLeft ? '' : 'none';
      if (RIGHT[t]) {
        const btn = $(`.tab-btn[data-tab="${RIGHT[t]}"]`);
        if (btn && !btn.classList.contains('active')) { syncing = true; btn.click(); syncing = false; }
      }
      if (scroll && small()) {
        const top = (showLeft ? rl : rr).getBoundingClientRect().top + window.scrollY - ($('.topbar')?.offsetHeight || 56) - ($('.stage-wrap')?.offsetHeight || 0);
        window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
      }
    }
    bar.addEventListener('click', e => { const b = e.target.closest('button[data-t]'); if (b) setTab(b.dataset.t); });
    // when the editor itself switches panels (e.g. "Brand Kit", selecting something on the design), follow it
    $$('.tab-btn').forEach(b => b.addEventListener('click', () => {
      if (syncing) return;
      const t = FROM_RIGHT[b.dataset.tab];
      if (t && !(t === 'style' && document.body.dataset.mtab === 'style')) setTab(t, { scroll: false });
    }));
    // tapping something on the design opens the Style panel with the position controls
    const pos = $('#posCard');
    if (pos) new MutationObserver(() => {
      if (small() && pos.classList.contains('has-sel') && document.body.dataset.mtab !== 'style') setTab('style', { scroll: false });
    }).observe(pos, { attributes: true, attributeFilter: ['class'] });
    setTab('photo', { scroll: false });
    window.matchMedia('(max-width: 900px)').addEventListener?.('change', () => setTab(document.body.dataset.mtab || 'photo', { scroll: false }));
  }
})();
