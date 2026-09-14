import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { render, renderElement, keyframeCss, escapeHtml } from '../../invite/build/render.mjs';
import { assetKey } from '../../invite/build/assets.mjs';
import { serve } from './serve.mjs';

const read = (f) => JSON.parse(fs.readFileSync(new URL(`../../invite/build/${f}`, import.meta.url)));
const model = read('model.json'), assets = read('assets.json'), anims = read('animations.json');

test('escapes text for HTML', () => {
  assert.equal(escapeHtml(`<a href="x">Tom & Jerry's</a>`), '&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;');
});

test('renders a text element line by line with the run style', () => {
  const el = model.pages[0].sections[0].elements[12];
  const html = renderElement(el, { assets, anims: {}, eager: true, ids: new Set() });
  assert.match(html, /class="el txt"/);
  assert.match(html, /<span class="ln">.*We are getting.*<\/span><span class="ln">.*married !.*<\/span>/s);
  assert.match(html, /font-family:'f-YAFcf99lyzk-0'/);
  assert.match(html, /text-transform:uppercase/);
  assert.match(html, /font-weight:900/);
});

test('renders images inside a crop frame, eager on the envelope and lazy elsewhere', () => {
  const el = model.pages[0].sections[0].elements[0];
  const eager = renderElement(el, { assets, anims: {}, eager: true, ids: new Set() });
  assert.match(eager, /<img src="assets\/[a-f0-9]+\.webp"/);
  assert.match(eager, /assets\/[a-f0-9]+\.webp/);
  assert.match(eager, /top:-929\.9\d?px/);
  const lazy = renderElement(el, { assets, anims: {}, eager: false, ids: new Set() });
  assert.match(lazy, /<img data-src="assets\//);
  assert.doesNotMatch(lazy, /<img src=/);

  // LBq7bt3xrnV5lSC1: the CLICK TO OPEN ribbon, a recoloured spritesheet.
  const ribbon = model.pages[0].sections[0].elements[7];
  assert.equal(ribbon.id, 'LBq7bt3xrnV5lSC1');
  const ribbonHtml = renderElement(ribbon, { assets, anims: {}, eager: true, ids: new Set() });
  const key = assetKey(ribbon.media, { '#000000': '#715449' });
  const src = assets.media[key].src;
  assert.match(ribbonHtml, new RegExp(`<img src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
});

test('renders a linked image as an anchor', () => {
  const el = model.pages[0].sections[0].elements[4];
  const html = renderElement(el, { assets, anims: {}, eager: true, ids: new Set() });
  assert.match(html, /^<a href="#home" class="el img"/);
});

test('turns recorded frames into keyframes that keep rotation and static opacity', () => {
  const css = keyframeCss('k1', [{ t: 0, opacity: 0, dx: 0, dy: 80, scale: 1, blur: 0, clip: null }, { t: 1, opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0, clip: null }]);
  assert.match(css, /@keyframes k1\{0%\{opacity:calc\(var\(--op,1\)\*0\);transform:translate\(0px,80px\) rotate\(var\(--rot,0deg\)\) scale\(1\)/);
  assert.match(css, /100%\{opacity:calc\(var\(--op,1\)\*1\);transform:translate\(0px,0px\) rotate\(var\(--rot,0deg\)\) scale\(1\)/);
});

test('the full render has seven pages, fonts and no unresolved media', () => {
  const { html, css } = render(model, assets, anims);
  assert.equal((html.match(/<section class="page/g) || []).length, 7);
  assert.match(html, /id="envelope"[^>]*class="[^"]*active|class="page active" id="envelope"/);
  assert.match(css, /@font-face\{font-family:'f-YAFcf99lyzk-0'/);
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /data-cd="s"/);
});

test('animation rulings: hygiene, snap, loop class, invisible skip, borrowing', () => {
  const home = model.pages.find((p) => p.slug === 'home');
  const homeIds = new Set(); (function walk(els) { for (const e of els) { homeIds.add(e.id); if (e.children) walk(e.children); } })(home.sections.flatMap((s) => s.elements));
  const loopId = Object.entries(anims).find(([id, a]) => a.loop && homeIds.has(id))[0];
  // Pick a recorded non-loop entry whose raw last frame is NOT already at rest (no homeIds
  // filter here — any page): otherwise the snap-to-rest assertion below would pass vacuously
  // against an entry that was already resting before the snap ever touched it.
  const restId = 'LBmGP6J3tmzZBvKq';
  assert.notEqual(anims[restId].frames.at(-1).opacity, 1, 'fixture assumption: raw last frame not already at rest');
  const { html, css } = render(model, assets, anims);
  // loop class present on a looping element
  assert.match(html, new RegExp(`data-id="${loopId}"[^>]*class="[^"]*\\ban\\b[^"]*\\bloop\\b|class="[^"]*\\bloop\\b[^"]*"[^>]*data-id="${loopId}"`));
  assert.match(css, /\.el\.an\.loop\.in\{animation-iteration-count:infinite;animation-direction:alternate\}/);
  // non-loop keyframes end at rest
  const restClass = html.match(new RegExp(`data-id="${restId}"[^>]*class="el [^"]*\\b(k\\d+)\\b`))?.[1] || html.match(new RegExp(`class="el [^"]*\\b(k\\d+)\\b[^"]*"[^>]*data-id="${restId}"`))?.[1];
  assert.ok(restClass, `no keyframe class on ${restId}`);
  const block = css.match(new RegExp(`@keyframes ${restClass}\\{[^]*?\\}\\}`))[0];
  assert.match(block, /100%\{opacity:calc\(var\(--op,1\)\*1\);transform:translate\(0px,0px\) rotate\(var\(--rot,0deg\)\) scale\(1\);filter:blur\(0px\)/);
  // borrowed: element with anim.effect but no recording still animates, with zero delay.
  // Ruling 5 (refined) skips an invisible donor in favour of the next entry with the same
  // effect: LBTsJDh8fRLwBhKl (effect 18) skips the invisible LBwHyJnDhFdwT00m and borrows
  // the visible LBHF3m9B2D2zRr53 instead; LBXZW5Svpnfy6Mmv (effect 24) borrows the visible
  // LB7KNXNdyg4sxl4b directly. Both must animate with --del:0ms.
  for (const borrowedId of ['LBTsJDh8fRLwBhKl', 'LBXZW5Svpnfy6Mmv']) {
    assert.ok(!anims[borrowedId], `fixture assumption: ${borrowedId} not recorded`);
    assert.match(html, new RegExp(`data-id="${borrowedId}"[^>]*--del:0ms|--del:0ms[^>]*data-id="${borrowedId}"`), `${borrowedId} should animate with --del:0ms`);
  }
});

test('hygiene sorts and de-duplicates frames and skips invisible entries', () => {
  const el = model.pages[0].sections[0].elements[12];
  const messy = { [el.id]: { effect: 8, loop: false, startMs: 0, durationMs: 500, frames: [
    { t: 1, opacity: 0.9, dx: 0, dy: 4, scale: 1, blur: 1, clip: null },
    { t: 0.5, opacity: 0.5, dx: 0, dy: 40, scale: 1, blur: 0, clip: null },
    { t: 0.5, opacity: 0.6, dx: 0, dy: 40, scale: 1, blur: 0, clip: null },
    { t: 0, opacity: 0, dx: 0, dy: 80, scale: 1, blur: 0, clip: null },
  ] } };
  const { css } = render(model, assets, messy);
  const block = css.match(/@keyframes k1\{[^]*?\}\}/)[0];
  assert.deepEqual([...block.matchAll(/(\d+(?:\.\d+)?)%\{/g)].map((m) => Number(m[1])), [0, 50, 100]);
  // The un-rested t:1 frame (opacity 0.9, dy 4, blur 1) must have been replaced by the snap,
  // not merely sorted into place — assert the 100% stop is exactly the rest stop.
  assert.match(block, /100%\{opacity:calc\(var\(--op,1\)\*1\);transform:translate\(0px,0px\) rotate\(var\(--rot,0deg\)\) scale\(1\);filter:blur\(0px\)\}\}$/);
  const still = { [el.id]: { effect: 8, loop: true, startMs: 0, durationMs: 30000, frames: [
    { t: 0, opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0, clip: null },
    { t: 1, opacity: 0.995, dx: 0.1, dy: 0, scale: 1.001, blur: 0, clip: null },
  ] } };
  const out = render(model, assets, still);
  // class precedes data-id in this renderer's tag order; check both orders so the
  // assertion actually exercises the "no an class" behaviour rather than looking
  // only after data-id (where an animated element's class token never appears).
  assert.doesNotMatch(out.html, new RegExp(`data-id="${el.id}"[^>]*\\ban\\b|class="[^"]*\\ban\\b[^"]*"[^>]*data-id="${el.id}"`));
  assert.doesNotMatch(out.css, /@keyframes/);
});

test('a borrowed startMs:0 does not drag the section delay baseline down', () => {
  const home = model.pages.find((p) => p.slug === 'home');
  const s0 = home.sections[0];
  // Home section 0, elements 0 and 1: arbitrary picks (any two distinct elements in the
  // section would do) to carry synthetic recorded entries. Element 10 (LBx2hFJCMqCggSF4)
  // is hard-coded because its real model anim.effect is 2, matching the effect we give
  // the two synthetic entries below, so it borrows one of them.
  const idA = s0.elements[0].id, idB = s0.elements[1].id, idC = s0.elements[10].id;
  assert.equal(s0.elements[10].anim?.effect, 2, 'fixture assumption: idC borrows effect 2');
  const visibleFrames = [
    { t: 0, opacity: 0, dx: 0, dy: 40, scale: 1, blur: 0, clip: null },
    { t: 1, opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0, clip: null },
  ];
  const synth = {
    [idA]: { effect: 2, loop: false, startMs: 500, durationMs: 400, frames: visibleFrames },
    [idB]: { effect: 2, loop: false, startMs: 800, durationMs: 400, frames: visibleFrames },
  };
  const { html } = render(model, assets, synth);
  // sectionStart must be min(500, 800) = 500 over the recorded pair only — idC's forced
  // startMs:0 (it borrows) must not pull that baseline down to 0.
  assert.match(html, new RegExp(`data-id="${idA}"[^>]*--del:0ms|--del:0ms[^>]*data-id="${idA}"`), 'recorded startMs:500 should get --del:0ms');
  assert.match(html, new RegExp(`data-id="${idB}"[^>]*--del:300ms|--del:300ms[^>]*data-id="${idB}"`), 'recorded startMs:800 should get --del:300ms');
  assert.match(html, new RegExp(`data-id="${idC}"[^>]*--del:0ms|--del:0ms[^>]*data-id="${idC}"`), 'borrower should get --del:0ms');
});

test('rendered elements land where the model puts them at 1366 wide', async () => {
  const { html, css } = render(model, assets, anims);
  fs.writeFileSync(new URL('../../invite/index.html', import.meta.url), html);
  fs.writeFileSync(new URL('../../invite/invite.css', import.meta.url), css);
  const { url, close } = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    const failed = [];
    page.on('response', (r) => { if (r.status() >= 400) failed.push(r.url()); });
    await page.goto(`${url}/invite/#envelope`, { waitUntil: 'networkidle' });
    const home = model.pages.find((p) => p.slug === 'home');
    // Without invite.js nothing is scaled, so the stage is 1366 px at origin: DOM rect == model box.
    await page.evaluate(() => { document.querySelectorAll('.page').forEach((p) => p.classList.add('active')); });
    for (const el of home.sections[0].elements.slice(0, 8)) {
      const rect = await page.$eval(`#home .sec:nth-child(1) .stage > [data-id="${el.id}"]`, (n) => { const r = n.getBoundingClientRect(); return { w: r.width, h: r.height }; });
      assert.ok(Math.abs(rect.w - el.width) < 1.5 && Math.abs(rect.h - el.height) < 1.5, `${el.id} ${JSON.stringify(rect)} vs ${el.width}x${el.height}`);
    }
    assert.deepEqual(failed, []);
  } finally { await browser.close(); await close(); }
});
