'use strict';
/* Reads a public product page (name, description, price, main photo) from a link the user pastes.
   Safety: only http(s) on normal ports, never private / internal addresses (checked on every redirect),
   small size limits and short timeouts. */
const dns = require('node:dns').promises;
const net = require('node:net');

const MAX_HTML = 2 * 1024 * 1024, MAX_IMG = 12 * 1024 * 1024;

function privateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224 || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
  }
  const v = ip.toLowerCase();
  if (v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb')) return true;
  const m = /::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
  return m ? privateIp(m[1]) : false;
}

async function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw Object.assign(new Error('That doesn’t look like a web link.'), { status: 400 }); }
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Use an http:// or https:// link.'), { status: 400 });
  if (u.port && !['80', '443'].includes(u.port) && !process.env.AI_URL_ALLOW_PRIVATE) throw Object.assign(new Error('That link uses an unusual port.'), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error('Links with passwords are not allowed.'), { status: 400 });
  if (!process.env.AI_URL_ALLOW_PRIVATE) {
    const addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.lookup(u.hostname, { all: true }).catch(() => []);
    if (!addrs.length) throw Object.assign(new Error('That website could not be found.'), { status: 400 });
    if (addrs.some(a => privateIp(a.address))) throw Object.assign(new Error('That link points to a private address.'), { status: 400 });
  }
  return u;
}

async function safeFetch(raw, { max, accept }) {
  let url = await checkUrl(raw);
  for (let hop = 0; hop < 4; hop++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 10000);
    let r;
    try {
      r = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PostGenXBot/1.0; +https://creativebuilder.fly.dev)', Accept: accept } });
    } catch (e) { clearTimeout(t); throw Object.assign(new Error('Could not open that link. Check it opens in your browser.'), { status: 400 }); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      clearTimeout(t);
      url = await checkUrl(new URL(r.headers.get('location'), url).href);
      continue;
    }
    if (!r.ok) { clearTimeout(t); throw Object.assign(new Error(`That page answered with an error (${r.status}).`), { status: 400 }); }
    const chunks = []; let size = 0;
    const reader = r.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > max) { ctl.abort(); throw Object.assign(new Error('That file is too big.'), { status: 400 }); }
        chunks.push(value);
      }
    } finally { clearTimeout(t); }
    return { buffer: Buffer.concat(chunks), type: r.headers.get('content-type') || '', url: url.href };
  }
  throw Object.assign(new Error('Too many redirects.'), { status: 400 });
}

const decode = s => String(s || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).trim();
function meta(html, names) {
  for (const n of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${n}["'][^>]*>`, 'i');
    const tag = re.exec(html)?.[0];
    const c = tag && /content=["']([^"']*)["']/i.exec(tag)?.[1];
    if (c) return decode(c);
  }
  return '';
}
function jsonLdProduct(html) {
  const blocks = html.match(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const b of blocks) {
    try {
      const data = JSON.parse(b.replace(/^<script[^>]*>|<\/script>$/gi, ''));
      const all = [].concat(data['@graph'] || data);
      const p = all.find(x => x && /Product/i.test([].concat(x['@type']).join(' ')));
      if (p) return p;
    } catch { /* ignore broken json-ld */ }
  }
  return null;
}

async function readProductPage(link) {
  const page = await safeFetch(link, { max: MAX_HTML, accept: 'text/html,application/xhtml+xml' });
  const html = page.buffer.toString('utf8');
  const ld = jsonLdProduct(html) || {};
  const offer = [].concat(ld.offers || [])[0] || {};
  const name = decode(ld.name) || meta(html, ['og:title', 'twitter:title']) || decode(/<title[^>]*>([^<]*)/i.exec(html)?.[1]);
  const desc = decode(typeof ld.description === 'string' ? ld.description.replace(/<[^>]+>/g, ' ') : '') || meta(html, ['og:description', 'description', 'twitter:description']);
  let image = [].concat(ld.image || [])[0];
  if (image && typeof image === 'object') image = image.url || image.contentUrl;
  image = image || meta(html, ['og:image:secure_url', 'og:image', 'twitter:image']);
  const price = offer.price ? `${offer.priceCurrency || ''} ${offer.price}`.trim() : meta(html, ['product:price:amount', 'og:price:amount']);
  const brand = decode(typeof ld.brand === 'string' ? ld.brand : ld.brand?.name || '');
  return {
    product: name.replace(/\s*[|–-]\s*[^|–-]*$/, '').slice(0, 120) || name.slice(0, 120),
    details: [brand && `Brand: ${brand}`, desc.slice(0, 300)].filter(Boolean).join('. '),
    price, imageUrl: image ? new URL(image, page.url).href : '', pageUrl: page.url,
  };
}

async function fetchImage(link) {
  const r = await safeFetch(link, { max: MAX_IMG, accept: 'image/avif,image/webp,image/png,image/jpeg,*/*' });
  return r.buffer;
}

module.exports = { readProductPage, fetchImage, privateIp, checkUrl };
