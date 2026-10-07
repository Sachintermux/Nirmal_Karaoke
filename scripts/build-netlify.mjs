/**
 * Netlify build: assemble a lean, cache-friendly `dist/` from the repo.
 *
 *  - publishes ONLY the public frontend (not server.js, package.json, notes, node_modules, scratch)
 *  - stamps every local .js/.css reference with one per-deploy version so assets can be
 *    cached "immutable" yet always refresh on the next deploy (also collapses the old
 *    mixed ?v=24 / ?v=31 imports that made the browser load some modules twice)
 *  - hoists the Google Fonts @import out of css/style.css into <link> tags (an @import
 *    chains a second blocking request before first paint, which hurts mobile most)
 *
 * Local dev (`npm start`) serves the untouched source and does not use this script.
 */
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';

const ROOT = process.cwd();
const OUT = join(ROOT, 'dist');
const VERSION = (process.env.COMMIT_REF || process.env.DEPLOY_ID || Date.now().toString(36)).slice(0, 10);

const FILES = [
  'index.html', 'audience.html', 'users.html', 'googleb691adf1eb31de8a.html',
  'favicon.ico', 'icon-192.png', 'icon-512.png', 'robots.txt', 'sitemap.xml'
];
const DIRS = ['css', 'js'];

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const f of FILES) if (existsSync(join(ROOT, f))) cpSync(join(ROOT, f), join(OUT, f));
for (const d of DIRS) cpSync(join(ROOT, d), join(OUT, d), { recursive: true });

function walk(dir) {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// "./x.js", "../x.js", "/js/x.js" inside quotes, with or without an existing ?v=...
const LOCAL_REF = /(["'`])((?:\.{1,2}\/|\/)[^"'`\s?<>]*?\.(?:js|mjs|css))(?:\?v=[\w.-]*)?\1/g;
const stamp = (text) => text.replace(LOCAL_REF, (_, q, path) => `${q}${path}?v=${VERSION}${q}`);

const FONT_IMPORT = /@import\s+url\((['"]?)(https:\/\/fonts\.googleapis\.com[^'")]+)\1\);?/;
let fontsUrl = null;
let rewritten = 0;

for (const file of walk(OUT)) {
  const ext = extname(file);
  if (!['.html', '.js', '.css'].includes(ext)) continue;
  const before = readFileSync(file, 'utf8');
  let text = before;
  if (ext === '.css') {
    const m = text.match(FONT_IMPORT);
    if (m) { fontsUrl = m[2]; text = text.replace(FONT_IMPORT, ''); }
  } else {
    text = stamp(text);
  }
  if (text !== before) { writeFileSync(file, text); rewritten++; }
}

// Hoist the fonts into the page heads (before the first stylesheet link).
const fontTags = fontsUrl
  ? `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="${fontsUrl}">\n`
  : '';
if (fontTags) {
  for (const name of FILES.filter((f) => f.endsWith('.html'))) {
    const p = join(OUT, name);
    if (!existsSync(p)) continue;
    const html = readFileSync(p, 'utf8');
    if (!/<link[^>]+css\/style\.css/.test(html) || html.includes('fonts.googleapis.com')) continue;
    writeFileSync(p, html.replace(/(<link[^>]+css\/style\.css)/, `${fontTags}$1`));
  }
}

console.log(`[build-netlify] dist/ ready  version=${VERSION}  rewritten=${rewritten} files  fonts=${fontsUrl ? 'hoisted' : 'none'}`);
