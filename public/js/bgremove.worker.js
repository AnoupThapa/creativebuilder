/* Runs the background-removal engine off the main thread so the editor never freezes. */
importScripts('/js/bgremove.js');
let P = null, RGBA = null;

self.onmessage = e => {
  const m = e.data;
  try {
    if (m.type === 'init') {
      RGBA = new Uint8ClampedArray(m.buffer);
      P = PFBG.prepare(RGBA, m.width, m.height);
      self.postMessage({ type: 'ready', id: m.id });
    } else if (m.type === 'segment') {
      const r = PFBG.segment(P, m.opts);
      self.postMessage({ type: 'segment', id: m.id, alpha: r.alpha, bgColors: r.bgColors, stats: r.stats }, [r.alpha.buffer]);
    } else if (m.type === 'wand') {
      const mask = PFBG.wand(P, m.x, m.y, m.tolerance);
      self.postMessage({ type: 'wand', id: m.id, mask }, [mask.buffer]);
    }
  } catch (err) {
    self.postMessage({ type: 'error', id: m.id, message: String(err && err.message || err) });
  }
};
