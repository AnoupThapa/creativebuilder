/* Shared browser helpers: API calls with CSRF header, toasts, escaping. */
(function () {
  'use strict';
  let csrf = null;

  async function api(path, { method = 'GET', body, form, _retried = false } = {}) {
    const headers = {};
    if (csrf && method !== 'GET') headers['X-CSRF-Token'] = csrf;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch('/api' + path, { method, headers, body: payload, credentials: 'same-origin' });
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && !path.startsWith('/auth/')) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search);
      throw Object.assign(new Error('Please log in.'), { status: 401 });
    }
    // The security token went stale (logged in/out in another tab): fetch a fresh one and retry once
    if (res.status === 403 && data && data.code === 'csrf' && !_retried) {
      try { const me = await fetch('/api/me', { credentials: 'same-origin' }).then(r => r.json()); if (me && me.csrf) csrf = me.csrf; } catch { /* ignore */ }
      return api(path, { method, body, form, _retried: true });
    }
    if (!res.ok) {
      const err = new Error((data && data.error) || `Request failed (${res.status})`);
      err.status = res.status; err.data = data || {};
      throw err;
    }
    return data;
  }

  async function loadMe() {
    const me = await api('/me');
    csrf = me.csrf;
    return me;
  }

  let toastTimer;
  function toast(msg, { error = false, ms = 2800 } = {}) {
    let t = document.getElementById('toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.toggle('error', !!error);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), ms);
  }

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const money = (cents, cur = 'usd') => new Intl.NumberFormat(undefined, { style: 'currency', currency: cur.toUpperCase(), maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
  const date = ms => ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : '—';
  const ago = ms => {
    if (!ms) return 'never';
    const s = (Date.now() - ms) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' d ago';
    return date(ms);
  };
  const bytes = n => n < 1024 * 1024 ? (n / 1024).toFixed(0) + ' KB' : n < 1024 ** 3 ? (n / 1024 / 1024).toFixed(1) + ' MB' : (n / 1024 ** 3).toFixed(2) + ' GB';
  const quotaLabel = p => {
    const n = (v, u) => `${v} image${v === 1 ? '' : 's'} ${u}`;
    if (p.quota_period === 'lifetime') return n(p.quota_limit, 'to try');
    if (p.quota_period === 'day') return n(p.quota_limit, 'a day');
    return p.daily_limit ? `${n(p.daily_limit, 'a day')} (up to ${p.quota_limit}/month)` : n(p.quota_limit, 'a month');
  };
  /* "3 / 5 today · 42 / 100 this month" */
  const usageText = u => {
    if (!u) return '';
    if (!u.day && !u.month) return `${u.used} / ${u.limit} used`;
    return [u.day && `${u.day.used} / ${u.day.limit} today`, u.month && `${u.month.used} / ${u.month.limit} this month`].filter(Boolean).join(' · ');
  };

  function confirmBox(title, text, okLabel = 'Confirm', danger = false) {
    return new Promise(resolve => {
      const wrap = document.createElement('div');
      wrap.className = 'modal-wrap open';
      wrap.innerHTML = `<div class="modal-backdrop"></div><div class="modal" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3><p class="muted">${esc(text)}</p>
        <div class="modal-actions"><button class="btn btn-ghost" data-a="no">Cancel</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-a="yes">${esc(okLabel)}</button></div></div>`;
      document.body.appendChild(wrap);
      const done = v => { wrap.remove(); resolve(v); };
      wrap.addEventListener('click', e => {
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'yes') done(true); else if (a === 'no' || e.target.classList.contains('modal-backdrop')) done(false);
      });
      wrap.querySelector('[data-a="yes"]').focus();
    });
  }

  window.PF = { api, loadMe, toast, esc, money, date, ago, bytes, quotaLabel, usageText, confirmBox, setCsrf: v => { csrf = v; }, csrf: () => csrf };
})();
