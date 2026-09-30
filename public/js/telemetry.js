/* Cookie-free page analytics + browser error reporting (sent to our own server only). */
(function () {
  'use strict';
  const send = (url, data) => {
    const body = JSON.stringify(data);
    try {
      if (navigator.sendBeacon) { navigator.sendBeacon(url, new Blob([body], { type: 'application/json' })); return; }
    } catch (e) { /* fall through */ }
    fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
  };
  // page view (path only — no query strings, no cookies)
  // count marketing pages only (not the signed-in app)
  if (['/', '/help', '/signup', '/login'].includes(location.pathname)) send('/api/pv', { path: location.pathname, ref: document.referrer });

  // uncaught errors (max 5 per page load)
  let sent = 0;
  function report(message, source, stack) {
    if (sent++ >= 5 || !message) return;
    send('/api/client-error', { message: String(message).slice(0, 500), source: String(source || '').slice(0, 300), stack: String(stack || '').slice(0, 3000), page: location.pathname });
  }
  window.addEventListener('error', e => {
    if (e.target && e.target !== window && (e.target.src || e.target.href)) return; // resource load errors are noise
    report(e.message, (e.filename || '') + ':' + (e.lineno || 0) + ':' + (e.colno || 0), e.error && e.error.stack);
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason || {};
    if (r.status === 401 || r.status === 402 || r.status === 403) return; // expected API answers
    report('Unhandled promise: ' + (r.message || r), '', r.stack);
  });

  // optional Plausible analytics (only when configured on the server)
  fetch('/api/public/config', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(c => {
    window.PF_PUBLIC = c || {};
    if (c && c.plausibleDomain) {
      const s = document.createElement('script');
      s.defer = true; s.src = 'https://plausible.io/js/script.js'; s.dataset.domain = c.plausibleDomain;
      document.head.appendChild(s);
    }
    document.dispatchEvent(new CustomEvent('pf:config', { detail: window.PF_PUBLIC }));
  }).catch(() => {});
})();
