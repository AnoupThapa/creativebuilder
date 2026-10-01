/* Dashboard → Social posts: connected accounts, scheduled posts and history. */
(function () {
  'use strict';
  const { api, toast, esc, confirmBox } = window.PF;
  const S = window.PFSocial;
  const $ = id => document.getElementById(id);
  let me = null, status = null, filter = 'scheduled', poll = null;

  async function load(m) {
    me = m || me;
    try { status = await api('/social/status'); } catch (e) { toast(e.message, { error: true }); return; }
    $('socDemo').innerHTML = status.demo
      ? '<div class="soc-demo"><b>Demo mode.</b> Meta (Facebook &amp; Instagram) isn’t set up on this server yet, so connecting adds sample accounts and posts are simulated. See the README “Social media posting” section to switch on real posting.</div>'
      : (!status.instagramReady ? '<div class="soc-demo">PostForge is running on this computer (localhost). Facebook posting works, but Instagram needs PostForge online (e.g. Fly.io) because Instagram downloads the picture from your PostForge address.</div>' : '');
    $('socConnect').classList.toggle('hidden', !status.canManage);
    renderAccounts();
    loadPosts();
  }

  function renderAccounts() {
    const a = status.accounts;
    $('socAccounts').innerHTML = a.length ? a.map(x => `
      <div class="soc-acct ${x.status !== 'active' ? 'err' : ''}">
        <span class="grow">${S.accountLabel(x)}</span>
        ${x.status !== 'active' ? '<span class="soc-badge bad" style="margin-right:8px">Needs reconnecting</span>' : ''}
        ${status.canManage ? `<button class="btn btn-ghost btn-sm" data-disc="${x.id}" data-name="${esc(x.name)}">Disconnect</button>` : ''}
      </div>${x.last_error && x.status !== 'active' ? `<div class="soc-err" style="margin:-4px 0 8px 4px">${esc(x.last_error)}</div>` : ''}`).join('')
      : `<p class="muted small">No accounts connected yet.${status.canManage ? '' : ' Ask your workspace owner or an admin to connect them.'}</p>`;
  }

  async function loadPosts() {
    clearTimeout(poll);
    let posts;
    try { posts = await api('/social/posts?filter=' + filter); } catch (e) { toast(e.message, { error: true }); return; }
    const mine = p => p.user_id === me.user.id || ['owner', 'admin'].includes(me.user.role);
    $('socPosts').innerHTML = posts.map(p => {
      const time = p.status === 'scheduled' ? `🗓 ${S.when(p.scheduled_at)}` : p.published_at ? `Posted ${S.when(p.published_at)}` : S.when(p.created_at);
      const acts = [];
      if (mine(p) && p.status === 'scheduled') acts.push(`<button class="btn btn-ghost btn-sm" data-resched="${p.id}" data-at="${p.scheduled_at}">Change time</button>`, `<button class="btn btn-ghost btn-sm" data-cancel="${p.id}">Cancel</button>`);
      if (mine(p) && ['failed', 'partial'].includes(p.status)) acts.push(`<button class="btn btn-dark btn-sm" data-retry="${p.id}">Retry</button>`);
      if (mine(p) && p.status !== 'publishing') acts.push(`<button class="btn btn-ghost btn-sm" data-del="${p.id}">Remove</button>`);
      return `<div class="soc-post">
        ${p.kind === 'video' ? `<video class="thumb" src="${p.preview}" muted preload="metadata"></video>` : `<img class="thumb" src="${p.preview}" alt="" loading="lazy">`}
        <div class="body">
          <div>${S.badge(p.status)} <span class="meta">${esc(time)}${p.design_name ? ' · ' + esc(p.design_name) : ''}${p.ig_placement === 'story' ? ' · Instagram Story' : ''}</span></div>
          ${p.caption ? `<div class="cap">${esc(p.caption)}</div>` : ''}
          <div class="targets">${p.targets.map(t => `<span class="tgt">${S.ICON[t.platform] || ''}${esc(t.name || 'removed account')} ${S.badge(t.status)}${t.permalink ? ` <a href="${esc(t.permalink)}" target="_blank" rel="noopener">view ↗</a>` : ''}</span>`).join('')}</div>
          ${p.targets.filter(t => t.error).map(t => `<div class="tgt-err">${esc(t.name || '')}: ${esc(t.error)}</div>`).join('')}
        </div>
        <div class="acts">${acts.join('')}</div>
      </div>`;
    }).join('') || `<p class="muted center" style="padding:30px 0">${filter === 'scheduled' ? 'Nothing scheduled. Open a design and click <b>📣 Post</b> → <b>Schedule</b>.' : 'No posts yet.'}</p>`;
    if (posts.some(p => ['publishing'].includes(p.status) || (p.status === 'scheduled' && p.scheduled_at < Date.now() + 120000))) {
      poll = setTimeout(() => { if (location.hash === '#social') loadPosts(); }, 5000);
    }
  }

  $('socTabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    filter = b.dataset.f;
    $('socTabs').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    loadPosts();
  });
  $('socConnect').addEventListener('click', async () => {
    const r = await S.connect();
    if (r && r.ok) { toast(`Connected ${r.n} account${r.n === 1 ? '' : 's'} ✓`); load(); }
    else if (r && r.error) toast(r.error, { error: true, ms: 6000 });
  });
  document.getElementById('view-social').addEventListener('click', async e => {
    const t = e.target.closest('button'); if (!t) return;
    try {
      if (t.dataset.disc && await confirmBox(`Disconnect ${t.dataset.name}?`, 'Scheduled posts to this account will fail until it is connected again.', 'Disconnect', true)) {
        await api('/social/accounts/' + t.dataset.disc, { method: 'DELETE' }); toast('Disconnected'); load();
      }
      if (t.dataset.cancel && await confirmBox('Cancel this scheduled post?', 'It will not be published.', 'Cancel post', true)) {
        await api(`/social/posts/${t.dataset.cancel}/cancel`, { method: 'POST' }); toast('Cancelled'); loadPosts();
      }
      if (t.dataset.retry) { await api(`/social/posts/${t.dataset.retry}/retry`, { method: 'POST' }); toast('Retrying…'); setTimeout(loadPosts, 800); }
      if (t.dataset.del && await confirmBox('Remove this post from PostForge?', 'This only removes it from this list — it does not delete it from Facebook or Instagram.', 'Remove', true)) {
        await api('/social/posts/' + t.dataset.del, { method: 'DELETE' }); loadPosts();
      }
      if (t.dataset.resched) {
        const box = t.closest('.acts');
        if (box.querySelector('.resched')) return;
        box.insertAdjacentHTML('beforeend', `<div class="resched"><input type="datetime-local" class="input" min="${S.localInput(Date.now() + 2 * 60000)}" value="${S.localInput(+t.dataset.at)}" style="font-size:12.5px;padding:5px 7px">
          <button class="btn btn-dark btn-sm" data-save-resched="${t.dataset.resched}" style="margin-top:4px">Save time</button></div>`);
      }
      if (t.dataset.saveResched) {
        const at = new Date(t.parentElement.querySelector('input').value).getTime();
        if (!at) { toast('Pick a date and time', { error: true }); return; }
        await api('/social/posts/' + t.dataset.saveResched, { method: 'PATCH', body: { scheduledAt: at } }); toast('Rescheduled'); loadPosts();
      }
    } catch (ex) { toast(ex.message, { error: true }); }
  });

  // returning from a full-page connect (when pop-ups are blocked)
  window.PFSocialView = { load };
})();
