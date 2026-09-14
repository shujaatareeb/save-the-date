import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const SLUGS = ['envelope', 'home', 'timeline', 'mehendi', 'nikah', 'reception', 'dress-code'];
const run = promisify(execFile);

async function thumb(file, w, h) {
  const { stdout } = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
  return stdout;
}
async function meanDiff(a, b) {
  // Both pages are forced to the same small size, so differing full-page heights only smear, not misalign.
  const w = 64, h = 512;
  const [x, y] = await Promise.all([thumb(a, w, h), thumb(b, w, h)]);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}

let browser, site;
test.before(async () => { browser = await chromium.launch(); site = await serve(); fs.mkdirSync(OUT, { recursive: true }); });
test.after(async () => { await browser.close(); await site.close(); });

for (const slug of SLUGS) {
  test(`${slug} resembles the Canva original at 1366 wide`, async () => {
    const ref = path.join(HERE, 'ref', `${slug}.png`);
    assert.ok(fs.existsSync(ref), `run node test/invite/refs.mjs first`);
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(`${site.url}/invite/#${slug}`, { waitUntil: 'networkidle' });
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < h; y += 600) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(400); }
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, 0));
    const shot = path.join(OUT, `${slug}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const d = await meanDiff(ref, shot);
    assert.ok(d < 13, `${slug}: mean channel difference ${d.toFixed(1)} (see test/invite/out/${slug}.png vs test/invite/ref/${slug}.png)`);
    await page.close();
  });
}
