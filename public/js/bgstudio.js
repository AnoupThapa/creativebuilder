/* =====================================================================
   PostGenX — Cut-out Studio
   Full-screen background remover with automatic detection, a subject
   box for busy photos, Keep / Erase brushes, a magic eraser, edge
   controls, undo/redo and before/after previews.
   Exposes window.BGStudio = { autoCut, applySavedMask, open, maskToBlob }
   ===================================================================== */
(function () {
  'use strict';
  const MAX_SIDE = 1280;

  /* ------------------------------------------------------------------ */
  /* Worker client (falls back to the main thread if workers fail)       */
  /* ------------------------------------------------------------------ */
  class Engine {
    constructor() {
      this.seq = 0; this.pending = new Map(); this.sync = null;
      try {
        this.worker = new Worker('/js/bgremove.worker.js');
        this.worker.onmessage = e => {
          const p = this.pending.get(e.data.id); if (!p) return;
          this.pending.delete(e.data.id);
          e.data.type === 'error' ? p.reject(new Error(e.data.message)) : p.resolve(e.data);
        };
        this.worker.onerror = () => { this.worker = null; };
      } catch (e) { this.worker = null; }
    }
    call(type, payload, transfer) {
      if (!this.worker) return this.callSync(type, payload);
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject });
        this.worker.postMessage({ type, id, ...payload }, transfer || []);
      });
    }
    async callSync(type, m) {
      await new Promise(r => setTimeout(r, 16));
      if (type === 'init') { this.sync = PFBG.prepare(new Uint8ClampedArray(m.buffer), m.width, m.height); return { type: 'ready' }; }
      if (type === 'segment') { const r = PFBG.segment(this.sync, m.opts); return { type, ...r }; }
      if (type === 'wand') return { type, mask: PFBG.wand(this.sync, m.x, m.y, m.tolerance) };
    }
    async init(rgba, width, height) {
      const copy = rgba.slice(); // keep our own copy; the worker gets the transferred buffer
      await this.call('init', { buffer: copy.buffer, width, height }, [copy.buffer]);
    }
    terminate() { if (this.worker) this.worker.terminate(); }
  }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */
  function elSize(el) {
    return { w: el.naturalWidth || el.videoWidth || el.width, h: el.naturalHeight || el.videoHeight || el.height };
  }
  function workingPixels(img) {
    const { w, h } = elSize(img);
    const s = Math.min(1, MAX_SIDE / Math.max(w, h));
    const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, W, H);
    return { W, H, rgba: ctx.getImageData(0, 0, W, H).data };
  }
  /* Mask stored as an opaque greyscale PNG (compresses well, no premultiply issues) */
  function maskToBlob(alpha, W, H) {
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const id = new ImageData(W, H);
    for (let i = 0; i < alpha.length; i++) { const o = i * 4; id.data[o] = id.data[o + 1] = id.data[o + 2] = alpha[i]; id.data[o + 3] = 255; }
    c.getContext('2d').putImageData(id, 0, 0);
    return new Promise(res => c.toBlob(res, 'image/png'));
  }

  /* Final cut-out at up to 2400px: the mask is scaled up smoothly and applied to the
     full-resolution photo, so print-quality exports stay sharp */
  const OUT_MAX = 2400;
  function buildCutout(img, alpha, W, H, bgColors) {
    const { w, h } = elSize(img);
    const s = Math.min(1, OUT_MAX / Math.max(w, h));
    const OW = Math.max(1, Math.round(w * s)), OH = Math.max(1, Math.round(h * s));
    const mc = document.createElement('canvas'); mc.width = W; mc.height = H;
    const mid = new ImageData(W, H);
    for (let i = 0; i < alpha.length; i++) { const o = i * 4; mid.data[o] = mid.data[o + 1] = mid.data[o + 2] = alpha[i]; mid.data[o + 3] = 255; }
    mc.getContext('2d').putImageData(mid, 0, 0);
    const big = document.createElement('canvas'); big.width = OW; big.height = OH;
    const bctx = big.getContext('2d', { willReadFrequently: true });
    bctx.imageSmoothingQuality = 'high';
    bctx.drawImage(mc, 0, 0, OW, OH);
    const ma = bctx.getImageData(0, 0, OW, OH).data;
    bctx.clearRect(0, 0, OW, OH);
    bctx.drawImage(img, 0, 0, OW, OH);
    const px = bctx.getImageData(0, 0, OW, OH).data;
    const A = new Uint8ClampedArray(OW * OH);
    for (let i = 0; i < A.length; i++) A[i] = ma[i * 4];
    const out = PFBG.applyAlpha(px, A, bgColors, !!(bgColors && bgColors.length));
    bctx.putImageData(new ImageData(out, OW, OH), 0, 0);
    return big;
  }

  /* One-click automatic cut-out */
  async function autoCut(img, opts = {}) {
    const { W, H, rgba } = workingPixels(img);
    const eng = new Engine();
    try {
      await eng.init(rgba, W, H);
      const r = await eng.call('segment', { opts });
      const alpha = new Uint8ClampedArray(r.alpha);
      return { canvas: buildCutout(img, alpha, W, H, r.bgColors), alpha, W, H, stats: r.stats };
    } finally { eng.terminate(); }
  }

  /* Rebuild a cut-out from a saved mask image */
  function applySavedMask(img, maskImg) {
    const { W, H, rgba } = workingPixels(img);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(maskImg, 0, 0, W, H);
    const m = ctx.getImageData(0, 0, W, H).data;
    const alpha = new Uint8ClampedArray(W * H);
    for (let i = 0; i < alpha.length; i++) alpha[i] = m[i * 4];
    return { canvas: buildCutout(img, alpha, W, H, PFBG.estimateBgColors(rgba, alpha)), alpha, W, H };
  }

  /* ------------------------------------------------------------------ */
  /* Studio UI                                                           */
  /* ------------------------------------------------------------------ */
  const HTML = `
  <div class="bgs-head">
    <div class="bgs-title">✂️ <span class="bgs-tt">Background remover</span> <span class="bgs-sub">Cut-out studio</span></div>
    <div class="bgs-views" role="tablist" aria-label="Preview">
      <button data-view="result" class="on">Result</button>
      <button data-view="overlay">Show removed</button>
      <button data-view="original">Original</button>
    </div>
    <div class="bgs-actions">
      <button class="bgs-btn" data-act="cancel">Cancel</button>
      <button class="bgs-btn bgs-primary" data-act="apply">✓ Apply cut-out</button>
    </div>
  </div>
  <div class="bgs-body">
    <aside class="bgs-side">
      <div class="bgs-sec">
        <div class="bgs-lbl">1 · Detect subject</div>
        <div class="bgs-seg" data-group="method">
          <button data-method="auto" class="on">✨ Auto</button>
          <button data-method="box">▭ Subject box</button>
        </div>
        <div class="bgs-hint" data-hint="method">Auto picks the best method for your photo. Busy background? Choose <b>Subject box</b> and drag a box around the product.</div>
      </div>

      <div class="bgs-sec">
        <div class="bgs-lbl">2 · Fine-tune</div>
        <label class="bgs-row"><span>Removal strength <em data-val="strength">50</em></span>
          <input type="range" data-opt="strength" min="0" max="100" value="50"></label>
        <label class="bgs-row"><span>Edge softness <em data-val="softness">1.2</em></span>
          <input type="range" data-opt="softness" min="0" max="6" step="0.2" value="1.2"></label>
        <label class="bgs-row"><span>Shrink / grow edge <em data-val="shift">0</em></span>
          <input type="range" data-opt="shift" min="-6" max="6" step="1" value="0"></label>
        <label class="bgs-row"><span>Remove loose bits <em data-val="speck">0.15</em></span>
          <input type="range" data-opt="speck" min="0" max="3" step="0.05" value="0.15"></label>
        <label class="bgs-check"><input type="checkbox" data-opt="shadows" checked> Remove shadows on the backdrop</label>
        <label class="bgs-check"><input type="checkbox" data-opt="holes" checked> Remove backdrop inside gaps &amp; handles</label>
        <label class="bgs-check"><input type="checkbox" data-opt="decontam" checked> Clean colour fringe on edges</label>
        <button class="bgs-btn bgs-wide" data-act="rerun">↻ Re-detect</button>
      </div>

      <div class="bgs-sec">
        <div class="bgs-lbl">3 · Touch up</div>
        <div class="bgs-tools">
          <button data-tool="keep" title="Paint back parts that were removed (K)">🟢 Keep</button>
          <button data-tool="erase" title="Paint away leftover background (E)">🔴 Erase</button>
          <button data-tool="wand" title="Click an area to erase everything of that colour (W)">🪄 Magic erase</button>
        </div>
        <label class="bgs-row"><span>Brush size <em data-val="brush">28</em></span>
          <input type="range" data-ui="brush" min="4" max="140" value="28"></label>
        <label class="bgs-row"><span>Magic erase range <em data-val="wandTol">10</em></span>
          <input type="range" data-ui="wandTol" min="3" max="45" value="10"></label>
        <div class="bgs-undo">
          <button class="bgs-btn" data-act="undo" title="Undo (Ctrl+Z)">↶ Undo</button>
          <button class="bgs-btn" data-act="redo" title="Redo (Ctrl+Y)">↷ Redo</button>
          <button class="bgs-btn" data-act="clear" title="Remove all brush touch-ups">Clear touch-ups</button>
        </div>
      </div>

      <div class="bgs-sec">
        <div class="bgs-lbl">Check edges on</div>
        <div class="bgs-bgs">
          <button data-bd="checker" class="on" title="Transparent"></button>
          <button data-bd="#ffffff" title="White"></button>
          <button data-bd="#111111" title="Black"></button>
          <button data-bd="brand" title="Brand colour"></button>
        </div>
      </div>
    </aside>

    <div class="bgs-stage">
      <div class="bgs-zoom">
        <button data-zoom="-">−</button><span data-val="zoom">Fit</span><button data-zoom="+">+</button><button data-zoom="fit">Fit</button>
      </div>
      <div class="bgs-scroll">
        <div class="bgs-box bd-checker">
          <canvas class="bgs-view"></canvas>
          <canvas class="bgs-over"></canvas>
        </div>
      </div>
      <div class="bgs-status"><span class="bgs-spin"></span><span data-status>Preparing…</span></div>
    </div>
  </div>`;

  let root = null;
  function build() {
    if (root) return root;
    root = document.createElement('div');
    root.className = 'bgs-wrap';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Background remover');
    root.innerHTML = HTML;
    document.body.appendChild(root);
    return root;
  }

  function open({ img, alpha: initialAlpha, brandColor, onApply }) {
    const R = build();
    const q = sel => R.querySelector(sel);
    const qa = sel => [...R.querySelectorAll(sel)];
    const view = q('.bgs-view'), over = q('.bgs-over'), box = q('.bgs-box'), scroll = q('.bgs-scroll');
    const { W, H, rgba } = workingPixels(img);
    view.width = over.width = W; view.height = over.height = H;
    const vctx = view.getContext('2d'), octx = over.getContext('2d');

    const hint = document.createElement('canvas'); hint.width = W; hint.height = H;
    const hctx = hint.getContext('2d', { willReadFrequently: true });

    const opts = { strength: 50, softness: 1.2, shift: 0, speck: 0.15, shadows: true, holes: true, method: 'auto', rect: null };
    let decontam = true, autoAlpha = null, bgColors = [], finalAlpha = null;
    let tool = null, brush = 28, wandTol = 10, viewMode = 'result', zoom = 0, busy = 0, seq = 0;
    const undo = [], redo = [];
    const eng = new Engine();
    const status = (t, spin) => { q('[data-status]').textContent = t; R.classList.toggle('busy', !!spin); };

    /* ---- reset UI to defaults ---- */
    qa('[data-opt]').forEach(el => {
      const k = el.dataset.opt;
      if (el.type === 'checkbox') el.checked = k === 'decontam' ? true : !!opts[k];
      else { el.value = opts[k]; q(`[data-val="${k}"]`).textContent = opts[k]; }
    });
    qa('[data-method]').forEach(b => b.classList.toggle('on', b.dataset.method === 'auto'));
    qa('[data-tool]').forEach(b => b.classList.remove('on'));
    qa('[data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === 'result'));
    q('[data-ui="brush"]').value = brush; q('[data-val="brush"]').textContent = brush;
    q('[data-ui="wandTol"]').value = wandTol; q('[data-val="wandTol"]').textContent = wandTol;
    q('[data-bd="brand"]').style.background = brandColor || '#ff6b4a';
    setBackdrop('checker');

    /* ---- layout / zoom ---- */
    function fit() {
      const sw = scroll.clientWidth - 40, sh = scroll.clientHeight - 40;
      const base = Math.min(sw / W, sh / H);
      const s = zoom ? base * zoom : base;
      box.style.width = Math.round(W * s) + 'px';
      box.style.height = Math.round(H * s) + 'px';
      q('[data-val="zoom"]').textContent = zoom ? `${Math.round(zoom * 100)}%` : 'Fit';
    }
    const onResize = () => fit();
    window.addEventListener('resize', onResize);

    function setBackdrop(bd) {
      qa('[data-bd]').forEach(b => b.classList.toggle('on', b.dataset.bd === bd));
      box.classList.toggle('bd-checker', bd === 'checker');
      box.style.background = bd === 'checker' ? '' : bd === 'brand' ? (brandColor || '#ff6b4a') : bd;
    }

    /* ---- compose auto result + brush touch-ups ---- */
    function composeAlpha() {
      const h = hctx.getImageData(0, 0, W, H).data;
      const out = new Uint8ClampedArray(W * H);
      for (let i = 0; i < out.length; i++) {
        const o = i * 4, a = h[o + 3] / 255;
        let v = autoAlpha ? autoAlpha[i] : 255;
        if (a > 0) v = h[o + 1] > h[o] ? Math.max(v, 255 * a) : v * (1 - a);
        out[i] = v;
      }
      return out;
    }
    let rafPending = false;
    function redraw() {
      if (rafPending) return;
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        finalAlpha = composeAlpha();
        if (viewMode === 'original') { vctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), W, H), 0, 0); return; }
        let px;
        if (viewMode === 'overlay') {
          px = new Uint8ClampedArray(rgba);
          for (let i = 0; i < finalAlpha.length; i++) {
            const o = i * 4, k = 1 - finalAlpha[i] / 255;
            px[o] = px[o] * (1 - k * 0.6) + 255 * k * 0.6; px[o + 1] *= 1 - k * 0.6; px[o + 2] *= 1 - k * 0.6;
          }
        } else px = PFBG.applyAlpha(rgba, finalAlpha, bgColors, decontam);
        vctx.clearRect(0, 0, W, H);
        vctx.putImageData(new ImageData(px, W, H), 0, 0);
      });
    }

    /* ---- detection ---- */
    let timer = null;
    function schedule() { clearTimeout(timer); timer = setTimeout(run, 280); }
    async function run() {
      if (opts.method === 'box' && !opts.rect) { status('Drag a box around your product on the photo.'); drawOverlay(); return; }
      const my = ++seq; busy++;
      status(opts.method === 'box' ? 'Separating subject inside the box…' : 'Detecting background…', true);
      try {
        const r = await eng.call('segment', { opts: { ...opts, rect: opts.method === 'box' ? opts.rect : null, method: opts.method === 'box' ? undefined : 'auto' } });
        if (my !== seq) return;
        autoAlpha = new Uint8ClampedArray(r.alpha); bgColors = r.bgColors;
        const how = r.stats.method === 'graph' ? (opts.method === 'box' ? 'Subject box' : 'Busy-background mode') : 'Plain-background mode';
        status(`${how} · subject covers ${r.stats.subjectPct}% of the photo. Use Keep / Erase to touch up.`);
        redraw();
      } catch (e) {
        status('Could not process this photo: ' + e.message);
      } finally { busy--; if (!busy) R.classList.remove('busy'); }
    }

    /* ---- overlay: subject box, brush cursor ---- */
    let cursor = null, drag = null;
    function drawOverlay() {
      octx.clearRect(0, 0, W, H);
      const r = drag && drag.box ? drag.box : (opts.method === 'box' ? opts.rect : null);
      if (r) {
        octx.save();
        octx.fillStyle = 'rgba(26,26,46,.35)';
        octx.beginPath(); octx.rect(0, 0, W, H); octx.rect(r.x, r.y, r.w, r.h); octx.fill('evenodd');
        octx.setLineDash([10, 6]); octx.lineWidth = Math.max(2, W / 400); octx.strokeStyle = '#fff';
        octx.strokeRect(r.x, r.y, r.w, r.h); octx.restore();
      }
      if (cursor && (tool === 'keep' || tool === 'erase')) {
        octx.save(); octx.beginPath();
        octx.arc(cursor.x, cursor.y, brushPx() / 2, 0, Math.PI * 2);
        octx.lineWidth = Math.max(1.5, W / 600); octx.strokeStyle = tool === 'keep' ? '#1d7a5f' : '#e63946';
        octx.fillStyle = tool === 'keep' ? 'rgba(29,122,95,.15)' : 'rgba(230,57,70,.15)';
        octx.fill(); octx.stroke(); octx.restore();
      }
    }
    const brushPx = () => brush * W / over.getBoundingClientRect().width;
    const pos = e => { const r = over.getBoundingClientRect(); return { x: (e.clientX - r.left) * W / r.width, y: (e.clientY - r.top) * H / r.height }; };

    function pushUndo() {
      undo.push(hctx.getImageData(0, 0, W, H)); if (undo.length > 25) undo.shift();
      redo.length = 0;
    }
    function stroke(a, b) {
      hctx.save();
      hctx.globalCompositeOperation = 'source-over';
      hctx.strokeStyle = hctx.fillStyle = tool === 'keep' ? 'rgb(0,255,0)' : 'rgb(255,0,0)';
      hctx.lineWidth = brushPx(); hctx.lineCap = hctx.lineJoin = 'round';
      hctx.beginPath(); hctx.moveTo(a.x, a.y); hctx.lineTo(b.x + 0.01, b.y); hctx.stroke();
      hctx.restore();
    }

    over.onpointerdown = async e => {
      e.preventDefault();
      over.setPointerCapture(e.pointerId);
      const p = pos(e);
      if (opts.method === 'box' && !tool) { drag = { start: p, box: { x: p.x, y: p.y, w: 0, h: 0 } }; return; }
      if (tool === 'keep' || tool === 'erase') { pushUndo(); drag = { last: p }; stroke(p, p); redraw(); return; }
      if (tool === 'wand') {
        status('Magic erase…', true);
        try {
          const r = await eng.call('wand', { x: p.x, y: p.y, tolerance: wandTol });
          pushUndo();
          const id = hctx.getImageData(0, 0, W, H);
          for (let i = 0; i < r.mask.length; i++) if (r.mask[i]) { const o = i * 4; id.data[o] = 255; id.data[o + 1] = 0; id.data[o + 2] = 0; id.data[o + 3] = 255; }
          hctx.putImageData(id, 0, 0);
          redraw(); status('Erased the clicked area. Click again for more, or Undo.');
        } catch (err) { status(err.message); }
        R.classList.remove('busy');
      }
    };
    over.onpointermove = e => {
      const p = pos(e); cursor = p;
      if (drag && drag.box) {
        drag.box = { x: Math.min(p.x, drag.start.x), y: Math.min(p.y, drag.start.y), w: Math.abs(p.x - drag.start.x), h: Math.abs(p.y - drag.start.y) };
      } else if (drag && drag.last) { stroke(drag.last, p); drag.last = p; redraw(); }
      drawOverlay();
    };
    over.onpointerup = () => {
      if (drag && drag.box) {
        if (drag.box.w > 12 && drag.box.h > 12) { opts.rect = drag.box; drag = null; drawOverlay(); run(); }
        else { drag = null; drawOverlay(); }
      }
      drag = null;
    };
    over.onpointerleave = () => { cursor = null; drawOverlay(); };

    /* ---- controls ---- */
    R.onclick = e => {
      const t = e.target.closest('button'); if (!t || !R.contains(t)) return;
      if (t.dataset.method) {
        opts.method = t.dataset.method;
        qa('[data-method]').forEach(b => b.classList.toggle('on', b === t));
        if (opts.method === 'box') { setTool(null); if (!opts.rect) { status('Drag a box around your product on the photo.'); drawOverlay(); return; } }
        drawOverlay(); run();
      } else if (t.dataset.tool) setTool(tool === t.dataset.tool ? null : t.dataset.tool);
      else if (t.dataset.view) { viewMode = t.dataset.view; qa('[data-view]').forEach(b => b.classList.toggle('on', b === t)); redraw(); }
      else if (t.dataset.bd) setBackdrop(t.dataset.bd);
      else if (t.dataset.zoom) {
        zoom = t.dataset.zoom === 'fit' ? 0 : Math.max(1, Math.min(4, (zoom || 1) + (t.dataset.zoom === '+' ? 0.5 : -0.5)));
        if (t.dataset.zoom === '-' && zoom === 1) zoom = 0;
        fit();
      } else if (t.dataset.act) act(t.dataset.act);
    };
    function setTool(tl) {
      tool = tl;
      qa('[data-tool]').forEach(b => b.classList.toggle('on', b.dataset.tool === tl));
      over.style.cursor = tl === 'wand' ? 'crosshair' : tl ? 'none' : opts.method === 'box' ? 'crosshair' : 'default';
      if (tl === 'wand') status('Click on leftover background to erase it.');
      else if (tl) status(tl === 'keep' ? 'Paint over parts of your product that went missing.' : 'Paint over leftover background.');
      drawOverlay();
    }
    R.oninput = e => {
      const el = e.target;
      if (el.dataset.opt) {
        const k = el.dataset.opt;
        if (el.type === 'checkbox') { if (k === 'decontam') { decontam = el.checked; redraw(); return; } opts[k] = el.checked; }
        else { opts[k] = parseFloat(el.value); q(`[data-val="${k}"]`).textContent = el.value; }
        schedule();
      } else if (el.dataset.ui === 'brush') { brush = +el.value; q('[data-val="brush"]').textContent = el.value; drawOverlay(); }
      else if (el.dataset.ui === 'wandTol') { wandTol = +el.value; q('[data-val="wandTol"]').textContent = el.value; }
    };
    const onKey = e => {
      if (e.key === 'Escape') { act('cancel'); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); act(e.shiftKey ? 'redo' : 'undo'); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); act('redo'); return; }
      if (e.target.tagName === 'INPUT') return;
      if (e.key === '[' || e.key === ']') { brush = Math.max(4, Math.min(140, brush + (e.key === ']' ? 6 : -6))); q('[data-ui="brush"]').value = brush; q('[data-val="brush"]').textContent = brush; drawOverlay(); }
      if (e.key === 'k') setTool('keep'); if (e.key === 'e') setTool('erase'); if (e.key === 'w') setTool('wand');
    };
    document.addEventListener('keydown', onKey);

    function close() {
      R.classList.remove('open');
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      clearTimeout(timer); eng.terminate();
      document.body.style.overflow = '';
    }
    function act(a) {
      if (a === 'cancel') close();
      else if (a === 'apply') {
        const alpha = composeAlpha();
        const canvas = buildCutout(img, alpha, W, H, decontam ? bgColors : null);
        close();
        onApply && onApply({ canvas, alpha, W, H });
      } else if (a === 'rerun') run();
      else if (a === 'undo' && undo.length) { redo.push(hctx.getImageData(0, 0, W, H)); hctx.putImageData(undo.pop(), 0, 0); redraw(); }
      else if (a === 'redo' && redo.length) { undo.push(hctx.getImageData(0, 0, W, H)); hctx.putImageData(redo.pop(), 0, 0); redraw(); }
      else if (a === 'clear') { pushUndo(); hctx.clearRect(0, 0, W, H); redraw(); }
    }

    /* ---- go ---- */
    R.classList.add('open');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(fit);
    status('Preparing photo…', true);
    eng.init(rgba, W, H).then(() => {
      if (initialAlpha && initialAlpha.length === W * H) {
        autoAlpha = new Uint8ClampedArray(initialAlpha);
        bgColors = PFBG.estimateBgColors(rgba, autoAlpha);
        status('Loaded your saved cut-out. Adjust the sliders to re-detect, or touch up with the brushes.');
        redraw();
      } else run();
    }).catch(e => status('Could not start: ' + e.message));
  }

  window.BGStudio = { autoCut, applySavedMask, open, maskToBlob };
})();
