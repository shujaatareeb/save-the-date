// One-off: full-page references of the Canva original at 1366 wide.
//   node test/invite/refs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'ref');
const SITE = 'https://misbahareeb.my.canva.site/';
const PAGES = { envelope: 0, home: 3, timeline: 4, mehendi: 5, nikah: 6, reception: 8, 'dress-code': 9 };

// The Canva site's real scroll container is not `window` — window.scrollTo is a
// no-op there. Find whatever element actually scrolls and drive that instead.
const scrollBy = (y) => page.evaluate((y) => {
  const all = [document.scrollingElement, ...document.querySelectorAll('body *')];
  const sc = all.find((e) => e && e.scrollHeight > e.clientHeight + 50 && e.clientHeight >= innerHeight * 0.6) || document.scrollingElement;
  sc.scrollTop = y; return sc.scrollHeight;
}, y);

// The page/body never grows to the content's real height — the site paginates by
// keeping <body> pinned to the viewport height and scrolling an inner div instead.
// `page.screenshot({ fullPage: true })` measures the document, so left as-is it only
// ever captures one viewport-tall slice. Unclip the scroll container's ancestor chain
// (overflow:visible, height:auto) so the document lays out to the full content height.
const unclip = () => page.evaluate(() => {
  const all = [document.scrollingElement, ...document.querySelectorAll('body *')];
  const sc = all.find((e) => e && e.scrollHeight > e.clientHeight + 50 && e.clientHeight >= innerHeight * 0.6) || document.scrollingElement;
  let el = sc;
  while (el) {
    el.style.setProperty('overflow', 'visible', 'important');
    el.style.setProperty('height', 'auto', 'important');
    el.style.setProperty('max-height', 'none', 'important');
    if (el === document.body) break;
    el = el.parentElement;
  }
  return document.documentElement.scrollHeight;
});

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
for (const [slug, n] of Object.entries(PAGES)) {
  await page.goto(`${SITE}#page-${n}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // Scroll through so every section's entrance animation has played, then back to top.
  let h = await scrollBy(0);
  for (let y = 0; y < h; y += 600) { h = await scrollBy(y); await page.waitForTimeout(700); }
  await page.waitForTimeout(3000);
  await scrollBy(0);
  await page.evaluate(() => document.querySelectorAll('footer, [class*="footer"], main ~ *').forEach((f) => f.remove()));
  await unclip();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `${slug}.png`), fullPage: true });
  console.log(slug, 'captured');
}
await browser.close();
