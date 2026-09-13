import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { render, renderElement, keyframeCss, escapeHtml } from '../../invite/build/render.mjs';
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
  assert.match(eager, /top:-929\.9\d?px/);
  const lazy = renderElement(el, { assets, anims: {}, eager: false, ids: new Set() });
  assert.match(lazy, /<img data-src="assets\//);
  assert.doesNotMatch(lazy, /<img src=/);
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
  const restId = Object.entries(anims).find(([id, a]) => !a.loop && homeIds.has(id))[0];
  const { html, css } = render(model, assets, anims);
  // loop class present on a looping element
  assert.match(html, new RegExp(`data-id="${loopId}"[^>]*class="[^"]*\\ban\\b[^"]*\\bloop\\b|class="[^"]*\\bloop\\b[^"]*"[^>]*data-id="${loopId}"`));
  assert.match(css, /\.el\.an\.loop\.in\{animation-iteration-count:infinite;animation-direction:alternate\}/);
  // non-loop keyframes end at rest
  const restClass = html.match(new RegExp(`data-id="${restId}"[^>]*class="el [^"]*\\b(k\\d+)\\b`))?.[1] || html.match(new RegExp(`class="el [^"]*\\b(k\\d+)\\b[^"]*"[^>]*data-id="${restId}"`))?.[1];
  assert.ok(restClass, `no keyframe class on ${restId}`);
  const block = css.match(new RegExp(`@keyframes ${restClass}\\{[^]*?\\}\\}`))[0];
  assert.match(block, /100%\{opacity:calc\(var\(--op,1\)\*1\);transform:translate\(0px,0px\) rotate\(var\(--rot,0deg\)\) scale\(1\);filter:blur\(0px\)/);
  // borrowed: element with anim.effect but no recording still animates, with zero delay
  // (LBTsJDh8fRLwBhKl from the review's suggestion borrows effect 18, whose first-in-file
  // entry LBwHyJnDhFdwT00m is itself skipped as invisible per ruling 4 — so that fixture
  // would stay static, not animate. LBXZW5Svpnfy6Mmv instead borrows effect 24 from
  // LB7KNXNdyg4sxl4b, a visible entry, so it actually gets the an class.)
  const borrowedId = 'LBXZW5Svpnfy6Mmv';
  assert.ok(!anims[borrowedId], 'fixture assumption: not recorded');
  assert.match(html, new RegExp(`data-id="${borrowedId}"[^>]*--del:0ms|--del:0ms[^>]*data-id="${borrowedId}"`));
});

test('hygiene sorts and de-duplicates frames and skips invisible entries', () => {
  const el = model.pages[0].sections[0].elements[12];
  const messy = { [el.id]: { effect: 8, loop: false, startMs: 0, durationMs: 500, frames: [
    { t: 1, opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0, clip: null },
    { t: 0.5, opacity: 0.5, dx: 0, dy: 40, scale: 1, blur: 0, clip: null },
    { t: 0.5, opacity: 0.6, dx: 0, dy: 40, scale: 1, blur: 0, clip: null },
    { t: 0, opacity: 0, dx: 0, dy: 80, scale: 1, blur: 0, clip: null },
  ] } };
  const { css } = render(model, assets, messy);
  const block = css.match(/@keyframes k1\{[^]*?\}\}/)[0];
  assert.deepEqual([...block.matchAll(/(\d+(?:\.\d+)?)%\{/g)].map((m) => Number(m[1])), [0, 50, 100]);
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
