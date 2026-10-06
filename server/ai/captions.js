'use strict';
/* AI captions: one request writes a caption tuned for each social platform (hook for TikTok,
   professional for LinkedIn, hashtags for Instagram…), in the customer's language.
   Uses the same Gemini / OpenAI key as the images. Without a key: simple template captions. */
const config = require('../config');
const { clean } = require('./prompts');

const PLATFORMS = {
  instagram: { label: 'Instagram', rule: '2–4 short lines that stop the scroll, 1–3 fitting emojis, a clear call to action, then 8–15 relevant hashtags (mix of broad, niche and local).', max: 2200, tags: [8, 15] },
  facebook: { label: 'Facebook', rule: '2–3 friendly sentences that explain the offer, a clear call to action, at most 3 hashtags.', max: 1500, tags: [0, 3] },
  tiktok: { label: 'TikTok', rule: 'one punchy hook line under 150 characters plus 3–5 trending-style hashtags.', max: 300, tags: [3, 5] },
  linkedin: { label: 'LinkedIn', rule: '3–5 professional sentences focused on value for business customers (quality, reliability, supply, service), no slang, at most 3 hashtags.', max: 1300, tags: [0, 3] },
  x: { label: 'X (Twitter)', rule: 'one tweet under 240 characters including 1–2 hashtags.', max: 280, tags: [1, 2] },
  whatsapp: { label: 'WhatsApp Status', rule: 'one or two very short lines with an emoji, no hashtags.', max: 300, tags: [0, 0] },
  pinterest: { label: 'Pinterest', rule: 'a keyword-rich 2–3 sentence description people would search for, 3–5 hashtags.', max: 500, tags: [3, 5] },
  youtube: { label: 'YouTube', rule: 'a title line under 90 characters, then 2–3 sentence description, 3 hashtags.', max: 1000, tags: [0, 3] },
};
const TONES = ['friendly', 'professional', 'fun', 'luxury', 'urgent', 'warm'];

function sanitize(input = {}) {
  const platforms = (Array.isArray(input.platforms) ? input.platforms : Object.keys(PLATFORMS).slice(0, 4))
    .filter(p => PLATFORMS[p]).slice(0, 8);
  return {
    product: clean(input.product, 120), details: clean(input.details, 500), price: clean(input.price, 40),
    offer: clean(input.offer, 120), brand: clean(input.brand, 80), contact: clean(input.contact, 120),
    tone: TONES.includes(input.tone) ? input.tone : 'friendly',
    language: clean(input.language, 40) || 'English',
    platforms: platforms.length ? platforms : ['instagram', 'facebook'],
  };
}

function buildPrompt(c) {
  return `You are an expert social media copywriter for small businesses. Write ready-to-post captions.

Product: ${c.product || '(see details)'}
${c.details ? `Details: ${c.details}\n` : ''}${c.price ? `Price: ${c.price} (write it exactly like this)\n` : ''}${c.offer ? `Offer: ${c.offer}\n` : ''}${c.brand ? `Business name: ${c.brand}\n` : ''}${c.contact ? `Contact / where to buy: ${c.contact}\n` : ''}Tone: ${c.tone}
Language: write every caption in ${c.language}${/english/i.test(c.language) ? '' : ' (natural, correctly spelled, native-speaker wording; hashtags may mix ' + c.language + ' and English)'}.

Write one caption for each of these platforms:
${c.platforms.map(p => `- ${p}: ${PLATFORMS[p].rule}`).join('\n')}

Rules: use only the facts given — never invent prices, discounts, awards, health or medical claims, certifications or guarantees. Spell product and business names exactly as given. No placeholder text like [link]. Keep hashtags relevant (no spaces inside a hashtag).
Answer ONLY with JSON in this shape: {"captions": {"<platform>": {"text": "caption without the hashtags", "hashtags": ["#tag", "#tag"]}}}`;
}

function parse(txt, c) {
  const m = String(txt || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const src = j.captions || j;
  const out = {};
  for (const p of c.platforms) {
    const e = src[p] || src[PLATFORMS[p].label];
    if (!e) continue;
    const text = String(typeof e === 'string' ? e : e.text || '').replace(/\s+\n/g, '\n').trim();
    let tags = Array.isArray(e.hashtags) ? e.hashtags : [];
    tags = [...new Set(tags.map(t => '#' + String(t).replace(/^#+/, '').replace(/\s+/g, '')).filter(t => t.length > 1 && t.length < 60))].slice(0, PLATFORMS[p].tags[1]);
    if (text) out[p] = { text: text.slice(0, PLATFORMS[p].max), hashtags: tags };
  }
  return Object.keys(out).length ? out : null;
}

/* Free fallback (demo mode, or when the AI service fails): simple, correct, editable captions */
function template(c) {
  const name = c.product || 'our latest product';
  const price = c.price ? ` — ${c.price}` : '';
  const offer = c.offer ? ` ${c.offer}.` : '';
  const brand = c.brand ? ` at ${c.brand}` : '';
  const contact = c.contact ? ` ${c.contact}` : '';
  const slug = s => String(s || '').replace(/[^\p{L}\p{N}]+/gu, '');
  const tags = [slug(name), slug(c.brand), 'ShopLocal', 'NewArrival', 'SmallBusiness'].filter(Boolean).map(t => '#' + t);
  const T = {
    instagram: [`✨ ${name}${price}${brand}.${offer}\nTap to order — DM us!${contact}`, tags.slice(0, 5)],
    facebook: [`${name} is here${brand}${price}.${offer} Message us to order today!${contact}`, tags.slice(0, 2)],
    tiktok: [`Have you seen ${name}?${price ? ' Only' + price.replace(' —', '') : ''} 👀`, tags.slice(0, 4)],
    linkedin: [`We're pleased to offer ${name}${brand}.${c.details ? ' ' + c.details : ''}${offer} Get in touch to discuss supply and pricing.${contact}`, tags.slice(0, 2)],
    x: [`${name}${price}${brand}.${offer}`.slice(0, 200), tags.slice(0, 2)],
    whatsapp: [`🛍️ ${name}${price}.${offer}${contact}`, []],
    pinterest: [`${name}${brand}.${c.details ? ' ' + c.details : ''}${offer}`, tags.slice(0, 4)],
    youtube: [`${name}${price}\n${c.details || 'Take a closer look.'}${offer}`, tags.slice(0, 3)],
  };
  return Object.fromEntries(c.platforms.map(p => [p, { text: T[p][0].trim(), hashtags: T[p][1] }]));
}

async function post(url, body, headers) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 45000);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } finally { clearTimeout(t); }
}
const texts = n => (!n || typeof n !== 'object') ? [] : Array.isArray(n) ? n.flatMap(texts) : [...(typeof n.text === 'string' ? [n.text] : []), ...Object.values(n).flatMap(v => typeof v === 'object' ? texts(v) : [])];

async function write(input) {
  const c = sanitize(input);
  if (!c.product && !c.details) throw Object.assign(new Error('Add the product name or a few details first.'), { status: 400 });
  const a = config.ai;
  const which = a.provider === 'demo' ? null : a.provider === 'openai' && a.openaiKey ? 'openai' : a.geminiKey ? 'gemini' : a.openaiKey ? 'openai' : null;
  if (!which) return { captions: template(c), source: 'template' };
  try {
    let r, out;
    if (which === 'gemini') {
      r = await post(`${a.geminiBase}/v1beta/models/${encodeURIComponent(a.geminiCheckModel)}:generateContent`,
        { contents: [{ parts: [{ text: buildPrompt(c) }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.8 } }, { 'x-goog-api-key': a.geminiKey });
      out = r.status < 300 ? parse(texts(r.json).join('\n'), c) : null;
    } else {
      r = await post(`${a.openaiBase}/v1/chat/completions`,
        { model: a.openaiCheckModel, messages: [{ role: 'user', content: buildPrompt(c) }], response_format: { type: 'json_object' } }, { Authorization: `Bearer ${a.openaiKey}` });
      out = r.status < 300 ? parse(r.json?.choices?.[0]?.message?.content, c) : null;
    }
    if (!out) { console.warn('[captions]', which, r.status, (r.text || '').slice(0, 200)); return { captions: template(c), source: 'template', note: 'The AI was unavailable, so simple captions were written instead.' }; }
    // fill any platform the AI skipped
    const t = template(c);
    for (const p of c.platforms) if (!out[p]) out[p] = t[p];
    return { captions: out, source: which };
  } catch (e) {
    console.warn('[captions]', e.message);
    return { captions: template(c), source: 'template', note: 'The AI was unavailable, so simple captions were written instead.' };
  }
}

module.exports = { write, PLATFORMS, TONES, sanitize, parse, template };
