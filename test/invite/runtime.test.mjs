import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

let browser, site;
test.before(async () => { browser = await chromium.launch(); site = await serve(); });
test.after(async () => { await browser.close(); await site.close(); });

const open = async (width, hash = '') => {
  const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(`${site.url}/invite/${hash}`, { waitUntil: 'networkidle' });
  return { page, errors };
};

test('shows the envelope first and switches pages on hash change', async () => {
  const { page, errors } = await open(390);
  assert.equal(await page.$eval('.page.active', (n) => n.id), 'envelope');
  await page.evaluate(() => { location.hash = '#home'; });
  await page.waitForFunction(() => document.querySelector('.page.active')?.id === 'home');
  assert.equal(await page.evaluate(() => document.querySelectorAll('.page.active').length), 1);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test('fits the content box to a phone with no horizontal scroll', async () => {
  const { page } = await open(390);
  const { k, secH, docW, vw } = await page.evaluate(() => {
    const sec = document.querySelector('#envelope .sec');
    const m = getComputedStyle(sec.querySelector('.stage')).transform.match(/matrix\(([^,]+),/);
    return { k: parseFloat(m[1]), secH: sec.getBoundingClientRect().height, docW: document.documentElement.scrollWidth, vw: innerWidth };
  });
  assert.ok(k > 0.6 && k < 0.9, `k=${k}`);
  assert.ok(Math.abs(secH - 990 * k) < 2, `height ${secH} vs ${990 * k}`);
  assert.equal(docW, vw);
  await page.close();
});

const stageAt = async (width, slug = 'envelope') => {
  const { page } = await open(width);
  const r = await page.evaluate((slug) => {
    const sec = document.querySelector(`#${slug} .sec`);
    const st = sec.querySelector('.stage');
    const m = getComputedStyle(st).transform.match(/matrix\(([^,]+),/);
    return { k: parseFloat(m[1]), left: st.getBoundingClientRect().left, cl: +sec.dataset.cl, cw: +sec.dataset.cw };
  }, slug);
  await page.close();
  return r;
};

test('renders 1:1 on a desktop with the whole canvas centred, as Canva does', async () => {
  // The envelope section's content column sits off-centre in its 1366 canvas
  // (cl 403, cw 450), so centring the column would shift everything ~55 px.
  for (const width of [1366, 1500]) {
    const { k, left } = await stageAt(width);
    assert.equal(k, 1);
    assert.ok(Math.abs(left - (width - 1366) / 2) < 1, `${width}: left=${left}`);
  }
});

test('centres the content column instead when the canvas is wider than the viewport', async () => {
  // A tablet: the canvas would overflow, the column fits — centre the column so nothing is cropped.
  const { k, left, cl, cw } = await stageAt(1100);
  assert.equal(k, 1);
  assert.ok(Math.abs(left + cl + cw / 2 - 550) < 2, `left=${left} cl=${cl} cw=${cw}`);
});

test('reveals animated elements once they are in view and loads lazy images on activation', async () => {
  const { page } = await open(390, '#home');
  await page.waitForTimeout(500);
  const seen = await page.evaluate(() => [...document.querySelectorAll('#home .el.an')].filter((e) => e.getBoundingClientRect().top < innerHeight).map((e) => e.classList.contains('in')));
  assert.ok(seen.length > 0 && seen.every(Boolean), `${seen.filter(Boolean).length}/${seen.length} in view got .in`);
  const lazy = await page.evaluate(() => ({ pending: document.querySelectorAll('#home img[data-src]').length, loaded: [...document.querySelectorAll('#home img')].filter((i) => i.currentSrc).length }));
  assert.equal(lazy.pending, 0);
  assert.ok(lazy.loaded > 5);
  const untouched = await page.evaluate(() => document.querySelectorAll('#timeline img[data-src]').length);
  assert.ok(untouched > 0, 'inactive pages stay lazy');
  await page.close();
});

test('plays an effect-30 matte into a canvas as the element comes into view, then hands back to the picture', async () => {
  const { page, errors } = await open(1366, '#home');
  const sel = '[data-id="LB5G72RFmZTRXFxD"]';
  await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), sel);
  // The canvas takes its size on the first frame it draws, once both the matte and the picture are ready.
  await page.waitForFunction((sel) => document.querySelector(sel).classList.contains('mt-run') && document.querySelector(`${sel} > canvas`)?.width > 300, sel, { timeout: 4000 });
  const mid = await page.evaluate((sel) => {
    const el = document.querySelector(sel), c = el.querySelector('canvas'), img = el.querySelector('img');
    return { imgHidden: getComputedStyle(img).visibility, cw: c.width, ch: c.height, cssW: c.getBoundingClientRect().width > 0, videos: document.querySelectorAll(`${sel} video`).length };
  }, sel);
  assert.equal(mid.imgHidden, 'hidden', 'the picture stays out of sight while the matte draws it in');
  assert.ok(mid.cw > 400 && mid.ch > 700 && mid.cssW, `canvas ${mid.cw}x${mid.ch}`);
  assert.equal(mid.videos, 0, 'the matte video never enters the DOM');
  await page.waitForFunction((sel) => !document.querySelector(sel).classList.contains('mt-run'), sel, { timeout: 6000 });
  const done = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    return { canvases: el.querySelectorAll('canvas').length, imgVisible: getComputedStyle(el.querySelector('img')).visibility, opacity: getComputedStyle(el).opacity };
  }, sel);
  assert.deepEqual(done, { canvases: 0, imgVisible: 'visible', opacity: '1' });
  assert.deepEqual(errors, []);
  await page.close();
});

test('shows an effect-30 picture outright when its matte cannot play', async () => {
  const { page, errors } = await open(1366);
  await page.route('**/*.webm', (r) => r.abort());
  await page.route('**/*.mp4', (r) => r.abort());
  await page.evaluate(() => { location.hash = '#home'; });
  const sel = '[data-id="LB5G72RFmZTRXFxD"]';
  await page.evaluate((sel) => document.querySelector(sel).scrollIntoView({ block: 'center' }), sel);
  await page.waitForFunction((sel) => { const el = document.querySelector(sel); return el.classList.contains('in') && !el.classList.contains('mt-run') && !el.querySelector('canvas') && getComputedStyle(el.querySelector('img')).visibility === 'visible'; }, sel, { timeout: 6000 });
  // The aborted download is the browser's own resource error; nothing in the page may throw.
  assert.deepEqual(errors.filter((e) => !/ERR_FAILED/.test(e)), []);
  await page.close();
});

test('the countdown ticks toward 10 October 2026 IST', async () => {
  const { page } = await open(390, '#home');
  await page.waitForTimeout(1100);
  const read = () => page.evaluate(() => ['d', 'h', 'm', 's'].map((u) => document.querySelector(`[data-cd="${u}"]`).textContent));
  const a = await read();
  await page.waitForTimeout(1100);
  const b = await read();
  assert.notDeepEqual(a, b, 'seconds should change');
  const expectedDays = Math.floor((Date.parse('2026-10-10T00:00:00+05:30') - Date.now()) / 86400000);
  assert.ok(Math.abs(Number(a[0]) - expectedDays) <= 1, `days ${a[0]} vs ${expectedDays}`);
  await page.close();
});

test('survives a malformed hash by falling back to the envelope', async () => {
  const { page, errors } = await open(390, '#home%');
  assert.equal(await page.$eval('.page.active', (n) => n.id), 'envelope');
  assert.equal(await page.evaluate(() => typeof window.__invite), 'object');
  assert.deepEqual(errors, []);
  await page.close();
});
