/* White-label review portal (client side). No login: the secret link is the key. */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = (location.pathname.match(/^\/r\/([\w-]+)/) || [])[1] || '';
  const API = `/portal-api/${token}`;
  const STATUS = { in_review: ['⏳ Waiting for your review', 'st-in_review'], approved: ['✓ Approved', 'st-approved'], changes: ['✏️ Changes asked', 'st-changes'] };
  const store = { get: k => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch {} } };
  let data = null, filter = 'all', cur = null, curSnap = null;
  const when = t => t ? new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '';

  async function api(path, body) {
    const r = await fetch(API + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong.');
    return j;
  }

  async function load() {
    try { data = await api(''); } catch (e) {
      $('msg').textContent = e.message; $('msg').classList.remove('hidden'); return;
    }
    const p = data.portal;
    document.documentElement.style.setProperty('--acc', p.color);
    document.title = `${p.name} — ${data.brand.name} designs`;
    $('pName').textContent = p.name;
    $('pSub').textContent = `Designs for ${data.brand.name} — review, approve and download`;
    if (p.logo_url) { $('pLogo').src = p.logo_url; $('pLogo').alt = p.name; $('pLogo').classList.remove('hidden'); }
    $('who').value = store.get('pf-portal-name') || '';
    render();
  }

  function render() {
    const list = data.designs.filter(d => filter === 'all' || d.status === filter);
    $('tabs').classList.toggle('hidden', !data.designs.length);
    $('dlApproved').classList.toggle('hidden', !data.designs.some(d => d.status === 'approved'));
    if (!data.designs.length) { $('msg').textContent = 'Nothing to review yet — you’ll find new designs here as soon as they’re ready.'; $('msg').classList.remove('hidden'); }
    $('grid').innerHTML = list.map(d => {
      const s = d.snapshots[0], [lbl, cls] = STATUS[d.status] || ['', ''];
      return `<button class="pt-card" type="button" data-id="${esc(d.id)}"><div class="im">${s ? `<img src="${esc(s.url)}" alt="" loading="lazy">` : ''}</div>
        <div class="bd"><b>${esc(d.name)}</b><span class="pt-badge ${cls}">${lbl}</span><span style="font-size:12px;color:var(--muted)">${d.snapshots.length} size${d.snapshots.length === 1 ? '' : 's'} · ${d.comments.length} comment${d.comments.length === 1 ? '' : 's'}</span></div></button>`;
    }).join('') || (data.designs.length ? '<p style="color:var(--muted)">Nothing here.</p>' : '');
  }
  $('tabs').addEventListener('click', e => {
    const b = e.target.closest('[data-f]'); if (!b) return;
    filter = b.dataset.f; $('tabs').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); render();
  });
  $('grid').addEventListener('click', e => { const c = e.target.closest('[data-id]'); if (c) open(c.dataset.id); });

  function open(id) {
    cur = data.designs.find(d => d.id === id);
    curSnap = cur.snapshots[0];
    $('dName').textContent = cur.name;
    $('dSizes').innerHTML = cur.snapshots.map((s, i) => `<button type="button" data-s="${s.id}" class="${i ? '' : 'on'}">${esc(s.label)}</button>`).join('');
    showSnap(); showSide();
    $('modal').classList.remove('hidden');
  }
  function showSnap() {
    if (!curSnap) { $('dImg').removeAttribute('src'); return; }
    $('dImg').src = curSnap.url; $('dImg').alt = `${cur.name} — ${curSnap.label}`;
    $('dDl').href = curSnap.url + '?download=1';
  }
  function showSide() {
    const [lbl, cls] = STATUS[cur.status] || ['', ''];
    $('dStatus').innerHTML = `<span class="pt-badge ${cls}">${lbl}</span>`;
    $('approve').disabled = cur.status === 'approved';
    $('approve').textContent = cur.status === 'approved' ? '✓ Approved' : '✓ Approve';
    $('thread').innerHTML = cur.comments.slice().reverse().map(c => `<div class="pt-c ${c.author_type}">
      <div class="who">${esc(c.author_name || (c.author_type === 'agency' ? data.portal.name : 'Client'))}
        ${c.action === 'approved' ? '<span class="pt-badge st-approved">approved</span>' : c.action === 'changes' ? '<span class="pt-badge st-changes">asked for changes</span>' : c.action === 'sent' ? '<span class="pt-badge st-in_review">sent for review</span>' : ''}
        <span class="when">${when(c.created_at)}</span></div>${c.body ? `<p>${esc(c.body)}</p>` : ''}</div>`).join('');
  }
  $('dSizes').addEventListener('click', e => {
    const b = e.target.closest('[data-s]'); if (!b) return;
    curSnap = cur.snapshots.find(s => String(s.id) === b.dataset.s);
    $('dSizes').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); showSnap();
  });
  document.querySelectorAll('[data-close]').forEach(el => el.addEventListener('click', () => $('modal').classList.add('hidden')));
  document.addEventListener('keydown', e => { if (e.key === 'Escape') $('modal').classList.add('hidden'); });

  async function act(kind) {
    const name = $('who').value.trim();
    const body = $('note').value.trim();
    if (!name) { alertBox('Please add your name first.'); $('who').focus(); return; }
    if (kind !== 'approve' && !body) { alertBox(kind === 'changes' ? 'Tell us what you’d like changed.' : 'Write a comment first.'); $('note').focus(); return; }
    store.set('pf-portal-name', name);
    const btns = ['approve', 'changesBtn', 'send'].map($); btns.forEach(b => { b.disabled = true; });
    try {
      const r = await api(`/designs/${encodeURIComponent(cur.id)}/${kind === 'changes' ? 'changes' : kind === 'approve' ? 'approve' : 'comment'}`, { name, body });
      cur.status = r.status; cur.comments = r.comments; $('note').value = '';
      showSide(); render();
      alertBox(kind === 'approve' ? 'Approved — thank you! The team has been told.' : kind === 'changes' ? 'Sent — the team will update the design.' : 'Comment sent.');
    } catch (e) { alertBox(e.message); }
    btns.forEach(b => { b.disabled = false; }); showSide();
  }
  $('approve').addEventListener('click', () => act('approve'));
  $('changesBtn').addEventListener('click', () => act('changes'));
  $('send').addEventListener('click', () => act('comment'));
  let tmo;
  function alertBox(t) {
    let el = document.querySelector('.pt-toast');
    if (!el) { el = document.createElement('div'); el.className = 'pt-toast'; el.style.cssText = 'position:fixed;left:50%;bottom:22px;transform:translateX(-50%);background:#1a1a2e;color:#fff;padding:11px 16px;border-radius:12px;font:600 14px var(--FB);z-index:99;max-width:90vw'; document.body.appendChild(el); }
    el.textContent = t; el.style.display = 'block'; clearTimeout(tmo); tmo = setTimeout(() => { el.style.display = 'none'; }, 3500);
  }

  async function zipOf(designs, name) {
    if (typeof JSZip === 'undefined') { alertBox('Download not available in this browser.'); return; }
    const zip = new JSZip();
    for (const d of designs) for (const s of d.snapshots) {
      const b = await (await fetch(s.url)).blob();
      const slug = d.name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'design';
      zip.folder(slug).file(`${slug}-${s.platform}.${b.type === 'image/png' ? 'png' : 'jpg'}`, b);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const slugName = s => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
  $('dDlAll').addEventListener('click', () => zipOf([cur], `${slugName(cur.name) || 'design'}.zip`));
  $('dlApproved').addEventListener('click', () => zipOf(data.designs.filter(d => d.status === 'approved'), `${slugName(data.brand.name) || 'approved'}-approved.zip`));

  load();
})();
