/* In-app feedback button: star rating + comment, with optional permission to quote
   (approved quotes appear as testimonials on the home page). Used on dashboard + editor. */
(() => {
  'use strict';
  if (window.__pfFeedback) return;
  window.__pfFeedback = true;
  const pos = (document.currentScript && document.currentScript.dataset.pos) || 'right';
  const css = `
  .pf-fb-btn{position:fixed;right:16px;bottom:16px;z-index:900;background:#1d1b2e;color:#fff;border:0;border-radius:999px;padding:10px 16px;font:700 13px/1 inherit;box-shadow:0 6px 20px rgba(0,0,0,.2);cursor:pointer}
  .pf-fb-btn:hover{background:#ff6b4a}
  .pf-fb-wrap{position:fixed;inset:0;z-index:1000;display:none;align-items:flex-end;justify-content:flex-end;padding:16px}
  .pf-fb-wrap.open{display:flex}
  .pf-fb{background:#fff;color:#1d1b2e;width:100%;max-width:380px;border-radius:16px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.3);font-size:14px;max-height:calc(100vh - 32px);overflow:auto}
  .pf-fb h3{font-size:17px;margin:0 0 4px}
  .pf-fb p{color:#6b6880;margin:0 0 12px;font-size:13px}
  .pf-fb .stars{display:flex;gap:4px;margin-bottom:12px}
  .pf-fb .stars button{font-size:28px;background:none;border:0;cursor:pointer;color:#d8d5e3;padding:0 2px;line-height:1}
  .pf-fb .stars button.on{color:#ffb400}
  .pf-fb textarea,.pf-fb input[type=text]{width:100%;border:1px solid #dcd9e6;border-radius:10px;padding:9px 11px;font:inherit;margin-bottom:10px;box-sizing:border-box}
  .pf-fb textarea{min-height:90px;resize:vertical}
  .pf-fb label.ck{display:flex;gap:8px;align-items:flex-start;font-size:13px;margin-bottom:10px;cursor:pointer}
  .pf-fb .row{display:flex;gap:8px;justify-content:flex-end;margin-top:6px}
  .pf-fb .b{border:0;border-radius:10px;padding:9px 14px;font:700 13px inherit;cursor:pointer}
  .pf-fb .b1{background:#ff6b4a;color:#fff}.pf-fb .b2{background:#f1eff6;color:#1d1b2e}
  .pf-fb .err{color:#c62828;font-size:12.5px;min-height:1em;margin-bottom:6px}
  @media(max-width:700px){.pf-fb-btn{display:none}}
  @media print{.pf-fb-btn{display:none}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  const btn = document.createElement('button');
  btn.className = 'pf-fb-btn'; if (pos === 'left') { btn.style.right = 'auto'; btn.style.left = '16px'; } btn.type = 'button'; btn.textContent = '💬 Feedback';
  const wrap = document.createElement('div');
  wrap.className = 'pf-fb-wrap';
  wrap.innerHTML = `<form class="pf-fb" novalidate>
    <h3>How is PostForge working for you?</h3>
    <p>Your feedback shapes what we build next. It goes straight to the founder.</p>
    <div class="stars" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map(n => `<button type="button" data-n="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
    <textarea name="message" maxlength="2000" placeholder="What do you like? What's missing or annoying?"></textarea>
    <label class="ck"><input type="checkbox" name="allow"> <span>You may quote this on the PostForge website (we'll show only the name and business below).</span></label>
    <div class="quote hidden-q" style="display:none">
      <input type="text" name="displayName" maxlength="60" placeholder="Name to show, e.g. Priya S.">
      <input type="text" name="business" maxlength="80" placeholder="Business, e.g. Sunrise Café, Sydney">
    </div>
    <div class="err"></div>
    <div class="row"><button type="button" class="b b2" data-x>Close</button><button class="b b1" type="submit">Send feedback</button></div>
  </form>`;
  const mount = () => {
    const slot = pos === 'slot' && document.getElementById('fbSlot');
    document.body.append(wrap);
    if (slot) slot.addEventListener('click', () => btn.click()); // editor: small pill in the top bar
    else document.body.append(btn);
    // any element with data-feedback opens it too (e.g. the sidebar link, used on phones)
    document.addEventListener('click', e => { const t = e.target.closest('[data-feedback]'); if (t) { e.preventDefault(); document.getElementById('sidebar')?.classList.remove('open'); btn.click(); } });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();

  const form = wrap.querySelector('form');
  let rating = 0;
  const paint = () => form.querySelectorAll('.stars button').forEach(b => b.classList.toggle('on', +b.dataset.n <= rating));
  form.querySelector('.stars').addEventListener('click', e => { const b = e.target.closest('button'); if (b) { rating = +b.dataset.n; paint(); } });
  form.allow.addEventListener('change', () => { form.querySelector('.quote').style.display = form.allow.checked ? 'block' : 'none'; });
  const close = () => wrap.classList.remove('open');
  btn.addEventListener('click', () => { wrap.classList.add('open'); form.querySelector('.err').textContent = ''; });
  wrap.addEventListener('click', e => { if (e.target === wrap || e.target.closest('[data-x]')) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const err = form.querySelector('.err');
    if (!rating) { err.textContent = 'Tap a star rating first.'; return; }
    const body = { rating, message: form.message.value, allowQuote: form.allow.checked, displayName: form.displayName.value, business: form.business.value };
    try {
      await window.PF.api('/feedback', { method: 'POST', body });
      form.innerHTML = '<h3>Thank you! 🙏</h3><p>We read every message. If you asked a question, we will reply by email.</p><div class="row"><button type="button" class="b b2" data-x>Close</button></div>';
      setTimeout(close, 2500);
    } catch (ex) { err.textContent = ex.message; }
  });
})();
