/* Shared helpers for social media publishing (dashboard + editor). */
(function () {
  'use strict';
  const esc = s => window.PF.esc(s);

  const ICON = {
    facebook: '<span class="soc-ico soc-fb" aria-label="Facebook">f</span>',
    instagram: '<span class="soc-ico soc-ig" aria-label="Instagram">◎</span>',
  };
  const STATUS = {
    scheduled: ['Scheduled', ''], publishing: ['Posting…', 'busy'], published: ['Posted', 'ok'],
    partial: ['Partly posted', 'bad'], failed: ['Failed', 'bad'], cancelled: ['Cancelled', ''], pending: ['Waiting', ''],
  };
  const badge = s => { const [t, c] = STATUS[s] || [s, '']; return `<span class="soc-badge ${c}">${t}</span>`; };
  const accountLabel = a => `${ICON[a.platform] || ''}<span class="soc-name">${esc(a.name || '')}${a.username ? ` <span class="muted">@${esc(a.username)}</span>` : ''}</span>${a.demo ? ' <span class="soc-badge" style="margin-left:6px">demo</span>' : ''}`;

  /* Opens Facebook's own login/permission pop-up. Resolves {ok, n, error} when it finishes. */
  function connect() {
    return new Promise(resolve => {
      const w = 600, h = 720;
      const left = Math.max(0, (screen.width - w) / 2), top = Math.max(0, (screen.height - h) / 2);
      const pop = window.open('/api/social/meta/start', 'pf-connect', `width=${w},height=${h},left=${left},top=${top}`);
      if (!pop) { location.href = '/api/social/meta/start'; return; } // pop-ups blocked (e.g. some phones): use the same tab
      let done = false;
      const onMsg = e => {
        if (e.origin !== location.origin || !e.data || e.data.type !== 'pf-social-connected') return;
        done = true; window.removeEventListener('message', onMsg); clearInterval(t); resolve(e.data);
      };
      window.addEventListener('message', onMsg);
      const t = setInterval(() => { if (pop.closed && !done) { clearInterval(t); window.removeEventListener('message', onMsg); resolve({ ok: false, closed: true }); } }, 600);
    });
  }

  const when = ts => ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
  /* value for <input type="datetime-local"> in the viewer's own time zone */
  function localInput(ts) {
    const d = new Date(ts), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  window.PFSocial = { ICON, badge, accountLabel, connect, when, localInput };
})();
