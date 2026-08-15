// Whether the music actually arrives, on a browser that enforces the autoplay
// policy the way a guest's browser does.
//
//   node test/music.mjs
//
// The policy is installed by this file rather than left to the browser. It has
// to be: measured on Chrome 140 and on the Chromium Playwright ships, the two
// do not agree, and the one that matters is the one nobody here runs.
//
//   real Chrome           new AudioContext() -> "suspended"
//                         resume() before a gesture -> a promise that never
//                         settles. Not rejected. Still pending after a real
//                         click, because the gesture does not retroactively
//                         settle a call made before it.
//
//   Playwright Chromium   new AudioContext() -> "running", even under
//                         --autoplay-policy=user-gesture-required. Web Audio is
//                         simply not gated there, so the branch that breaks the
//                         page on Chrome is never entered and any arrangement
//                         of this code passes.
//
// So BLOCKED_WEB_AUDIO below reproduces Chrome's half of that, and the element
// side is left to --autoplay-policy=user-gesture-required, which Chromium does
// honour. What is being asserted is the page's contract: given a context that
// starts suspended and a resume() that may never answer, the music still has to
// arrive on the first gesture, and the chip has to keep working.
//
// Two things are checked, because the page needs both and they fail separately:
// the element is playing, and every AudioContext it routes that element through
// is running. A suspended context between the element and the speakers is
// silence with a resolved play() promise behind it, which looks exactly like
// success from the element alone.
//
// Served over http rather than file:// for the same reason the other harnesses
// do it: the page taints its canvas under file:// and half of it stops working.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = 8736;

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

// Chrome's Web Audio autoplay policy, put back on a browser that has dropped
// it. Every context starts suspended and reports itself that way; resume()
// before the first gesture returns a promise that is never settled at all;
// resume() from a gesture onward does what it says. The native context
// underneath is left running so real audio still reaches a real clock — it is
// the policy that is being reproduced here, not the silence.
const BLOCKED_WEB_AUDIO = () => {
  const Native = window.AudioContext || window.webkitAudioContext;
  if (!Native) return;

  let activated = false;
  const onActivation = [];
  const activate = () => {
    if (activated) return;
    activated = true;
    for (const fn of onActivation.splice(0)) fn();
  };
  // Capture phase, so the page cannot get in front of it and so this sees the
  // gesture whether or not anything else does.
  for (const type of ['pointerdown', 'mousedown', 'touchstart', 'keydown']) {
    window.addEventListener(type, activate, { capture: true, passive: true });
  }

  const Blocked = new Proxy(Native, {
    construct(target, args) {
      const ctx = Reflect.construct(target, args);
      let allowed = false;

      // Every gain node the page builds, so the assertions can ask the one
      // question the element cannot answer: is any of this actually audible.
      const nativeGain = ctx.createGain.bind(ctx);
      ctx.createGain = () => {
        const g = nativeGain();
        (window.__gains || (window.__gains = [])).push(g);
        return g;
      };

      Object.defineProperty(ctx, 'state', {
        configurable: true,
        get: () => (allowed ? Reflect.get(Native.prototype, 'state', ctx) : 'suspended'),
      });

      const nativeResume = Native.prototype.resume.bind(ctx);
      Object.defineProperty(ctx, 'resume', {
        configurable: true,
        value: () => {
          const start = () => nativeResume().then(() => {
            allowed = true;
            ctx.dispatchEvent(new Event('statechange'));
          });
          if (activated) return start();
          // The pending promise Chrome hands back, including the part where the
          // gesture that follows does not settle it.
          onActivation.push(start);
          return new Promise(() => {});
        },
      });

      (window.__contexts || (window.__contexts = [])).push(ctx);
      return ctx;
    },
  });

  window.AudioContext = Blocked;
  if (window.webkitAudioContext) window.webkitAudioContext = Blocked;
};

const sound = () => {
  const m = document.getElementById('music');
  const contexts = window.__contexts || [];
  const gains = window.__gains || [];
  return {
    paused: m.paused,
    currentTime: m.currentTime,
    readyState: m.readyState,
    error: m.error && m.error.code,
    contexts: contexts.map((c) => c.state),
    // Whichever of the two carries the level: the gain node once the graph is
    // up, the element's own volume before that.
    level: gains.length ? Math.max(...gains.map((g) => g.gain.value)) : m.volume,
  };
};

// Playing means the clock is moving, not merely that `paused` went false —
// a stalled element reports both.
const playing = (a, b) => !b.paused && b.currentTime > a.currentTime;
// Audible means a running context AND a level that has come up off the floor.
// Music playing into a gain still sitting at 0 is silence that passes every
// other check on this page.
const audible = (s) => s.contexts.every((state) => state === 'running') && s.level > 0.1;

async function observe(page, forSeconds = 5) {
  const deadline = Date.now() + forSeconds * 1000;
  let first = await page.evaluate(sound);
  let last = first;
  while (Date.now() < deadline) {
    await page.waitForTimeout(250);
    last = await page.evaluate(sound);
    if (playing(first, last) && audible(last)) return { first, last, ok: true };
  }
  return { first, last, ok: false };
}

const browser = await chromium.launch({
  args: ['--autoplay-policy=user-gesture-required'],
});

const failures = [];
const report = (name, ok, detail) => {
  if (!ok) failures.push(`${name}: ${detail}`);
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name.padEnd(46)} ${detail}`);
};

const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(BLOCKED_WEB_AUDIO);
const page = await context.newPage();
await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
await page.waitForTimeout(600);

// Before any gesture nothing is expected to be playing. This is not the bug —
// it is the policy, and it is what the gesture fallback exists to answer.
const before = await page.evaluate(sound);
report('silent before a gesture', before.paused === true, `paused=${before.paused}`);

// And nothing is wired up yet either. A context built on an untouched page is
// born suspended, and an element routed into a suspended context is stuck in a
// way no later gesture reliably undoes — so the graph has to wait.
report(
  'builds no audio graph before a gesture',
  before.contexts.length === 0,
  `contexts=[${before.contexts}]`,
);

// The gesture. A guest's first touch is nearly always the seal or the scratch;
// the backdrop is the same event with nothing else attached to it.
await page.mouse.click(200, 700);
const first = await observe(page);
report(
  'plays after the first gesture',
  first.ok,
  `paused=${first.last.paused} currentTime=${first.last.currentTime.toFixed(2)} level=${first.last.level.toFixed(2)} contexts=[${first.last.contexts}]`,
);

// The ramp is 1.2s, and the check above passes the moment the level leaves the
// floor. It also has to arrive.
await page.waitForTimeout(1800);
const full = await page.evaluate(sound);
report('comes up to full level', full.level > 0.5, `level=${full.level.toFixed(2)}`);

// The chip is the only way back from a mute, so a mute that cannot be undone
// is worse than no chip.
await page.click('#sound');
await page.waitForTimeout(700);
await page.click('#sound');
const again = await observe(page);
report(
  'comes back after mute and unmute',
  again.ok,
  `paused=${again.last.paused} currentTime=${again.last.currentTime.toFixed(2)} level=${again.last.level.toFixed(2)} contexts=[${again.last.contexts}]`,
);

await context.close();
await browser.close();
server.close();

if (failures.length) {
  console.error('\n' + failures.length + ' failing:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nthe music arrives, and it is audible when it does');
