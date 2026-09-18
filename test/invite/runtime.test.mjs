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
  // Pages the active one does not lead to stay lazy (home links to the timeline, not to mehendi).
  const untouched = await page.evaluate(() => document.querySelectorAll('#mehendi img[data-src]').length);
  assert.ok(untouched > 0, 'unlinked pages stay lazy');
  await page.close();
});

// A tap on the envelope must land on a home page that is already there. Canva
// has the next page's pictures before you tap; we only started fetching them
// on the tap, so a guest on a phone saw a blank cream screen and then a pop.
test('warms the pages a page links to once its own pictures are in', async () => {
  const { page } = await open(390);
  await page.waitForFunction(() => document.querySelectorAll('#home img[data-src]').length === 0, null, { timeout: 5000 });
  const state = await page.evaluate(() => ({
    homeLoaded: [...document.querySelectorAll('#home img')].filter((i) => i.currentSrc).length,
    homeMatte: document.querySelectorAll('#home canvas').length,
    homeShown: document.querySelector('#home').classList.contains('active'),
    mehendiPending: document.querySelectorAll('#mehendi img[data-src]').length,
    hash: location.hash,
  }));
  assert.ok(state.homeLoaded > 5, `home pictures fetched: ${state.homeLoaded}`);
  assert.equal(state.homeMatte, 0, 'warming fetches; it does not play anything');
  assert.equal(state.homeShown, false);
  assert.ok(state.mehendiPending > 0, 'only the linked pages are warmed');
  await page.close();
});

// An entrance that plays over a picture that has not arrived is a pop, not an
// entrance. Hold the reveal until the element's pictures are in.
test('holds an element\'s entrance until its pictures have arrived', async () => {
  // The delay has to be in place before anything loads — the envelope warms the home page's pictures.
  const page = await browser.newPage({ viewport: { width: 1366, height: 844 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.route(/\/assets\/[0-9a-f]{12}\.(webp|avif)$/, async (r) => { await new Promise((res) => setTimeout(res, 1500)); await r.continue(); });
  await page.goto(`${site.url}/invite/#home`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.querySelector('.page.active')?.id === 'home');
  await page.waitForTimeout(600);
  // Only the WebP/AVIF pictures are held up by the route; SVG ones arrive at once.
  const webpIn = () => [...document.querySelectorAll('#home .el.img.an.in')].filter((e) => /\.webp$/.test(e.querySelector('img')?.getAttribute('src') || '')).length;
  const early = await page.evaluate((fn) => ({ imgIn: eval(fn)(), txtIn: document.querySelectorAll('#home .el.txt.an.in').length }), webpIn.toString());
  assert.equal(early.imgIn, 0, 'picture elements wait for their picture');
  assert.ok(early.txtIn > 0, 'text needs no picture and enters at once');
  await page.waitForFunction((fn) => eval(fn)() > 0, webpIn.toString(), { timeout: 4000 });
  assert.deepEqual(errors, []);
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

// Canva mounts a page afresh each time you arrive, so its entrances play again
// when you come back; a reveal that sticks makes the second visit a still.
test('plays a page\'s entrances again when you come back to it', async () => {
  const { page, errors } = await open(1366, '#home');
  await page.waitForFunction(() => document.querySelectorAll('#home .el.an.in').length > 0);
  await page.waitForTimeout(3500); // let the first visit's entrances finish
  // Idle sways and pulses loop for ever; only one-shot entrances count here.
  const entrancesRunning = () => [...document.querySelectorAll('#home .el.an.in')].filter((e) => e.getAnimations({ subtree: true }).some((a) => a.playState === 'running' && Number.isFinite(a.effect.getTiming().iterations))).length;
  const settled = await page.evaluate((fn) => eval(fn)(), entrancesRunning.toString());
  assert.equal(settled, 0, 'first visit has settled');
  await page.evaluate(() => { location.hash = '#timeline'; });
  await page.waitForFunction(() => document.querySelector('.page.active')?.id === 'timeline');
  await page.waitForTimeout(300);
  const homeWhileAway = await page.evaluate(() => document.querySelectorAll('#home .el.in, #home .el[data-entering]').length);
  assert.equal(homeWhileAway, 0, 'leaving a page clears its reveals');
  await page.goBack();
  await page.waitForFunction(() => document.querySelector('.page.active')?.id === 'home');
  await page.waitForTimeout(400);
  const replaying = await page.evaluate((fn) => eval(fn)(), entrancesRunning.toString());
  assert.ok(replaying > 0, `entrances running again on return: ${replaying}`);
  assert.equal(await page.evaluate(() => window.scrollY), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

// The widget on the live page counts down to 2026-10-10T21:00 with no zone —
// nine in the evening wherever the guest is. Two digits per unit, each in its
// own tspan so they sit where the widget puts them.
test('a phone takes the small encoding of a still, a retina desktop the big one', async () => {
  for (const [width, dpr, wantSmall] of [[390, 3, true], [1366, 2, false]]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, deviceScaleFactor: dpr });
    await page.goto(`${site.url}/invite/#home`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => [...document.querySelectorAll('#home img[srcset]')].filter((i) => i.currentSrc).length > 10);
    const picks = await page.evaluate(() => [...document.querySelectorAll('#home img[srcset]')].filter((i) => i.currentSrc).map((i) => {
      // whichever encoding the browser chose (the AVIF source or the WebP img), which of its two widths did it take?
      const set = i.currentSrc.endsWith('.avif') ? i.parentElement.querySelector('source').srcset : i.srcset;
      const [small, big] = set.split(', ').map((c) => c.split(' ')[0]);
      return i.currentSrc.endsWith(small) ? 'small' : i.currentSrc.endsWith(big) ? 'big' : '?';
    }));
    const small = picks.filter((p) => p === 'small').length, big = picks.filter((p) => p === 'big').length;
    assert.ok(!picks.includes('?'), 'every pick is one of the two offered');
    if (wantSmall) assert.ok(small > big, `${width}@${dpr}x: ${small} small vs ${big} big`);
    else assert.ok(big > small, `${width}@${dpr}x: ${big} big vs ${small} small`);
    await page.close();
  }
});

test('lets go of an entrance once it has played, and keeps the beat, the spin and the write-on', async () => {
  const { page } = await open(1366, '#home');
  await page.waitForFunction(() => document.querySelectorAll('#home .el.an.in').length > 0);
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 600) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(150); }
  await page.waitForTimeout(6000);
  const state = await page.evaluate(() => {
    const plain = [...document.querySelectorAll('#home .el.an.in:not(.hb):not(.sp):not(.wr)')];
    const done = plain.filter((e) => e.classList.contains('done'));
    const stillAnimated = done.filter((e) => getComputedStyle(e).animationName !== 'none');
    const beating = [...document.querySelectorAll('#home .el.hb.in')].filter((e) => e.getAnimations().some((a) => a.playState === 'running')).length;
    const spinning = [...document.querySelectorAll('#home .el.sp.in')].filter((e) => e.getAnimations().some((a) => a.playState === 'running')).length;
    const sample = done[0] ? getComputedStyle(done[0]) : null;
    return { plain: plain.length, done: done.length, stillAnimated: stillAnimated.length, beating, spinning, sampleOpacity: sample?.opacity, sampleFilter: sample?.filter };
  });
  assert.ok(state.plain > 20 && state.done === state.plain, `${state.done}/${state.plain} entrances released`);
  assert.equal(state.stillAnimated, 0);
  assert.equal(state.sampleFilter, 'none');
  assert.ok(Number(state.sampleOpacity) > 0.5, `released element still visible: ${state.sampleOpacity}`);
  assert.ok(state.beating >= 1 && state.spinning === 1, `beating ${state.beating}, spinning ${state.spinning}`);
  await page.close();
});

test('a browser that decodes AVIF is served it, and activation swaps the source too', async () => {
  const { page } = await open(390, '#home');
  await page.waitForFunction(() => [...document.querySelectorAll('#home img')].filter((i) => i.currentSrc).length > 10);
  const st = await page.evaluate(() => ({
    avif: [...document.querySelectorAll('#home img')].filter((i) => i.currentSrc.endsWith('.avif')).length,
    webp: [...document.querySelectorAll('#home img')].filter((i) => i.currentSrc.endsWith('.webp')).length,
    pendingSources: document.querySelectorAll('#home source[data-srcset]').length,
    liveSources: document.querySelectorAll('#home source[srcset]').length,
  }));
  assert.equal(st.pendingSources, 0);
  assert.ok(st.liveSources > 10);
  assert.ok(st.avif > 10 && st.webp === 0, `avif ${st.avif}, webp ${st.webp}`);
  await page.close();
});

test('the countdown ticks toward nine in the evening on 10 October 2026, local time', async () => {
  const { page } = await open(390, '#home');
  await page.waitForTimeout(1100);
  const read = () => page.evaluate(() => ['d', 'h', 'm', 's'].map((u) => [...document.querySelector(`[data-cd="${u}"]`).querySelectorAll('tspan')].map((t) => t.textContent).join('')));
  const a = await read();
  await page.waitForTimeout(1100);
  const b = await read();
  assert.notDeepEqual(a, b, 'seconds should change');
  assert.ok(a.every((v) => /^\d{2}$/.test(v)), `two digits per unit: ${a}`);
  const expected = await page.evaluate(() => Math.floor((new Date(2026, 9, 10, 21, 0, 0) - Date.now()) / 86400000));
  assert.ok(Math.abs(Number(a[0]) - expected) <= 1, `days ${a[0]} vs ${expected}`);
  await page.close();
});

test('survives a malformed hash by falling back to the envelope', async () => {
  const { page, errors } = await open(390, '#home%');
  assert.equal(await page.$eval('.page.active', (n) => n.id), 'envelope');
  assert.equal(await page.evaluate(() => typeof window.__invite), 'object');
  assert.deepEqual(errors, []);
  await page.close();
});
