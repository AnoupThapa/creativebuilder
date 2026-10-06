(function () {
  'use strict';
  const { api, esc } = window.PF;
  const $ = id => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const mode = location.pathname.replace('/', '') || 'login';
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  function show(kind, html) {
    $('alert').innerHTML = html ? `<div class="alert alert-${kind}"><div class="grow">${html}</div></div>` : '';
  }
  function busy(form, on) {
    const b = form.querySelector('button[type=submit]');
    b.disabled = on;
    if (on) { b.dataset.label = b.textContent; b.textContent = 'Please wait…'; } else if (b.dataset.label) b.textContent = b.dataset.label;
  }
  // only allow same-site relative redirects (prevents open-redirects)
  function safeNext(def) {
    const n = params.get('next') || '';
    return /^\/(?!\/)[\w\-/?=&#.%]*$/.test(n) ? n : def;
  }
  function devLink(label, link) {
    return link ? `<br><span class="small">Dev mode — ${esc(label)}: <a href="${esc(link)}">open link</a></span>` : '';
  }

  document.querySelectorAll('.pw-toggle').forEach(b => b.addEventListener('click', () => {
    const i = $(b.dataset.for); i.type = i.type === 'password' ? 'text' : 'password';
    b.textContent = i.type === 'password' ? 'Show' : 'Hide';
  }));
  function strength(pw) {
    let s = 0;
    if (pw.length >= 10) s++;
    if (pw.length >= 14) s++;
    if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) s++;
    if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) s++;
    return pw ? Math.max(1, s) : 0;
  }
  [['su-pw', 'su-meter'], ['rs-pw', 'rs-meter'], ['iv-pw', 'iv-meter']].forEach(([i, m]) =>
    $(i).addEventListener('input', e => { $(m).dataset.s = strength(e.target.value); }));

  const msgs = {
    verified: ['ok', 'Email confirmed ✓ — log in to continue.'],
    verify_invalid: ['error', 'That confirmation link is invalid or has expired. Log in to get a new one.'],
    reset: ['ok', 'Password updated ✓ — log in with your new password.'],
  };
  if (msgs[params.get('msg')]) show(...msgs[params.get('msg')]);

  const form = $('f-' + mode) || $('f-login');
  form.classList.remove('hidden');
  document.title = 'PostGenX — ' + ({ login: 'Log in', signup: 'Sign up', forgot: 'Reset password', reset: 'New password', invite: 'Join team' }[mode] || 'Log in');

  /* ---------- LOGIN ---------- */
  $('f-login').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.currentTarget; busy(f, true); show();
    try {
      const r = await api('/auth/login', { method: 'POST', body: { email: $('li-email').value, password: $('li-pw').value, totp: $('li-totp').value || undefined } });
      if (r.needTotp) {
        $('loginCreds').classList.add('hidden'); $('loginTotp').classList.remove('hidden');
        $('li-totp').focus(); show('info', 'Enter the code from your authenticator app.');
        return;
      }
      location.href = safeNext('/app');
    } catch (err) { show('error', esc(err.message)); }
    finally { busy(f, false); }
  });

  /* ---------- SIGNUP ---------- */
  const code = params.get('code');
  if (code) { $('su-code').value = code; $('codeField').classList.remove('hidden'); }
  api('/public/config').then(c => {
    if (c.betaMode) {
      $('codeField').classList.remove('hidden');
      $('su-code').required = true;
      $('signupLead').textContent = 'PostGenX is in private beta. Enter the invite code you were sent.';
    }
  }).catch(() => {});
  const wantPlan = params.get('plan');
  if (params.get('type') === 'business') { const r = document.querySelector('input[name="su-type"][value="business"]'); if (r) r.checked = true; }
  if (wantPlan) $('signupLead').textContent = 'Create your account, then confirm your plan on the next screen.';
  $('f-signup').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.currentTarget; busy(f, true); show();
    try {
      await api('/auth/signup', { method: 'POST', body: {
        name: $('su-name').value, business: $('su-biz').value, email: $('su-email').value,
        password: $('su-pw').value, acceptTerms: $('su-terms').checked, timezone: tz, betaCode: $('su-code').value,
        accountType: (document.querySelector('input[name="su-type"]:checked') || {}).value || 'retail',
      } });
      location.href = wantPlan ? `/app?plan=${encodeURIComponent(wantPlan)}${params.get('interval') === 'year' ? '&interval=year' : ''}#billing` : '/app?welcome=1';
    } catch (err) { show('error', esc(err.message)); busy(f, false); }
  });

  /* ---------- FORGOT ---------- */
  $('f-forgot').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.currentTarget; busy(f, true); show();
    try {
      const r = await api('/auth/forgot', { method: 'POST', body: { email: $('fg-email').value } });
      show('ok', esc(r.message) + devLink('reset link', r.devResetLink));
    } catch (err) { show('error', esc(err.message)); }
    finally { busy(f, false); }
  });

  /* ---------- RESET ---------- */
  if (mode === 'reset') {
    api('/auth/reset-check?token=' + encodeURIComponent(params.get('token') || '')).then(r => {
      if (r.email) show('ok', 'Choose a new password for <b>' + esc(r.email) + '</b>.');
    }).catch(err => {
      show('error', esc(err.message) + ' <a href="/forgot">Get a new link</a>');
      $('f-reset').querySelector('button[type=submit], button:not([type])')?.setAttribute('disabled', '');
    });
  }
  $('f-reset').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.currentTarget; busy(f, true); show();
    try {
      await api('/auth/reset', { method: 'POST', body: { token: params.get('token'), password: $('rs-pw').value } });
      location.href = '/login?msg=reset';
    } catch (err) { show('error', esc(err.message)); busy(f, false); }
  });

  /* ---------- INVITE ---------- */
  if (mode === 'invite') {
    api('/auth/invite?token=' + encodeURIComponent(params.get('token') || '')).then(inv => {
      $('inviteLead').textContent = `You've been invited to ${inv.workspace} as a ${inv.role}.`;
      $('iv-email').value = inv.email;
    }).catch(err => { $('inviteLead').textContent = err.message; $('f-invite').querySelector('button').disabled = true; });
    $('f-invite').addEventListener('submit', async e => {
      e.preventDefault();
      const f = e.currentTarget; busy(f, true); show();
      try {
        await api('/auth/accept-invite', { method: 'POST', body: { token: params.get('token'), name: $('iv-name').value, password: $('iv-pw').value, timezone: tz } });
        location.href = '/app?welcome=1';
      } catch (err) { show('error', esc(err.message)); busy(f, false); }
    });
  }
})();
