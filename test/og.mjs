// Re-shoots og.png, the link preview, off the real page.
//
//   npm i -D playwright && npx playwright install chromium
//   node test/og.mjs
//
// A photograph of the card rather than a picture drawn to look like one, so
// the preview cannot drift from the sheet the way it did when the lace came
// off and this file kept the frame for another eight commits. Run it whenever
// the card changes.
//
// The card is left unscratched on purpose. The page is one surprise and the
// description under this image promises it — a preview holding the date up
// has already given away the only thing anyone came to find out.
//
// Same http server as the other harnesses: foil.jpg taints the canvas under
// file:// and the plate never paints.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const OUT = path.join(ROOT, 'og.png');
const PORT = 8736;

// what the meta tags in index.html already promise
const W = 1200;
const H = 630;

const TYPES = {
  '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4', '.ics': 'text/calendar',
};

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
  viewport: { width: W, height: H },
  // Rendered at 2x and handed back at 1x: the sheet is a photograph of paper
  // and the type is hairline, and both come apart when they are rasterised
  // once at preview size. `scale: 'css'` below is what brings it back down.
  deviceScaleFactor: 2,
  // Not the machine's setting. Under `reduce` the page skips the envelope
  // entirely and hands the card over, which is a different code path to the
  // one every reader will see.
  reducedMotion: 'no-preference',
});

const problems = [];
page.on('pageerror', (e) => problems.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') problems.push('console: ' + m.text()); });

await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });

// The chip is the page's own control, not part of the invitation.
//
// And the card is given more to reserve than a window owes it, which is the
// one thing this shot needs that the page does not: on screen the sheet is
// meant to fill what it is given, and in a preview — a small rectangle inside
// someone else's message list — a card running out of the frame reads as a
// crop rather than a card. 130px leaves it at about 330x500 in the 1200x630,
// which is the margin the preview has always had. It is the card's own
// responsive path, not a transform: the foil is a canvas, and scaling a
// rasterised plate would hand back a soft heart.
//
// Set before the page has drawn anything, and with the width transition off,
// so the sheet is this size from the first frame. Applied later it animates
// instead — the card carries 1.6s of width on a 1s delay — and the plate
// would be rasterised against a size it is on its way out of.
await page.addStyleTag({ content: `
  .sound{ display:none !important; }
  .card{ --reserve:130px !important; transition:none !important; }
  /* The band under the card is 0 tall here, but the body still lays its gap
     between the two and the sheet ends up sitting 8px above the middle of a
     frame that has nothing else in it. Nothing to hold space for in a still. */
  .below{ display:none !important; }
` });

await page.waitForTimeout(1400);
await page.click('#seal');
// the open runs 3.4s, and the hint is put up at 3.1s
await page.waitForTimeout(4200);

const state = await page.evaluate(() => ({
  card: (() => {
    const r = document.querySelector('.card').getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(innerHeight - r.bottom) };
  })(),
  envelope: getComputedStyle(document.querySelector('.envelope')).display,
  hint: getComputedStyle(document.getElementById('hint')).opacity,
  scratched: document.getElementById('card').classList.contains('revealed'),
  transform: getComputedStyle(document.querySelector('.card')).transform,
}));
if (state.envelope !== 'none') problems.push('the envelope is still in the shot (' + state.envelope + ')');
if (Number(state.hint) < 1) problems.push('the hint had not come up (' + state.hint + ')');
if (state.scratched) problems.push('the card is scratched — the preview gives the date away');
if (state.transform !== 'none') problems.push('the card is still moving: ' + state.transform);

// `scale: 'css'` is the whole point of the 2x page above: Chromium captures at
// device resolution and hands back the CSS size, so this is a downsample of a
// 2400x1260 frame and not a 1200x630 render.
await page.screenshot({ path: OUT, scale: 'css' });

const bytes = fs.statSync(OUT).size;
const png = fs.readFileSync(OUT);
const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
if (w !== W || h !== H) problems.push(`og.png came out ${w}x${h}, and the meta tags say ${W}x${H}`);

console.log(problems.length ? problems.join('\n') : 'clean: envelope gone, card unscratched, hint up');
console.log(`og.png  ${w}x${h}  ${(bytes / 1024).toFixed(0)}KB`);
console.log(`card    ${state.card.w}x${state.card.h}  ${state.card.top}px of sheet above, ${state.card.bottom}px below`);

await browser.close();
server.close();
process.exit(problems.length ? 1 : 0);
