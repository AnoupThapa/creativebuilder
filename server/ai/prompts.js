'use strict';
/* Turns a style template + what the user gave us into the final prompt. */

const SPACE = {
  top: 'Keep the top third of the image calm and uncluttered (soft background only) — a headline will be added there later.',
  left: 'Keep the left third of the image calm and uncluttered (soft background only) — text will be added there later.',
  bottom: 'Keep the bottom quarter calm and uncluttered — text will be added there later.',
  none: '',
};

const RATIO_WORDS = { '4:5': 'vertical 4:5', '1:1': 'square 1:1', '9:16': 'tall vertical 9:16 (keep the subject in the middle band, away from the top and bottom edges)', '16:9': 'wide horizontal 16:9' };

/* Remove anything that could be read as an instruction to the image model */
function clean(v, max) {
  return String(v || '').replace(/[\u0000-\u001f<>{}\[\]`]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function buildPrompt(tpl, input, { hasPhoto, aspect }) {
  const product = clean(input.product, 120) || (hasPhoto ? 'the product shown in the attached photo' : 'the product');
  const details = clean(input.details, 400);
  const colours = clean(input.colours, 80) || 'natural, harmonious colours that suit the product';
  const mood = clean(input.mood, 60) || 'fresh, inviting and premium';
  const setting = clean(input.setting, 120) || tpl.setting || 'a setting that suits the product';
  const fill = s => s
    .replaceAll('{product}', product)
    .replaceAll('{details}', details ? `Product details: ${details}.` : '')
    .replaceAll('{colours}', colours)
    .replaceAll('{mood}', mood)
    .replaceAll('{setting}', setting);

  const rules = [
    `Format: ${RATIO_WORDS[aspect] || aspect} photograph, high resolution, sRGB.`,
    hasPhoto
      ? 'Use the attached photo as the exact product: keep its shape, colours, packaging, label text and logo 100% unchanged — do not redraw, restyle or invent a different product. Only create the scene, lighting and background around it, matching perspective and shadows so it looks like one real photo.'
      : 'Show one clear, realistic product as described.',
    'ABSOLUTELY NO added text, words, letters, numbers, prices, captions, logos, watermarks, badges, buttons, stickers or frames anywhere in the image (only text that is physically printed on the real product may appear).',
    SPACE[tpl.text_space] || '',
    'One clear focal point, no collage, no clutter, no extra copies of the product, no distorted hands or faces, no fake social-media UI.',
  ].filter(Boolean);
  return `${fill(tpl.prompt).replace(/\n{2,}/g, '\n')}\n\n${rules.join('\n')}`;
}

module.exports = { buildPrompt, clean };
