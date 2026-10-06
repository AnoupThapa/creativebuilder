(function () {
  'use strict';
  const { api, loadMe, toast, esc, money, date, ago, quotaLabel, usageText, confirmBox } = window.PF;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  let me = null;
  let designs = [];
  let designFilter = 'all';
  let plans = [];
  let billingMode = 'demo';

  const RANK = { viewer: 0, designer: 1, admin: 2, owner: 3 };
  const can = role => RANK[me.user.role] >= RANK[role];
  const TITLES = { designs: 'Designs', social: 'Social posts', brand: 'Brand kits', team: 'Team', billing: 'Plan & billing', account: 'Account & security', activity: 'Activity log' };
  const isBiz = () => me && me.workspace.account_type === 'business';
  const isClient = () => !!(me && me.user.client_brand);
  const posting = () => !!(me && me.features && me.features.socialPosting); // posting & scheduling switched off in the creative-only beta
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };

  /* ================= Shell ================= */
  async function refreshMe() {
    me = await loadMe();
    const u = me.user, w = me.workspace, p = me.plan, us = me.usage;
    $('wsName').textContent = w.name;
    $('meName').textContent = u.name;
    $('meRole').textContent = u.role.charAt(0).toUpperCase() + u.role.slice(1) + (u.is_superadmin ? ' · Platform admin' : '');
    $('meAvatar').textContent = (u.name.trim()[0] || '?').toUpperCase();
    $('navAdmin').classList.toggle('hidden', !u.is_superadmin);
    $('ucPlan').textContent = p.name;
    $('ucCount').textContent = us.day || us.month ? `${us.remaining} left ${us.label}` : `${us.used} / ${us.limit} used`;
    const pct = Math.min(100, (us.used / Math.max(1, us.limit)) * 100);
    $('ucMeter').className = 'meter' + (pct >= 100 ? ' full' : pct >= 80 ? ' warn' : '');
    $('ucMeter').firstElementChild.style.width = pct + '%';
    $('ucReset').textContent = (us.day && us.month ? usageText(us) + '. ' : '') + us.resets;
    $('ucUpgrade').classList.toggle('hidden', !(p.code === 'free' && u.role === 'owner'));
    $('btnNewDesign').classList.toggle('hidden', u.role === 'viewer');
    // profile: retail shop vs business/agency vs agency client
    document.body.classList.toggle('acct-business', isBiz());
    document.body.classList.toggle('acct-retail', !isBiz());
    document.body.classList.toggle('client', isClient());
    document.querySelector('#nav a[data-view=social]')?.classList.toggle('hidden', !posting());
    TITLES.brand = isBiz() ? 'Brands & clients' : 'Brand kit';
    $('navBrand').lastChild.textContent = TITLES.brand;
    $('navActivity').classList.toggle('hidden', !(isBiz() && can('admin')));
    if (isClient()) {
      document.querySelectorAll('#nav a').forEach(a => { a.classList.toggle('hidden', !['designs', 'account'].includes(a.dataset.view) && !/help/.test(a.getAttribute('href') || '')); });
      $('ucUpgrade').classList.add('hidden');
    }
    renderBanners();
  }

  function renderBanners() {
    const b = [];
    const w = me.workspace;
    if (params.get('welcome')) b.push(`<div class="alert alert-ok"><div class="grow">🎉 Welcome to PostGenX, ${esc(me.user.name)}! Create your first design to get started.</div></div>`);
    if (params.get('verified')) b.push('<div class="alert alert-ok"><div class="grow">Email confirmed ✓ — downloads are unlocked.</div></div>');
    if (params.get('checkout') === 'success') b.push('<div class="alert alert-ok"><div class="grow">Payment received — your plan will update in a few seconds. Refresh if it doesn\'t.</div></div>');
    if (!me.user.email_verified && me.requireVerifiedEmail)
      b.push(`<div class="alert alert-warn"><div class="grow">📧 Confirm your email (${esc(me.user.email)}) to start downloading designs. <span id="devVerify"></span></div><button class="btn btn-ghost btn-sm" id="btnResend">Resend email</button></div>`);
    if (me.user.is_superadmin && me.requireAdmin2fa && !me.user.totp_enabled)
      b.push('<div class="alert alert-warn"><div class="grow">🔐 Platform admin area is locked until you turn on <b>2-step login</b> for this account. Set it up below in Account &amp; security.</div><a class="btn btn-ghost btn-sm" href="#account">Set up now</a></div>');
    if (w.plan_code !== 'free' && w.billing_mode === 'comp' && w.current_period_end && w.current_period_end - Date.now() < 14 * 86400000 && w.current_period_end > Date.now())
      b.push(`<div class="alert alert-warn"><div class="grow">Your free ${esc(me.plan.name)} access ends on ${new Date(w.current_period_end).toLocaleDateString()}. Choose a plan to keep your downloads.</div><a class="btn btn-ghost btn-sm" href="#billing">See plans</a></div>`);
    if (w.sub_status === 'past_due') b.push('<div class="alert alert-error"><div class="grow">⚠️ Your last payment failed. Update your card in Billing to keep your plan.</div><a class="btn btn-ghost btn-sm" href="#billing">Fix billing</a></div>');
    $('banners').innerHTML = b.join('');
    $('btnResend')?.addEventListener('click', async () => {
      try {
        const r = await api('/auth/resend-verification', { method: 'POST' });
        toast('Confirmation email sent ✓');
        if (r.devVerifyLink) $('devVerify').innerHTML = `<br><span class="small">Dev mode: <a href="${esc(r.devVerifyLink)}">confirm now</a></span>`;
      } catch (e) { toast(e.message, { error: true }); }
    });
  }

  function route() {
    const v = (location.hash.replace('#', '') || 'designs').split('?')[0];
    let view = TITLES[v] ? v : 'designs';
    if (isClient() && !['designs', 'account'].includes(view)) view = 'designs';
    if (view === 'social' && !posting()) view = 'designs';
    document.querySelectorAll('.view').forEach(s => s.classList.toggle('hidden', s.id !== 'view-' + view));
    document.querySelectorAll('#nav a[data-view]').forEach(a => a.classList.toggle('active', a.dataset.view === view));
    $('viewTitle').textContent = TITLES[view];
    $('sidebar').classList.remove('open');
    ({ designs: loadDesigns, social: () => window.PFSocialView.load(me), brand: loadKits, team: loadTeam, billing: loadBilling, account: loadAccount, activity: loadActivity })[view]();
  }

  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('btnLogout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } finally { location.href = '/login'; }
  });
  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => el.closest('.modal-wrap').classList.remove('open')));

  /* ================= Designs ================= */
  $('btnNewDesign').addEventListener('click', async () => {
    try {
      const brand = isBiz() && /^\d+$/.test(brandFilter) ? +brandFilter : undefined;
      const d = await api('/designs', { method: 'POST', body: { name: 'Untitled design', ...(brand ? { brand_kit_id: brand } : {}) } });
      location.href = '/editor?id=' + encodeURIComponent(d.id);
    } catch (e) { toast(e.message, { error: true, ms: 4500 }); }
  });

  let brandFilter = store.get('pf-brand-filter') || 'all';
  async function loadDesigns() {
    const tasks = [api('/designs').catch(e => { toast(e.message, { error: true }); return []; })];
    if (isBiz() || isClient()) tasks.push(api('/brand-kits').catch(() => []));
    const [d, k] = await Promise.all(tasks);
    designs = d; if (k) kits = k;
    // retail shops get the quick "snap → edit → post" start; agency clients see their brand header
    $('quickStart').classList.toggle('hidden', isBiz() || me.user.role === 'viewer');
    $('designFilter').classList.toggle('hidden', isClient());
    const cb = $('clientBar');
    cb.classList.toggle('hidden', !isClient());
    if (isClient()) {
      const kit = kits[0];
      cb.innerHTML = `${kit && kit.logo_url ? `<img src="${esc(kit.logo_url)}" alt="">` : ''}<div><b>${esc(me.user.client_brand.name)}</b><br><span class="small muted">Designs shared with you by ${esc(me.workspace.name)}. Open one to review it and download the sizes you need.</span></div>`;
    }
    const bf = $('brandFilter');
    bf.classList.toggle('hidden', !isBiz() || isClient());
    if (isBiz() && !isClient()) {
      if (brandFilter !== 'all' && brandFilter !== 'none' && !kits.some(x => String(x.id) === brandFilter)) brandFilter = 'all';
      bf.innerHTML = `<option value="all">All brands</option>${kits.map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}<option value="none">No brand</option>`;
      bf.value = brandFilter;
    }
    renderDesigns();
  }
  $('brandFilter').addEventListener('change', e => { brandFilter = e.target.value; store.set('pf-brand-filter', brandFilter); renderDesigns(); });
  /* Snap → edit → post: upload the photo and open it as a new design */
  $('snapInput').addEventListener('change', async e => {
    const f = e.target.files[0]; e.target.value = '';
    if (!f) return;
    toast('Uploading your photo…');
    try {
      const fd = new FormData(); fd.append('file', f, f.name || 'photo.jpg');
      const m = await api('/media', { method: 'POST', form: fd });
      const data = { v: 1, contentType: 'promo', platformKey: 'ig_portrait', mediaId: m.id, mediaName: f.name || 'Product photo', mediaKind: m.kind, mediaFit: 'auto', fitBg: 'blur', headline: 'New Arrival' };
      const d = await api('/designs', { method: 'POST', body: { name: 'Product post', data } });
      location.href = '/editor?id=' + encodeURIComponent(d.id);
    } catch (err) { toast(err.message, { error: true, ms: 5000 }); }
  });
  $('designFilter').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    designFilter = b.dataset.f;
    $('designFilter').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderDesigns();
  });
  $('designSearch').addEventListener('input', renderDesigns);

  const VIS_LABEL = { private: '🔒 Private', team_view: '👁 Team can view', team_edit: '✏️ Team can edit' };
  function renderDesigns() {
    const term = $('designSearch').value.trim().toLowerCase();
    const list = designs.filter(d =>
      (isClient() || designFilter === 'all' || (designFilter === 'mine' ? d.owner_id === me.user.id : d.owner_id !== me.user.id)) &&
      (!isBiz() || isClient() || brandFilter === 'all' || (brandFilter === 'none' ? !d.brand_kit_id : String(d.brand_kit_id) === brandFilter)) &&
      (!term || d.name.toLowerCase().includes(term)));
    const kitOf = id => kits.find(k => k.id === id);
    const brandCell = d => {
      if (!isBiz()) return '';
      if (d.can_manage) return `<div class="dmeta"><select data-brand aria-label="Brand"><option value="">No brand</option>${kits.map(k => `<option value="${k.id}" ${k.id === d.brand_kit_id ? 'selected' : ''}>🏷 ${esc(k.name)}</option>`).join('')}</select></div>`;
      const k = kitOf(d.brand_kit_id);
      return k ? `<div class="dmeta"><span class="brand-tag"><i style="background:${esc(k.color)}"></i>${esc(k.name)}</span></div>` : '';
    };
    const grid = $('designGrid');
    if (!list.length) {
      grid.innerHTML = `<div class="empty"><h3>${designs.length ? 'No designs match' : 'No designs yet'}</h3>
        <p>${isClient() ? 'Designs shared with you will appear here.' : me.user.role === 'viewer' ? 'Designs your team shares with you will appear here.' : isBiz() ? 'Pick a brand above and click “New design” — it starts with that brand’s logo, colours and fonts.' : 'Snap a product photo above, or click “New design”.'}</p></div>`;
      return;
    }
    grid.innerHTML = list.map(d => `
      <div class="dcard" data-id="${esc(d.id)}">
        <div class="dthumb" data-open>${d.thumbnail ? `<img src="${esc(d.thumbnail)}" alt="">` : '<span class="ph">🖼</span>'}</div>
        <div class="dbody">
          <div class="dname" title="${esc(d.name)}">${esc(d.name)}</div>
          <div class="dmeta"><span>${esc(d.owner_id === me.user.id ? 'You' : d.owner_name)}</span>·<span>${ago(d.updated_at)}</span></div>
          ${brandCell(d)}
          ${d.review_status ? `<div class="dmeta"><span class="rv-badge rv-${esc(d.review_status)}">${{ in_review: '⏳ With client', approved: '✓ Client approved', changes: '✏️ Changes asked' }[d.review_status] || ''}</span>${d.review_comments ? `<span class="small muted">💬 ${d.review_comments}</span>` : ''}</div>` : ''}
          <div class="dmeta">${d.can_manage
            ? `<select data-vis aria-label="Sharing">${Object.entries(VIS_LABEL).map(([k, v]) => `<option value="${k}" ${k === d.visibility ? 'selected' : ''}>${v}</option>`).join('')}</select>`
            : isClient() ? '' : `<span class="badge">${VIS_LABEL[d.visibility]}</span>`}</div>
          <div class="dactions">
            <button data-open>${d.can_edit ? 'Edit' : isClient() ? 'Open & download' : 'View'}</button>
            ${d.review_status && !isClient() ? '<button data-review>💬 Review</button>' : ''}
            ${me.user.role !== 'viewer' ? '<button data-dup>Duplicate</button><button data-var>✨ Variations</button>' : ''}
            ${d.can_edit ? '<button data-rename>Rename</button>' : ''}
            ${d.can_manage ? '<button class="del" data-del>Delete</button>' : ''}
          </div>
        </div>
      </div>`).join('');
  }

  /* client review conversation */
  let revDesign = null;
  const REV = { in_review: ['⏳ Waiting for the client', 'rv-in_review'], approved: ['✓ Approved by the client', 'rv-approved'], changes: ['✏️ The client asked for changes', 'rv-changes'] };
  function renderReview(r) {
    const [l, c] = REV[r.status] || ['Not sent yet', ''];
    $('revStatus').innerHTML = `<span class="rv-badge ${c}">${l}</span>`;
    $('revSnaps').innerHTML = r.snapshots.map(s => `<figure><img src="${esc(s.url)}" alt="${esc(s.label)}" loading="lazy">${esc(s.label)}</figure>`).join('') || '<p class="muted small">No sizes sent yet — open the design and click 📤 Send for review.</p>';
    $('revThread').innerHTML = r.comments.slice().reverse().map(m => `<div class="rev-c ${m.author_type}"><div class="who">${esc(m.author_name || (m.author_type === 'client' ? 'Client' : 'You'))}
      ${m.action === 'approved' ? ' · approved' : m.action === 'changes' ? ' · asked for changes' : m.action === 'sent' ? ' · sent for review' : ''} <span class="muted" style="font-weight:500">· ${ago(m.created_at)}</span></div>${m.body ? `<p>${esc(m.body)}</p>` : ''}</div>`).join('');
  }
  async function openReview(d) {
    revDesign = d; $('revTitle').textContent = `Client review — ${d.name}`;
    try { renderReview(await api(`/reviews/designs/${d.id}`)); $('revModal').classList.add('open'); } catch (e) { toast(e.message, { error: true }); }
  }
  $('revForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = $('revReply').value.trim(); if (!body) return;
    try { await api(`/reviews/designs/${revDesign.id}/comments`, { method: 'POST', body: { body } }); $('revReply').value = ''; renderReview(await api(`/reviews/designs/${revDesign.id}`)); }
    catch (err) { toast(err.message, { error: true }); }
  });

  /* review links per brand */
  let linkKit = null;
  async function openLinks(k) {
    linkKit = k; $('linkTitle').textContent = `Client review link — ${k.name}`;
    await renderLinks(); $('linkModal').classList.add('open');
  }
  async function renderLinks() {
    try {
      const links = await api(`/brand-kits/${linkKit.id}/review-links`);
      $('linkList').innerHTML = links.map(l => `<div class="link-row"><code title="${esc(l.url)}">${esc(l.url)}</code>
        <button class="btn btn-ghost btn-sm" type="button" data-copy="${esc(l.url)}">Copy</button>
        <a class="btn btn-ghost btn-sm" href="${esc(l.url)}" target="_blank" rel="noopener">Open</a>
        ${can('admin') ? `<button class="btn btn-danger btn-sm" type="button" data-off="${l.id}">Turn off</button>` : ''}
        <span class="small muted" style="width:100%">${l.expires_at ? 'Expires ' + date(l.expires_at) : 'Never expires'} · ${l.last_opened_at ? 'last opened ' + ago(l.last_opened_at) : 'not opened yet'}</span></div>`).join('')
        || '<p class="muted small">No active link yet.</p>';
    } catch (e) { $('linkList').innerHTML = `<p class="small" style="color:#c0392b">${esc(e.message)}</p>`; }
  }
  $('linkList').addEventListener('click', async e => {
    const c = e.target.closest('[data-copy]');
    if (c) { try { await navigator.clipboard.writeText(c.dataset.copy); toast('Link copied ✓'); } catch { prompt('Copy this link:', c.dataset.copy); } return; }
    const off = e.target.closest('[data-off]');
    if (off && await confirmBox('Turn off this link?', 'Anyone using it will no longer see the designs.', 'Turn off', true)) {
      try { await api('/review-links/' + off.dataset.off, { method: 'DELETE' }); renderLinks(); } catch (err) { toast(err.message, { error: true }); }
    }
  });
  $('linkNew').addEventListener('click', async () => {
    try { await api(`/brand-kits/${linkKit.id}/review-links`, { method: 'POST', body: { days: +$('linkDays').value } }); toast('Review link created ✓'); renderLinks(); }
    catch (err) { toast(err.message, { error: true, ms: 5000 }); }
  });

  /* one design → themed versions */
  let varFrom = null, varKinds = null;
  async function openVariations(d) {
    varFrom = d;
    if (!varKinds) { try { varKinds = await api('/design-variations'); } catch (e) { toast(e.message, { error: true }); return; } }
    $('varGrid').innerHTML = varKinds.map((k, i) => `<label class="check"><input type="checkbox" value="${esc(k.key)}" ${i < 3 ? 'checked' : ''}> ${esc(k.label)}</label>`).join('');
    $('varModal').classList.add('open');
  }
  $('varGo').addEventListener('click', async () => {
    const kinds = [...$('varGrid').querySelectorAll('input:checked')].map(i => i.value);
    if (!kinds.length) { toast('Tick at least one.', { error: true }); return; }
    $('varGo').disabled = true;
    try {
      const r = await api(`/designs/${varFrom.id}/variations`, { method: 'POST', body: { kinds } });
      $('varModal').classList.remove('open');
      toast(`${r.designs.length} new design${r.designs.length === 1 ? '' : 's'} ✓ — open each to see it and save`);
      loadDesigns();
    } catch (err) { toast(err.message, { error: true, ms: 5000 }); }
    $('varGo').disabled = false;
  });

  let renaming = null;
  $('designGrid').addEventListener('click', async e => {
    const card = e.target.closest('.dcard'); if (!card) return;
    const d = designs.find(x => x.id === card.dataset.id);
    if (e.target.closest('[data-open]')) location.href = '/editor?id=' + encodeURIComponent(d.id);
    else if (e.target.closest('[data-var]')) openVariations(d);
    else if (e.target.closest('[data-review]')) openReview(d);
    else if (e.target.closest('[data-dup]')) {
      try { await api('/designs', { method: 'POST', body: { duplicateOf: d.id } }); toast('Duplicated ✓'); loadDesigns(); }
      catch (err) { toast(err.message, { error: true, ms: 4500 }); }
    } else if (e.target.closest('[data-rename]')) {
      renaming = d; $('renameInput').value = d.name; $('renameModal').classList.add('open'); $('renameInput').select();
    } else if (e.target.closest('[data-del]')) {
      if (!(await confirmBox('Delete design?', `"${d.name}" will be removed for everyone on your team.`, 'Delete', true))) return;
      try { await api('/designs/' + d.id, { method: 'DELETE' }); toast('Design deleted'); loadDesigns(); }
      catch (err) { toast(err.message, { error: true }); }
    }
  });
  $('designGrid').addEventListener('change', async e => {
    if (e.target.matches('[data-brand]')) {
      const id = e.target.closest('.dcard').dataset.id;
      try { await api('/designs/' + id, { method: 'PUT', body: { brand_kit_id: e.target.value ? +e.target.value : null } }); toast('Brand updated ✓'); loadDesigns(); }
      catch (err) { toast(err.message, { error: true }); }
      return;
    }
    if (!e.target.matches('[data-vis]')) return;
    const id = e.target.closest('.dcard').dataset.id;
    try { await api('/designs/' + id, { method: 'PUT', body: { visibility: e.target.value } }); toast('Sharing updated ✓'); loadDesigns(); }
    catch (err) { toast(err.message, { error: true }); }
  });
  $('renameForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/designs/' + renaming.id, { method: 'PUT', body: { name: $('renameInput').value } });
      $('renameModal').classList.remove('open'); loadDesigns();
    } catch (err) { toast(err.message, { error: true }); }
  });

  /* ================= Brand kits ================= */
  let kits = [];
  let editingKit = null;
  let kitLogoId = null;

  async function loadKits() {
    kits = await api('/brand-kits');
    const max = me.plan.max_brand_kits;
    const canEditKits = can('designer');
    $('brandIntro').textContent = isBiz()
      ? `One brand kit per brand or client (up to ${max} on ${me.plan.name}) — logo, colours, fonts, contact details and social accounts. New designs made for a brand start with its kit, and you can give each client a free login to review and download their designs.`
      : 'Your logo, colours, fonts and contact details — applied to designs in one click from the editor.';
    $('kitGrid').innerHTML = kits.map(k => `
      <div class="kit">
        <div class="logo">${k.logo_url ? `<img src="${esc(k.logo_url)}" alt="">` : '<span class="muted small">No logo</span>'}</div>
        <div class="row"><strong class="grow">${esc(k.name)}</strong><span class="sw" style="background:${esc(k.color)}"></span></div>
        ${k.colors && k.colors.length ? `<div class="palette">${k.colors.map(c => `<span style="background:${esc(c)}"></span>`).join('')}</div>` : ''}
        <div class="small muted">${esc(k.tagline || '')}${k.tagline ? '<br>' : ''}${esc(k.phone || '—')}<br>${esc(k.website || '—')}</div>
        ${isBiz() ? `<div class="kstats">${k.designs} design${k.designs === 1 ? '' : 's'} · ${k.clients} client login${k.clients === 1 ? '' : 's'}</div>` : ''}
        <div class="row wrap" style="gap:6px">
          ${canEditKits ? `<button class="btn btn-ghost btn-sm" data-kit="${k.id}">Edit</button>` : ''}
          ${isBiz() ? `<button class="btn btn-ghost btn-sm" data-kit-designs="${k.id}">Designs →</button>` : ''}
          ${isBiz() && me.plan.code !== 'free' ? `<button class="btn btn-ghost btn-sm" data-kit-link="${k.id}">🔗 Review link</button>` : ''}
        </div>
      </div>`).join('') +
      (canEditKits ? (kits.length < max
        ? `<button class="kit empty" id="addKit" style="cursor:pointer"><h3>＋ ${isBiz() ? 'Add a brand / client' : 'Add brand kit'}</h3><p class="small">Logo, colours, fonts &amp; contact details</p></button>`
        : `<div class="kit empty"><p class="small">Your ${esc(me.plan.name)} plan includes ${max} brand kit${max > 1 ? 's' : ''}.</p>${me.plan.code !== 'pro' ? '<a class="btn btn-primary btn-sm" href="#billing">Upgrade for more</a>' : ''}</div>`) : '');
    $('addKit')?.addEventListener('click', () => openKit(null));
    $('kitGrid').querySelectorAll('[data-kit]').forEach(b => b.addEventListener('click', () => openKit(kits.find(k => k.id === +b.dataset.kit))));
    $('kitGrid').querySelectorAll('[data-kit-link]').forEach(b => b.addEventListener('click', () => openLinks(kits.find(k => k.id === +b.dataset.kitLink))));
    $('kitGrid').querySelectorAll('[data-kit-designs]').forEach(b => b.addEventListener('click', () => {
      brandFilter = b.dataset.kitDesigns; store.set('pf-brand-filter', brandFilter); location.hash = 'designs';
    }));
  }
  const SOCIAL_FIELDS = [['instagram', 'Instagram'], ['facebook', 'Facebook'], ['tiktok', 'TikTok'], ['linkedin', 'LinkedIn'], ['youtube', 'YouTube'], ['x', 'X (Twitter)'], ['whatsapp', 'WhatsApp']];
  $('kSocials').innerHTML = SOCIAL_FIELDS.map(([k, l]) => `<div class="field" style="margin:0"><label for="kSoc-${k}">${l}</label><input id="kSoc-${k}" maxlength="120" placeholder="@handle or link"></div>`).join('');
  const fontOpts = (() => {
    const F = (window.PF_CONTENT && window.PF_CONTENT.FONTS) || [];
    const o = f => `<option value="${esc(f.name)}">${esc(f.name)}${f.lang ? ' · ' + esc(f.lang) : ''}</option>`;
    return '<option value="">Design default</option>' + `<optgroup label="Popular">${F.filter(f => !f.lang).map(o).join('')}</optgroup><optgroup label="Local languages">${F.filter(f => f.lang).map(o).join('')}</optgroup>`;
  })();
  $('kFontH').innerHTML = fontOpts; $('kFontB').innerHTML = fontOpts;
  let kitColors = [];
  function renderKitColors() {
    $('kColors').innerHTML = kitColors.map((c, i) => `<span class="cw"><input type="color" value="${esc(c)}" data-ci="${i}" aria-label="Colour ${i + 1}"><button type="button" class="btn btn-ghost btn-sm" data-cdel="${i}" title="Remove">✕</button></span>`).join('')
      + (kitColors.length < 5 ? '<button type="button" class="btn btn-ghost btn-sm" id="kAddColor">＋ Add colour</button>' : '');
  }
  $('kColors').addEventListener('input', e => { if (e.target.dataset.ci) kitColors[+e.target.dataset.ci] = e.target.value; });
  $('kColors').addEventListener('click', e => {
    if (e.target.id === 'kAddColor') { kitColors.push('#1a1a2e'); renderKitColors(); }
    else if (e.target.dataset.cdel !== undefined) { kitColors.splice(+e.target.dataset.cdel, 1); renderKitColors(); }
  });
  function setKitLogo(id, url) {
    kitLogoId = id;
    $('kLogoPrev').innerHTML = url ? `<img src="${esc(url)}" alt="">` : 'No logo';
    $('kLogoRemove').classList.toggle('hidden', !id);
  }
  function openKit(k) {
    editingKit = k;
    $('kitModalTitle').textContent = k ? 'Edit brand kit' : isBiz() ? 'New brand / client' : 'New brand kit';
    $('kName').value = k?.name || (isBiz() && kits.length ? '' : me.workspace.name);
    $('kColor').value = $('kColorHex').value = k?.color || '#ff6b4a';
    $('kPhone').value = k?.phone || '';
    $('kWeb').value = k?.website || '';
    $('kTag').value = k?.tagline || '';
    $('kEmail').value = k?.email || '';
    $('kAddr').value = k?.address || '';
    $('kFontH').value = k?.font_heading || '';
    $('kFontB').value = k?.font_body || '';
    SOCIAL_FIELDS.forEach(([s]) => { $('kSoc-' + s).value = (k?.socials || {})[s] || ''; });
    kitColors = [...(k?.colors || [])]; renderKitColors();
    setKitLogo(k?.logo_media_id || null, k?.logo_url || null);
    $('kDelete').classList.toggle('hidden', !k || !can('admin'));
    $('kitModal').classList.add('open');
  }
  $('kColor').addEventListener('input', e => { $('kColorHex').value = e.target.value; });
  $('kColorHex').addEventListener('input', e => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) $('kColor').value = e.target.value; });
  $('kLogo').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try { const m = await api('/media', { method: 'POST', form: fd }); setKitLogo(m.id, m.url); }
    catch (err) { toast(err.message, { error: true, ms: 4500 }); }
    e.target.value = '';
  });
  $('kLogoRemove').addEventListener('click', () => setKitLogo(null, null));
  $('kitForm').addEventListener('submit', async e => {
    e.preventDefault();
    const body = { name: $('kName').value, color: $('kColorHex').value, phone: $('kPhone').value, website: $('kWeb').value, logo_media_id: kitLogoId,
      tagline: $('kTag').value, email: $('kEmail').value, address: $('kAddr').value, font_heading: $('kFontH').value, font_body: $('kFontB').value,
      colors: kitColors, socials: Object.fromEntries(SOCIAL_FIELDS.map(([s]) => [s, $('kSoc-' + s).value.trim()]).filter(([, v]) => v)) };
    try {
      if (editingKit) await api('/brand-kits/' + editingKit.id, { method: 'PUT', body });
      else await api('/brand-kits', { method: 'POST', body });
      $('kitModal').classList.remove('open'); toast('Brand kit saved ✓'); loadKits();
    } catch (err) { toast(err.message, { error: true, ms: 4500 }); }
  });
  $('kDelete').addEventListener('click', async () => {
    if (!(await confirmBox('Delete brand kit?', 'Designs keep their current look.', 'Delete', true))) return;
    try { await api('/brand-kits/' + editingKit.id, { method: 'DELETE' }); $('kitModal').classList.remove('open'); loadKits(); }
    catch (err) { toast(err.message, { error: true }); }
  });

  /* ================= Team ================= */
  async function loadTeam() {
    const t = await api('/team');
    const used = t.seatsUsed;
    $('seatInfo').textContent = `${used} of ${t.seats} seat${t.seats > 1 ? 's' : ''} in use` + (me.plan.code === 'free' ? ' · Team members need a paid plan' : '')
      + (isBiz() ? ` · ${t.clients} of ${t.clientLimit} free client logins` : '');
    if (isBiz()) {
      if (!kits.length) kits = await api('/brand-kits').catch(() => []);
      $('invBrand').innerHTML = kits.length ? kits.map(k => `<option value="${k.id}">for ${esc(k.name)}</option>`).join('') : '<option value="">Add a brand first</option>';
    }
    $('addSeatsLink').classList.toggle('hidden', me.user.role !== 'owner');
    $('inviteCard').classList.toggle('hidden', !can('admin'));
    $('invRole').querySelector('[value=admin]').disabled = me.user.role !== 'owner';
    $('memberRows').innerHTML = t.members.map(m => {
      const editable = can('admin') && m.role !== 'owner' && m.id !== me.user.id && (me.user.role === 'owner' || m.role !== 'admin');
      const roleCell = m.client_brand_id ? `<span class="badge badge-blue">Client · ${esc(m.client_brand || '')}</span>` : editable
        ? `<select class="input" data-role="${m.id}" style="width:auto;padding:5px 8px">${['admin', 'designer', 'viewer'].map(r =>
            `<option value="${r}" ${r === m.role ? 'selected' : ''} ${r === 'admin' && me.user.role !== 'owner' ? 'disabled' : ''}>${r[0].toUpperCase() + r.slice(1)}</option>`).join('')}</select>`
        : `<span class="badge ${m.role === 'owner' ? 'badge-dark' : ''}">${esc(m.role)}</span>`;
      return `<tr><td><strong>${esc(m.name)}</strong>${m.id === me.user.id ? ' <span class="small muted">(you)</span>' : ''}<br><span class="small muted">${esc(m.email)}</span></td>
        <td>${roleCell}</td>
        <td>${m.totp_enabled ? '<span class="badge badge-green">2-step on</span>' : '<span class="badge">Password only</span>'}${m.email_verified ? '' : ' <span class="badge badge-red">Unverified</span>'}</td>
        <td class="small muted">${ago(m.last_login_at)}</td>
        <td>${editable ? `<button class="btn btn-danger btn-sm" data-remove="${m.id}" data-name="${esc(m.name)}">Remove</button>` : ''}</td></tr>`;
    }).join('');
    $('pendingInvites').innerHTML = t.invites.length ? `<h4 style="margin:18px 0 8px;font-size:13px">Pending invites</h4>
      <div class="table-wrap"><table class="t"><tbody>${t.invites.map(i => `<tr><td>${esc(i.email)}</td><td><span class="badge ${i.client_brand_id ? 'badge-blue' : ''}">${i.client_brand_id ? 'Client · ' + esc((kits.find(k => k.id === i.client_brand_id) || {}).name || 'brand') : esc(i.role)}</span></td>
        <td class="small muted">expires ${date(i.expires_at)}</td><td><button class="btn btn-ghost btn-sm" data-revoke="${esc(i.id)}">Revoke</button></td></tr>`).join('')}</tbody></table></div>` : '';
  }
  $('memberRows').addEventListener('change', async e => {
    const id = e.target.dataset.role; if (!id) return;
    try { await api('/team/' + id, { method: 'PATCH', body: { role: e.target.value } }); toast('Role updated ✓'); }
    catch (err) { toast(err.message, { error: true }); loadTeam(); }
  });
  $('memberRows').addEventListener('click', async e => {
    const b = e.target.closest('[data-remove]'); if (!b) return;
    if (!(await confirmBox('Remove team member?', `${b.dataset.name} will lose access immediately. Their designs stay in the workspace.`, 'Remove', true))) return;
    try { await api('/team/' + b.dataset.remove, { method: 'DELETE' }); toast('Member removed'); loadTeam(); }
    catch (err) { toast(err.message, { error: true }); }
  });
  $('pendingInvites').addEventListener('click', async e => {
    const b = e.target.closest('[data-revoke]'); if (!b) return;
    await api('/team/invites/' + b.dataset.revoke, { method: 'DELETE' }); loadTeam();
  });
  $('inviteForm').addEventListener('submit', async e => {
    e.preventDefault();
    $('inviteResult').innerHTML = '';
    try {
      const r = await api('/team/invite', { method: 'POST', body: { email: $('invEmail').value, role: $('invRole').value, brand_kit_id: $('invRole').value === 'client' ? +$('invBrand').value : undefined } });
      $('inviteResult').innerHTML = `<div class="alert alert-ok" style="margin-top:12px"><div class="grow">Invite sent to ${esc($('invEmail').value)} ✓${r.devInviteLink ? `<br><span class="small">Dev mode link: <code>${esc(r.devInviteLink)}</code></span>` : ''}</div></div>`;
      $('invEmail').value = ''; loadTeam();
    } catch (err) {
      $('inviteResult').innerHTML = `<div class="alert alert-error" style="margin-top:12px"><div class="grow">${esc(err.message)}</div>${err.data?.code ? '<a class="btn btn-ghost btn-sm" href="#billing">Billing</a>' : ''}</div>`;
    }
  });

  $('invRole').addEventListener('change', () => $('invBrand').classList.toggle('hidden', $('invRole').value !== 'client'));

  /* ================= Activity log (business) ================= */
  async function loadActivity() {
    const days = $('actDays').value;
    $('actCsv').href = `/api/workspace/activity?format=csv&days=${days}`;
    $('actJson').href = `/api/workspace/activity?format=json&days=${days}`;
    try {
      const rows = await api('/workspace/activity?days=' + days);
      $('actRows').innerHTML = rows.map(r => `<tr><td class="small" title="${esc(r.time)}">${ago(Date.parse(r.time))}</td><td class="small">${esc(r.name || r.user || '—')}</td>
        <td class="mono small">${esc(r.action)}</td><td class="small mono">${esc(r.ip)}</td><td class="small mono" style="max-width:320px;overflow:hidden;text-overflow:ellipsis">${esc(r.detail).slice(0, 140)}</td></tr>`).join('')
        || '<tr><td colspan="5" class="center muted small">No activity in this period.</td></tr>';
    } catch (e) { toast(e.message, { error: true }); }
  }
  $('actDays').addEventListener('change', loadActivity);

  /* ================= Billing ================= */
  const STATUS = { active: ['Active', 'badge-green'], trialing: ['Trial', 'badge-blue'], past_due: ['Payment failed', 'badge-red'], canceled: ['Cancelled', 'badge'], none: ['Free', 'badge'] };

  function planFeatures(p) {
    return [
      [true, quotaLabel(p) + (p.code === 'free' ? '' : ' per user')],
      [true, p.ai_credits_monthly ? `${p.ai_credits_monthly} AI credits a month (1 per AI photo)` : `${p.ai_credits_lifetime || 0} free AI product photos`],
      [p.ai_video, 'AI product videos (10 credits each)'],
      [p.batch_export, 'Multi-platform ZIP export'],
      [true, `Up to ${p.max_quality}× quality`],
      [p.video_export, p.max_video_seconds ? `Your own videos (up to ${p.max_video_seconds} s)` : 'Video posts'],
      [p.premium_templates, 'All templates'],
      [true, `${p.max_brand_kits} brand kit${p.max_brand_kits > 1 ? 's' : ''}`],
      [true, p.max_designs < 0 ? 'Unlimited saved designs' : `${p.max_designs} saved designs`],
      [!p.watermark, p.watermark ? 'Watermarked' : 'No watermark'],
    ].map(([ok, t]) => `<li class="${ok ? '' : 'no'}">${esc(t)}</li>`).join('');
  }

  async function loadBilling() {
    await refreshMe();
    const r = await api('/billing/plans');
    plans = r.plans; billingMode = r.mode;
    const w = me.workspace, sp = w.subscribed_plan, live = me.plan.code !== 'free';
    const [stLabel, stCls] = STATUS[live ? w.sub_status : 'none'] || STATUS.none;
    const owner = me.user.role === 'owner';

    $('billingMode').innerHTML = billingMode === 'demo'
      ? '<div class="alert alert-info"><div class="grow"><b>Demo billing mode</b> — no payment is taken; plan changes apply instantly. Add your Stripe keys to go live.</div></div>' : '';

    $('currentPlan').innerHTML = `
      <div class="row wrap"><div class="grow"><h3>${esc(me.plan.name)} <span class="badge ${stCls}">${stLabel}</span>${w.billing_mode === 'comp' ? ' <span class="badge badge-blue">Complimentary</span>' : ''}</h3>
        <p class="muted small">${esc(me.plan.description)}</p></div>
        ${owner && w.billing_mode === 'stripe' ? '<button class="btn btn-ghost btn-sm" id="btnPortal">Invoices &amp; card</button>' : ''}
        ${owner && live && ['stripe', 'demo'].includes(w.billing_mode) ? (w.cancel_at_period_end
          ? '<button class="btn btn-dark btn-sm" id="btnResume">Resume plan</button>'
          : '<button class="btn btn-danger btn-sm" id="btnCancel">Cancel plan</button>') : ''}
      </div>
      <div class="cur-grid">
        <div><div class="k">Your downloads</div><div class="v">${me.usage.remaining > 99999 ? '∞' : me.usage.remaining} left</div><div class="small muted">${esc(usageText(me.usage))}</div></div>
        <div><div class="k">Seats</div><div class="v">${w.members} / ${w.seats}</div><div class="small muted">users on this plan</div></div>
        <div><div class="k">Price</div><div class="v">${live ? money(unitPrice(sp, w.billing_interval) * w.seats, sp.currency) + (w.billing_interval === 'year' ? '/yr' : '/mo') : 'Free'}</div><div class="small muted">${live ? `${money(unitPrice(sp, w.billing_interval), sp.currency)} × ${w.seats} user${w.seats > 1 ? 's' : ''} · billed ${w.billing_interval === 'year' ? 'yearly' : 'monthly'}` : '—'}</div></div>
        <div><div class="k">${w.cancel_at_period_end ? 'Ends' : 'Renews'}</div><div class="v">${live ? date(w.current_period_end) : '—'}</div><div class="small muted">${w.cancel_at_period_end && live ? 'then moves to Free' : ''}</div></div>
      </div>`;

    if (!intervalTouched) interval = live ? (w.billing_interval || 'month') : 'month';
    $('intervalToggle').querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.int === interval));
    $('seatCount').value = Math.max(w.seats, w.members);
    $('seatCount').min = w.members;
    $('seatHint').textContent = `You have ${w.members} member${w.members > 1 ? 's' : ''}.`;
    $('seatPicker').classList.toggle('hidden', !owner);
    renderPlanCards();

    $('btnPortal')?.addEventListener('click', async () => {
      try { const p = await api('/billing/portal', { method: 'POST' }); location.href = p.url; } catch (e) { toast(e.message, { error: true }); }
    });
    $('btnCancel')?.addEventListener('click', async () => {
      if (!(await confirmBox('Cancel your plan?', 'You keep your plan until the end of this billing period, then move to Free.', 'Cancel plan', true))) return;
      await api('/billing/cancel', { method: 'POST', body: {} }); toast('Plan will end at period end'); loadBilling();
    });
    $('btnResume')?.addEventListener('click', async () => {
      await api('/billing/cancel', { method: 'POST', body: { resume: true } }); toast('Plan resumed ✓'); loadBilling();
    });

    const hist = await api('/exports/history');
    $('historyRows').innerHTML = hist.length ? hist.map(h => `<tr><td class="small">${ago(h.created_at)}</td><td>${esc(h.design_name || '—')}</td>
      <td class="small">${esc(h.platform)}</td><td>${esc(h.kind)}</td><td>${h.quality}×</td></tr>`).join('')
      : '<tr><td colspan="5" class="muted small center">No downloads yet.</td></tr>';

    const want = params.get('plan');
    if (want && owner && !live) { const b = document.querySelector(`[data-plan="${CSS.escape(want)}"]`); b?.scrollIntoView({ behavior: 'smooth', block: 'center' }); b?.closest('.pcard')?.classList.add('current'); }
  }

  let interval = params.get('interval') === 'year' ? 'year' : 'month', intervalTouched = params.get('interval') === 'year', showAllPlans = !!params.get('plan');
  const unitPrice = (p, int) => int === 'year' && p.price_cents_annual ? p.price_cents_annual : p.price_cents;
  $('intervalToggle').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    interval = b.dataset.int; intervalTouched = true;
    $('intervalToggle').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderPlanCards();
  });
  function renderPlanCards() {
    const w = me.workspace, owner = me.user.role === 'owner';
    const seats = Math.max(1, parseInt($('seatCount').value, 10) || 1);
    const live = me.plan.code !== 'free';
    const fits = p => p.audience === 'both' || p.audience === (isBiz() ? 'business' : 'retail') || (live && p.code === w.plan_code);
    const shown = showAllPlans ? plans : plans.filter(fits);
    $('audienceNote').innerHTML = (isBiz() ? 'Showing plans for <b>businesses &amp; agencies</b>.' : 'Showing plans for <b>shops &amp; small businesses</b>.')
      + (shown.length < plans.length ? ' <a href="#" id="allPlans">Show all plans</a>' : '');
    $('allPlans')?.addEventListener('click', e => { e.preventDefault(); showAllPlans = true; renderPlanCards(); });
    $('planGrid').innerHTML = shown.map(p => {
      const isCur = live ? p.code === w.plan_code : p.code === 'free';
      const sameInt = (w.billing_interval || 'month') === interval;
      let action = '';
      if (!owner) action = isCur ? '<span class="badge">Current plan</span>' : '<span class="small muted">Ask the owner to change plans</span>';
      else if (p.price_cents === 0) action = isCur ? '<button class="btn btn-ghost btn-block" disabled>Current plan</button>' : '<span class="small muted center">Cancel your plan to return to Free</span>';
      else if (interval === 'year' && !p.annual_available) action = '<span class="small muted center">Monthly only</span>';
      else if (isCur && seats === w.seats && sameInt) action = '<button class="btn btn-ghost btn-block" disabled>Current plan</button>';
      else action = `<button class="btn ${p.code === 'pro' ? 'btn-primary' : 'btn-dark'} btn-block" data-plan="${esc(p.code)}">${isCur ? (sameInt ? 'Update seats' : 'Switch to ' + (interval === 'year' ? 'yearly' : 'monthly')) : live ? 'Switch to ' + esc(p.name) : 'Choose ' + esc(p.name)}</button>`;
      const yearly = interval === 'year' && p.annual_available;
      const perUnit = unitPrice(p, yearly ? 'year' : 'month');
      const save = p.annual_available ? Math.round((1 - p.price_cents_annual / (p.price_cents * 12)) * 100) : 0;
      return `<div class="pcard ${isCur ? 'current' : ''}">
        <div class="pn">${esc(p.name)}${isCur ? '<span class="badge badge-coral">Current</span>' : ''}</div>
        <div class="pp">${p.price_cents ? money(perUnit, p.currency) : 'Free'}<small>${p.price_cents ? (yearly ? ' /user/yr' : ' /user/mo') : ''}</small></div>
        ${yearly && save > 0 ? `<div class="total"><span class="badge badge-green">2 months free · save ${save}%</span> = ${money(perUnit / 12, p.currency)}/user/mo</div>` : ''}
        ${p.price_cents ? `<div class="total">${seats} user${seats > 1 ? 's' : ''} = <b>${money(perUnit * seats, p.currency)}/${yearly ? 'year' : 'month'}</b></div>` : ''}
        <ul>${planFeatures(p)}</ul>${action}</div>`;
    }).join('');
  }
  $('seatCount').addEventListener('input', renderPlanCards);
  $('planGrid').addEventListener('click', async e => {
    const b = e.target.closest('[data-plan]'); if (!b) return;
    const p = plans.find(x => x.code === b.dataset.plan);
    const seats = parseInt($('seatCount').value, 10) || 1;
    const unit = unitPrice(p, interval);
    const ok = await confirmBox(`${p.name} — ${seats} user${seats > 1 ? 's' : ''}, billed ${interval === 'year' ? 'yearly' : 'monthly'}`,
      `${money(unit * seats, p.currency)} per ${interval} (${money(unit, p.currency)} × ${seats}). ${billingMode === 'demo' ? 'Demo mode: no payment will be taken.' : 'You will be taken to secure checkout.'}`, 'Continue');
    if (!ok) return;
    b.disabled = true;
    try {
      const r = await api('/billing/checkout', { method: 'POST', body: { plan: p.code, seats, interval } });
      if (r.url) { location.href = r.url; return; }
      toast(r.updated ? 'Subscription updated ✓' : `You're on ${p.name} ✓`);
      history.replaceState(null, '', '/app#billing');
      loadBilling();
    } catch (err) { toast(err.message, { error: true, ms: 4500 }); b.disabled = false; }
  });

  /* ================= Account ================= */
  function fillTimezones(sel, current) {
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['UTC']; }
    if (!zones.includes(current)) zones.unshift(current);
    sel.innerHTML = zones.map(z => `<option ${z === current ? 'selected' : ''}>${esc(z)}</option>`).join('');
  }
  async function loadAccount() {
    $('pfName').value = me.user.name;
    $('pfEmail').value = me.user.email;
    $('pfBiz').value = me.workspace.name;
    $('pfBizField').classList.toggle('hidden', !can('admin'));
    fillTimezones($('pfTz'), me.user.timezone);
    $('acctTypeCard').classList.toggle('hidden', me.user.role !== 'owner');
    $('portalCard').classList.toggle('hidden', !isBiz() || !can('admin'));
    if (isBiz() && can('admin')) api('/workspace/portal').then(pt => {
      $('ptName').value = pt.portal_name || ''; $('ptName').placeholder = me.workspace.name;
      $('ptColor').value = pt.color; setPortalLogo(pt.logo_media_id, pt.logo_url);
    }).catch(() => {});
    loadDevKeys();
    $('acctTypes').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.type === me.workspace.account_type));
    renderTwofa();
    loadSessions();
    $('deleteHint').textContent = deleteText();
  }
  /* ---- Developer API keys + website widget ---- */
  const relTime = t => t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never';
  const snippet = k => `<script src="${location.origin}/widget.js" data-key="${k}" async></script>`;
  async function loadDevKeys() {
    const show = isBiz() && can('admin');
    $('devCard').classList.toggle('hidden', !show);
    if (!show) return;
    let r; try { r = await api('/api-keys'); } catch { return; }
    $('devLocked').classList.toggle('hidden', r.allowed);
    $('devBody').classList.toggle('hidden', !r.allowed && !r.keys.length);
    $('devSecretForm').classList.toggle('hidden', !r.allowed); $('devPubForm').classList.toggle('hidden', !r.allowed);
    $('devRows').innerHTML = r.keys.map(k => `<tr><td>${esc(k.name)}${k.origins.length ? `<div class="small muted">${k.origins.map(esc).join(', ')}</div>` : ''}</td>
      <td>${k.kind === 'secret' ? '🔑 Server' : '🧩 Widget'}</td><td><code>${esc(k.prefix)}…</code></td><td class="small">${relTime(k.last_used_at)}</td>
      <td class="right" style="white-space:nowrap">${k.key ? `<button class="btn btn-ghost btn-sm" data-dev-snip="${esc(k.key)}">Copy code</button> ` : ''}<button class="btn btn-ghost btn-sm" data-dev-del="${k.id}">Delete</button></td></tr>`).join('')
      || '<tr><td colspan="5" class="muted small">No keys yet.</td></tr>';
  }
  function showNewKey(k) {
    const box = $('devNew'); box.classList.remove('hidden');
    box.innerHTML = k.kind === 'secret'
      ? `<b>Your new server key — copy it now, it won't be shown again:</b><div class="dev-code"><code>${esc(k.key)}</code><button type="button" class="btn btn-dark btn-sm" data-dev-copy="${esc(k.key)}">Copy</button></div><p class="small muted">Give it only to your developer. If it leaks, delete it here and make a new one.</p>`
      : `<b>Paste this code into your website where the widget should appear:</b><div class="dev-code"><code>${esc(snippet(k.key))}</code><button type="button" class="btn btn-dark btn-sm" data-dev-copy="${esc(snippet(k.key))}">Copy</button></div>`;
  }
  async function copyIt(t) { try { await navigator.clipboard.writeText(t); toast('Copied ✓'); } catch { prompt('Copy this:', t); } }
  $('devCard').addEventListener('click', async e => {
    const c = e.target.closest('[data-dev-copy]'); if (c) return copyIt(c.dataset.devCopy);
    const sn = e.target.closest('[data-dev-snip]'); if (sn) return copyIt(snippet(sn.dataset.devSnip));
    const d = e.target.closest('[data-dev-del]'); if (!d) return;
    if (!(await confirmBox('Delete this key?', 'Anything using it stops working straight away. This cannot be undone.', 'Delete', true))) return;
    try { await api(`/api-keys/${d.dataset.devDel}`, { method: 'DELETE' }); $('devNew').classList.add('hidden'); toast('Key deleted'); loadDevKeys(); } catch (err) { toast(err.message, { error: true }); }
  });
  $('devSecretForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { const k = await api('/api-keys', { method: 'POST', body: { kind: 'secret', name: $('devSecretName').value } }); $('devSecretName').value = ''; showNewKey(k); loadDevKeys(); }
    catch (err) { toast(err.message, { error: true, ms: 5000 }); }
  });
  $('devPubForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { const k = await api('/api-keys', { method: 'POST', body: { kind: 'publishable', name: $('devPubName').value, origins: $('devPubOrigins').value } }); $('devPubName').value = ''; $('devPubOrigins').value = ''; showNewKey(k); loadDevKeys(); }
    catch (err) { toast(err.message, { error: true, ms: 5000 }); }
  });
  let ptLogoId = null;
  function setPortalLogo(id, url) { ptLogoId = id || null; $('ptLogoPrev').innerHTML = url ? `<img src="${esc(url)}" alt="">` : 'No logo'; $('ptLogoRemove').classList.toggle('hidden', !id); }
  $('ptLogo').addEventListener('change', async e => {
    const f = e.target.files[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    try { const m = await api('/media', { method: 'POST', form: fd }); setPortalLogo(m.id, m.url); } catch (err) { toast(err.message, { error: true }); }
    e.target.value = '';
  });
  $('ptLogoRemove').addEventListener('click', () => setPortalLogo(null, null));
  $('portalForm').addEventListener('submit', async e => {
    e.preventDefault();
    try { await api('/workspace/portal', { method: 'PUT', body: { portal_name: $('ptName').value, portal_color: $('ptColor').value, portal_logo_media_id: ptLogoId } }); toast('Portal look saved ✓'); }
    catch (err) { toast(err.message, { error: true }); }
  });
  $('acctTypes').addEventListener('click', async e => {
    const b = e.target.closest('[data-type]'); if (!b || b.dataset.type === me.workspace.account_type) return;
    const biz = b.dataset.type === 'business';
    if (!(await confirmBox(biz ? 'Switch to Business / Agency?' : 'Switch to Retail / Shop owner?',
      biz ? 'You get a brand switcher, client logins and an activity log. Your designs and brand kits stay as they are.' : 'The dashboard becomes simpler: snap → edit → post. Your designs and brand kits stay as they are.', 'Switch'))) return;
    try { await api('/workspace/account-type', { method: 'PUT', body: { account_type: b.dataset.type } }); await refreshMe(); loadAccount(); toast('Account type updated ✓'); }
    catch (err) { toast(err.message, { error: true, ms: 5000 }); }
  });
  $('profileForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/me', { method: 'PATCH', body: { name: $('pfName').value, timezone: $('pfTz').value, ...(can('admin') ? { workspaceName: $('pfBiz').value } : {}) } });
      toast('Profile saved ✓'); refreshMe();
    } catch (err) { toast(err.message, { error: true }); }
  });
  $('pwForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/me/password', { method: 'POST', body: { current: $('pwCur').value, password: $('pwNew').value } });
      toast('Password changed ✓ — other devices signed out'); e.target.reset(); loadSessions();
    } catch (err) { toast(err.message, { error: true, ms: 4000 }); }
  });

  function renderTwofa() {
    const box = $('twofa');
    if (me.user.totp_enabled) {
      box.innerHTML = `<div class="row wrap"><span class="badge badge-green">✓ On</span><span class="grow small muted">You'll be asked for a code each time you log in.</span>
        <input class="input" type="password" id="tfPw" placeholder="Your password" style="max-width:200px"><button class="btn btn-danger btn-sm" id="tfOff">Turn off</button></div>`;
      $('tfOff').addEventListener('click', async () => {
        try { await api('/me/2fa/disable', { method: 'POST', body: { password: $('tfPw').value } }); toast('2-step verification turned off'); await refreshMe(); renderTwofa(); }
        catch (err) { toast(err.message, { error: true }); }
      });
    } else {
      box.innerHTML = '<button class="btn btn-dark" id="tfSetup">Set up 2-step verification</button>';
      $('tfSetup').addEventListener('click', async () => {
        try {
          const r = await api('/me/2fa/setup', { method: 'POST' });
          box.innerHTML = `<div class="qr"><img src="${esc(r.qr)}" width="170" height="170" alt="QR code">
            <div class="grow" style="min-width:220px"><p class="small"><b>1.</b> Scan this QR code with your authenticator app.<br>Can't scan? Enter this key:</p>
            <p class="secret" style="margin:6px 0 12px">${esc(r.secret)}</p>
            <p class="small"><b>2.</b> Enter the 6-digit code it shows:</p>
            <div class="row" style="margin-top:6px"><input class="input" id="tfCode" inputmode="numeric" maxlength="6" style="max-width:130px;letter-spacing:.3em;font-weight:700"><button class="btn btn-primary" id="tfOn">Turn on</button></div></div></div>`;
          $('tfOn').addEventListener('click', async () => {
            try { await api('/me/2fa/enable', { method: 'POST', body: { code: $('tfCode').value } }); toast('2-step verification is on ✓'); await refreshMe(); renderTwofa(); }
            catch (err) { toast(err.message, { error: true }); }
          });
        } catch (err) { toast(err.message, { error: true }); }
      });
    }
  }

  function deviceName(ua) {
    ua = ua || '';
    const b = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
    const os = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
    return `${b}${os ? ' on ' + os : ''}`;
  }
  async function loadSessions() {
    const rows = await api('/me/sessions');
    $('sessionRows').innerHTML = rows.map(s => `<tr><td>${esc(deviceName(s.user_agent))}${s.current ? ' <span class="badge badge-green">This device</span>' : ''}</td>
      <td class="small muted">${esc(s.ip || '—')}</td><td class="small">${date(s.created_at)}</td><td class="small">${ago(s.last_seen)}</td>
      <td>${s.current ? '' : `<button class="btn btn-ghost btn-sm" data-sess="${s.id}">Sign out</button>`}</td></tr>`).join('');
  }
  $('sessionRows').addEventListener('click', async e => {
    const b = e.target.closest('[data-sess]'); if (!b) return;
    await api('/me/sessions/' + b.dataset.sess, { method: 'DELETE' }); loadSessions();
  });
  $('btnRevokeAll').addEventListener('click', async () => {
    await api('/me/sessions/revoke-others', { method: 'POST' }); toast('Other devices signed out ✓'); loadSessions();
  });

  /* ================= Your data / delete account ================= */
  function deleteText() {
    return me.user.role === 'owner'
      ? `You own "${me.workspace.name}". Deleting your account deletes the whole workspace: every team member's access, all designs, brand kits and uploaded files${me.plan.code !== 'free' ? ', and cancels your subscription' : ''}. This cannot be undone — download your data first if you want a copy.`
      : 'Your account and private drafts will be deleted. Designs you shared with the team stay with the business. This cannot be undone.';
  }
  $('btnExportData').addEventListener('click', async () => {
    const b = $('btnExportData'); b.disabled = true; b.textContent = 'Preparing your ZIP…';
    try {
      const r = await fetch('/api/me/export', { credentials: 'same-origin' });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Export failed');
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = (r.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'postgenx-data.zip';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
      toast('Your data download has started ✓');
    } catch (e) { toast(e.message, { error: true }); }
    b.disabled = false; b.textContent = '⬇ Download my data';
  });
  $('btnDeleteAccount').addEventListener('click', () => {
    $('deleteModalText').textContent = deleteText();
    $('deleteForm').reset();
    $('deleteModal').classList.add('open');
    $('delPw').focus();
  });
  $('deleteForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/me/delete', { method: 'POST', body: { password: $('delPw').value, confirm: $('delConfirm').value.trim() } });
      location.href = '/?deleted=1';
    } catch (err) { toast(err.message, { error: true, ms: 4500 }); }
  });

  /* ================= Boot ================= */
  refreshMe().then(() => {
    window.addEventListener('hashchange', route);
    route();
  }).catch(e => toast(e.message, { error: true }));
})();
