import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { render, renderElement, keyframeCss, escapeHtml, splitLoop, textEffects, trimLeadingHold } from '../../invite/build/render.mjs';
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

  // LBq7bt3xrnV5lSC1: the small heart-and-squiggle flourish under "WE ARE
  // GETTING MARRIED!", a recoloured spritesheet (not the purple ribbon plate,
  // which is a separate, unrecoloured element).
  const flourish = model.pages[0].sections[0].elements[7];
  assert.equal(flourish.id, 'LBq7bt3xrnV5lSC1');
  const flourishHtml = renderElement(flourish, { assets, anims: {}, eager: true, ids: new Set() });
  const key = assetKey(flourish.media, { '#000000': '#715449' });
  const src = assets.media[key].src;
  assert.match(flourishHtml, new RegExp(`<img src="${src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
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

test('splits a recorded loop into its entrance and its idle sway', () => {
  const f = (t, dy, op = 1) => ({ t, opacity: op, dx: 0, dy, scale: 1, blur: 0, clip: null });
  const frames = [f(0, 80, 0), f(0.1, 40, 0.5), f(0.2, 0), f(0.4, 2), f(0.6, -2), f(0.8, 2), f(1, 0)];
  const { entrance, idle } = splitLoop(frames);
  assert.deepEqual(entrance.map((x) => [x.t, x.dy]), [[0, 80], [0.5, 40], [1, 0]]);
  assert.equal(idle.length, 5); assert.equal(idle[0].t, 0); assert.equal(idle.at(-1).t, 1);
  assert.equal(splitLoop([f(0, 2), f(0.5, -2), f(1, 0)]).entrance, null);
  assert.equal(splitLoop([f(0, 80, 0), f(1, 0)]).idle, null);
});

test('an entrance followed by a wide slow sway still ends when the reveal settles', () => {
  const f = (t, dy, op, dx = 0) => ({ t, opacity: op, dx, dy, scale: 1, blur: 0, clip: null });
  const frames = [f(0, 80, 0), f(0.02, 40, 0.5), f(0.04, 0, 1), f(0.3, 12, 1), f(0.55, -12, 1), f(0.8, 12, 1), f(1, 0, 1)];
  const { entrance, idle, i } = splitLoop(frames);
  assert.equal(i, 2);
  assert.equal(entrance.length, 3);
  assert.equal(idle.length, 5);
});

test('drops a leading hold, keyed on the time gap, so the entrance starts one sample before the first change', () => {
  const f = (t, op) => ({ t, opacity: op, dx: 0, dy: 0, scale: 1, blur: 0, clip: null });
  const { frames, durationMs } = trimLeadingHold([f(0, 0), f(0.9, 0.2), f(0.95, 0.5), f(1, 1)], 10000);
  // t0 = 0.9 - 40/10000 = 0.896, span = 0.104: frame[1] (the first real change, originally
  // t=0.9) lands one 40ms sample after the new zero, not exactly at it — (0.9-0.896)/0.104 = 0.038.
  assert.deepEqual(frames.map((x) => [x.t, x.opacity]), [[0, 0], [0.038, 0.2], [0.519, 0.5], [1, 1]]);
  assert.equal(durationMs, 1040);
  // frames[1].t <= 0.3: no gap worth trimming, left untouched.
  const same = trimLeadingHold([f(0, 0), f(0.2, 0.5), f(1, 1)], 1000);
  assert.deepEqual(same.frames.map((x) => [x.t, x.opacity]), [[0, 0], [0.2, 0.5], [1, 1]]);
  assert.equal(same.durationMs, 1000);
});

test('a looping element gets a one-shot entrance followed by an infinite idle', () => {
  const el = model.pages[0].sections[0].elements[12];
  const f = (t, dy, op = 1) => ({ t, opacity: op, dx: 0, dy, scale: 1, blur: 0, clip: null });
  const anims2 = { [el.id]: { effect: 26, loop: true, startMs: 0, durationMs: 1000, frames: [f(0, 80, 0), f(0.1, 40, 0.5), f(0.2, 0), f(0.4, 2), f(0.6, -2), f(0.8, 2), f(1, 0)] } };
  const { html, css } = render(model, assets, anims2);
  assert.match(css, /@keyframes k1\{/); assert.match(css, /@keyframes k1i\{/);
  assert.match(css, /\.k1\.in\{animation-name:k1,k1i;[^}]*animation-iteration-count:1,infinite;animation-direction:normal,alternate;animation-fill-mode:both,forwards/);
  assert.match(html, new RegExp(`data-id="${el.id}"[^>]*--idur:800ms|--idur:800ms[^>]*data-id="${el.id}"`));
});

test('two loops with an identical entrance but different idle sways never share a keyframe', () => {
  const home = model.pages.find((p) => p.slug === 'home');
  const s0 = home.sections[0];
  const idA = s0.elements[0].id, idB = s0.elements[1].id;
  const f = (t, dy, op = 1) => ({ t, opacity: op, dx: 0, dy, scale: 1, blur: 0, clip: null });
  const entrance = [f(0, 80, 0), f(0.1, 40, 0.5), f(0.2, 0)];
  const synth = {
    [idA]: { effect: 501, loop: true, startMs: 0, durationMs: 1000, frames: [...entrance, f(0.4, 2), f(0.6, -2), f(0.8, 2), f(1, 0)] },
    [idB]: { effect: 502, loop: true, startMs: 0, durationMs: 1000, frames: [...entrance, f(0.4, 3), f(0.6, -3), f(0.8, 3), f(1, 0)] },
  };
  const { html, css } = render(model, assets, synth);
  const classOf = (id) => (html.match(new RegExp(`data-id="${id}"[^>]*class="el [^"]*\\b(k\\d+)\\b`)) || html.match(new RegExp(`class="el [^"]*\\b(k\\d+)\\b[^"]*"[^>]*data-id="${id}"`)))?.[1];
  const nameA = classOf(idA), nameB = classOf(idB);
  assert.ok(nameA && nameB, 'both elements should carry a keyframe class');
  assert.notEqual(nameA, nameB, 'identical entrances but different idle sways must not share a name');
  const idleBlock = (name) => css.match(new RegExp(`@keyframes ${name}i\\{[^]*?\\}\\}`))[0];
  assert.notEqual(idleBlock(nameA), idleBlock(nameB), 'each element\'s idle keyframes should reflect its own sway');
  // each element's class points at its own rule, not the other's
  assert.match(html, new RegExp(`data-id="${idA}"[^>]*class="[^"]*\\b${nameA}\\b|class="[^"]*\\b${nameA}\\b[^"]*"[^>]*data-id="${idA}"`));
  assert.match(html, new RegExp(`data-id="${idB}"[^>]*class="[^"]*\\b${nameB}\\b|class="[^"]*\\b${nameB}\\b[^"]*"[^>]*data-id="${idB}"`));
});

test('the full render has seven pages, fonts and no unresolved media', () => {
  const { html, css } = render(model, assets, anims);
  assert.equal((html.match(/<section class="page/g) || []).length, 7);
  assert.match(html, /id="envelope"[^>]*class="[^"]*active|class="page active" id="envelope"/);
  assert.match(css, /@font-face\{font-family:'f-YAFcf99lyzk-0'/);
  assert.doesNotMatch(html, /undefined/);
  assert.match(html, /data-cd="s"/);
});

test('animation rulings: hygiene, snap, invisible skip, borrowing', () => {
  // Pick a recorded non-loop entry whose raw last frame is NOT already at rest (any page):
  // otherwise the snap-to-rest assertion below would pass vacuously against an entry that was
  // already resting before the snap ever touched it.
  const restId = 'LBmGP6J3tmzZBvKq';
  assert.notEqual(anims[restId].frames.at(-1).opacity, 1, 'fixture assumption: raw last frame not already at rest');
  const { html, css } = render(model, assets, anims);
  // the old always-on "loop" class and its blanket CSS rule are gone — a looping element now
  // splits into a one-shot entrance plus an infinite idle (or an idle-only class); see the
  // dedicated splitLoop tests above.
  assert.doesNotMatch(css, /\.el\.an\.loop\.in/);
  // the split mechanism actually fires on the real recording: at least one entry gets a real
  // paired entrance+idle rule (the .kN.in selector referencing both kN and kNi), and some
  // element in the page actually carries that class.
  assert.match(css, /animation-iteration-count:1,infinite/);
  const splitRule = css.match(/\.(k\d+)\.in\{animation-name:\1,\1i;/);
  assert.ok(splitRule, 'expected at least one real entrance+idle split rule');
  assert.match(html, new RegExp(`class="[^"]*\\b${splitRule[1]}\\b[^"]*"`), `${splitRule[1]} should actually be used by an element`);
  // non-loop keyframes end at rest
  const restClass = html.match(new RegExp(`data-id="${restId}"[^>]*class="el [^"]*\\b(k\\d+)\\b`))?.[1] || html.match(new RegExp(`class="el [^"]*\\b(k\\d+)\\b[^"]*"[^>]*data-id="${restId}"`))?.[1];
  assert.ok(restClass, `no keyframe class on ${restId}`);
  const block = css.match(new RegExp(`@keyframes ${restClass}\\{[^]*?\\}\\}`))[0];
  assert.match(block, /100%\{opacity:calc\(var\(--op,1\)\*1\);transform:translate\(0px,0px\) rotate\(var\(--rot,0deg\)\) scale\(1\);filter:blur\(0px\)/);
  // borrowed: element with anim.effect but no recording still animates, with zero delay.
  // Ruling 5 (refined) skips an invisible donor in favour of the next entry with the same
  // effect: LBTsJDh8fRLwBhKl (effect 18) skips the invisible LBwHyJnDhFdwT00m and borrows
  // the visible LBHF3m9B2D2zRr53 instead; LBx2hFJCMqCggSF4 (effect 2) borrows the visible
  // LBBcjtxjzZv8KTTD directly (the effect-24 example this used to be, LBXZW5Svpnfy6Mmv, lived
  // in a Timeline section Canva hides — task 12 stopped extracting it). Both must animate with --del:0ms.
  for (const borrowedId of ['LBTsJDh8fRLwBhKl', 'LBx2hFJCMqCggSF4']) {
    assert.ok(!anims[borrowedId], `fixture assumption: ${borrowedId} not recorded`);
    assert.match(html, new RegExp(`data-id="${borrowedId}"[^>]*--del:0ms|--del:0ms[^>]*data-id="${borrowedId}"`), `${borrowedId} should animate with --del:0ms`);
  }
});

test('hygiene sorts and de-duplicates frames and skips invisible entries', () => {
  const el = model.pages[0].sections[0].elements[12];
  // The dedup'd middle frame sits at t:0.2 (not 0.5) so this fixture stays under
  // trimLeadingHold's frames[1].t <= 0.3 no-op threshold — this test is about
  // hygiene's sort/dedupe/snap, not about the leading-hold trim.
  const messy = { [el.id]: { effect: 8, loop: false, startMs: 0, durationMs: 500, frames: [
    { t: 1, opacity: 0.9, dx: 0, dy: 4, scale: 1, blur: 1, clip: null },
    { t: 0.2, opacity: 0.5, dx: 0, dy: 40, scale: 1, blur: 0, clip: null },
    { t: 0.2, opacity: 0.6, dx: 0, dy: 40, scale: 1, blur: 0, clip: null },
    { t: 0, opacity: 0, dx: 0, dy: 80, scale: 1, blur: 0, clip: null },
  ] } };
  const { css } = render(model, assets, messy);
  const block = css.match(/@keyframes k1\{[^]*?\}\}/)[0];
  assert.deepEqual([...block.matchAll(/(\d+(?:\.\d+)?)%\{/g)].map((m) => Number(m[1])), [0, 20, 100]);
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

test('scales a text block from its natural size to its box and keeps Canva line breaks', () => {
  const home = model.pages.find((p) => p.slug === 'home');
  const days = (function find(els) { for (const e of els) { if (e.kind === 'text' && /Days left/.test(e.text)) return e; if (e.children) { const f = find(e.children); if (f) return f; } } })(home.sections[2].elements);
  const html = renderElement(days, { assets, anims: {}, eager: false, groupFor: () => ({ name: 'k1' }), sectionStart: 0 });
  assert.match(html, /<div class="tin" style="[^"]*width:186(\.\d+)?px[^"]*transform:scale\(5\.0\d+,[\d.]+\)/);
  assert.match(html, /font-size:25\.1px/);
});
test('marks superscript runs', () => {
  const home = model.pages.find((p) => p.slug === 'home');
  const date = (function find(els) { for (const e of els) { if (e.kind === 'text' && /10th October/.test(e.text)) return e; if (e.children) { const f = find(e.children); if (f) return f; } } })(home.sections[1].elements);
  const html = renderElement(date, { assets, anims: {}, eager: false, groupFor: () => ({ name: 'k1' }), sectionStart: 0 });
  assert.match(html, /vertical-align:super;font-size:0\.6em[^>]*>th</);
});
test('keeps text effects at sane sizes', () => {
  const fx = textEffects([{ type: 'shadow', angle: '-45', blur: '2', color: '#000000', offset: '1.74', transparency: '0.33' }], 86.5);
  const m = fx.shadow.match(/text-shadow:([-\d.]+)px ([-\d.]+)px ([\d.]+)px rgba\(0,0,0,0\.67\)/);
  assert.ok(m, fx.shadow);
  assert.ok(Math.abs(+m[1]) <= 43.25 && Math.abs(+m[2]) <= 43.25 && +m[3] <= 17.3, fx.shadow);
  assert.match(textEffects([{ type: 'outline', color: '#614124', thickness: '0.11' }], 68).stroke, /-webkit-text-stroke:0\.37px #614124;paint-order:stroke fill/);
  assert.match(textEffects([{ type: 'background', color: '#800d09', roundness: '1', spread: '1', transparency: '1' }], 20).background, /background:rgba\(128,13,9,1\);/);
});
