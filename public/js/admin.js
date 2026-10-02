(function () {
  'use strict';
  const { api, loadMe, toast, esc, money, date, ago, bytes, confirmBox } = window.PF;
  const $ = id => document.getElementById(id);
  const TITLES = { overview: 'Overview', users: 'Users & workspaces', plans: 'Plans & pricing', audit: 'Audit log', outbox: 'Email outbox',
    support: 'Support inbox', beta: 'Beta & feedback', analytics: 'Site analytics', examples: 'Home page examples', reliability: 'Backups & errors', ai: 'AI studio' };
  let plans = [];
  let me;

  function route() {
    const v = TITLES[location.hash.slice(1)] ? location.hash.slice(1) : 'overview';
    document.querySelectorAll('.view').forEach(s => s.classList.toggle('hidden', s.id !== 'view-' + v));
    document.querySelectorAll('#nav a[data-view]').forEach(a => a.classList.toggle('active', a.dataset.view === v));
    $('viewTitle').textContent = TITLES[v];
    $('sidebar').classList.remove('open');
    ({ overview: loadStats, users: loadUsers, plans: loadPlans, audit: loadAudit, outbox: loadOutbox,
      support: loadSupport, beta: loadBeta, analytics: loadAnalytics, examples: loadExamples, reliability: loadReliability, ai: loadAI })[v]();
  }
  $('menuBtn').addEventListener('click', () => $('sidebar').classList.toggle('open'));

  /* Overview */
  async function loadStats() {
    const s = await api('/admin/stats');
    const seatText = Object.entries(s.paidSeatsByPlan).map(([k, v]) => `${esc(k)}: ${v}`).join(' · ') || 'none yet';
    const tiles = [
      ['Users', s.users, `${s.activeUsers30d} active in 30 days`],
      ['New sign-ups', s.signups7d, 'last 7 days'],
      ['Workspaces', s.workspaces, `${s.paidWorkspaces} on paid plans`],
      ['Est. monthly revenue', money(s.mrrCents), 'Stripe + demo subscriptions'],
      ['Paid seats', Object.values(s.paidSeatsByPlan).reduce((a, b) => a + b, 0), seatText],
      ['Downloads (24h)', s.exports24h, `${s.exports30d} in 30 days`],
      ['Saved designs', s.designs, bytes(s.storageBytes) + ' media stored'],
      ['Security', s.failedLogins24h, `failed logins (24h) · ${s.lockedAccounts} locked`],
    ];
    $('stats').innerHTML = tiles.map(([k, v, sub]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${sub}</div></div>`).join('');
    const days = [];
    for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 86400000).toISOString().slice(0, 10));
    const map = Object.fromEntries(s.dailyExports.map(d => [d.d, d.n]));
    const max = Math.max(1, ...days.map(d => map[d] || 0));
    $('bars').innerHTML = days.map(d => `<div class="b"><em>${map[d] || ''}</em><span class="bar" style="height:${((map[d] || 0) / max) * 100}%"></span><small>${d.slice(8)}</small></div>`).join('');
  }

  /* Users */
  let searchTimer;
  $('userSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadUsers, 250); });
  async function loadUsers() {
    const rows = await api('/admin/users?q=' + encodeURIComponent($('userSearch').value));
    $('userRows').innerHTML = rows.map(u => {
      const locked = u.locked_until && u.locked_until > Date.now();
      return `<tr data-id="${u.id}" data-ws="${u.workspace_id}">
        <td><strong>${esc(u.name)}</strong>${u.is_superadmin ? ' <span class="badge badge-dark">admin</span>' : ''}<br><span class="small muted">${esc(u.email)}</span></td>
        <td>${esc(u.workspace)} <span class="small muted">#${u.workspace_id}</span><br><span class="badge ${u.plan_code === 'free' ? '' : 'badge-coral'}">${esc(u.plan_code)}</span>
          <span class="small muted">${esc(u.role)} · ${u.seats} seat${u.seats > 1 ? 's' : ''}${u.plan_code !== 'free' ? ' · ' + esc(u.sub_status) + ' · ' + esc(u.billing_mode) : ''}</span></td>
        <td>${u.status === 'active' ? '<span class="badge badge-green">active</span>' : '<span class="badge badge-red">' + esc(u.status) + '</span>'}
          ${u.email_verified ? '' : '<span class="badge">unverified</span>'}${u.totp_enabled ? ' <span class="badge badge-blue">2FA</span>' : ''}${locked ? ' <span class="badge badge-red">locked</span>' : ''}</td>
        <td>${u.exports30d}</td>
        <td class="small">${ago(u.last_login_at)}</td>
        <td class="act"><select class="input" data-act style="width:auto;padding:5px 8px">
          <option value="">Action…</option>
          ${u.status === 'active' ? '<option value="suspend">Suspend</option>' : '<option value="activate">Re-activate</option>'}
          ${u.status === 'active' ? '<option value="sendreset">Email a password reset link</option>' : ''}
          ${u.email_verified ? '' : '<option value="verify">Mark email verified</option>'}
          ${locked ? '<option value="unlock">Unlock</option>' : ''}
          ${u.totp_enabled ? '<option value="reset2fa">Reset 2FA</option>' : ''}
          <option value="grant">Grant plan…</option>
          ${u.is_superadmin ? '<option value="demote">Remove admin</option>' : '<option value="promote">Make platform admin</option>'}
        </select></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="center muted">No users found.</td></tr>';
  }
  $('userRows').addEventListener('change', async e => {
    if (!e.target.matches('[data-act]')) return;
    const tr = e.target.closest('tr'), act = e.target.value; e.target.value = '';
    if (act === 'sendreset') {
      try {
        const r = await api('/admin/users/' + tr.dataset.id + '/send-reset', { method: 'POST' });
        toast(r.sending ? 'Reset link emailed to the user ✓' : 'Email sending is off — copy the link from Email outbox and send it yourself');
      } catch (err) { toast(err.message, { error: true }); }
      return;
    }
    if (act === 'grant') { location.hash = 'plans'; setTimeout(() => { $('gWs').value = tr.dataset.ws; $('gWs').focus(); }, 50); return; }
    const body = { suspend: { status: 'suspended' }, activate: { status: 'active' }, verify: { email_verified: true }, unlock: { unlock: true },
      reset2fa: { reset2fa: true }, promote: { is_superadmin: true }, demote: { is_superadmin: false } }[act];
    if (!body) return;
    if (['suspend', 'promote', 'reset2fa'].includes(act) && !(await confirmBox('Are you sure?', `This will ${act === 'suspend' ? 'sign the user out and block access' : act === 'promote' ? 'give full platform admin access' : 'remove their 2-step verification'}.`, 'Yes', act === 'suspend'))) return;
    try { await api('/admin/users/' + tr.dataset.id, { method: 'PATCH', body }); toast('Updated ✓'); loadUsers(); }
    catch (err) { toast(err.message, { error: true }); }
  });

  /* Plans */
  const COLS = [['name', 'text'], ['price_cents', 'number'], ['price_cents_annual', 'number'], ['quota_limit', 'number'], ['quota_period', 'period'], ['daily_limit', 'number'], ['max_quality', 'number'],
    ['video_export', 'bool'], ['batch_export', 'bool'], ['premium_templates', 'bool'], ['watermark', 'bool'], ['max_designs', 'number'],
    ['max_brand_kits', 'number'], ['max_upload_mb', 'number'], ['storage_mb', 'number'], ['public', 'bool'], ['active', 'bool'], ['stripe_price_id', 'text'], ['stripe_price_id_annual', 'text']];
  async function loadPlans() {
    plans = await api('/admin/plans');
    $('planRows').innerHTML = plans.map(p => `<tr data-code="${esc(p.code)}"><td class="mono">${esc(p.code)}</td>${COLS.map(([k, t]) => {
      if (t === 'bool') return `<td><input type="checkbox" data-k="${k}" ${p[k] ? 'checked' : ''}></td>`;
      if (t === 'period') return `<td><select data-k="${k}">${['day', 'month', 'lifetime'].map(o => `<option ${o === p[k] ? 'selected' : ''}>${o}</option>`).join('')}</select></td>`;
      return `<td><input type="${t}" data-k="${k}" value="${esc(p[k])}" ${k === 'max_quality' ? 'min="1" max="3"' : ''} style="${k === 'name' || k.startsWith('stripe_price_id') ? 'min-width:120px' : ''}"></td>`;
    }).join('')}<td><button class="btn btn-dark btn-sm" data-save>Save</button></td></tr>`).join('');
    $('gPlan').innerHTML = plans.map(p => `<option value="${esc(p.code)}">${esc(p.name)}</option>`).join('');
  }
  $('planRows').addEventListener('click', async e => {
    if (!e.target.matches('[data-save]')) return;
    const tr = e.target.closest('tr');
    const body = {};
    tr.querySelectorAll('[data-k]').forEach(i => { body[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; });
    try { await api('/admin/plans/' + tr.dataset.code, { method: 'PUT', body }); toast('Plan saved ✓'); loadPlans(); }
    catch (err) { toast(err.message, { error: true }); }
  });
  $('newPlan').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api('/admin/plans', { method: 'POST', body: { code: $('npCode').value, name: $('npName').value, price_cents: $('npPrice').value,
        quota_limit: $('npQuota').value, quota_period: $('npPeriod').value, max_quality: 2, batch_export: true, premium_templates: true, public: false } });
      toast('Plan created (hidden until you tick Public) ✓'); e.target.reset(); loadPlans();
    } catch (err) { toast(err.message, { error: true }); }
  });
  $('grantForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      await api(`/admin/workspaces/${encodeURIComponent($('gWs').value)}/plan`, { method: 'POST', body: { plan: $('gPlan').value, seats: $('gSeats').value, days: $('gDays').value } });
      toast('Plan granted ✓');
    } catch (err) { toast(err.message, { error: true }); }
  });

  /* Audit */
  $('auditFilter').addEventListener('change', loadAudit);
  async function loadAudit() {
    const rows = await api('/admin/audit?action=' + encodeURIComponent($('auditFilter').value));
    $('auditRows').innerHTML = rows.map(r => `<tr><td class="small" title="${esc(new Date(r.created_at).toLocaleString())}">${ago(r.created_at)}</td>
      <td class="mono">${esc(r.action)}</td><td class="small">${esc(r.email || (r.user_id ? '#' + r.user_id : '—'))}</td>
      <td class="small mono">${esc(r.ip || '')}</td><td class="small mono">${esc(r.detail === '{}' ? '' : r.detail).slice(0, 160)}</td></tr>`).join('')
      || '<tr><td colspan="5" class="center muted">No events.</td></tr>';
  }

  /* Outbox */
  const MAIL_BADGE = { sent: '<span class="badge badge-green">delivered to email</span>', failed: '<span class="badge badge-red">failed</span>',
    sending: '<span class="badge">sending…</span>', not_sent: '<span class="badge">not sent – email not set up</span>' };
  function renderMailStatus(st) {
    const box = $('mailStatus');
    if (!st.configured) {
      box.innerHTML = `<strong>📭 Email sending is OFF.</strong> <span class="small">Password reset and confirmation emails are only saved below, not delivered.
        Add SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS and MAIL_FROM in Fly.io → Secrets to turn it on.
        Until then, copy a reset link from below and send it to the person yourself.</span>`;
      return;
    }
    box.innerHTML = `<div class="row wrap" style="gap:8px"><div class="grow">${st.ok === false
        ? `<strong>⚠️ Email sending is set up but not working.</strong><br><span class="small">${esc(st.error)}</span><br><span class="small"><b>How to fix:</b> ${esc(st.hint || 'Check the SMTP_* settings in Fly.io → Secrets.')}</span>`
        : `<strong>✅ Email sending is ON</strong> <span class="small muted">from ${esc(st.from)} via ${esc(st.host)}</span>`}</div>
      <input class="input" id="testTo" type="email" placeholder="Send a test to…" style="width:220px">
      <button class="btn btn-dark btn-sm" id="btnTestMail">Send test email</button></div>`;
    $('btnTestMail').onclick = async () => {
      $('btnTestMail').disabled = true;
      try {
        const r = await api('/admin/test-email', { method: 'POST', body: { to: $('testTo').value || undefined } });
        toast(r.ok ? 'Test email sent ✓ — check the inbox (and Spam)' : 'Sending failed: ' + r.error, { error: !r.ok });
        loadOutbox();
      } catch (err) { toast(err.message, { error: true }); }
      $('btnTestMail').disabled = false;
    };
  }
  async function loadOutbox() {
    api('/admin/mail-status?check=1').then(renderMailStatus).catch(() => {});
    const rows = await api('/admin/outbox');
    $('outboxList').innerHTML = rows.map(m => `<div class="card"><div class="row wrap"><strong class="grow">${esc(m.subject)}</strong>${MAIL_BADGE[m.status] || ''}<span class="small muted">${ago(m.created_at)}</span></div>
      <div class="small muted">to ${esc(m.to_email)}${m.error ? ' · <span style="color:#c0392b">' + esc(m.error) + '</span>' : ''}</div><pre class="mail">${esc(m.body)}</pre></div>`).join('') || '<p class="muted">No emails yet.</p>';
  }

  /* Support inbox */
  let supStatus = 'open';
  $('supTabs').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    supStatus = b.dataset.s;
    $('supTabs').querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    loadSupport();
  });
  async function loadSupport() {
    const rows = await api('/admin/support?status=' + supStatus);
    $('supList').innerHTML = rows.map(t => `<div class="card"><div class="row wrap"><strong class="grow">PF-${String(t.id).padStart(5, '0')} · ${esc(t.topic)}</strong>
      <span class="small muted">${ago(t.created_at)}</span>
      <a class="btn btn-ghost btn-sm" href="mailto:${esc(t.email)}?subject=${encodeURIComponent('Re: your PostForge message PF-' + String(t.id).padStart(5, '0'))}">Reply by email</a>
      <button class="btn btn-sm ${t.status === 'open' ? 'btn-dark' : 'btn-ghost'}" data-close="${t.id}" data-to="${t.status === 'open' ? 'closed' : 'open'}">${t.status === 'open' ? 'Mark done' : 'Reopen'}</button></div>
      <div class="small muted">${esc(t.name)} &lt;${esc(t.email)}&gt;${t.user_id ? ' · user #' + t.user_id : ' · not logged in'}${t.page ? ' · from ' + esc(t.page) : ''}</div>
      <pre class="mail">${esc(t.message)}</pre></div>`).join('') || `<p class="muted">No ${supStatus} messages.</p>`;
  }
  $('supList').addEventListener('click', async e => {
    const b = e.target.closest('[data-close]'); if (!b) return;
    await api('/admin/support/' + b.dataset.close, { method: 'PATCH', body: { status: b.dataset.to } });
    loadSupport();
  });

  /* Beta codes + feedback */
  async function loadBeta() {
    if (!plans.length) plans = await api('/admin/plans');
    if (!$('bcPlan').options.length) $('bcPlan').innerHTML = plans.map(p => `<option value="${esc(p.code)}"${p.code === 'pro' ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
    const [codes, fb] = await Promise.all([api('/admin/beta-codes'), api('/admin/feedback')]);
    $('betaRows').innerHTML = codes.map(c => {
      const link = `${location.origin}/signup?code=${encodeURIComponent(c.code)}`;
      return `<tr><td class="mono"><b>${esc(c.code)}</b></td><td class="small">${esc(c.note)}</td><td>${c.uses} / ${c.max_uses}</td>
        <td class="small">${c.plan_days ? `${esc(c.plan_code)} for ${c.plan_days} days` : 'Free plan'}</td>
        <td><button class="btn btn-ghost btn-sm" data-copy="${esc(link)}">Copy link</button></td>
        <td><button class="btn btn-ghost btn-sm" data-del="${esc(c.code)}">Delete</button></td></tr>`;
    }).join('') || '<tr><td colspan="6" class="center muted">No invite codes yet.</td></tr>';
    const avg = fb.length ? (fb.reduce((s, f) => s + f.rating, 0) / fb.length).toFixed(1) : '—';
    $('fbSummary').innerHTML = `<b>${fb.length}</b> responses · average rating <b>${avg}</b> ★ · <b>${fb.filter(f => f.approved).length}</b> testimonials live`;
    $('fbRows').innerHTML = fb.map(f => `<tr><td class="small">${ago(f.created_at)}</td><td>${'★'.repeat(f.rating)}<span class="muted">${'★'.repeat(5 - f.rating)}</span></td>
      <td class="small" style="max-width:380px">${esc(f.message) || '<span class="muted">—</span>'}</td>
      <td class="small">${esc(f.display_name || '')}${f.business ? ', ' + esc(f.business) : ''}<br><span class="muted">${esc(f.email || '')}</span></td>
      <td>${f.allow_quote ? `<button class="btn btn-sm ${f.approved ? 'btn-ghost' : 'btn-dark'}" data-approve="${f.id}" data-to="${f.approved ? 0 : 1}">${f.approved ? 'Hide from site' : 'Show on site'}</button>` : '<span class="small muted">Private</span>'}</td></tr>`).join('')
      || '<tr><td colspan="5" class="center muted">No feedback yet.</td></tr>';
  }
  $('betaForm').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await api('/admin/beta-codes', { method: 'POST', body: { code: $('bcCode').value, note: $('bcNote').value, max_uses: $('bcUses').value, plan_code: $('bcPlan').value, plan_days: $('bcDays').value } });
      toast('Code ' + r.code + ' created'); $('bcCode').value = ''; loadBeta();
    } catch (ex) { toast(ex.message, { error: true }); }
  });
  $('view-beta').addEventListener('click', async e => {
    const c = e.target.closest('[data-copy]'), d = e.target.closest('[data-del]'), a = e.target.closest('[data-approve]');
    try {
      if (c) { await navigator.clipboard.writeText(c.dataset.copy).catch(() => prompt('Copy this link:', c.dataset.copy)); toast('Link copied'); }
      if (d && await confirmBox(`Delete code ${d.dataset.del}?`, 'People who have not signed up yet will not be able to use it.', 'Delete', true)) { await api('/admin/beta-codes/' + encodeURIComponent(d.dataset.del), { method: 'DELETE' }); loadBeta(); }
      if (a) { await api('/admin/feedback/' + a.dataset.approve, { method: 'PATCH', body: { approved: a.dataset.to === '1' } }); loadBeta(); }
    } catch (ex) { toast(ex.message, { error: true }); }
  });

  /* Home page examples */
  async function loadExamples() {
    const rows = await api('/admin/examples');
    $('exGrid').innerHTML = rows.map(e => `<div class="card" style="margin:0"><div style="display:grid;grid-template-columns:1fr 1fr;gap:6px">
      <img src="/site/${esc(e.before_file)}" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px">
      <img src="/site/${esc(e.after_file)}" alt="" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:8px"></div>
      <div class="small" style="margin:8px 0"><b>${esc(e.industry)}</b> ${esc(e.caption)}</div>
      <button class="btn btn-ghost btn-sm" data-exdel="${e.id}">Remove</button></div>`).join('')
      || '<p class="muted">No examples yet — the home page is showing the built-in samples.</p>';
  }
  $('exForm').addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('before', $('exBefore').files[0]); fd.append('after', $('exAfter').files[0]);
    fd.append('industry', $('exIndustry').value); fd.append('caption', $('exCaption').value);
    try { await api('/admin/examples', { method: 'POST', form: fd }); toast('Example added'); e.target.reset(); loadExamples(); }
    catch (ex) { toast(ex.message, { error: true }); }
  });
  $('exGrid').addEventListener('click', async e => {
    const b = e.target.closest('[data-exdel]'); if (!b) return;
    if (await confirmBox('Remove this example?', 'It disappears from the home page.', 'Remove', true)) { await api('/admin/examples/' + b.dataset.exdel, { method: 'DELETE' }); loadExamples(); }
  });

  /* Analytics */
  function bars(el, rows, key, label) {
    const max = Math.max(1, ...rows.map(r => r[key]));
    el.innerHTML = rows.map(r => `<div class="b"><em>${r[key]}</em><span class="bar" style="height:${(r[key] / max) * 100}%"></span><small>${label(r)}</small></div>`).join('') || '<p class="muted">No data yet.</p>';
  }
  async function loadAnalytics() {
    const a = await api('/admin/analytics?days=30');
    const sum = (rows, k) => rows.reduce((s, r) => s + r[k], 0);
    const signups = sum(a.signups, 'n'), visitors = sum(a.daily, 'visitors');
    $('anStats').innerHTML = [['Visitors (30d)', visitors], ['Page views (30d)', sum(a.daily, 'views')], ['Sign-ups (30d)', signups],
      ['Visitor → sign-up', visitors ? (signups / visitors * 100).toFixed(1) + '%' : '—']]
      .map(([k, v]) => `<div class="stat"><div class="k">${k}</div><div class="v">${v}</div></div>`).join('');
    bars($('anBars'), a.daily.slice(-30), 'visitors', r => r.day.slice(8));
    $('anPages').innerHTML = a.pages.map(p => `<tr><td class="mono">${esc(p.path)}</td><td style="text-align:right">${p.visitors} visitors</td></tr>`).join('') || '<tr><td class="muted">No data yet.</td></tr>';
    $('anRefs').innerHTML = a.referrers.map(r => `<tr><td>${esc(r.referrer)}</td><td style="text-align:right">${r.views}</td></tr>`).join('') || '<tr><td class="muted">No referrers yet.</td></tr>';
  }

  /* Reliability */
  function verifyHtml(v) {
    if (!v) return '<div class="alert alert-warn"><div class="grow">No restore test recorded yet. Run one before launch.</div></div>';
    return `<div class="alert ${v.ok ? 'alert-ok' : 'alert-error'}"><div class="grow">${v.ok ? '✓ Restore test passed' : '✗ Restore test FAILED'} for backup <b>${esc(v.backup || '?')}</b> ${v.checkedAt ? ago(v.checkedAt) : ''} —
      integrity: ${esc(v.integrity || '?')}, users ${v.counts?.users ?? '?'}, designs ${v.counts?.designs ?? '?'}, files missing: ${v.missingFiles ?? '?'}${v.error ? ' — ' + esc(v.error) : ''}</div></div>`;
  }
  async function loadReliability() {
    $('healthUrl').textContent = location.origin + '/health';
    const [b, errs] = await Promise.all([api('/admin/backups'), api('/admin/errors')]);
    const last = b.backups[0];
    $('bkInfo').innerHTML = `Automatic daily backup · keeps the last 14 · ${b.offsite ? 'off-site copy: <b>on</b>' : 'off-site copy: <b>not set up</b> (set BACKUP_S3_* in settings)'} · last backup: <b>${last ? ago(last.created_at) : 'never'}</b>`;
    $('bkVerify').innerHTML = verifyHtml(b.lastVerify);
    $('bkRows').innerHTML = b.backups.map(x => `<tr><td class="mono">${esc(x.name)}</td><td class="small">${esc(x.reason)}</td><td class="small">${bytes(x.db_gz_bytes)}</td>
      <td>${x.counts.users}</td><td>${x.counts.designs}</td><td>${x.counts.media}</td><td class="small">${esc(x.offsite)}</td></tr>`).join('') || '<tr><td colspan="7" class="center muted">No backups yet — click “Back up now”.</td></tr>';
    $('errRows').innerHTML = errs.map(e => `<tr><td class="small">${ago(e.last_seen)}</td><td>${e.count}</td>
      <td class="small" style="max-width:420px"><b>${esc(e.message)}</b>${e.stack ? `<details><summary class="small muted">details</summary><pre class="mail">${esc(e.stack)}</pre></details>` : ''}</td>
      <td class="small mono">${esc(e.page || '')}<br>${esc(e.source || '')}</td><td class="small muted" style="max-width:200px">${esc((e.user_agent || '').slice(0, 90))}</td></tr>`).join('')
      || '<tr><td colspan="5" class="center muted">No errors recorded. 🎉</td></tr>';
  }
  $('btnBackup').addEventListener('click', async e => {
    e.target.disabled = true;
    try { const r = await api('/admin/backups', { method: 'POST' }); toast('Backup ' + r.name + ' created'); loadReliability(); }
    catch (ex) { toast(ex.message, { error: true }); } finally { e.target.disabled = false; }
  });
  $('btnVerify').addEventListener('click', async e => {
    e.target.disabled = true;
    try { const r = await api('/admin/backups/verify', { method: 'POST', body: {} }); toast(r.ok ? 'Restore test passed ✓' : 'Restore test failed', { error: !r.ok }); loadReliability(); }
    catch (ex) { toast(ex.message, { error: true }); } finally { e.target.disabled = false; }
  });
  $('btnClearErr').addEventListener('click', async () => { if (await confirmBox('Clear all recorded errors?', 'The list starts fresh.', 'Clear')) { await api('/admin/errors', { method: 'DELETE' }); loadReliability(); } });

  /* AI studio */
  const PROVIDER_NAME = { gemini: 'Google Gemini', openai: 'OpenAI', demo: 'Demo mode (no AI key yet)' };
  let aiTpls = [];
  async function loadAI() {
    const s = await api('/admin/ai');
    aiTpls = s.templates;
    const live = s.provider !== 'demo';
    $('aiStatus').innerHTML = live
      ? `<strong>${s.enabled ? '✅ AI images are ON' : '⏸ AI images are PAUSED'}</strong> <span class="small muted">using ${esc(PROVIDER_NAME[s.provider])} · model ${esc(s.models[s.provider])}</span>`
      : `<strong>🧪 Demo mode.</strong> <span class="small">No AI key is set, so customers get sample pictures (free to you). To switch on real AI images add
         <b>GEMINI_API_KEY</b> (recommended) or <b>OPENAI_API_KEY</b> in Fly.io → Secrets. The app restarts by itself and this page will say which service is in use.</span>`;
    const t = s.today, m = s.month;
    const tiles = [
      ['Images today', t.images, `${t.jobs} requests · ${t.failed} failed`],
      ['Cost today', '$' + t.cost.toFixed(2), `cap $${Number(s.dailyBudget).toFixed(0)} a day`],
      ['Images this month', m.images, `${m.failed} failed (credits refunded)`],
      ['Cost this month', '$' + m.cost.toFixed(2), 'estimated from the AI price list'],
      ['Working now', s.queue.running, `${s.queue.waiting} waiting`],
    ];
    $('aiStats').innerHTML = tiles.map(([k, v, sub]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(sub)}</div></div>`).join('');
    $('aiEnabled').checked = s.enabled;
    $('aiBudget').value = s.dailyBudget;
    $('aiErrs').innerHTML = s.recentErrors.map(e => `<tr><td class="small">${ago(e.created_at)}</td><td class="mono small">${esc(e.template_key)}</td>
      <td class="small">${esc(e.provider || '')}</td><td class="small">${esc(e.error || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="center muted">No failures. 🎉</td></tr>';
    $('aiTpls').innerHTML = aiTpls.map(t => `<details class="card" data-id="${t.id}" style="margin:8px 0;padding:10px 14px">
      <summary class="row wrap" style="cursor:pointer;gap:8px"><span>${esc(t.emoji || '✨')}</span><strong class="grow">${esc(t.name)}</strong>
        <span class="badge">${esc(t.industry)}</span>${t.needs_photo ? '<span class="badge badge-blue">needs photo</span>' : ''}${t.active ? '<span class="badge badge-green">shown</span>' : '<span class="badge badge-red">hidden</span>'}</summary>
      <div style="margin-top:10px;display:grid;gap:8px">
        <label class="small muted">Name<input class="input" data-k="name" value="${esc(t.name)}"></label>
        <label class="small muted">Short description<input class="input" data-k="description" value="${esc(t.description || '')}"></label>
        <label class="small muted">Default scene (used when the customer leaves it empty)<input class="input" data-k="setting" value="${esc(t.setting || '')}"></label>
        <label class="small muted">Prompt<textarea class="input" data-k="prompt" rows="6" style="font-family:inherit">${esc(t.prompt)}</textarea></label>
        <div class="row wrap" style="gap:14px">
          <label class="small">Space for text <select class="input" data-k="text_space" style="width:auto">${['top', 'left', 'bottom', 'none'].map(o => `<option ${o === t.text_space ? 'selected' : ''}>${o}</option>`).join('')}</select></label>
          <label class="small row" style="gap:6px"><input type="checkbox" data-k="needs_photo" ${t.needs_photo ? 'checked' : ''}> Customer must upload a photo</label>
          <label class="small row" style="gap:6px"><input type="checkbox" data-k="active" ${t.active ? 'checked' : ''}> Show to customers</label>
          <button class="btn btn-dark btn-sm" data-save>Save style</button>
        </div>
      </div></details>`).join('');
  }
  $('aiTpls').addEventListener('click', async e => {
    if (!e.target.matches('[data-save]')) return;
    const box = e.target.closest('[data-id]');
    const body = {};
    box.querySelectorAll('[data-k]').forEach(i => { body[i.dataset.k] = i.type === 'checkbox' ? i.checked : i.value; });
    try { await api('/admin/ai/templates/' + box.dataset.id, { method: 'PUT', body }); toast('Style saved ✓'); loadAI(); }
    catch (err) { toast(err.message, { error: true }); }
  });
  $('aiSave').addEventListener('click', async () => {
    try { await api('/admin/ai/settings', { method: 'PATCH', body: { enabled: $('aiEnabled').checked, dailyBudget: $('aiBudget').value } }); toast('AI settings saved ✓'); loadAI(); }
    catch (err) { toast(err.message, { error: true }); }
  });
  $('aiTest').addEventListener('click', async e => {
    e.target.disabled = true;
    $('aiTestOut').textContent = 'Asking the AI for a test picture… (up to a minute)';
    try {
      const r = await api('/admin/ai/test', { method: 'POST', body: {} });
      $('aiTestOut').innerHTML = r.ok
        ? `✅ Working — ${esc(PROVIDER_NAME[r.provider] || r.provider)} (${esc(r.model)}) made a test picture:<br><img src="${r.preview}" alt="AI test image" style="width:180px;border-radius:12px;margin-top:8px">`
        : `❌ Not working: ${esc(r.error)}${r.detail ? `<details><summary class="muted">technical details</summary><pre class="mail">${esc(r.detail)}</pre></details>` : ''}`;
    } catch (err) { $('aiTestOut').textContent = '❌ ' + err.message; }
    e.target.disabled = false;
  });
  $('aiGrant').addEventListener('submit', async e => {
    e.preventDefault();
    try {
      const r = await api(`/admin/workspaces/${encodeURIComponent($('aiGrantWs').value.replace('#', ''))}/ai-credits`, { method: 'POST', body: { credits: $('aiGrantN').value } });
      toast(`Done ✓ — extra AI credits now ${r.balance}`); e.target.reset();
    } catch (err) { toast(err.message, { error: true }); }
  });

  loadMe().then(m => { me = m; window.addEventListener('hashchange', route); route(); }).catch(e => toast(e.message, { error: true }));
})();
