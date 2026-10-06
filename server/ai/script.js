'use strict';
/* Presenter script for AI model videos: what the made-up presenter says about the product.
   Rules: only facts the business gave us, spoken like an advert presenter — never as a customer
   describing their own experience (the presenter does not exist, so that would be a fake testimonial). */
const config = require('../config');
const { clean } = require('./prompts');
const { testimonialProblem } = require('./characters');

const WPS = { English: 2.5 };                    // comfortable speaking speed (words per second)
const wordsFor = (sec, lang) => Math.round(sec * (WPS[lang] || 2.2));
const TONES = { friendly: 'warm and friendly', professional: 'confident and professional', energetic: 'upbeat and energetic', calm: 'calm and reassuring', luxury: 'elegant and premium' };

function sanitize(input = {}) {
  return {
    product: clean(input.product, 120), details: clean(input.details, 500), price: clean(input.price, 40),
    brand: clean(input.brand, 80), cta: clean(input.cta, 80),
    language: clean(input.language, 40) || 'English',
    tone: TONES[input.tone] ? input.tone : 'friendly',
    seconds: +input.seconds === 15 ? 15 : 8,
  };
}

function prompt(c) {
  const words = wordsFor(c.seconds, c.language);
  return `Write the spoken script for a ${c.seconds}-second vertical social-media video ad. An on-screen presenter talks directly to the camera about a product.

Product: ${c.product || '(see details)'}
${c.details ? `Key features / details: ${c.details}\n` : ''}${c.price ? `Price: ${c.price} (say it exactly)\n` : ''}${c.brand ? `Business: ${c.brand}\n` : ''}${c.cta ? `Call to action: ${c.cta}\n` : ''}Tone: ${TONES[c.tone]}
Language: ${c.language}${/english/i.test(c.language) ? '' : ' (natural, correctly spelled, native-speaker wording)'}

Rules:
- About ${words} words in total (it must fit ${c.seconds} seconds when spoken naturally). ${c.seconds === 15 ? 'Write it as two short parts: part 1 (hook + first feature) and part 2 (more features + call to action).' : 'One short part: a hook, the key feature(s), a call to action.'}
- The presenter is a PRESENTER, not a customer: describe what the product is and does ("This serum has…", "It comes in…", "You get…"). NEVER speak as someone who bought or used it — no "I've been using", "I bought", "my skin", "changed my life", no reviews or ratings.
- Use only the facts given. Never invent prices, discounts, awards, health, medical or results claims, certifications or guarantees.
- Plain spoken sentences only: no emojis, hashtags, stage directions, brackets or speaker names.
Answer ONLY with JSON: {"parts": ["part 1 text"${c.seconds === 15 ? ', "part 2 text"' : ''}]}`;
}

function template(c) {
  const name = c.product || 'our product';
  const feat = c.details ? c.details.split(/[.·;\n]/).map(s => s.trim()).filter(Boolean).slice(0, 2).join(', ') : '';
  const p1 = `Meet ${name}${feat ? ` — ${feat}` : ''}.`;
  const p2 = `${c.price ? `Just ${c.price}. ` : ''}${c.cta || (c.brand ? `Get yours from ${c.brand} today.` : 'Order yours today.')}`;
  return c.seconds === 15 ? [p1, p2] : [`${p1} ${p2}`];
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
function parse(txt, c) {
  const m = String(txt || '').match(/\{[\s\S]*\}/); if (!m) return null;
  let j; try { j = JSON.parse(m[0]); } catch { return null; }
  const parts = (Array.isArray(j.parts) ? j.parts : [j.script || j.text]).map(s => String(s || '').replace(/[#*_[\]{}<>]/g, '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!parts.length) return null;
  const out = c.seconds === 15 ? (parts.length >= 2 ? parts.slice(0, 2) : splitHalf(parts[0])) : [parts.join(' ')];
  return out.some(p => testimonialProblem(p)) ? null : out;
}
function splitHalf(s) {
  const sent = String(s).match(/[^.!?।]+[.!?।]*/g) || [s];
  if (sent.length < 2) { const w = s.split(' '); return [w.slice(0, Math.ceil(w.length / 2)).join(' '), w.slice(Math.ceil(w.length / 2)).join(' ')]; }
  const half = Math.ceil(sent.length / 2);
  return [sent.slice(0, half).join(' ').trim(), sent.slice(half).join(' ').trim()];
}

async function write(input) {
  const c = sanitize(input);
  if (!c.product && !c.details) throw Object.assign(new Error('Add the product name or a few details first.'), { status: 400 });
  const a = config.ai;
  const which = a.provider === 'demo' ? null : a.provider === 'openai' && a.openaiKey ? 'openai' : a.geminiKey ? 'gemini' : a.openaiKey ? 'openai' : null;
  if (!which) return { parts: template(c), source: 'template', words: wordsFor(c.seconds, c.language) };
  try {
    let r, out;
    if (which === 'gemini') {
      r = await post(`${a.geminiBase}/v1beta/models/${encodeURIComponent(a.geminiCheckModel)}:generateContent`,
        { contents: [{ parts: [{ text: prompt(c) }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.8 } }, { 'x-goog-api-key': a.geminiKey });
      out = r.status < 300 ? parse(texts(r.json).join('\n'), c) : null;
    } else {
      r = await post(`${a.openaiBase}/v1/chat/completions`,
        { model: a.openaiCheckModel, messages: [{ role: 'user', content: prompt(c) }], response_format: { type: 'json_object' } }, { Authorization: `Bearer ${a.openaiKey}` });
      out = r.status < 300 ? parse(r.json?.choices?.[0]?.message?.content, c) : null;
    }
    if (!out) return { parts: template(c), source: 'template', words: wordsFor(c.seconds, c.language), note: 'The AI was unavailable, so a simple script was written instead.' };
    return { parts: out, source: which, words: wordsFor(c.seconds, c.language) };
  } catch (e) {
    console.warn('[script]', e.message);
    return { parts: template(c), source: 'template', words: wordsFor(c.seconds, c.language), note: 'The AI was unavailable, so a simple script was written instead.' };
  }
}

/* Check a script the user typed or edited → { parts, problem } */
function check(parts, seconds, language) {
  parts = (Array.isArray(parts) ? parts : [parts]).map(s => clean(s, 400)).filter(Boolean);
  if (!parts.length) return { problem: 'Write what the presenter should say (or press “Write it for me”).' };
  if (seconds === 15 && parts.length === 1) parts = splitHalf(parts[0]);
  if (seconds !== 15) parts = [parts.join(' ')];
  const t = testimonialProblem(parts.join(' '));
  if (t) return { problem: `The presenter is an AI character, so they can’t speak as a customer (“${t}”). Describe what the product is and does instead — e.g. “This serum has vitamin C…”.` };
  const words = parts.join(' ').split(/\s+/).filter(Boolean).length, max = Math.round(wordsFor(seconds, language) * 1.35);
  if (words > max) return { problem: `That’s too much to say in ${seconds} seconds (${words} words — keep it under ${max}).` };
  return { parts };
}

module.exports = { write, check, wordsFor, TONES, splitHalf };
