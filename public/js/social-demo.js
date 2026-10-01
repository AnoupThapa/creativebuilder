(function () {
  'use strict';
  const { api, loadMe } = window.PF;
  const done = q => { location.href = '/social/done?' + q; };
  document.getElementById('cancel').addEventListener('click', () => done('error=' + encodeURIComponent('Connection cancelled.')));
  document.getElementById('go').addEventListener('click', async e => {
    e.target.disabled = true;
    try {
      await loadMe();
      const r = await api('/social/meta/demo', { method: 'POST' });
      done('ok=1&n=' + r.accounts);
    } catch (ex) { done('error=' + encodeURIComponent(ex.message)); }
  });
})();
