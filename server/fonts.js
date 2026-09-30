'use strict';
/* Self-hosted fonts (from @fontsource packages) — no calls to Google, works offline,
   GDPR-friendly, and the canvas editor can rely on them being available. */
const fs = require('node:fs');
const path = require('node:path');

const PKGS = ['space-grotesk', 'inter', 'poppins', 'montserrat', 'nunito', 'raleway', 'oswald', 'bebas-neue', 'anton',
  'archivo-black', 'playfair-display', 'dm-serif-display', 'merriweather', 'lobster', 'pacifico', 'dancing-script', 'caveat'];
const WEIGHTS = ['400', '500', '600', '700', '800', '900'];
const ROOT = path.join(__dirname, '..', 'node_modules', '@fontsource');

let css = '';
for (const pkg of PKGS) {
  const dir = path.join(ROOT, pkg);
  if (!fs.existsSync(dir)) continue;
  for (const w of WEIGHTS) {
    const f = path.join(dir, `${w}.css`);
    if (!fs.existsSync(f)) continue;
    css += fs.readFileSync(f, 'utf8').replace(/url\(\.\/files\//g, `url(/fontsource/${pkg}/files/`) + '\n';
  }
}

function mount(app) {
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
module.exports = { mount, available: css.length > 0 };
