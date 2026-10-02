'use strict';
/* Ready-made AI styles per industry. Users never write prompts: they pick a style and give
   a product photo, a link or a short description; the {placeholders} are filled in by the server.
   Rules every prompt shares (no text, keep the real product…) are added in prompts.js.
   Admins can edit the wording later in Platform admin → AI studio. */

const INDUSTRIES = [
  { key: 'food',     label: 'Restaurant & food',       emoji: '🍽️' },
  { key: 'cafe',     label: 'Café & bakery',           emoji: '☕' },
  { key: 'shop',     label: 'Online shop & retail',    emoji: '🛍️' },
  { key: 'beauty',   label: 'Beauty & salon',          emoji: '💄' },
  { key: 'supplies', label: 'Health, cleaning & B2B',  emoji: '🧴' },
  { key: 'festive',  label: 'Festivals & seasons',     emoji: '🪔' },
];

const T = (key, industry, name, emoji, description, prompt, extra = {}) =>
  ({ key, industry, kind: 'image', name, emoji, description, prompt, needs_photo: 0, text_space: 'top', ...extra });

const TEMPLATES = [
  /* ---------- Restaurant & food (real photo only: the dish must look like what is served) ---------- */
  T('food_hero_plate', 'food', 'Hero plate', '🍛', 'Your dish on a beautiful table, restaurant lighting',
    `A mouth-watering, photorealistic restaurant advertising photo of {product}. {details}
The dish is the single hero, sharp and appetising, plated on a stylish plate on a {setting}. Warm, moody restaurant lighting from the side, gentle highlights on sauces and textures, soft shadows, shallow depth of field so the background melts away.
A few small, natural props (cutlery, a folded linen napkin, scattered fresh herbs or spices) around the plate, never covering the food.
Colour mood: {colours}. Feeling: {mood}.`,
    { needs_photo: 1, text_space: 'top', setting: 'dark wooden restaurant table' }),
  T('food_flatlay', 'food', 'Overhead flat lay', '🥗', 'Top-down spread — great for menus and combos',
    `A photorealistic overhead (top-down, 90°) flat-lay food advertising photo featuring {product}. {details}
The dish sits slightly off-centre on a {setting}, with complementary side dishes, sauces in small bowls and fresh ingredients arranged neatly around it — balanced, generous and inviting.
Bright, soft, even daylight; rich true-to-life food colours; crisp detail.
Colour mood: {colours}. Feeling: {mood}.`,
    { needs_photo: 1, text_space: 'left', setting: 'textured stone or rustic wooden surface' }),
  T('food_steam', 'food', 'Fresh & hot close-up', '♨️', 'Close-up with gentle steam — makes food look just cooked',
    `A photorealistic close-up advertising photo of {product}, freshly cooked and hot, with delicate natural steam rising. {details}
Low camera angle, dramatic warm backlight that makes the steam glow, dark blurred background, rich glossy textures. The food fills the lower-middle of the frame.
Colour mood: {colours}. Feeling: {mood}.`,
    { needs_photo: 1, text_space: 'top', setting: 'dark kitchen background' }),
  T('food_menu_board', 'food', 'Menu / special background', '📋', 'Your dish on one side, a calm empty area for your menu words',
    `A photorealistic, styled food advertising background for {product}. {details}
The dish is placed on the right third of the frame on a {setting}; the left two-thirds is calm, uncluttered, softly lit plain surface with gentle texture and nothing on it (negative space).
Elegant, minimal, premium restaurant look.
Colour mood: {colours}. Feeling: {mood}.`,
    { needs_photo: 1, text_space: 'left', setting: 'matte dark slate surface' }),

  /* ---------- Café & bakery ---------- */
  T('cafe_morning', 'cafe', 'Morning café', '🥐', 'Coffee or pastry in warm morning window light',
    `A photorealistic café advertising photo of {product} on a {setting} next to a window. {details}
Warm golden morning sunlight streaming in, soft shadows, a cosy blurred café interior behind, a little natural latte foam or a few crumbs for authenticity. The product is the sharp single focal point in the lower-middle.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'marble café table' }),
  T('bakery_counter', 'cafe', 'Bakery display', '🍰', 'Fresh bakes on a counter — inviting and homely',
    `A photorealistic bakery advertising photo of {product} displayed on a {setting}. {details}
Freshly baked look, soft flour dusting, warm bakery lighting, softly out-of-focus loaves and cakes in the background (no shelf tags, no chalkboards). Product sharp and centred, about half of the frame.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'rustic wooden bakery counter with parchment paper' }),

  /* ---------- Online shop & retail ---------- */
  T('shop_studio', 'shop', 'Studio packshot', '📦', 'Clean product photo on a soft colour backdrop',
    `A premium photorealistic e-commerce studio photo of {product}. {details}
The product stands centred on a seamless {setting}, filling about 50% of the frame, with a soft natural contact shadow and subtle reflection. Large soft-box lighting, crisp edges, true-to-life colours, perfect focus on the whole product.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'pastel paper backdrop in a colour that complements the product', text_space: 'top' }),
  T('shop_lifestyle', 'shop', 'Lifestyle in use', '🏡', 'Your product in a real, stylish everyday setting',
    `A photorealistic lifestyle advertising photo of {product} being used naturally in a {setting}. {details}
Authentic, social-media-native look (not stock-photo stiff). Natural daylight, shallow depth of field, the product sharp and clearly the focal point; if a person appears, show only hands or a partial figure so the product stays the hero.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'bright modern home', text_space: 'top' }),
  T('shop_flatlay', 'shop', 'Flat lay with props', '🧺', 'Top-down arrangement with matching props',
    `A photorealistic top-down flat-lay product photo of {product} on a {setting}. {details}
Neatly arranged complementary props that suit the product and its buyers, generous breathing space, soft even light, crisp detail, editorial Instagram style. The product is clearly the largest, sharpest item.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'clean light linen or paper surface', text_space: 'left' }),
  T('shop_podium', 'shop', 'Podium showcase', '🏆', 'Product on a stylish podium — perfect for launches and sales',
    `A photorealistic 3D-style product showcase of {product} standing on a {setting}. {details}
Minimal geometric shapes and soft shadows around it, gentle gradient background, premium launch-campaign feel, product razor sharp and centred.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'round matte podium', text_space: 'top' }),

  /* ---------- Beauty & salon ---------- */
  T('beauty_pastel', 'beauty', 'Soft pastel beauty', '🌸', 'Skincare & cosmetics with petals, water and soft light',
    `A photorealistic luxury beauty advertising photo of {product} on a {setting}. {details}
Delicate props such as flower petals, water droplets or smooth stones, soft diffused light, gentle reflections, clean premium cosmetic-brand aesthetic, product sharp and beautifully lit.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'glossy pastel acrylic surface', text_space: 'top' }),
  T('beauty_texture', 'beauty', 'Texture splash', '💧', 'Product with a cream / liquid texture swirl',
    `A photorealistic macro beauty advertising photo of {product} beside an elegant swirl of its own texture (cream, gel, oil or powder) on a {setting}. {details}
Studio lighting with soft highlights, very shallow depth of field, high-end cosmetic campaign look.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'smooth neutral surface', text_space: 'top' }),

  /* ---------- Health, cleaning & B2B supplies ---------- */
  T('supplies_clinical', 'supplies', 'Clean & professional', '🩺', 'Bright, hygienic workplace setting — clinics, cleaners, kitchens',
    `A photorealistic advertising photo of {product} in a bright, spotless {setting}. {details}
Clean white and soft-blue tones, even natural daylight, everything tidy and hygienic; the product is the sharp single focal point on the counter in the lower-middle of the frame. Trustworthy, professional, calm. No signs, posters, certificates, symbols or screens in the background.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'professional workplace such as a clinic, commercial kitchen or office', text_space: 'top' }),
  T('supplies_in_use', 'supplies', 'Hands at work', '🧤', 'Worker hands using the product — shows real value',
    `A photorealistic close-up advertising photo of a worker's hands naturally using {product} in a {setting}. {details}
Authentic documentary style, natural light, realistic skin with five fingers on each hand, product sharp and clearly visible; background softly blurred.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'busy but clean commercial workplace', text_space: 'top' }),

  /* ---------- Festivals & seasons ---------- */
  T('festive_lights', 'festive', 'Festival of lights', '🪔', 'Dashain, Tihar, Diwali — diyas, marigolds and warm lights',
    `A photorealistic festive advertising photo of {product} surrounded by glowing clay diyas, marigold flowers and warm bokeh lights (no greeting words, no symbols with letters), on a {setting}. {details}
Rich warm golden and orange tones, joyful celebratory mood, product sharp and centred as the hero.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'festive table with a rangoli-inspired pattern', text_space: 'top' }),
  T('festive_christmas', 'festive', 'Christmas & New Year', '🎄', 'Cosy Christmas or New Year scene around your product',
    `A photorealistic festive advertising photo of {product} on a {setting} with soft fairy lights, pine branches, small plain wrapped gifts (no tags or cards) and gentle bokeh. {details}
Cosy, warm and celebratory, product sharp and centred as the hero.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'cosy wooden table', text_space: 'top' }),
  T('festive_sale', 'festive', 'Big sale backdrop', '🏷️', 'Energetic sale-day scene — bold colours and confetti; add your offer in the editor',
    `A photorealistic, energetic celebration-style shopping campaign photo of {product} on a {setting}, with dynamic bright abstract colour shapes and a little falling plain confetti. {details}
Punchy contrast, exciting but uncluttered, product sharp and centred in the lower half; the upper area is plain calm colour with nothing in it.
Colour mood: {colours}. Feeling: {mood}.`,
    { setting: 'bold colour block backdrop', text_space: 'top' }),
];

/* ---------- Video motions (phase B) ----------
   Image-to-video from a start picture. Only the camera, light and small background elements move —
   the product itself stays rigid so its shape and label never change. Rules shared by every motion
   (no lettering, rigid product, smooth camera) are added in prompts.js. */
const V = (key, name, emoji, description, prompt, extra = {}) =>
  ({ key, industry: 'video', kind: 'video', name, emoji, description, prompt, needs_photo: 1, text_space: 'none', setting: '', ...extra });

const VIDEO_TEMPLATES = [
  V('vid_light_sweep', 'Light sweep', '✨', 'A soft studio light glides across your product — classy and safe for any product',
    `A premium product commercial shot of {product}. The camera stays almost still with a very slight slow push-in.
A soft beam of studio light sweeps slowly across the scene from left to right, creating a gentle moving highlight and reflection over the product, then settles. Subtle floating dust particles glow in the light. Elegant, calm, high-end.`),
  V('vid_push_in', 'Slow push-in', '🎯', 'Camera glides gently towards your product — draws the eye',
    `A cinematic product commercial shot of {product}. The camera performs one smooth, slow dolly push-in towards the product, ending slightly closer with the product still fully in frame and centred. Background softly defocuses as the camera moves. Calm, premium, steady.`),
  V('vid_orbit', 'Slow orbit (3D feel)', '🔄', 'Camera circles a little around the product for a 3D look',
    `A product commercial shot of {product}. The camera makes a slow, smooth partial orbit of about 25 degrees around the product at the same height, keeping it centred, showing a little more of its side for a three-dimensional feel. Realistic parallax in the background; lighting follows naturally.`),
  V('vid_float', 'Floating hero', '🎈', 'Product gently floats and turns slightly — great for launches',
    `A playful premium product commercial shot of {product}. The product gently levitates a few centimetres and bobs up and down slowly with a very slight rotation (less than 15 degrees), its soft shadow below growing and shrinking accordingly. Smooth, weightless, satisfying loop-like motion.`),
  V('vid_parallax', 'Parallax depth', '🌄', 'Background drifts behind your product — subtle and modern',
    `A modern product commercial shot of {product}. Slow lateral camera slide to the right creating gentle parallax: the background and any props drift more than the product, which stays sharp and centred. Subtle, smooth, cinematic depth.`),
  V('vid_steam', 'Hot & fresh', '♨️', 'Steam rises from the food or drink — makes it look just made',
    `An appetising food commercial shot of {product}. The food or drink stays exactly as it is; delicate natural wisps of steam rise slowly and curl in warm backlight, with a very slow push-in. Warm, inviting, mouth-watering.`),
  V('vid_splash', 'Fresh splash', '💧', 'Water droplets and a gentle splash around the product — beauty & drinks',
    `A fresh product commercial shot of {product}. Around and behind the product, clear water droplets fall in slow motion and a gentle splash of water rises and settles at its base; small droplets glisten on surfaces. The product itself does not move or change. Crisp, refreshing, clean.`),
  V('vid_festive', 'Festive glow', '🪔', 'Twinkling lights and slowly falling petals or confetti — festivals & sales',
    `A festive product commercial shot of {product}. Warm bokeh lights twinkle softly in the background and a few marigold petals or plain confetti pieces drift slowly down behind and around the product, never covering it. Slight slow push-in. Joyful, celebratory, warm.`),
];

module.exports = { INDUSTRIES, TEMPLATES: [...TEMPLATES, ...VIDEO_TEMPLATES], IMAGE_TEMPLATES: TEMPLATES, VIDEO_TEMPLATES };
