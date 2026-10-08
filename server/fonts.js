'use strict';
/* Self-hosted fonts (from @fontsource packages) — no calls to Google, works offline,
   GDPR-friendly, and the canvas editor can rely on them being available. */
const fs = require('node:fs');
const path = require('node:path');

const PKGS = ['bricolage-grotesque', 'fraunces', 'manrope', 'space-grotesk', 'inter', 'poppins', 'montserrat', 'nunito', 'raleway', 'oswald', 'bebas-neue', 'anton',
  'archivo-black', 'playfair-display', 'dm-serif-display', 'merriweather', 'lobster', 'pacifico', 'dancing-script', 'caveat', 'courier-prime',
  // local languages — each file is only downloaded by a browser when that script is actually typed (unicode-range)
  'mukta', 'hind', 'baloo-2', 'tiro-devanagari-hindi', 'yatra-one', 'kalam', 'rozha-one', 'noto-sans-devanagari', 'noto-serif-devanagari', // Nepali, Hindi, Marathi
  'hind-siliguri', 'noto-sans-bengali',            // Bengali
  'hind-vadodara', 'noto-sans-gujarati',           // Gujarati
  'baloo-paaji-2', 'noto-sans-gurmukhi',           // Punjabi
  'catamaran', 'noto-sans-tamil',                  // Tamil
  'noto-sans-telugu', 'noto-sans-kannada', 'noto-sans-malayalam', 'noto-sans-sinhala',
  'kanit', 'prompt', 'noto-sans-thai',             // Thai
  'cairo', 'tajawal', 'noto-naskh-arabic', 'noto-sans-arabic', // Arabic, Urdu, Persian
  'noto-sans-hebrew', 'noto-sans-myanmar', 'noto-sans-khmer', 'noto-serif-tibetan'];
const WEIGHTS = ['400', '500', '600', '700', '800', '900'];
const ITALIC = new Set(['fraunces']); // the brand serif's italic is used for emphasis
const ROOT = path.join(__dirname, '..', 'node_modules', '@fontsource');

let css = '';
const scripts = {}; // font family → writing systems it covers (from the package's subset files)
const NOT_SCRIPTS = new Set(['index', 'latin-ext', 'vietnamese', 'math', 'symbols']);
for (const pkg of PKGS) {
  const dir = path.join(ROOT, pkg);
  if (!fs.existsSync(dir)) continue;
  try {
    const first = fs.readFileSync(path.join(dir, 'index.css'), 'utf8');
    const fam = (/font-family:\s*'([^']+)'/.exec(first) || [])[1];
    if (fam) scripts[fam] = [...new Set(fs.readdirSync(dir).map(f => /^([a-z-]+)\.css$/.exec(f)).filter(Boolean).map(m => m[1])
      .filter(n => !NOT_SCRIPTS.has(n) && !n.endsWith('-italic')).map(n => n.replace(/-ext$/, '')))];
  } catch { /* package without index.css */ }
  for (const w of WEIGHTS) {
    for (const f of [path.join(dir, `${w}.css`), ...(ITALIC.has(pkg) ? [path.join(dir, `${w}-italic.css`)] : [])]) {
      if (!fs.existsSync(f)) continue;
      css += fs.readFileSync(f, 'utf8').replace(/url\(\.\/files\//g, `url(/fontsource/${pkg}/files/`) + '\n';
    }
  }
}

const scriptsJs = `window.PF_FONT_SCRIPTS=${JSON.stringify(scripts)};`;

function mount(app) {
  app.get('/js/font-scripts.js', (req, res) => {
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    res.send(scriptsJs);
  });
  app.get('/css/fonts.css', (req, res) => {
    res.set({ 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'public, max-age=86400' });
    res.send(css);
  });
  app.get('/fontsource/:pkg/files/:file', (req, res) => {
    const { pkg, file } = req.params;
    if (!PKGS.includes(pkg) || !/^[\w.-]+\.(woff2?|ttf)$/.test(file)) return res.status(404).end();
    res.sendFile(path.join(ROOT, pkg, 'files', file), { maxAge: '30d', immutable: true }, err => { if (err && !res.headersSent) res.status(404).end(); });
  });
}
module.exports = { mount, available: css.length > 0, scripts };
