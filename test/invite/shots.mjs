// Phone-sized frames of every invite page for eyeballing.
//   node test/invite/shots.mjs          → test/shots/invite/<slug>-<n>.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shots', 'invite');
const SLUGS = ['envelope', 'home', 'timeline', 'mehendi', 'nikah', 'reception', 'dress-code'];
fs.mkdirSync(OUT, { recursive: true });
const site = await serve();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
for (const slug of SLUGS) {
  await page.goto(`${site.url}/invite/#${slug}`, { waitUntil: 'networkidle' });
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  let n = 0;
  for (let y = 0; y < h; y += 800) {
    await page.evaluate((y) => window.scrollTo(0, y), y);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(OUT, `${slug}-${n++}.png`) });
  }
  console.log(slug, n, 'frames');
}
await browser.close();
await site.close();
