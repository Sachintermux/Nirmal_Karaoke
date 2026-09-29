import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.join(__dirname, '..');

console.log('=== TEST 1: Sitemap.xml & Robots.txt Verification ===');
const sitemapPath = path.join(root, 'sitemap.xml');
if (!fs.existsSync(sitemapPath)) throw new Error('sitemap.xml does not exist');
const sitemapContent = fs.readFileSync(sitemapPath, 'utf8');
if (!sitemapContent.includes('<?xml version="1.0" encoding="UTF-8"?>')) throw new Error('Invalid XML header in sitemap.xml');
if (!sitemapContent.includes('<loc>https://nirmal-karaoke.onrender.com/</loc>')) throw new Error('Root URL missing in sitemap.xml');
if (!sitemapContent.includes('<loc>https://nirmal-karaoke.onrender.com/audience.html</loc>')) throw new Error('Audience URL missing in sitemap.xml');
if (!sitemapContent.includes('<loc>https://nirmal-karaoke.onrender.com/users.html</loc>')) throw new Error('Users URL missing in sitemap.xml');
console.log('PASS: sitemap.xml verified with all core URLs ✅');

const robotsPath = path.join(root, 'robots.txt');
if (!fs.existsSync(robotsPath)) throw new Error('robots.txt does not exist');
const robotsContent = fs.readFileSync(robotsPath, 'utf8');
if (!robotsContent.includes('User-agent: *')) throw new Error('User-agent missing in robots.txt');
if (!robotsContent.includes('Sitemap: https://nirmal-karaoke.onrender.com/sitemap.xml')) throw new Error('Sitemap link missing in robots.txt');
console.log('PASS: robots.txt verified ✅');

console.log('\n=== TEST 2: Visualizer Resilience Verification ===');
// Emulate DOM environment to test VisualizerRenderer behavior when hidden vs visible
global.window = {
  innerWidth: 390,
  devicePixelRatio: 2,
  addEventListener: () => {},
  removeEventListener: () => {}
};
global.document = {
  hidden: false,
  getElementById: (id) => {
    if (id === 'visualizer') {
      return {
        width: 300,
        height: 150,
        parentElement: {
          clientWidth: 0, // initially hidden!
          clientHeight: 0
        },
        getContext: () => ({
          clearRect: () => {},
          beginPath: () => {},
          createLinearGradient: () => ({ addColorStop: () => {} }),
          createRadialGradient: () => ({ addColorStop: () => {} })
        }),
        offsetParent: null
      };
    }
    if (id === 'hudAccel' || id === 'hudFps') {
      return { textContent: '', style: {} };
    }
    return null;
  }
};
global.performance = { now: () => 1000 };
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = () => {};

const { VisualizerRenderer } = await import('../js/visualizer.js');
const renderer = new VisualizerRenderer({});
renderer.init();

// When parent is hidden (0 dimensions), resize() MUST NOT crush width/height to 10!
const initialWidth = renderer.cvs.width;
const initialHeight = renderer.cvs.height;
renderer.resize();
if (renderer.cvs.width === 10 || renderer.cvs.height === 10) {
  throw new Error(`FAIL: Visualizer crushed to 10x10 when hidden! Width: ${renderer.cvs.width}, Height: ${renderer.cvs.height}`);
}
if (renderer.cvs.width !== initialWidth || renderer.cvs.height !== initialHeight) {
  throw new Error('FAIL: Canvas dimensions modified when parent had 0 width/height!');
}
console.log('PASS: Canvas dimensions preserved safely when hidden (display:none) ✅');

// When parent becomes visible with mobile screen width (e.g. 390px, height: 132px)
renderer.cvs.parentElement.clientWidth = 390;
renderer.cvs.parentElement.clientHeight = 132;
renderer.cvs.offsetParent = {}; // visible
renderer.resize();

const expectedDpr = 1.25; // capped on mobile
const expectedW = Math.round(390 * expectedDpr);
const expectedH = Math.round(132 * expectedDpr);

if (renderer.cvs.width !== expectedW || renderer.cvs.height !== expectedH) {
  throw new Error(`FAIL: Expected width ${expectedW} and height ${expectedH}, got ${renderer.cvs.width}x${renderer.cvs.height}`);
}
console.log(`PASS: Visualizer resized accurately to ${renderer.cvs.width}x${renderer.cvs.height} upon returning to stage ✅`);

renderer.refresh();
console.log('PASS: Visualizer refresh() executed cleanly without errors ✅');

renderer.destroy();
console.log('PASS: Visualizer destroy() executed cleanly ✅');

console.log('\n=== TEST 3: CSS & HTML Link Checks ===');
const cssPath = path.join(root, 'css', 'style.css');
const cssContent = fs.readFileSync(cssPath, 'utf8');
if (cssContent.includes('.mobile-screen {\n   content-visibility: auto;')) {
  throw new Error('FAIL: mobile-screen still has problematic content-visibility: auto');
}
if (!cssContent.includes('.stage-card, .stage-visual, .stage-visual canvas')) {
  throw new Error('FAIL: stage-card visibility override missing in style.css');
}
console.log('PASS: CSS content-visibility properly configured for canvas stability ✅');

const indexPath = path.join(root, 'index.html');
const indexContent = fs.readFileSync(indexPath, 'utf8');
if (!indexContent.includes('<link rel="sitemap" type="application/xml" title="Sitemap" href="/sitemap.xml">')) {
  throw new Error('FAIL: sitemap link missing in index.html');
}
console.log('PASS: index.html references sitemap.xml ✅');

console.log('\nALL VERIFICATION TESTS COMPLETED SUCCESSFULLY! 🎉');
