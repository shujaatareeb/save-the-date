// Screenshots of the page at each stage, for looking at what actually renders
// rather than reasoning about what ought to.
//
//   npm i -D playwright && npx playwright install chromium
//   node test/screenshots.mjs            # frames into test/shots/
//   node test/screenshots.mjs --tint     # each envelope layer in a flat colour
//
// It serves the directory over http rather than opening the file directly.
// Drawing foil.jpg onto the canvas taints it under file://, getImageData throws,
// and the scratch stops working — an artefact of the harness, not of the page,
// but it makes the half of the page worth testing untestable.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(HERE, 'shots');
const TINT = process.argv.includes('--tint');
const PORT = 8734;

const TYPES = {
  '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4', '.ics': 'text/calendar',
};

fs.mkdirSync(OUT, { recursive: true });

const server = http.createServer((req, res) => {
  const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
});
await new Promise((r) => server.listen(PORT, r));

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  isMobile: true,
  hasTouch: true,
});

const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(1400);

if (TINT) {
  await page.addStyleTag({ content: `
    .env-back  { background-image:none !important; background-color:#3aa0ff !important; filter:none !important; }
    .env-front { background-image:none !important; background-color:#ff4d4d !important; filter:none !important; }
    .env-flap  { background-image:none !important; background-color:#2ecc40 !important; filter:none !important; }
    .card      { outline:4px solid #ff00ff !important; }
    .stock::before{ display:none !important; }
  ` });
}

const shot = (name) => page.screenshot({ path: path.join(OUT, name + '.png') });
await shot('00-sealed');

await page.click('#seal');
const t0 = Date.now();
for (const t of [500, 950, 1300, 1700, 2200, 2900, 3400]) {
  const wait = t - (Date.now() - t0);
  if (wait > 0) await page.waitForTimeout(wait);
  await shot('01-open-' + String(t).padStart(4, '0'));
}

// the envelope has to be out of the document, not merely out of sight
const after = await page.evaluate(() => ({
  envelope: getComputedStyle(document.querySelector('.envelope')).display,
  fore: getComputedStyle(document.querySelector('.env-fore')).display,
  flap: getComputedStyle(document.querySelector('.env-flap-layer')).display,
  card: getComputedStyle(document.querySelector('.card')).transform,
}));
for (const [k, v] of Object.entries(after)) {
  if (k !== 'card' && v !== 'none') problems.push(`${k} is still displayed after the open (${v})`);
}
if (after.card !== 'none') problems.push('card kept a transform after landing: ' + after.card);

// scratch it, in the same run, because a reveal that never fires is the one
// failure a screenshot of the card cannot show
const heart = await page.locator('#foil').boundingBox();
for (let row = 0; row < 7; row++) {
  await page.mouse.move(heart.x + 10, heart.y + 14 + row * heart.height / 8);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) {
    await page.mouse.move(heart.x + 10 + (i / 30) * (heart.width - 20), heart.y + 14 + row * heart.height / 8);
  }
  await page.mouse.up();
}
await page.waitForTimeout(2600);
await shot('02-revealed');

const revealed = await page.evaluate(() => document.getElementById('card').classList.contains('revealed'));
if (!revealed) problems.push('scratching the heart did not reveal the date');

console.log(problems.length ? problems.join('\n') : 'clean: no page errors, envelope gone, reveal fired');
console.log('frames in ' + OUT);

await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
