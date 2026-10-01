/* Last page of the "Connect Facebook & Instagram" pop-up: tells the opener and closes. */
(function () {
  'use strict';
  const p = new URLSearchParams(location.search);
  const ok = p.get('ok') === '1';
  const n = parseInt(p.get('n') || '0', 10);
  const error = p.get('error') || '';
  document.getElementById('ico').textContent = ok ? '✅' : '⚠️';
  document.getElementById('title').textContent = ok ? 'Accounts connected' : 'Not connected';
  document.getElementById('msg').textContent = ok
    ? `${n} account${n === 1 ? '' : 's'} ready for posting. This window will close.`
    : error || 'Something went wrong. Please try again.';
  if (window.opener && !window.opener.closed) {
    try { window.opener.postMessage({ type: 'pf-social-connected', ok, n, error }, location.origin); } catch { /* ignore */ }
    if (ok) setTimeout(() => window.close(), 1500);
    document.getElementById('back').textContent = 'Close this window';
    document.getElementById('back').addEventListener('click', e => { e.preventDefault(); window.close(); });
  }
})();
