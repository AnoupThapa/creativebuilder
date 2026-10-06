(function () {
  'use strict';
  const { api, esc } = window.PF;
  const $ = id => document.getElementById(id);
  $('yr').textContent = new Date().getFullYear();

  /* search: filter questions as you type, open matches */
  $('q').addEventListener('input', e => {
    const term = e.target.value.trim().toLowerCase();
    let any = false;
    document.querySelectorAll('#faq section:not([hidden])').forEach(sec => {
      let secAny = false;
      sec.querySelectorAll('details').forEach(d => {
        const hit = !term || d.textContent.toLowerCase().includes(term);
        d.style.display = hit ? '' : 'none';
        d.open = !!term && hit;
        if (hit) secAny = true;
      });
      sec.style.display = secAny ? '' : 'none';
      if (secAny) any = true;
    });
    $('none').style.display = any ? 'none' : 'block';
  });
  if (new URLSearchParams(location.search).get('topic') === 'beta') {
    $('sTopic').value = 'beta';
    $('sMsg').placeholder = 'Tell us about your business: name, type (café, salon, shop…), city, and how often you post on social media.';
  }
  if (location.hash === '#contact') setTimeout(() => $('sMsg').focus(), 300);

  /* prefill for signed-in users */
  fetch('/api/me', { credentials: 'same-origin' }).then(r => r.ok ? r.json() : null).then(me => {
    if (!me) { $('navApp').textContent = 'Log in'; $('navApp').href = '/login'; return; }
    window.PF.setCsrf(me.csrf);
    $('sName').value = me.user.name; $('sEmail').value = me.user.email; $('sEmail').readOnly = true;
  }).catch(() => {});

  /* support channels configured on the server */
  function channels(c) {
    if (!c) return;
    if (c.whatsapp) { $('waLink').href = `https://wa.me/${encodeURIComponent(c.whatsapp)}?text=${encodeURIComponent('Hi PostGenX support, ')}`; $('waLink').classList.remove('hidden'); }
    if (c.supportEmail) { $('mailLink').href = 'mailto:' + c.supportEmail; $('mailText').textContent = c.supportEmail; $('mailLink').classList.remove('hidden'); }
  }
  if (window.PF_PUBLIC) channels(window.PF_PUBLIC);
  document.addEventListener('pf:config', e => channels(e.detail));

  $('supportForm').addEventListener('submit', async e => {
    e.preventDefault();
    const b = e.target.querySelector('button[type=submit]'); b.disabled = true;
    try {
      const r = await api('/support', { method: 'POST', body: {
        name: $('sName').value, email: $('sEmail').value, topic: $('sTopic').value, message: $('sMsg').value,
        page: document.referrer ? new URL(document.referrer).pathname : '/help', website: $('sWebsite').value,
      } });
      $('sentMsg').innerHTML = `<div class="alert alert-ok"><div class="grow">Thanks — your message is in (reference <b>${esc(r.ref || '')}</b>). We've emailed you a copy and will reply within one business day.</div></div>`;
      $('sMsg').value = '';
    } catch (err) {
      $('sentMsg').innerHTML = `<div class="alert alert-error"><div class="grow">${esc(err.message)}</div></div>`;
    }
    b.disabled = false;
  });
})();
