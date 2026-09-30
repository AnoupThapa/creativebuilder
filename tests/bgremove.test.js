'use strict';
/* Accuracy tests for the background-removal engine on synthetic product photos. */
const test = require('node:test');
const assert = require('node:assert/strict');
const BG = require('../public/js/bgremove.js');

const W = 400, H = 400;
function make(bgFn, inside, fgColor, noise = 3) {
  const rgba = new Uint8ClampedArray(W * H * 4), gt = new Uint8Array(W * H);
  let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * noise;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = i * 4, f = inside(x, y);
    const c = f ? fgColor(x, y) : bgFn(x, y);
    rgba[o] = c[0] + rnd(); rgba[o + 1] = c[1] + rnd(); rgba[o + 2] = c[2] + rnd(); rgba[o + 3] = 255; gt[i] = f ? 1 : 0;
  }
  return { rgba, gt };
}
function iou(alpha, gt) { let a = 0, u = 0; for (let i = 0; i < gt.length; i++) { const p = alpha[i] > 127, t = gt[i]; if (p && t) a++; if (p || t) u++; } return a / u; }
const ellipse = (cx, cy, rx, ry) => (x, y) => ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;

const cases = {
  'gradient backdrop': make((x, y) => [120 - y / 5, 170 - y / 4.5, 230 - y / 3.3], ellipse(200, 200, 70, 110), () => [240, 190, 60]),
  'low-contrast cream on grey': make(() => [214, 214, 214], (x, y) => x > 110 && x < 290 && y > 120 && y < 300, () => [238, 232, 212]),
  'white mug on pale blue with handle hole': make(() => [200, 220, 240],
    (x, y) => (x > 120 && x < 250 && y > 130 && y < 300) || (ellipse(260, 215, 45, 50)(x, y) && !ellipse(262, 215, 22, 26)(x, y)), () => [240, 240, 235]),
  'subject touching bottom edge': make(() => [225, 205, 175], (x, y) => ellipse(200, 330, 140, 120)(x, y), () => [60, 60, 70]),
  'two-tone wall + table': make((x, y) => (y > 250 ? [150, 110, 80] : [235, 225, 210]), ellipse(200, 190, 70, 100), () => [60, 140, 60], 6),
};

for (const [name, c] of Object.entries(cases)) {
  test(`auto cut-out: ${name}`, () => {
    const P = BG.prepare(c.rgba, W, H);
    const r = BG.segment(P, {});
    const score = iou(r.alpha, c.gt);
    assert.ok(score > 0.95, `IoU ${score.toFixed(3)} should be > 0.95`);
    const legacy = iou(BG.legacy(c.rgba, W, H), c.gt);
    assert.ok(score >= legacy - 0.01, `new (${score.toFixed(3)}) should not be worse than legacy (${legacy.toFixed(3)})`);
  });
}

test('subject box (GrabCut) separates subject on a noisy textured backdrop', () => {
  const c = make((x, y) => [140 + 40 * Math.sin(x / 7) * Math.cos(y / 9), 90 + 30 * Math.sin(y / 5), 60], ellipse(200, 200, 90, 90), () => [230, 230, 240], 10);
  const P = BG.prepare(c.rgba, W, H);
  const r = BG.segment(P, { rect: { x: 90, y: 90, w: 220, h: 220 } });
  assert.ok(iou(r.alpha, c.gt) > 0.93, 'IoU ' + iou(r.alpha, c.gt));
});

test('magic eraser selects a connected colour region only', () => {
  const c = make(() => [250, 250, 250], (x, y) => x > 100 && x < 300 && y > 100 && y < 300, () => [30, 90, 160], 1);
  const P = BG.prepare(c.rgba, W, H);
  const m = BG.wand(P, 200, 200, 10);
  let inside = 0, outside = 0;
  for (let i = 0; i < m.length; i++) if (m[i]) c.gt[i] ? inside++ : outside++;
  assert.ok(inside > 190 * 190 * 0.95 && outside === 0);
});
