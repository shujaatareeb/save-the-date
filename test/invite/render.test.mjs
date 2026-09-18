import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium } from 'playwright';
import { render, renderElement, keyframeCss, escapeHtml, splitLoop, textEffects, trimLeadingHold, blockLeading } from '../../invite/build/render.mjs';
import { planFonts } from '../../invite/build/assets.mjs';
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
  assert.match(html, /font-family:'f-YAFcf99lyzk'/);
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

test('caps a long two-frame entrance at 800ms', () => {
  const { html } = render(model, assets, anims);
  assert.match(html, /data-id="LB7KNXNdyg4sxl4b"[^>]*--dur:800ms|--dur:800ms[^>]*data-id="LB7KNXNdyg4sxl4b"/);
});

test('caps a long two-frame loop entrance', () => {
  const el = model.pages[1].sections[0].elements[0];
  const f = (t, dy, opacity = 1) => ({ t, opacity, dx: 0, dy, scale: 1, blur: 0, clip: null });
  const synth = { [el.id]: { effect: 501, loop: true, startMs: 0, durationMs: 10000, frames: [
    f(0, 80, 0), f(0.3, 0), f(0.6, 2), f(1, 0),
  ] } };
  const { html } = render(model, assets, synth);
  assert.match(html, new RegExp(`data-id="${el.id}"[^>]*--dur:800ms;`));
  assert.doesNotMatch(html, new RegExp(`data-id="${el.id}"[^>]*--idur:`));
});

// The recorder calls an entry a loop whenever the sampled node kept changing
// until the window closed — which an entrance's long easing tail does too.
// Sampled on the live page, every one of the 21 "loops" in the deck but the
// two hearts sits perfectly still once its entrance is over; played as an
// alternating sway, their tails became a 2–5 Hz shake. A loop now plays its
// entrance once and holds.
test('a looping recording plays its entrance once and then holds still', () => {
  const el = model.pages[0].sections[0].elements[12];
  const f = (t, dy, op = 1) => ({ t, opacity: op, dx: 0, dy, scale: 1, blur: 0, clip: null });
  const anims2 = { [el.id]: { effect: 26, loop: true, startMs: 0, durationMs: 1000, frames: [f(0, 80, 0), f(0.1, 40, 0.5), f(0.2, 0), f(0.4, 2), f(0.6, -2), f(0.8, 2), f(1, 0)] } };
  const { html, css } = render(model, assets, anims2);
  assert.match(css, /@keyframes k1\{/);
  assert.doesNotMatch(css, /@keyframes k1i\{|infinite|alternate/);
  assert.match(css, /\.k1\.in\{animation-name:k1\}/);
  assert.match(html, new RegExp(`data-id="${el.id}"[^>]*--dur:200ms;`));
  assert.doesNotMatch(html, /--idur:/);
});

// The two hearts — round the 10 on the home calendar and on the nikah card —
// beat on the live page: scale .85↔1.14 every .9 s, a quick swell and a slow
// release, no change in opacity. They are effect 2 with a recorded scale
// swing the recorder aliased into a 12–40 s loop; that signature is the beat.
test('an effect-2 loop with a big scale swing is a heartbeat', () => {
  const { html, css } = render(model, assets, anims);
  for (const id of ['LB6d2Q7MlFSXJzT6', 'LBy1MrY9MctlgX5z']) {
    const m = html.match(new RegExp(`<div class="el img an (k\\d+) hb"[^>]*data-id="${id}"`));
    assert.ok(m, `${id} carries an entrance class and hb`);
    assert.match(css, new RegExp(`\\.${m[1]}\\.in\\{animation-name:${m[1]}\\}`));
  }
  assert.match(css, /\.el\.hb\.in\{animation-name:var\(--kf\),hb;animation-duration:var\(--dur\),\.9s;animation-delay:var\(--del\),calc\(var\(--del\) \+ var\(--dur\)\);animation-iteration-count:1,infinite;animation-direction:normal,normal;animation-fill-mode:both,none;animation-timing-function:linear,ease-in-out\}/);
  assert.match(css, /@keyframes hb\{0%,100%\{transform:rotate\(var\(--rot,0deg\)\) scale\(\.85\)\}34%\{transform:rotate\(var\(--rot,0deg\)\) scale\(1\.14\)\}\}/);
  // The banner group is effect 2 too, but its recorded scale barely moves: no beat.
  assert.doesNotMatch(html, /data-id="LBx2hFJCMqCggSF4"[^>]*class="[^"]*\bhb\b|class="[^"]*\bhb\b[^"]*"[^>]*data-id="LBx2hFJCMqCggSF4"/);
});

test('two loops with the same entrance share one keyframe set once their sways are dropped', () => {
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
  assert.ok(classOf(idA) && classOf(idB), 'both elements should carry a keyframe class');
  assert.equal(classOf(idA), classOf(idB));
  assert.equal((css.match(/@keyframes k\d+\{/g) || []).length, 1);
});

test('the full render has seven pages, fonts and no unresolved media', () => {
  const { html, css } = render(model, assets, anims);
  assert.equal((html.match(/<section class="page/g) || []).length, 7);
  assert.match(html, /id="envelope"[^>]*class="[^"]*active|class="page active" id="envelope"/);
  assert.match(css, /@font-face\{font-family:'f-YAFcf99lyzk'/);
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
  // nothing recorded loops any more: the only infinite animations are the button pulse,
  // the heartbeat and the write-on's per-character fades (none of them recorded sways)
  assert.doesNotMatch(css, /@keyframes k\d+i\{|animation-direction:normal,alternate/);
  // non-loop keyframes end at rest
  const restClass = html.match(new RegExp(`data-id="${restId}"[^>]*class="el [^"]*\\b(k\\d+)\\b`))?.[1] || html.match(new RegExp(`class="el [^"]*\\b(k\\d+)\\b[^"]*"[^>]*data-id="${restId}"`))?.[1];
  assert.ok(restClass, `no keyframe class on ${restId}`);
  const block = css.match(new RegExp(`@keyframes ${restClass}\\{[^]*?\\}\\}`))[0];
  assert.match(block, /100%\{opacity:calc\(var\(--op,1\)\*1\);transform:translate\(0px,0px\) rotate\(var\(--rot,0deg\)\) scale\(1\)\}/);
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
  assert.match(block, /100%\{opacity:calc\(var\(--op,1\)\*1\);transform:translate\(0px,0px\) rotate\(var\(--rot,0deg\)\) scale\(1\)\}\}$/);
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
  // 0.6em here would resolve against the parent .ln, not this run's 25.1px.
  assert.match(html, /font-size:15\.06px[^>]*vertical-align:super[^>]*>th</);
});

test('leads a block against its own run size, not the wrapper', () => {
  // The .tin wrapper carries no font size, so an em resolves against 16px.
  assert.equal(blockLeading({ lineHeight: '0.74em', size: 159.815 }), '118.26px');
  assert.equal(blockLeading({ lineHeight: '0.87em', size: 86.4996 }), '75.25px');
});

test('leaves a block with no stored leading to the face', () => {
  assert.equal(blockLeading({ size: 30.0004 }), 'normal');
});

test('refuses a line height in a unit it cannot convert', () => {
  assert.throws(() => blockLeading({ lineHeight: '18px', size: 30 }), /unsupported line height/);
});

test('names each font format by its real extension', () => {
  const { css } = render(model, assets, {});
  // Every face ships as a WOFF2 subset now; the format hint must say so, or a browser skips the source.
  assert.match(css, /url\(assets\/fonts\/[0-9a-f]{12}\.woff2\) format\('woff2'\)/);
  assert.doesNotMatch(css, /\.woff2\) format\('(woff|opentype|truetype)'\)/);
  // and the mapping still tells a bare sfnt from a woff, should one ever come through
  const synth = { ...assets, fonts: { 'x-REGULAR': { fontId: 'x', family: 'X', src: 'assets/fonts/x.otf', weight: 400, italic: false }, 'y-REGULAR': { fontId: 'y', family: 'Y', src: 'assets/fonts/y.woff', weight: 400, italic: false } } };
  const { css: css2 } = render(model, synth, {});
  assert.match(css2, /x\.otf\) format\('opentype'\)/);
  assert.match(css2, /y\.woff\) format\('woff'\)/);
});

// Expected values are what the live Canva page computes for these same
// effects (read off its text-shadow), so a change here is a change in fidelity.
const shadows = (fx) => [...fx.shadow.matchAll(/(-?[\d.]+)px (-?[\d.]+)px(?: ([\d.]+)px)? rgba\((\d+),(\d+),(\d+),([\d.]+)\)/g)]
  .map((m) => ({ dx: +m[1], dy: +m[2], blur: m[3] == null ? 0 : +m[3], rgb: [+m[4], +m[5], +m[6]], a: +m[7] }));
const near = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: ${got} vs ${want}`);

test('shadow: offset and blur are sixteenths of the font size, angle turns from straight down, transparency is the alpha', () => {
  // "Misbah & Areeb" — Canva: rgba(0,0,0,.33) 6.65163px 6.65163px 10.8125px
  const [misbah] = shadows(textEffects([{ type: 'shadow', angle: '-45', blur: '2', color: '#000000', offset: '1.74', transparency: '0.33' }], 86.4996));
  near(misbah.dx, 6.652, 0.02, 'dx'); near(misbah.dy, 6.652, 0.02, 'dy'); near(misbah.blur, 10.81, 0.02, 'blur'); assert.equal(misbah.a, 0.33);
  // "Wedding Timeline" — Canva: rgba(75,56,34,.5) -0.535102px 0.260986px 8.63265px
  const [timeline] = shadows(textEffects([{ type: 'shadow', angle: '64', blur: '1.16', color: '#4b3822', offset: '0.08', transparency: '0.5' }], 119.071));
  near(timeline.dx, -0.535, 0.02, 'dx'); near(timeline.dy, 0.261, 0.02, 'dy'); near(timeline.blur, 8.633, 0.02, 'blur'); assert.equal(timeline.a, 0.5);
  assert.deepEqual(timeline.rgb, [75, 56, 34]);
});

test('echo: two copies at one and two steps, half and third strength', () => {
  // "For Details" — Canva: rgba(75,56,34,.5) 1.10194px 0.860929px, rgba(75,56,34,.3) 2.20388px 1.72186px
  const [one, two] = shadows(textEffects([{ type: 'echo', angle: '-52', color: '#4b3822', offset: '0.14' }], 159.815));
  near(one.dx, 1.102, 0.02, 'dx'); near(one.dy, 0.861, 0.02, 'dy'); assert.equal(one.a, 0.5); assert.equal(one.blur, 0);
  near(two.dx, 2.204, 0.02, 'dx2'); near(two.dy, 1.722, 0.02, 'dy2'); assert.equal(two.a, 0.3);
  // "Save the Date" — Canva: rgba(202,124,118,.5) -0.212702px -0.244685px, ×2 at .3
  const [a, b] = shadows(textEffects([{ type: 'echo', angle: '139', color: '#ca7c76', offset: '0.22' }], 23.579));
  near(a.dx, -0.213, 0.01, 'dx'); near(a.dy, -0.245, 0.01, 'dy'); near(b.dx, -0.425, 0.01, 'dx2'); near(b.dy, -0.489, 0.01, 'dy2');
});

test('lift: a straight-down drop whose blur and strength grow with intensity', () => {
  // Canva: i=.4 @36.7357 → rgba(0,0,0,.27) 0 1.37759px 4.95932px; i=1 @25.1043 → rgba(0,0,0,.6) 0 .941411px 7.06058px;
  // i=.56 @72.3136 → rgba(0,0,0,.357) 0 2.71176px 12.5826px
  for (const [i, size, dy, blur, a] of [['0.4', 36.7357, 1.378, 4.959, 0.27], ['1', 25.1043, 0.941, 7.061, 0.6], ['0.56', 72.3136, 2.712, 12.583, 0.36]]) {
    const [lift] = shadows(textEffects([{ type: 'lift', intensity: i }], size));
    assert.equal(lift.dx, 0); near(lift.dy, dy, 0.01, `dy i=${i}`); near(lift.blur, blur, 0.01, `blur i=${i}`); near(lift.a, a, 0.005, `alpha i=${i}`);
  }
});

test('keeps outline and background at sane sizes', () => {
  assert.match(textEffects([{ type: 'outline', color: '#614124', thickness: '0.11' }], 68).stroke, /-webkit-text-stroke:0\.37px #614124;paint-order:stroke fill/);
  assert.match(textEffects([{ type: 'background', color: '#800d09', roundness: '1', spread: '1', transparency: '1' }], 20).background, /background:rgba\(128,13,9,0\);/);
  assert.match(textEffects([{ type: 'background', color: '#800d09', transparency: '0.25' }], 20).background, /background:rgba\(128,13,9,0\.75\);/);
});

test('clamps shadow alpha and defaults it when the value is missing or junk', () => {
  const fx = textEffects([
    { type: 'shadow', color: '#000000', transparency: '-1' },
    { type: 'shadow', color: '#000000', transparency: '2' },
    { type: 'shadow', color: '#000000', transparency: 'invalid' },
    { type: 'shadow', color: '#000000' },
  ], 20);
  assert.deepEqual(fx.shadow.match(/rgba\(0,0,0,[\d.]+\)/g), [
    'rgba(0,0,0,0)',
    'rgba(0,0,0,1)',
    'rgba(0,0,0,0.5)',
    'rgba(0,0,0,0.5)',
  ]);
});

test('escapes outline colour before placing it in inline CSS', () => {
  const fx = textEffects([{ type: 'outline', color: '#614124\";content:\'<svg/onload=alert(1)>', thickness: '0.11' }], 68);
  assert.match(fx.stroke, /&quot;/);
  assert.match(fx.stroke, /&#39;/);
  assert.match(fx.stroke, /&lt;svg\/onload=alert\(1\)&gt;/);
  assert.doesNotMatch(fx.stroke, /\"|<|>/);
});

test('preserves whitespace in shape text blocks', () => {
  const { css } = render(model, assets, {});
  assert.match(css, /\.stxt\{[^}]*white-space:pre\}/); // preserved, and never wrapped on its own
});

// Canva's effect 30 is a luma-matte reveal: the animation's video is a
// black-to-white matte the live page composites over the picture on a canvas,
// not an overlay to blend on top of it. The build hands the matte to the
// runtime and leaves the picture alone; nothing about the wrapper animates.
test('an effect-30 image ships its matte for the runtime instead of a blended video overlay', () => {
  const { html, css } = render(model, assets, anims);
  const m = html.match(/<div class="el img mt"[^>]*data-id="LB5G72RFmZTRXFxD"[^>]*>(.*?)<\/div>/s);
  assert.ok(m, 'candelabra wrapper carries class mt');
  const [open, inner] = m;
  assert.match(open, /data-matte="assets\/[0-9a-f]{12}\.webm"/);
  assert.match(open, /data-matte-mp4="assets\/[0-9a-f]{12}\.mp4"/);
  assert.doesNotMatch(open, /class="el img mt[^"]*\ban\b/);
  assert.doesNotMatch(open, /--dur:/);
  assert.match(inner, /<img [^>]*data-src="assets\/[0-9a-f]{12}\.webp"/);
  assert.doesNotMatch(inner, /<video|mix-blend-mode/);
  assert.doesNotMatch(html, /<video|mix-blend-mode/);
  assert.match(css, /\.el\.mt:not\(\.in\)\{opacity:0\}/);
  assert.match(css, /\.el\.mt\.mt-run img\{visibility:hidden\}/);
  assert.match(css, /\.el\.mt>canvas\{position:absolute;left:0;top:0;width:100%;height:100%/);
});

// Canva pulses its buttons — opacity 0.35↔1 every 1.1 s and, for most, scale
// 0.85↔1.14 every 0.9 s — with no animation on the element itself. The
// recorder cannot sample that fast and aliased it into a 25-second drift that
// parked "view details" at half strength; the signature is unmistakable
// (no effect, a loop, an opacity floor at Canva's 0.35), so the build emits
// the pulse itself instead of the recording.
test('a recorded loop with no effect and a 0.35 opacity floor is Canva\'s button pulse', () => {
  const { html, css } = render(model, assets, anims);
  const wrapper = (id) => html.match(new RegExp(`<(?:div|a)[^>]*data-id="${id}"[^>]*>`))[0];
  const details = wrapper('LBHb4nSN2rqPfTlS');
  assert.match(details, /class="el txt pl pls"/, 'view details: opacity and scale pulse');
  assert.doesNotMatch(details, /--dur:|\ban\b/);
  assert.match(wrapper('LBrC6ChVnFnyKTVx'), /class="el txt pl"(?! pls)/, 'Click to open: opacity only');
  assert.match(wrapper('LB1P27837r8487lS'), /class="el img pl"/, 'reception button the recorder caught at .396');
  assert.match(css, /\.el\.pl\{animation:plo 1\.11s ease-in-out infinite\}/);
  assert.match(css, /\.el\.pl\.pls\{animation:plo 1\.11s ease-in-out infinite,pls \.9s ease-in-out infinite\}/);
  assert.match(css, /@keyframes plo\{0%,100%\{opacity:var\(--op,1\)\}50%\{opacity:calc\(var\(--op,1\)\*\.35\)\}\}/);
  // quick swell, slow release: the peak sits a third of the way through the beat
  assert.match(css, /@keyframes pls\{0%,100%\{transform:rotate\(var\(--rot,0deg\)\) scale\(\.85\)\}34%\{transform:rotate\(var\(--rot,0deg\)\) scale\(1\.14\)\}\}/);
  // A loop that genuinely goes to zero is an entrance, not a pulse.
  assert.match(wrapper('LBwySg2vwJKtFn3Y'), /class="el img an /);
});

// Canva's effect 18 writes a text on one character at a time — each character
// (spaces included) fades in ~72 ms after the one before, the fade itself
// lasting what the recorder measured. The recorder marks these entries with
// `parts` (many short-lived nodes on one text element); render turns them into
// per-character spans with a staggered delay instead of one fade for the block.
test('a text recorded in parts writes on character by character', () => {
  const { html, css } = render(model, assets, anims);
  const textOf = (id) => { let hit; const walk = (els) => els.forEach((e) => { if (e.id === id) hit = e; if (e.children) walk(e.children); }); model.pages.forEach((p) => p.sections.forEach((s) => walk(s.elements))); return hit.text.replace(/\n/g, ''); };
  for (const id of ['LBHF3m9B2D2zRr53', 'LBwHyJnDhFdwT00m']) {
    const text = textOf(id);
    const m = html.match(new RegExp(`<div class="el txt an wr"[^>]*data-id="${id}"[^>]*style="([^"]*)"[^>]*>(.*?)</div></div>`, 's'));
    assert.ok(m, `${id} is a write-on`);
    assert.match(m[1], /--dur:\d+ms;/);
    assert.match(m[1], /--step:72ms;/);
    const chars = [...m[2].matchAll(/<span class="ch" style="--i:(\d+)">(.*?)<\/span>/g)].map((c) => [Number(c[1]), c[2]]);
    assert.equal(chars.map((c) => c[1]).join(''), text.replace('&', '&amp;'), `${id} characters`);
    assert.deepEqual(chars.map((c) => c[0]), chars.map((_, i) => i), `${id} indices count spaces`);
    assert.doesNotMatch(m[0], /class="el txt an wr k\d/, 'no block keyframes on top of the write-on');
  }
  assert.match(css, /\.el\.wr\.in\{opacity:var\(--op,1\);animation:none\}/);
  assert.match(css, /\.el\.wr \.ch\{opacity:0\}\.el\.wr\.in \.ch\{animation:wr var\(--dur,800ms\) linear both;animation-delay:calc\(var\(--del,0ms\) \+ var\(--i\)\*var\(--step,72ms\)\)\}/);
  assert.match(css, /@keyframes wr\{from\{opacity:0\}to\{opacity:1\}\}/);
  // A text without parts is untouched.
  assert.doesNotMatch(html.match(/<div class="el txt[^>]*data-id="LBpx4R6Jb5dzwf96"[^>]*>.*?<\/div><\/div>/s)[0], /class="ch"/);
});

// The live countdown is an 800×400 SVG widget: Abril Fatface digits 140 px
// tall centred at x 60/140 · 260/340 · 460/540 · 660/740 on y 94.5, colons at
// 200/400/600, labels 40 px at x 100/300/500/700 on y 300, all #715449, with
// a letterpress filter. Ours is that SVG, drawn by hand.
test('the countdown is the widget\'s own SVG geometry', () => {
  const { html, css } = render(model, assets, anims);
  const m = html.match(/<div class="el cd"[^>]*data-id="LBjdk7hGK5sfSTt6"[^>]*>(<svg.*?<\/svg>)<\/div>/s);
  assert.ok(m, 'countdown wrapper holds an svg');
  const svg = m[1];
  assert.match(svg, /^<svg viewBox="0 0 800 400" preserveAspectRatio="xMidYMid slice">/);
  for (const [u, x1, x2] of [['d', 60, 140], ['h', 260, 340], ['m', 460, 540], ['s', 660, 740]]) {
    assert.match(svg, new RegExp(`<g class="cd-d">.*?<text data-cd="${u}" y="199.5"[^>]*><tspan x="${x1}">0</tspan><tspan x="${x2}">0</tspan></text>`, 's'), `unit ${u}`);
  }
  for (const x of [200, 400, 600]) assert.match(svg, new RegExp(`<text x="${x}" y="199.5"[^>]*>:</text>`));
  for (const [x, l] of [[100, 'DAYS'], [300, 'HOURS'], [500, 'MINS'], [700, 'SECS']]) assert.match(svg, new RegExp(`<text x="${x}" y="300"[^>]*>${l}</text>`));
  // The letterpress is two plain offset copies behind each text — a light one
  // up-left, a dark one down-right — not an SVG filter: WebKit rasterises a
  // filter's whole region into several buffers on every paint, and with the
  // digits repainting each second at 3× on a phone that was enough to have
  // iOS reload the page.
  assert.doesNotMatch(svg, /<filter|filter=/);
  assert.match(svg, /<g class="cd-l cd-lo"><text[^>]*>DAYS<\/text>/, 'light copies of the labels');
  assert.match(svg, /<g class="cd-d cd-lo"><text data-cd="d"[^>]*><tspan x="58">0<\/tspan><tspan x="138">0<\/tspan><\/text>/, 'light copy of the digits, 2px up-left');
  assert.match(svg, /<g class="cd-d cd-dk"><text data-cd="d"[^>]*><tspan x="62">0<\/tspan><tspan x="142">0<\/tspan><\/text>/, 'dark copy, 2px down-right');
  assert.match(css, /\.cd-lo text\{fill:rgba\(255,255,255,\.45\)\}\.cd-dk text\{fill:rgba\(0,0,0,\.2\)\}/);
  assert.equal((svg.match(/data-cd="s"/g) || []).length, 3, 'three copies of each unit, all updated by the runtime');
  assert.match(css, /@font-face\{font-family:'f-countdown';src:url\(assets\/fonts\/[0-9a-f]{12}\.woff2\) format\('woff2'\)/);
  assert.match(css, /\.cd text\{[^}]*font-family:'f-countdown'[^}]*fill:#715449/);
  assert.match(css, /\.cd-d text\{font-size:140px\}\.cd-l text\{font-size:40px\}/);
  assert.doesNotMatch(html, /cd-row|cd-u/);
});

// The vinyl record on the home page turns on the live page — 17.7°/s, one
// turn every 20 s, for ever. The recorder now writes rotation (dr, degrees
// relative to rest, unwrapped); a loop whose rotation only ever grows is a
// spin, and its speed sets the period.
test('a loop whose rotation only ever grows is a spin at the recorded speed', () => {
  const { html, css } = render(model, assets, anims);
  const m = html.match(/<div class="el img an (k\d+) sp"[^>]*data-id="LBdNPD4c6lVSCGRg"[^>]*style="([^"]*)"/);
  assert.ok(m, 'record carries an entrance class and sp');
  const period = Number(m[2].match(/--spin:(\d+)ms/)[1]);
  assert.ok(period > 19000 && period < 21500, `one turn every ${period} ms`);
  assert.match(m[2], /--kf:k\d+;/);
  // its entrance keeps the fade but not the turn — the spin owns the transform
  const kf = css.match(new RegExp(`@keyframes ${m[1]}\\{[^]*?\\}\\}`))[0];
  assert.doesNotMatch(kf, /calc\(var\(--rot,0deg\) \+/);
  assert.match(css, /\.el\.sp\.in\{animation-name:var\(--kf\),sp;animation-duration:var\(--dur\),var\(--spin\);animation-delay:var\(--del\),0ms;animation-iteration-count:1,infinite;animation-direction:normal,normal;animation-fill-mode:both,none;animation-timing-function:linear,linear\}/);
  assert.match(css, /@keyframes sp\{from\{transform:rotate\(var\(--rot,0deg\)\)\}to\{transform:rotate\(calc\(var\(--rot,0deg\) \+ 360deg\)\)\}\}/);
});

test('a recorded turn that settles is part of the entrance, not a spin', () => {
  const el = model.pages[0].sections[0].elements[12];
  const f = (t, dr, op = 1) => ({ t, opacity: op, dx: 0, dy: 0, scale: 1, blur: 0, clip: null, ...(dr ? { dr } : {}) });
  const synth = { [el.id]: { effect: 9, loop: false, startMs: 0, durationMs: 800, frames: [f(0, -90, 0), f(0.5, -30, 0.7), f(1, 0)] } };
  const { html, css } = render(model, assets, synth);
  assert.doesNotMatch(html, /\bsp\b/);
  assert.match(css, /0%\{opacity:calc\(var\(--op,1\)\*0\);transform:translate\(0px,0px\) rotate\(calc\(var\(--rot,0deg\) \+ -90deg\)\) scale\(1\)/);
  assert.match(css, /100%\{[^}]*rotate\(var\(--rot,0deg\)\)/);
});

// A still is offered at both encodings through srcset, with a sizes formula
// that is the scaler's own rule for its section — the browser then picks by
// real device pixels, and a phone at k ≈ 0.3 takes the small one.
test('offers each still at both widths with the scaler\'s rule as its sizes', () => {
  const { html } = render(model, assets, anims);
  // envelope is eager: real attributes
  const eager = html.match(/<section class="page active" id="envelope".*?<\/section>/s)[0];
  const img = eager.match(/<img src="(assets\/[0-9a-f]{12}\.webp)" srcset="(assets\/[0-9a-f]{12}\.webp) (\d+)w, \1 (\d+)w" sizes="\(max-width: (\d+)px\) calc\(\(100vw - 16px\) \* ([\d.]+)\), ([\d.]+)px"/);
  assert.ok(img, 'an eager still with srcset and sizes');
  const [, big, small, ws, w, bp, ratio, dw] = img;
  assert.ok(Number(ws) < Number(w));
  // envelope section: content column 449.93 wide → breakpoint cw+15, ratio dw/cw
  assert.equal(Number(bp), 465);
  assert.ok(Math.abs(Number(ratio) - Number(dw) / 449.93) < 0.002, `${ratio} vs ${Number(dw) / 449.93}`);
  // lazy pages carry the same as data attributes, and no src yet
  const lazy = html.match(/<section class="page" id="home".*?<\/section>/s)[0];
  assert.match(lazy, /<img data-src="assets\/[0-9a-f]{12}\.webp" data-srcset="assets\/[0-9a-f]{12}\.webp \d+w, assets\/[0-9a-f]{12}\.webp \d+w" data-sizes="\(max-width: \d+px\) calc\(\(100vw - 16px\) \* [\d.]+\), [\d.]+px" loading="lazy"/);
  assert.doesNotMatch(lazy, /<img src=/);
  // a picture inside a scaled group is drawn at crop width × group scale
  const grp = html.match(/<div class="el grp[^>]*data-id="LBmCKPCDjhvZsK0K"[^>]*>.*?<\/div><\/div>/s);
  assert.ok(grp);
});

// The envelope's script faces are the first thing a guest reads; with the
// faces subset to a few KB each, preloading them costs nothing and spares the
// swap from a fallback serif a second or two in.
test('preloads the faces the envelope page sets', () => {
  const { html } = render(model, assets, anims);
  const head = html.match(/<head>.*?<\/head>/s)[0];
  const preloads = [...head.matchAll(/<link rel="preload" href="(assets\/fonts\/[0-9a-f]{12}\.woff2)" as="font" type="font\/woff2" crossorigin>/g)].map((m) => m[1]);
  const envelope = model.pages.find((p) => p.slug === 'envelope');
  const wanted = planFonts({ ...model, pages: [envelope] }).map((f) => assets.fonts[f.key].src);
  assert.deepEqual(preloads.sort(), [...new Set(wanted)].sort());
  assert.ok(preloads.length >= 2 && preloads.length <= 5, `${preloads.length} faces`);
});

// A `filter`, even blur(0px), keeps an element on its own compositing layer;
// on a phone at 3× a full-bleed background's layer is tens of megabytes, and
// iOS reloads a page that holds too many. Keyframes only carry a filter when
// some frame actually blurs, and a finished entrance releases its animation
// (its rest state is the element's own) so nothing lingers.
test('keyframes carry a filter only when a frame blurs, and a finished entrance lets go', () => {
  const f = (t, blur, op = 1) => ({ t, opacity: op, dx: 0, dy: 0, scale: 1, blur, clip: null });
  assert.doesNotMatch(keyframeCss('k1', [f(0, 0, 0), f(1, 0)]), /filter/);
  assert.match(keyframeCss('k2', [f(0, 8, 0), f(1, 0)]), /0%\{[^}]*filter:blur\(8px\)/);
  assert.match(keyframeCss('k2', [f(0, 8, 0), f(1, 0)]), /100%\{[^}]*filter:blur\(0px\)/);
  const { css } = render(model, assets, anims);
  assert.match(css, /\.el\.an\.done:not\(\.hb\):not\(\.sp\):not\(\.wr\)\{animation:none;opacity:var\(--op,1\);transform:rotate\(var\(--rot,0deg\)\)\}/);
  assert.doesNotMatch(css, /content-visibility/);
});

// Canva's effect 26 is a wipe: the element's clipping box sweeps across its
// own width (or height) while the artwork inside counter-moves and stays
// put, so the picture is revealed edge to edge. The recorder kept only the
// box's motion, and we slid the whole thing. The wrapper still plays the
// recorded sweep; its content gets the inverse as a `translate`, which
// composes with any transform of its own.
test('an effect-26 entrance wipes the content in rather than sliding it', () => {
  const { html, css } = render(model, assets, anims);
  const cls = (id) => html.match(new RegExp(`class="el (?:img|txt|shp) an (k\\d+) wp"[^>]*data-id="${id}"`))?.[1];
  const line = cls('LBq7bt3xrnV5lSC1'), path = cls('LBDKD68Lf5BM7kkq'), heading = cls('LBl27C3knDdvHVj0');
  assert.ok(line && path && heading, 'wiped elements carry wp');
  // the line sweeps sideways by its width; its content starts pushed the other way and settles at rest
  const lineW = css.match(new RegExp(`@keyframes ${line}w\\{([^]*?)\\}\\}`))[1];
  assert.match(lineW, /^0%\{translate:21[01](\.\d+)?px 0px\}/);
  assert.match(lineW, /100%\{translate:0px 0px$/);
  const pathW = css.match(new RegExp(`@keyframes ${path}w\\{([^]*?)\\}\\}`))[1];
  // the path draws downward: its box starts above and sweeps down, its content starts pushed down
  assert.match(pathW, /^0%\{translate:0px 116[67](\.\d+)?px\}/);
  const pathBox = css.match(new RegExp(`@keyframes ${path}\\{([^]*?)\\}\\}`))[1];
  assert.match(pathBox, /^0%\{[^}]*translate\(0px,-116[67](\.\d+)?px\)/);
  for (const k of [line, path, heading]) assert.match(css, new RegExp(`\\.${k}\\.wp\\.in>\\*\\{animation:${k}w var\\(--dur\\) linear both;animation-delay:var\\(--del\\)\\}`));
  // clipped only while the wipe plays: a script heading's swash overhangs its box and was cut off for good
  assert.match(css, /\.el\.wp\.in:not\(\.done\)\{overflow:hidden\}/);
  assert.match(css, /\.el\.an\.done:not\(\.hb\):not\(\.sp\):not\(\.wr\)>\*\{animation:none\}/);
  // an ordinary entrance gets no companion
  assert.doesNotMatch(html, /class="el img an k\d+ wp"[^>]*data-id="LBmGP6J3tmzZBvKq"/);
});


// The first element of a section that spans the canvas edge to edge is its
// background; the runtime cover-scales it when the section is stretched to
// fill a phone screen. Only the first: the other bleeds are overlays.
test('marks each section\'s first bleed as its background', () => {
  const { html } = render(model, assets, anims);
  const nikah = html.match(/<section class="page" id="nikah".*?<\/section>/s)[0];
  assert.match(nikah, /class="el img[^"]*\bbg\b[^"]*"[^>]*data-id="LBg5tzRNb6dfJhmv"/, 'the satin is the background');
  assert.doesNotMatch(nikah, /class="el img[^"]*\bbg\b[^"]*"[^>]*data-id="LB7xDzbSWgpSSlhD"/, 'the second bleed is not');
  assert.equal((nikah.match(/\bbg\b[^"]*"[^>]*data-id/g) || []).length, 1);
});

test('marks a section\'s frame for the runtime', () => {
  const { html } = render(model, assets, anims);
  assert.match(html, /class="el shp[^"]*\bfr\b[^"]*"[^>]*data-id="LBmXYWhntCSrpFtH"/);
  assert.equal((html.match(/\bfr\b[^"]*"[^>]*data-id/g) || []).length, 1);
});

// A stroked path keeps its stroke at its design width whatever the shape's
// box is stretched to — Canva draws shape strokes in design pixels.
test('draws a path\'s stroke at its design width, unscaled by the box', () => {
  const { html } = render(model, assets, anims);
  const frame = html.match(/data-id="LBmXYWhntCSrpFtH"[^>]*>(<svg.*?<\/svg>)/s)[1];
  assert.match(frame, /<path d="M0 0H64V64H0z" fill="none" stroke="#715449" stroke-width="1" vector-effect="non-scaling-stroke"\/>/);
  const gold = html.match(/data-id="LBxLcThlXtcKV5sJ"[^>]*>(<svg.*?<\/svg>)/s)[1];
  assert.match(gold, /stroke="#ae8d3f" stroke-width="1" vector-effect="non-scaling-stroke"/);
});

// Every line of a text block is Canva's own line (the model lists them), so a
// line must never wrap on its own: a run that measures a hair wider than the
// block's natural width — "With Best Compliments" at 461 px in a 460.27 px
// box on WebKit — broke onto two lines.
test('a text line never wraps of its own accord', () => {
  const { css } = render(model, assets, anims);
  assert.match(css, /\.txt>\.tin\{[^}]*white-space:pre\}/);
  assert.doesNotMatch(css, /pre-wrap/);
});

test('passes a cover section on to the runtime', () => {
  const { html } = render(model, assets, anims);
  const dress = html.match(/<section class="page" id="dress-code".*?<\/section>/s)[0];
  assert.match(dress, /<div class="sec" data-h="2386"[^>]*data-cover[^>]*>/);
  assert.equal((html.match(/data-cover/g) || []).length, 1);
});
