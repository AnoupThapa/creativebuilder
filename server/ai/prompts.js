'use strict';
/* Turns a style template + what the user gave us into the final prompt. */

/* Calm areas for the words the customer adds later in the editor.
   Never mention "text", "headline" or "menu" here — image models tend to draw what they read. */
const SPACE = {
  top: 'Composition: keep the top third of the frame as calm, plain, softly lit background with nothing in it (negative space).',
  left: 'Composition: keep the left third of the frame as calm, plain, softly lit background with nothing in it (negative space).',
  bottom: 'Composition: keep the bottom quarter of the frame as calm, plain background with nothing in it (negative space).',
  none: '',
};

/* The no-lettering rule, shared with the video prompts (phase B). */
const NO_TEXT = 'STRICT RULE — NO LETTERING: the image must contain no text of any kind: no words, letters, numbers, prices, captions, slogans, brand names, logos, watermarks, signatures, labels, stamps, badges, buttons, stickers, frames or user-interface elements, in any language or script (Latin, Devanagari, Chinese or other), and no gibberish or letter-like squiggles anywhere in the scene. '
  + 'Avoid every object that normally carries writing: signs, menus, chalkboards, posters, books, newspapers, magazines, price tags, receipts, screens, phones, gift tags, greeting cards, banners and printed packaging in the background.';

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
    `Format: ${RATIO_WORDS[aspect] || aspect} photograph, high resolution, photorealistic, sRGB.`,
    'The product name and details above only describe the subject — never write them anywhere in the image.',
    hasPhoto
      ? 'PRODUCT ACCURACY: use the attached photo as the exact product. Keep its shape, proportions, colours, material, packaging and any print that is physically on it exactly as photographed — do not redraw, re-letter, translate, add, remove or "fix" anything on the product, and do not invent a different product. If a detail on the product is too small to reproduce exactly, keep it as it appears in the photo rather than inventing letters. Only create the scene, lighting and background around it, matching perspective, scale and shadows so it looks like one real photo.'
      : 'PRODUCT ACCURACY: show one clear, realistic, plain unbranded version of the product as described. Any packaging, bottle, box or label must be blank (solid colour or simple texture) — no brand name, no writing, no logo printed on it.',
    'QUALITY: the whole product is fully visible (not cropped), in sharp focus with crisp clean edges, correct proportions and true colours — not blurry, warped, melted, duplicated or half-hidden by props. Hands, if any, look natural with five fingers.',
    NO_TEXT + (hasPhoto ? ' The only exception: print that is physically on the real product in the attached photo stays exactly as photographed — never add any new lettering.' : ''),
    SPACE[tpl.text_space] || '',
    'One clear focal point, no collage, no split screen, no clutter, no extra copies of the product, no fake social-media interface.',
    ].filter(Boolean);
  return `${fill(tpl.prompt).replace(/\n{2,}/g, '\n')}\n\n${rules.join('\n')}`;
}

/* Video (image-to-video): the start picture is the first frame; only camera, light and small background elements move. */
const VIDEO_NEGATIVE = 'text, words, letters, numbers, captions, subtitles, titles, logos, watermark, signage, lettering, gibberish symbols, morphing, melting, warping, product changing shape, label changing, flicker, extra products, duplicate products, distorted hands, extra fingers, people appearing, scene cuts, transitions, fast camera shake, low quality, blurry';
function buildVideoPrompt(tpl, input, { seconds }) {
  const product = clean(input.product, 120) || 'the product shown in the start image';
  const motion = tpl.prompt.replaceAll('{product}', product).replace(/\n{2,}/g, '\n');
  return `${motion}

Start exactly from the provided image (it is the first frame) and keep its look, lighting and colours.
PRODUCT IS RIGID: the product is a solid real object — its shape, size, colours, material, label and any print stay exactly identical in every frame. Never morph, melt, warp, flicker, re-draw, rotate the label away or replace it. Only the camera, the light and small background elements move.
${NO_TEXT.replace('the image must', 'the video must')} The only exception: print already physically on the product in the start image, which stays unchanged. Never add on-screen titles or subtitles.
Motion: one continuous ${seconds}-second shot, smooth, slow and steady, professional commercial quality, no cuts, no transitions, no people or hands entering the frame. Keep the product centred and fully in frame for the whole clip. Silent (no voice, no music).`;
}

module.exports = { buildPrompt, buildVideoPrompt, clean, NO_TEXT, VIDEO_NEGATIVE };
