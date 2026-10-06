/* =====================================================================
   PostGenX — background removal engine (classical, no AI / no server)
   ---------------------------------------------------------------------
   Pipeline:
     1. light denoise → CIE-Lab colour (perceptual distances)
     2. edge map (Sobel on L, a, b)
     3. background colour model: k-means on the image border (or on
        everything outside the user's "subject box"); several colours,
        so gradients, two-tone and textured backdrops work
     4. edge-aware flood fill from the border — only background that is
        *connected* to the edge is removed, and strong edges stop it
     5. optional: remove background colour showing through holes
     6. GrabCut-style refinement: foreground/background colour
        histograms + neighbour smoothing re-decide the uncertain band
     7. clean-up: drop specks, fill pin-holes, shrink/grow the edge
     8. soft anti-aliased edge + colour decontamination (removes the
        old background's colour fringe from the subject's edges)
   Works in a Web Worker (bgremove.worker.js) or directly (Node tests).
   ===================================================================== */
(function (root) {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Colour helpers                                                      */
  /* ------------------------------------------------------------------ */
  const LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) { const c = i / 255; LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  const fLab = t => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

  function rgbToLab(r, g, b) {
    const R = LIN[r], G = LIN[g], B = LIN[b];
    const x = fLab((R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047);
    const y = fLab(R * 0.2126 + G * 0.7152 + B * 0.0722);
    const z = fLab((R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883);
    return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
  }

  /* 3×3 box blur (separable) → rounded RGB */
  function blurRGB(rgba, W, H) {
    const n = W * H, tmp = new Float32Array(n * 3), out = new Uint8ClampedArray(n * 3);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const x0 = x > 0 ? x - 1 : x, x1 = x < W - 1 ? x + 1 : x;
        const i0 = (y * W + x0) * 4, i1 = (y * W + x) * 4, i2 = (y * W + x1) * 4, o = (y * W + x) * 3;
        tmp[o] = (rgba[i0] + rgba[i1] + rgba[i2]) / 3;
        tmp[o + 1] = (rgba[i0 + 1] + rgba[i1 + 1] + rgba[i2 + 1]) / 3;
        tmp[o + 2] = (rgba[i0 + 2] + rgba[i1 + 2] + rgba[i2 + 2]) / 3;
      }
    }
    for (let y = 0; y < H; y++) {
      const y0 = y > 0 ? y - 1 : y, y1 = y < H - 1 ? y + 1 : y;
      for (let x = 0; x < W; x++) {
        const a = (y0 * W + x) * 3, b = (y * W + x) * 3, c = (y1 * W + x) * 3;
        out[b] = (tmp[a] + tmp[b] + tmp[c]) / 3;
        out[b + 1] = (tmp[a + 1] + tmp[b + 1] + tmp[c + 1]) / 3;
        out[b + 2] = (tmp[a + 2] + tmp[b + 2] + tmp[c + 2]) / 3;
      }
    }
    return out;
  }

  /* Everything that doesn't depend on the slider settings — computed once per image */
  function prepare(rgba, W, H) {
    const n = W * H;
    const rgb = blurRGB(rgba, W, H);
    const L = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
    const cache = new Map();
    for (let i = 0; i < n; i++) {
      const r = rgb[i * 3], g = rgb[i * 3 + 1], b = rgb[i * 3 + 2];
      const key = (r << 16) | (g << 8) | b;
      let lab = cache.get(key);
      if (!lab) { lab = rgbToLab(r, g, b); if (cache.size < 200000) cache.set(key, lab); }
      L[i] = lab[0]; A[i] = lab[1]; B[i] = lab[2];
    }
    // Sobel gradient magnitude (max over channels, in ΔE-like units)
    const grad = new Float32Array(n);
    const sob = (ch, x, y) => {
      const xm = x > 0 ? x - 1 : x, xp = x < W - 1 ? x + 1 : x, ym = y > 0 ? y - 1 : y, yp = y < H - 1 ? y + 1 : y;
      const gx = (ch[ym * W + xp] + 2 * ch[y * W + xp] + ch[yp * W + xp]) - (ch[ym * W + xm] + 2 * ch[y * W + xm] + ch[yp * W + xm]);
      const gy = (ch[yp * W + xm] + 2 * ch[yp * W + x] + ch[yp * W + xp]) - (ch[ym * W + xm] + 2 * ch[ym * W + x] + ch[ym * W + xp]);
      return Math.sqrt(gx * gx + gy * gy) / 8;
    };
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      grad[i] = Math.max(sob(L, x, y), sob(A, x, y) * 0.8, sob(B, x, y) * 0.8);
    }
    return { W, H, n, rgb, L, A, B, grad, src: rgba };
  }

  /* ------------------------------------------------------------------ */
  /* k-means on sampled pixels (deterministic farthest-point init)       */
  /* ------------------------------------------------------------------ */
  function kmeans(P, idx, k, wL) {
    const m = idx.length;
    if (!m) return [];
    k = Math.min(k, m);
    const C = [];
    const d2 = (i, c) => { const dl = (P.L[i] - c[0]) * wL, da = P.A[i] - c[1], db = P.B[i] - c[2]; return dl * dl + da * da + db * db; };
    // init: mean, then repeatedly the farthest sample
    let sL = 0, sA = 0, sB = 0;
    for (const i of idx) { sL += P.L[i]; sA += P.A[i]; sB += P.B[i]; }
    C.push([sL / m, sA / m, sB / m]);
    const best = new Float32Array(m).fill(Infinity);
    while (C.length < k) {
      let far = -1, farD = -1;
      for (let j = 0; j < m; j++) {
        best[j] = Math.min(best[j], d2(idx[j], C[C.length - 1]));
        if (best[j] > farD) { farD = best[j]; far = j; }
      }
      if (farD < 16) break; // remaining samples are all near an existing centre
      const i = idx[far];
      C.push([P.L[i], P.A[i], P.B[i]]);
    }
    const assign = new Int32Array(m);
    for (let it = 0; it < 8; it++) {
      const acc = C.map(() => [0, 0, 0, 0]);
      for (let j = 0; j < m; j++) {
        const i = idx[j]; let bi = 0, bd = Infinity;
        for (let c = 0; c < C.length; c++) { const d = d2(i, C[c]); if (d < bd) { bd = d; bi = c; } }
        assign[j] = bi;
        const a = acc[bi]; a[0] += P.L[i]; a[1] += P.A[i]; a[2] += P.B[i]; a[3]++;
      }
      for (let c = 0; c < C.length; c++) if (acc[c][3]) C[c] = [acc[c][0] / acc[c][3], acc[c][1] / acc[c][3], acc[c][2] / acc[c][3]];
    }
    // cluster sizes + mean RGB (for edge decontamination)
    const out = C.map(c => ({ lab: c, count: 0, rgb: [0, 0, 0] }));
    for (let j = 0; j < m; j++) {
      const o = out[assign[j]], i = idx[j];
      o.count++; o.rgb[0] += P.rgb[i * 3]; o.rgb[1] += P.rgb[i * 3 + 1]; o.rgb[2] += P.rgb[i * 3 + 2];
    }
    for (const o of out) if (o.count) o.rgb = o.rgb.map(v => v / o.count);
    return out.filter(o => o.count).sort((a, b) => b.count - a.count);
  }

  /* ------------------------------------------------------------------ */
  /* Chamfer distance transform: distance to nearest pixel where src=1   */
  /* ------------------------------------------------------------------ */
  function distTo(src, W, H) {
    const n = W * H, d = new Float32Array(n), INF = 1e9, a = 1, b = 1.4142;
    for (let i = 0; i < n; i++) d[i] = src[i] ? 0 : INF;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x; let v = d[i]; if (!v) continue;
      if (x > 0) v = Math.min(v, d[i - 1] + a);
      if (y > 0) {
        v = Math.min(v, d[i - W] + a);
        if (x > 0) v = Math.min(v, d[i - W - 1] + b);
        if (x < W - 1) v = Math.min(v, d[i - W + 1] + b);
      }
      d[i] = v;
    }
    for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
      const i = y * W + x; let v = d[i]; if (!v) continue;
      if (x < W - 1) v = Math.min(v, d[i + 1] + a);
      if (y < H - 1) {
        v = Math.min(v, d[i + W] + a);
        if (x < W - 1) v = Math.min(v, d[i + W + 1] + b);
        if (x > 0) v = Math.min(v, d[i + W - 1] + b);
      }
      d[i] = v;
    }
    return d;
  }

  /* Connected components (4-neighbour) of pixels where lab[i] === value */
  function components(lab, W, H, value) {
    const n = W * H, comp = new Int32Array(n).fill(-1), sizes = [], touchesEdge = [];
    const q = new Int32Array(n);
    for (let s = 0; s < n; s++) {
      if (lab[s] !== value || comp[s] >= 0) continue;
      const id = sizes.length; let head = 0, tail = 0, size = 0, edge = false;
      q[tail++] = s; comp[s] = id;
      while (head < tail) {
        const p = q[head++]; size++;
        const x = p % W, y = (p / W) | 0;
        if (x === 0 || y === 0 || x === W - 1 || y === H - 1) edge = true;
        if (x > 0 && lab[p - 1] === value && comp[p - 1] < 0) { comp[p - 1] = id; q[tail++] = p - 1; }
        if (x < W - 1 && lab[p + 1] === value && comp[p + 1] < 0) { comp[p + 1] = id; q[tail++] = p + 1; }
        if (y > 0 && lab[p - W] === value && comp[p - W] < 0) { comp[p - W] = id; q[tail++] = p - W; }
        if (y < H - 1 && lab[p + W] === value && comp[p + W] < 0) { comp[p + W] = id; q[tail++] = p + W; }
      }
      sizes.push(size); touchesEdge.push(edge);
    }
    return { comp, sizes, touchesEdge };
  }

  /* ------------------------------------------------------------------ */
  /* GrabCut (Rother et al. 2004): colour GMMs + graph min-cut.          */
  /* Used for the "Subject box" mode on busy / textured backgrounds.     */
  /* ------------------------------------------------------------------ */

  /* Boykov–Kolmogorov max-flow on a graph with paired reverse arcs */
  function makeGraph(nNodes, nArcsMax) {
    return {
      n: nNodes, first: new Int32Array(nNodes).fill(-1), next: new Int32Array(nArcsMax), head: new Int32Array(nArcsMax),
      cap: new Float64Array(nArcsMax), tr: new Float64Array(nNodes), m: 0, flow: 0,
    };
  }
  function addEdge(G, i, j, cij, cji) {
    const a = G.m++, b = G.m++;
    G.head[a] = j; G.next[a] = G.first[i]; G.first[i] = a; G.cap[a] = cij;
    G.head[b] = i; G.next[b] = G.first[j]; G.first[j] = b; G.cap[b] = cji;
  }
  function addTweights(G, i, toSource, toSink) {
    const d = Math.min(toSource, toSink);
    G.flow += d;
    G.tr[i] += toSource - toSink;
  }
  function maxflow(G) {
    const N = G.n, TERM = -2, ORPH = -3, NONE = -1;
    const tree = new Uint8Array(N);       // 0 free, 1 source tree, 2 sink tree
    const parent = new Int32Array(N).fill(NONE);
    const inQ = new Uint8Array(N);
    let Q = new Int32Array(N * 2), qh = 0, qt = 0, qlen = N * 2;
    const push = p => { if (inQ[p]) return; inQ[p] = 1; Q[qt] = p; qt = (qt + 1) % qlen; };
    const orph = []; const { head, next, first, cap, tr } = G;
    for (let p = 0; p < N; p++) {
      if (tr[p] > 0) { tree[p] = 1; parent[p] = TERM; push(p); }
      else if (tr[p] < 0) { tree[p] = 2; parent[p] = TERM; push(p); }
    }
    const originOK = p => { // follows parents to a terminal
      let i = p, steps = 0;
      while (true) {
        const a = parent[i];
        if (a === TERM) return true;
        if (a < 0) return false;
        i = head[a];
        if (++steps > N) return false;
      }
    };
    while (true) {
      /* growth */
      let bridge = -1;
      while (qh !== qt && bridge < 0) {
        const p = Q[qh];
        if (!tree[p]) { inQ[p] = 0; qh = (qh + 1) % qlen; continue; }
        for (let e = first[p]; e >= 0; e = next[e]) {
          const q = head[e];
          if (tree[p] === 1) {
            if (cap[e] <= 0) continue;
            if (!tree[q]) { tree[q] = 1; parent[q] = e ^ 1; push(q); }
            else if (tree[q] === 2) { bridge = e; break; }
          } else {
            if (cap[e ^ 1] <= 0) continue;
            if (!tree[q]) { tree[q] = 2; parent[q] = e ^ 1; push(q); }
            else if (tree[q] === 1) { bridge = e ^ 1; break; }
          }
        }
        if (bridge < 0) { inQ[p] = 0; qh = (qh + 1) % qlen; }
      }
      if (bridge < 0) break;
      /* augment */
      let b = cap[bridge];
      let i = head[bridge ^ 1];
      while (parent[i] !== TERM) { const a = parent[i]; b = Math.min(b, cap[a ^ 1]); i = head[a]; }
      b = Math.min(b, tr[i]);
      i = head[bridge];
      while (parent[i] !== TERM) { const a = parent[i]; b = Math.min(b, cap[a]); i = head[a]; }
      b = Math.min(b, -tr[i]);
      cap[bridge] -= b; cap[bridge ^ 1] += b;
      i = head[bridge ^ 1];
      while (parent[i] !== TERM) {
        const a = parent[i]; cap[a ^ 1] -= b; cap[a] += b;
        if (cap[a ^ 1] <= 0) { parent[i] = ORPH; orph.push(i); }
        i = head[a];
      }
      tr[i] -= b; if (tr[i] <= 0) { parent[i] = ORPH; orph.push(i); }
      i = head[bridge];
      while (parent[i] !== TERM) {
        const a = parent[i]; cap[a] -= b; cap[a ^ 1] += b;
        if (cap[a] <= 0) { parent[i] = ORPH; orph.push(i); }
        i = head[a];
      }
      tr[i] += b; if (tr[i] >= 0) { parent[i] = ORPH; orph.push(i); }
      G.flow += b;
      /* adoption */
      while (orph.length) {
        const p = orph.pop(), t = tree[p];
        let found = -1;
        for (let e = first[p]; e >= 0; e = next[e]) {
          const q = head[e];
          if (tree[q] !== t) continue;
          if (t === 1 ? cap[e ^ 1] <= 0 : cap[e] <= 0) continue;
          if (originOK(q)) { found = e; break; }
        }
        if (found >= 0) { parent[p] = found; continue; }
        for (let e = first[p]; e >= 0; e = next[e]) {
          const q = head[e];
          if (tree[q] !== t) continue;
          if (t === 1 ? cap[e ^ 1] > 0 : cap[e] > 0) push(q);
          const a = parent[q];
          if (a >= 0 && head[a] === p) { parent[q] = ORPH; orph.push(q); }
        }
        tree[p] = 0; parent[p] = NONE;
      }
    }
    return tree; // 1 = source side (subject)
  }

  /* Gaussian mixture model in RGB */
  function fitGMM(data, idxs, labels, K) {
    const comps = [];
    for (let k = 0; k < K; k++) {
      let n = 0; const mu = [0, 0, 0], S = new Float64Array(9);
      for (let j = 0; j < idxs.length; j++) if (labels[j] === k) { const o = idxs[j] * 3; mu[0] += data[o]; mu[1] += data[o + 1]; mu[2] += data[o + 2]; n++; }
      if (n < 3) continue;
      mu[0] /= n; mu[1] /= n; mu[2] /= n;
      for (let j = 0; j < idxs.length; j++) if (labels[j] === k) {
        const o = idxs[j] * 3, d0 = data[o] - mu[0], d1 = data[o + 1] - mu[1], d2 = data[o + 2] - mu[2];
        S[0] += d0 * d0; S[1] += d0 * d1; S[2] += d0 * d2; S[4] += d1 * d1; S[5] += d1 * d2; S[8] += d2 * d2;
      }
      const c = [S[0] / n + 4, S[1] / n, S[2] / n, S[1] / n, S[4] / n + 4, S[5] / n, S[2] / n, S[5] / n, S[8] / n + 4];
      const det = c[0] * (c[4] * c[8] - c[5] * c[7]) - c[1] * (c[3] * c[8] - c[5] * c[6]) + c[2] * (c[3] * c[7] - c[4] * c[6]);
      const inv = [
        (c[4] * c[8] - c[5] * c[7]) / det, (c[2] * c[7] - c[1] * c[8]) / det, (c[1] * c[5] - c[2] * c[4]) / det,
        (c[5] * c[6] - c[3] * c[8]) / det, (c[0] * c[8] - c[2] * c[6]) / det, (c[2] * c[3] - c[0] * c[5]) / det,
        (c[3] * c[7] - c[4] * c[6]) / det, (c[1] * c[6] - c[0] * c[7]) / det, (c[0] * c[4] - c[1] * c[3]) / det];
      comps.push({ w: n / idxs.length, mu, inv, norm: 1 / Math.sqrt(det) });
    }
    return comps;
  }
  function compLike(c, r, g, b) {
    const d0 = r - c.mu[0], d1 = g - c.mu[1], d2 = b - c.mu[2], v = c.inv;
    const m = d0 * (v[0] * d0 + v[1] * d1 + v[2] * d2) + d1 * (v[3] * d0 + v[4] * d1 + v[5] * d2) + d2 * (v[6] * d0 + v[7] * d1 + v[8] * d2);
    return c.norm * Math.exp(-0.5 * m);
  }
  function gmmLike(G, r, g, b) { let s = 0; for (const c of G) s += c.w * compLike(c, r, g, b); return s; }
  function initLabels(data, idxs, K) {
    // quick k-means in RGB for the initial component assignment
    const m = idxs.length, labels = new Uint8Array(m);
    const C = [];
    for (let k = 0; k < K; k++) { const o = idxs[Math.floor(((k + 0.5) / K) * m)] * 3; C.push([data[o], data[o + 1], data[o + 2]]); }
    for (let it = 0; it < 6; it++) {
      const acc = C.map(() => [0, 0, 0, 0]);
      for (let j = 0; j < m; j++) {
        const o = idxs[j] * 3; let bi = 0, bd = Infinity;
        for (let k = 0; k < K; k++) { const d = (data[o] - C[k][0]) ** 2 + (data[o + 1] - C[k][1]) ** 2 + (data[o + 2] - C[k][2]) ** 2; if (d < bd) { bd = d; bi = k; } }
        labels[j] = bi; const a = acc[bi]; a[0] += data[o]; a[1] += data[o + 1]; a[2] += data[o + 2]; a[3]++;
      }
      for (let k = 0; k < K; k++) if (acc[k][3]) C[k] = [acc[k][0] / acc[k][3], acc[k][1] / acc[k][3], acc[k][2] / acc[k][3]];
    }
    return labels;
  }
  function assignLabels(data, idxs, G) {
    const labels = new Uint8Array(idxs.length);
    for (let j = 0; j < idxs.length; j++) {
      const o = idxs[j] * 3; let bi = 0, bl = -1;
      for (let k = 0; k < G.length; k++) { const l = G[k].w * compLike(G[k], data[o], data[o + 1], data[o + 2]); if (l > bl) { bl = l; bi = k; } }
      labels[j] = bi;
    }
    return labels;
  }

  /* Returns a 0/1 subject mask at working resolution */
  function grabcut(P, rect, iterations) {
    const { W, H } = P;
    const s = Math.min(1, 360 / Math.max(W, H));
    const w = Math.max(8, Math.round(W * s)), h = Math.max(8, Math.round(H * s)), n = w * h;
    // area-downsample the (denoised) RGB
    const data = new Float32Array(n * 3), cnt = new Float32Array(n);
    for (let y = 0; y < H; y++) {
      const sy = Math.min(h - 1, Math.floor(y * s));
      for (let x = 0; x < W; x++) {
        const sx = Math.min(w - 1, Math.floor(x * s)), i = sy * w + sx, o = (y * W + x) * 3;
        data[i * 3] += P.rgb[o]; data[i * 3 + 1] += P.rgb[o + 1]; data[i * 3 + 2] += P.rgb[o + 2]; cnt[i]++;
      }
    }
    for (let i = 0; i < n; i++) { data[i * 3] /= cnt[i]; data[i * 3 + 1] /= cnt[i]; data[i * 3 + 2] /= cnt[i]; }
    const rx0 = Math.floor(rect.x0 * s), ry0 = Math.floor(rect.y0 * s), rx1 = Math.ceil(rect.x1 * s), ry1 = Math.ceil(rect.y1 * s);
    const hardBg = new Uint8Array(n);
    let fg = new Uint8Array(n);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x < rx0 || x > rx1 || y < ry0 || y > ry1 || x === 0 || y === 0 || x === w - 1 || y === h - 1) hardBg[i] = 1; else fg[i] = 1;
    }
    // smoothness weights (8-neighbour), β from mean colour contrast
    const nb = [[1, 0, 1], [0, 1, 1], [1, 1, Math.SQRT1_2], [-1, 1, Math.SQRT1_2]];
    let sum = 0, cntE = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (const [dx, dy] of nb) {
      const xx = x + dx, yy = y + dy; if (xx < 0 || xx >= w || yy >= h) continue;
      const a = (y * w + x) * 3, b = (yy * w + xx) * 3;
      sum += (data[a] - data[b]) ** 2 + (data[a + 1] - data[b + 1]) ** 2 + (data[a + 2] - data[b + 2]) ** 2; cntE++;
    }
    const beta = 1 / (2 * Math.max(1e-6, sum / cntE)), gamma = 50, K = 5;
    const all = [];
    for (let i = 0; i < n; i++) all.push(i);
    for (let it = 0; it < iterations; it++) {
      const fi = [], bi = [];
      for (let i = 0; i < n; i++) (fg[i] ? fi : bi).push(i);
      if (fi.length < 20 || bi.length < 20) break;
      const gf = fitGMM(data, fi, it === 0 ? initLabels(data, fi, K) : assignLabels(data, fi, GF), K);
      const gb = fitGMM(data, bi, it === 0 ? initLabels(data, bi, K) : assignLabels(data, bi, GB), K);
      GF = gf; GB = gb;
      const G = makeGraph(n, n * 8 + 8);
      for (let i = 0; i < n; i++) {
        if (hardBg[i]) { addTweights(G, i, 0, 1e9); continue; }
        const o = i * 3;
        const dF = -Math.log(Math.max(1e-300, gmmLike(gf, data[o], data[o + 1], data[o + 2])));
        const dB = -Math.log(Math.max(1e-300, gmmLike(gb, data[o], data[o + 1], data[o + 2])));
        addTweights(G, i, dB, dF); // cutting source→i (label backdrop) costs dB
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (const [dx, dy, f] of nb) {
        const xx = x + dx, yy = y + dy; if (xx < 0 || xx >= w || yy >= h) continue;
        const i = y * w + x, j = yy * w + xx, a = i * 3, b = j * 3;
        const d = (data[a] - data[b]) ** 2 + (data[a + 1] - data[b + 1]) ** 2 + (data[a + 2] - data[b + 2]) ** 2;
        const v = gamma * f * Math.exp(-beta * d);
        addEdge(G, i, j, v, v);
      }
      const tree = maxflow(G);
      for (let i = 0; i < n; i++) fg[i] = !hardBg[i] && tree[i] === 1 ? 1 : 0;
    }
    // upsample (nearest; edges are re-refined at full resolution afterwards)
    const out = new Uint8Array(W * H);
    for (let y = 0; y < H; y++) { const sy = Math.min(h - 1, Math.floor(y * s)); for (let x = 0; x < W; x++) out[y * W + x] = fg[sy * w + Math.min(w - 1, Math.floor(x * s))]; }
    return out;
  }
  let GF = null, GB = null;

  /* ------------------------------------------------------------------ */
  /* Main segmentation                                                   */
  /* ------------------------------------------------------------------ */
  const DEFAULTS = {
    strength: 50,       // 0–100: how aggressively backdrop-like colours are removed (50 = automatic)
    softness: 1.2,      // edge feather in px (at working resolution)
    shift: 0,           // px: − shrinks the subject edge, + grows it
    speck: 0.15,        // % of image area: smaller loose bits are removed
    shadows: true,      // treat darker/lighter versions of the backdrop (shadows, lighting) as backdrop
    holes: true,        // also remove backdrop colour visible through holes (handles, gaps)
    refine: true,       // GrabCut-style colour-model refinement of the edge band
    rect: null,         // subject box {x,y,w,h} in working-resolution px — everything outside is backdrop
  };

  function segment(P, opts) {
    const o = Object.assign({}, DEFAULTS, opts || {});
    const { W, H, n, L, A, B, grad } = P;
    const wL = o.shadows ? 0.45 : 1;
    let rect = o.rect && o.rect.w > 4 && o.rect.h > 4 ? {
      x0: Math.max(0, Math.round(o.rect.x)), y0: Math.max(0, Math.round(o.rect.y)),
      x1: Math.min(W - 1, Math.round(o.rect.x + o.rect.w)), y1: Math.min(H - 1, Math.round(o.rect.y + o.rect.h)),
    } : null;
    const inRect = i => { const x = i % W, y = (i / W) | 0; return x >= rect.x0 && x <= rect.x1 && y >= rect.y0 && y <= rect.y1; };

    /* 1 — backdrop samples: border ring, or outside the subject box */
    const samples = [];
    const step = Math.max(1, Math.floor(Math.sqrt(n / 60000)));
    if (rect) {
      for (let y = 0; y < H; y += step) for (let x = 0; x < W; x += step) {
        if (x < rect.x0 || x > rect.x1 || y < rect.y0 || y > rect.y1) samples.push(y * W + x);
      }
    }
    if (!rect || samples.length < 50) {
      const ring = Math.max(2, Math.round(Math.min(W, H) * 0.012));
      const bstep = Math.max(1, Math.floor((2 * (W + H) * ring) / 8000));
      let c = 0;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (x < ring || y < ring || x >= W - ring || y >= H - ring) { if (c++ % bstep === 0) samples.push(y * W + x); }
      }
    }

    /* 2 — backdrop colour model: k-means on the samples. A cluster only counts as
           backdrop if it covers a meaningful share AND (without a subject box) shows up
           on at least two sides of the photo — a subject touching one edge is ignored. */
    let clusters = kmeans(P, samples, 6, wL);
    const nearestC = i => {
      let bi = 0, bd = Infinity;
      for (let c = 0; c < clusters.length; c++) {
        const k = clusters[c].lab, dl = (L[i] - k[0]) * wL, da = A[i] - k[1], db = B[i] - k[2], d = dl * dl + da * da + db * db;
        if (d < bd) { bd = d; bi = c; }
      }
      return [bi, Math.sqrt(bd)];
    };
    const sideCount = clusters.map(() => [0, 0, 0, 0]);
    const perSide = [0, 0, 0, 0];
    const residual = [];
    for (const i of samples) {
      const [c, d] = nearestC(i);
      residual.push(d);
      const x = i % W, y = (i / W) | 0;
      const side = rect ? -1 : (y < H * 0.1 ? 0 : y > H * 0.9 ? 2 : x < W * 0.5 ? 3 : 1);
      if (side >= 0) { sideCount[c][side]++; perSide[side]++; }
    }
    const total = samples.length;
    let bgC = clusters.filter((c, ci) => {
      if (c.count / total < (rect ? 0.02 : 0.05)) return false;
      if (rect) return true;
      const sides = sideCount[ci].filter((v, s) => perSide[s] && v / perSide[s] > 0.12).length;
      return sides >= 2;
    });
    if (!bgC.length) bgC = clusters.slice(0, 1);

    /* adaptive tolerance: learn how "noisy" the backdrop is, then scale by the slider
       (strength 0–100, 50 = automatic) */
    const bgSet = new Set(bgC);
    const res = [];
    for (let j = 0; j < samples.length; j++) { const [c] = nearestC(samples[j]); if (bgSet.has(clusters[c])) res.push(residual[j]); }
    res.sort((a, b) => a - b);
    const p90 = res.length ? res[Math.floor(res.length * 0.9)] : 4;
    const baseTol = Math.max(5, Math.min(40, p90 * 2.2 + 3));
    const tol = baseTol * Math.pow(2, ((o.strength ?? 50) - 50) / 35);

    /* busy / textured backdrop (or forced): switch to graph-cut over (almost) the whole photo */
    let method = o.method || 'auto';
    if (method === 'auto') method = baseTol > 12 ? 'graph' : 'flood';
    if (method === 'graph' && !rect) {
      const m = Math.max(2, Math.round(Math.min(W, H) * 0.02));
      rect = { x0: m, y0: m, x1: W - 1 - m, y1: H - 1 - m };
    }

    /* distance of every pixel to the nearest backdrop colour */
    const dC = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let best = Infinity;
      for (const c of bgC) {
        const dl = (L[i] - c.lab[0]) * wL, da = A[i] - c.lab[1], db = B[i] - c.lab[2];
        const d = dl * dl + da * da + db * db;
        if (d < best) best = d;
      }
      dC[i] = Math.sqrt(best);
    }

    /* 3 — edge-aware flood fill from the backdrop seeds */
    const bg = new Uint8Array(n);        // 1 = backdrop
    const locked = new Uint8Array(n);    // 1 = certainly backdrop (outside the subject box / very close match)
    const q = new Int32Array(n);
    let head = 0, tail = 0;
    const seed = i => { if (!bg[i]) { bg[i] = 1; q[tail++] = i; } };
    if (rect) {
      for (let i = 0; i < n; i++) if (!inRect(i)) { bg[i] = 1; locked[i] = 1; }
    } else {
      for (let x = 0; x < W; x++) {
        if (dC[x] < tol) seed(x);
        const j = (H - 1) * W + x; if (dC[j] < tol) seed(j);
      }
      for (let y = 0; y < H; y++) {
        const i = y * W; if (dC[i] < tol) seed(i);
        const j = y * W + W - 1; if (dC[j] < tol) seed(j);
      }
    }
    const edgeW = 0.5, gradMax = tol * (o.shadows ? 0.5 : 0.3), stepMax = tol * (o.shadows ? 0.15 : 0.12), farMax = tol * (o.shadows ? 5 : 2.5);
    const tryAdd = (p, qq) => {
      if (bg[qq]) return;
      const g = grad[qq];
      let ok = dC[qq] + g * edgeW < tol;
      if (!ok && g < gradMax && dC[qq] < farMax) {
        // follow smooth gradients / soft shadows: small step from an already-backdrop neighbour
        const dl = (L[p] - L[qq]) * wL, da = A[p] - A[qq], db = B[p] - B[qq];
        ok = Math.sqrt(dl * dl + da * da + db * db) < stepMax;
      }
      if (ok) { bg[qq] = 1; q[tail++] = qq; }
    };
    while (head < tail) {
      const p = q[head++], x = p % W;
      if (x > 0) tryAdd(p, p - 1);
      if (x < W - 1) tryAdd(p, p + 1);
      if (p >= W) tryAdd(p, p - W);
      if (p < n - W) tryAdd(p, p + W);
    }

    /* 4 — backdrop visible through holes (not connected to the edge) */
    const keyed = new Uint8Array(n);
    if (o.holes && !rect) {
      for (let i = 0; i < n; i++) if (!bg[i] && dC[i] < tol * 0.6 && grad[i] < tol * 0.5 && (!rect || inRect(i))) { keyed[i] = 1; }
      // only accept keyed regions of a reasonable size (avoid punching dots in the subject)
      const kc = components(keyed, W, H, 1);
      const minHole = Math.max(12, n * 0.0004);
      for (let i = 0; i < n; i++) if (keyed[i]) {
        if (kc.sizes[kc.comp[i]] >= minHole) bg[i] = 1; else keyed[i] = 0;
      }
    }
    if (!rect) for (let i = 0; i < n; i++) if (bg[i] && dC[i] < tol * 0.35) locked[i] = 1;

    /* 5 — GrabCut-lite refinement with colour histograms + smoothing */
    let fg;
    if (rect) fg = grabcut(P, rect, 4);   // busy backgrounds: graph-cut inside the subject box
    else { fg = new Uint8Array(n); for (let i = 0; i < n; i++) fg[i] = bg[i] ? 0 : 1; }
    if (o.refine) {
      const rgb = P.rgb;
      const bin = i => ((rgb[i * 3] >> 4) << 8) | ((rgb[i * 3 + 1] >> 4) << 4) | (rgb[i * 3 + 2] >> 4);
      const bins = new Uint16Array(n);
      for (let i = 0; i < n; i++) bins[i] = bin(i);
      const band = Math.max(3, Math.round(Math.min(W, H) * 0.012));
      for (let iter = 0; iter < 2; iter++) {
        const dIn = distTo(fg.map(v => 1 - v), W, H);     // for fg pixels: distance to backdrop
        const dOut = distTo(fg, W, H);                     // for bg pixels: distance to subject
        const hf = new Float32Array(4096), hb = new Float32Array(4096);
        let nf = 0, nb = 0;
        for (let i = 0; i < n; i++) {
          if (fg[i]) { if (dIn[i] > band) { hf[bins[i]]++; nf++; } }
          else if (dOut[i] > band || locked[i]) { hb[bins[i]]++; nb++; }
        }
        if (nf < 50 || nb < 50) break;
        const llr = new Float32Array(4096);
        for (let k = 0; k < 4096; k++) llr[k] = Math.log((hf[k] + 0.5) / (nf + 2048)) - Math.log((hb[k] + 0.5) / (nb + 2048));
        const next = fg.slice();
        for (let i = 0; i < n; i++) {
          if (locked[i] || keyed[i]) continue;
          const near = fg[i] ? dIn[i] <= band : dOut[i] <= band;
          if (!near) continue;
          const x = i % W, y = (i / W) | 0;
          let s = 0, c = 0;
          for (let yy = Math.max(0, y - 1); yy <= Math.min(H - 1, y + 1); yy++)
            for (let xx = Math.max(0, x - 1); xx <= Math.min(W - 1, x + 1); xx++) { if (xx === x && yy === y) continue; s += fg[yy * W + xx] ? 1 : -1; c++; }
          // colour evidence + neighbour agreement + "looks like backdrop" distance + edge strength
          const score = llr[bins[i]] * 0.8 + (s / c) * 1.6 + (dC[i] - tol) / tol * (rect ? 0.3 : 1.2) + (fg[i] ? 0.25 : -0.25);
          next[i] = score > 0 ? 1 : 0;
        }
        fg = next;
      }
    }

    /* 6 — clean-up: keep the main subject + sizeable parts, fill pin-holes */
    const cc = components(fg, W, H, 1);
    if (cc.sizes.length) {
      let largest = 0;
      for (let c = 1; c < cc.sizes.length; c++) if (cc.sizes[c] > cc.sizes[largest]) largest = c;
      const minKeep = n * (o.speck / 100);
      // thickness of each part: thin lines (seams between two backdrop colours, hairline edges) are dropped
      const thick = new Float32Array(cc.sizes.length);
      const dEdge = distTo(fg.map(v => 1 - v), W, H);
      for (let i = 0; i < n; i++) if (fg[i] && dEdge[i] > thick[cc.comp[i]]) thick[cc.comp[i]] = dEdge[i];
      for (let i = 0; i < n; i++) if (fg[i]) {
        const c = cc.comp[i];
        if (c !== largest && (cc.sizes[c] < minKeep || thick[c] < 3)) fg[i] = 0;
      }
    }
    const hc = components(fg, W, H, 0);
    const maxHole = n * 0.0015;
    for (let i = 0; i < n; i++) if (!fg[i]) {
      const c = hc.comp[i];
      if (!hc.touchesEdge[c] && hc.sizes[c] < maxHole && !keyed[i] && !(rect && !inRect(i))) fg[i] = 1;
    }

    /* 7 — shrink / grow edge */
    if (o.shift) {
      const s = Math.abs(o.shift);
      if (o.shift < 0) { const d = distTo(fg.map(v => 1 - v), W, H); for (let i = 0; i < n; i++) if (fg[i] && d[i] <= s) fg[i] = 0; }
      else { const d = distTo(fg, W, H); for (let i = 0; i < n; i++) if (!fg[i] && d[i] <= s) fg[i] = 1; }
    }

    /* 8 — soft anti-aliased alpha from signed distance to the edge */
    const soft = Math.max(0.5, o.softness);
    const dIn = distTo(fg.map(v => 1 - v), W, H), dOut = distTo(fg, W, H);
    const alpha = new Uint8ClampedArray(n);
    for (let i = 0; i < n; i++) {
      const sd = fg[i] ? dIn[i] - 0.5 : -(dOut[i] - 0.5);
      alpha[i] = Math.round(Math.max(0, Math.min(1, 0.5 + sd / (2 * soft))) * 255);
    }

    /* 9 — colour matting on the edge band: for each edge pixel, compare its colour with the
           nearby solid subject colour (F) and nearby backdrop colour (B) and solve C = aF + (1−a)B.
           Gives natural anti-aliasing and removes light/dark halos around the subject. */
    if (o.matte !== false && soft <= 3) {
      const src = P.src, R = 4;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (!(fg[i] ? dIn[i] <= 2.5 : dOut[i] <= 1.5)) continue;
        let fr = 0, fgc = 0, fb = 0, fn = 0, br = 0, bgc2 = 0, bb = 0, bn = 0;
        for (let yy = Math.max(0, y - R); yy <= Math.min(H - 1, y + R); yy++) for (let xx = Math.max(0, x - R); xx <= Math.min(W - 1, x + R); xx++) {
          const j = yy * W + xx, o4 = j * 4;
          if (fg[j] && dIn[j] >= 3) { fr += src[o4]; fgc += src[o4 + 1]; fb += src[o4 + 2]; fn++; }
          else if (!fg[j] && dOut[j] >= 2.5) { br += src[o4]; bgc2 += src[o4 + 1]; bb += src[o4 + 2]; bn++; }
        }
        if (!fn || !bn) continue;
        fr /= fn; fgc /= fn; fb /= fn; br /= bn; bgc2 /= bn; bb /= bn;
        const dx = fr - br, dy = fgc - bgc2, dz = fb - bb, len2 = dx * dx + dy * dy + dz * dz;
        if (len2 < 900) continue; // subject and backdrop too similar here — keep the geometric edge
        const o4 = i * 4;
        const a = ((src[o4] - br) * dx + (src[o4 + 1] - bgc2) * dy + (src[o4 + 2] - bb) * dz) / len2;
        const am = Math.max(0, Math.min(1, a)) * 255;
        // trust the colour estimate, but don't let it contradict the segmentation too much
        alpha[i] = fg[i] ? Math.max(Math.min(am, 255), alpha[i] * 0.25) : Math.min(am, alpha[i] + 140);
      }
    }
    return { alpha, bgColors: bgC.map(c => c.rgb), stats: { method, clusters: bgC.length, tol: Math.round(tol * 10) / 10, subjectPct: Math.round((fg.reduce((s, v) => s + v, 0) / n) * 1000) / 10 } };
  }

  /* ------------------------------------------------------------------ */
  /* Magic eraser: region of similar colour connected to (x,y)           */
  /* ------------------------------------------------------------------ */
  function wand(P, x, y, tolerance) {
    const { W, H, n, L, A, B, grad } = P;
    const s = Math.round(y) * W + Math.round(x);
    const mask = new Uint8Array(n);
    if (s < 0 || s >= n) return mask;
    const tol = Math.max(3, tolerance);
    const sL = L[s], sA = A[s], sB = B[s];
    const q = new Int32Array(n); let head = 0, tail = 0;
    mask[s] = 1; q[tail++] = s;
    const add = (p, j) => {
      if (mask[j]) return;
      const dl = (L[j] - sL) * 0.6, da = A[j] - sA, db = B[j] - sB;
      const ds = Math.sqrt(dl * dl + da * da + db * db);
      const nl = L[j] - L[p], na = A[j] - A[p], nb = B[j] - B[p];
      if ((ds < tol || Math.sqrt(nl * nl + na * na + nb * nb) < tol * 0.2 && ds < tol * 2) && grad[j] < tol * 1.2) { mask[j] = 1; q[tail++] = j; }
    };
    while (head < tail) {
      const p = q[head++], px = p % W;
      if (px > 0) add(p, p - 1);
      if (px < W - 1) add(p, p + 1);
      if (p >= W) add(p, p - W);
      if (p < n - W) add(p, p + W);
    }
    return mask;
  }

  /* ------------------------------------------------------------------ */
  /* Build the final RGBA cut-out, removing backdrop colour fringes      */
  /* ------------------------------------------------------------------ */
  function nearest(colors, r, g, b) {
    let best = colors[0] || [255, 255, 255], bd = Infinity;
    for (const c of colors) { const d = (c[0] - r) ** 2 + (c[1] - g) ** 2 + (c[2] - b) ** 2; if (d < bd) { bd = d; best = c; } }
    return best;
  }
  function applyAlpha(rgba, alpha, bgColors, decontaminate) {
    const n = alpha.length, out = new Uint8ClampedArray(n * 4);
    const cols = bgColors && bgColors.length ? bgColors : null;
    for (let i = 0; i < n; i++) {
      const a = alpha[i], o = i * 4;
      let r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
      if (decontaminate && cols && a > 8 && a < 247) {
        const f = a / 255, c = nearest(cols, r, g, b);
        r = (r - (1 - f) * c[0]) / f; g = (g - (1 - f) * c[1]) / f; b = (b - (1 - f) * c[2]) / f;
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
    return out;
  }
  /* Backdrop colours estimated from a saved mask (used when reopening a design) */
  function estimateBgColors(rgba, alpha) {
    const acc = new Map();
    const n = alpha.length, step = Math.max(1, Math.floor(n / 40000));
    for (let i = 0; i < n; i += step) {
      if (alpha[i] > 10) continue;
      const o = i * 4, k = ((rgba[o] >> 5) << 6) | ((rgba[o + 1] >> 5) << 3) | (rgba[o + 2] >> 5);
      const e = acc.get(k) || [0, 0, 0, 0];
      e[0] += rgba[o]; e[1] += rgba[o + 1]; e[2] += rgba[o + 2]; e[3]++; acc.set(k, e);
    }
    return [...acc.values()].sort((a, b) => b[3] - a[3]).slice(0, 6).map(e => [e[0] / e[3], e[1] / e[3], e[2] / e[3]]);
  }

  /* The original simple method (kept for comparison tests) */
  function legacy(rgba, W, H, tolerance = 42) {
    const d = rgba, patch = (px, py) => { let r = 0, g = 0, b = 0, c = 0; for (let y = py; y < py + 8 && y < H; y++) for (let x = px; x < px + 8 && x < W; x++) { const i = (y * W + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; c++; } return [r / c, g / c, b / c]; };
    const ps = [patch(0, 0), patch(W - 8, 0), patch(0, H - 8), patch(W - 8, H - 8)];
    const bgc = [0, 1, 2].map(c => ps.reduce((s, p) => s + p[c], 0) / 4);
    const soft = tolerance * 0.6, alpha = new Uint8ClampedArray(W * H);
    for (let i = 0; i < W * H; i++) {
      const dr = d[i * 4] - bgc[0], dg = d[i * 4 + 1] - bgc[1], db = d[i * 4 + 2] - bgc[2];
      const dist = Math.sqrt(dr * dr + dg * dg + db * db);
      alpha[i] = dist < tolerance ? 0 : dist < tolerance + soft ? Math.round(((dist - tolerance) / soft) * 255) : 255;
    }
    return alpha;
  }

  const api = { prepare, segment, wand, applyAlpha, estimateBgColors, legacy, DEFAULTS };
  root.PFBG = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof self !== 'undefined' ? self : this);
