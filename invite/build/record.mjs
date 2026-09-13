// invite/build/record.mjs — watch the live Canva page animate and write down
// what every element did.
//
//   node invite/build/record.mjs             # all pages → build/animations.json
//   node invite/build/record.mjs envelope    # one page
//
// Canva animates by rewriting inline styles each frame. We scroll the whole
// page in small steps while sampling those styles at 40 ms, then hand each
// sampled node back to its model element by resting position and rotation.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { BUILD, isMain, round } from './lib.mjs';
import { SITE } from './fetch.mjs';

const VIEWPORT = { width: 1366, height: 900 };
const SAMPLE_MS = 40;
const WATCH_MS = 6000;
const MAX_FRAMES = 20;
const STEP_PX = 450;
const STEP_WAIT_MS = 4000;
const TOLERANCE = 6;
const CLUSTER_GAP_MS = 1500;
const LOOP_TAIL_MS = 600;

export function parseTransform(str) {
  const num = (re, d) => { const m = str.match(re); return m ? parseFloat(m[1]) : d; };
  return { x: num(/translate\(\s*([-\d.e]+)px/, 0), y: num(/translate\([^,]+,\s*([-\d.e]+)px/, 0), rot: num(/rotate\(\s*([-\d.e]+)deg/, 0), scale: num(/scale\(\s*([-\d.e]+)/, 1) };
}

export function normalise(samples, triggerMs) {
  const rest = samples.at(-1);
  const restT = parseTransform(rest.transform);
  const startMs = samples[0].t - triggerMs;
  const durationMs = Math.max(1, rest.t - samples[0].t);
  const toFrame = (s) => {
    const tf = parseTransform(s.transform);
    return {
      t: round((s.t - samples[0].t) / durationMs, 3),
      opacity: s.opacity === '' ? 1 : round(parseFloat(s.opacity), 3),
      dx: round(tf.x - restT.x), dy: round(tf.y - restT.y),
      scale: round(tf.scale / (restT.scale || 1), 3),
      blur: round(parseFloat((s.filter.match(/blur\(([\d.]+)px/) || [])[1] || 0)),
      clip: s.clip || null,
    };
  };
  let picked = samples;
  if (samples.length > MAX_FRAMES) {
    const step = (samples.length - 1) / (MAX_FRAMES - 1);
    picked = Array.from({ length: MAX_FRAMES }, (_, i) => samples[Math.round(i * step)]);
  }
  const frames = picked.map(toFrame);
  frames[0].t = 0; frames[frames.length - 1].t = 1;
  return { startMs: Math.max(0, Math.round(startMs)), durationMs: Math.round(durationMs), frames };
}

function score(node, el, x, y) {
  const drot = Math.abs((((node.rot || 0) - (el.rotation || 0)) % 360));
  return Math.abs(node.x - x) + Math.abs(node.y - y) + Math.min(drot, 20) * 0.1;
}

// Best element in one section for a resting position; offsetY lets a section
// that Canva merged into a taller DOM container still match.
export function bestMatch(node, section, sectionLeft, offsetY = 0) {
  let best = { el: null, score: TOLERANCE };
  const visit = (els, nested) => {
    for (const el of els) {
      const xs = nested ? [el.left] : [el.left + sectionLeft];
      const ys = nested ? [el.top] : [el.top, el.top + offsetY];
      for (const x of xs) for (const y of ys) {
        const s = score(node, el, x, y);
        if (s < best.score) best = { el, score: s };
      }
      if (el.kind === 'group') visit(el.children, true);
    }
  };
  visit(section.elements, false);
  return best;
}

export function matchElement(node, section, sectionLeft) {
  return bestMatch(node, section, sectionLeft).el;
}

export function matchOnPage(node, pageModel, sectionLeft) {
  let best = { el: null, score: TOLERANCE, section: -1 }, offsetY = 0;
  pageModel.sections.forEach((section, i) => {
    const m = bestMatch(node, section, sectionLeft, offsetY);
    if (m.score < best.score) best = { ...m, section: i };
    offsetY += section.height;
  });
  return best;
}

// Start offsets relative to the first start in each burst of reveals.
export function clusterStarts(starts) {
  const order = starts.map((t, i) => [t, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(starts.length);
  let clusterStart = null, prev = null;
  for (const [t, i] of order) {
    if (clusterStart === null || t - prev > CLUSTER_GAP_MS) clusterStart = t;
    out[i] = t - clusterStart;
    prev = t;
  }
  return out;
}

const isLooping = (samples) => samples.length > 2 && samples.at(-1).t - samples.at(-2).t < LOOP_TAIL_MS && samples.at(-1).t > samples[0].t + 2000;

// Runs inside the page: sample inline styles of everything under <main>.
const SAMPLER = `(() => {
  const S = window.__rec = { nodes: [], byNode: new Map(), t0: performance.now() };
  const tick = () => {
    const now = performance.now() - S.t0;
    for (const el of document.querySelectorAll('main *')) {
      const st = el.style;
      if (!st.opacity && !st.transform && !st.filter && !st.clipPath) continue;
      let rec = S.byNode.get(el);
      if (!rec) { rec = { el, samples: [] }; S.byNode.set(el, rec); S.nodes.push(rec); }
      const s = { t: Math.round(now), opacity: st.opacity, transform: st.transform, filter: st.filter, clip: st.clipPath };
      const last = rec.samples.at(-1);
      if (!last || last.opacity !== s.opacity || last.transform !== s.transform || last.filter !== s.filter || last.clip !== s.clip) rec.samples.push(s);
    }
  };
  S.timer = setInterval(tick, ${SAMPLE_MS});
})()`;

const SCROLLER = `(() => {
  const all = [document.scrollingElement, ...document.querySelectorAll('body *')];
  return all.find(e => e && e.scrollHeight > e.clientHeight + 50 && e.clientHeight >= innerHeight * 0.6) ? true : false;
})()`;

// Playwright 1.62 ignores the arg when pageFunction is passed as a string, so
// the step size is baked into the source (same trick SAMPLER already uses
// for SAMPLE_MS) instead of passed at call time.
const SCROLL_STEP = `(() => {
  const all = [document.scrollingElement, ...document.querySelectorAll('body *')];
  const sc = all.find(e => e && e.scrollHeight > e.clientHeight + 50 && e.clientHeight >= innerHeight * 0.6) || document.scrollingElement;
  const before = sc.scrollTop;
  sc.scrollTop = before + ${STEP_PX};
  return { before, after: sc.scrollTop, max: sc.scrollHeight - sc.clientHeight };
})()`;

const COLLECT = `(() => {
  const S = window.__rec; clearInterval(S.timer);
  const anchorOf = (el) => {
    for (let p = el.parentElement; p && p.tagName !== 'MAIN'; p = p.parentElement) {
      if (p.style && /translate\\(/.test(p.style.transform || '')) return p.style.transform;
    }
    return null;
  };
  return S.nodes.filter(r => r.samples.length > 1).map(r => ({
    samples: r.samples, isVideo: r.el.tagName === 'VIDEO', anchor: anchorOf(r.el),
  }));
})()`;

export async function recordPage(page, model, pageModel) {
  await page.goto(`${SITE}#page-${pageModel.number}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);
  await page.evaluate(SAMPLER);
  const sectionLeft = await page.evaluate(() => document.querySelector('main section').getBoundingClientRect().left);
  await page.waitForTimeout(STEP_WAIT_MS);
  for (let guard = 0; guard < 40; guard++) {
    const { before, after } = await page.evaluate(SCROLL_STEP);
    if (after <= before) break;
    await page.waitForTimeout(STEP_WAIT_MS);
  }
  const nodes = await page.evaluate(COLLECT);

  // Direct match first; per-character spans (rest ≈ identity) fall back to their anchor.
  const matched = [];
  const unmatched = [];
  for (const node of nodes) {
    if (node.isVideo) continue;
    const rest = parseTransform(node.samples.at(-1).transform);
    let m = matchOnPage(rest, pageModel, sectionLeft);
    let viaAnchor = false;
    if (!m.el && node.anchor) { m = matchOnPage(parseTransform(node.anchor), pageModel, sectionLeft); viaAnchor = true; }
    if (!m.el) { unmatched.push({ page: pageModel.slug, rest, anchor: node.anchor }); continue; }
    matched.push({ el: m.el, node, viaAnchor, start: node.samples[0].t });
  }

  const starts = clusterStarts(matched.map((m) => m.start));
  const out = {};
  matched.forEach((m, i) => {
    const loop = isLooping(m.node.samples);
    // Reversing the array alone leaves absolute timestamps descending, which
    // sends normalise's durationMs negative (clamped to 1) and its t values
    // far outside 0..1. Negating t too keeps the array in ascending order
    // (so the duration/fraction math holds) while still landing the FIRST
    // original sample at samples.at(-1), i.e. normalise's "rest" reference.
    const samples = loop ? [...m.node.samples].reverse().map((s) => ({ ...s, t: -s.t })) : m.node.samples;
    const entry = { effect: m.el.anim?.effect ?? null, loop, ...normalise(samples, samples[0].t - starts[i]) };
    if (loop) entry.frames.reverse().forEach((f, k, arr) => { f.t = k === 0 ? 0 : k === arr.length - 1 ? 1 : f.t; });
    const prev = out[m.el.id];
    if (m.viaAnchor) {
      // merge per-character parts: earliest start wins, count and stagger recorded.
      // prev can already exist from a direct (non-anchor) match on the same
      // element id without .starts/.parts — initialise them rather than crash.
      if (!prev) { out[m.el.id] = { ...entry, parts: 1, starts: [m.start] }; }
      else {
        if (!prev.starts) prev.starts = [];
        prev.parts = (prev.parts || 0) + 1;
        prev.starts.push(m.start);
        if (m.start < Math.min(...prev.starts.slice(0, -1))) Object.assign(prev, entry, { parts: prev.parts, starts: prev.starts });
      }
    } else if (!prev || (prev.frames?.length ?? 0) < entry.frames.length) {
      out[m.el.id] = { ...entry, ...(prev?.parts && { parts: prev.parts, starts: prev.starts }) };
    }
  });
  for (const e of Object.values(out)) {
    if (e.starts) {
      const s = [...e.starts].sort((a, b) => a - b);
      const gaps = s.slice(1).map((t, i) => t - s[i]).sort((a, b) => a - b);
      e.stagger = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
      delete e.starts;
    }
  }
  return { out, unmatched };
}

if (isMain(import.meta.url)) {
  const model = JSON.parse(fs.readFileSync(path.join(BUILD, 'model.json'), 'utf8'));
  const only = process.argv[2];
  const file = path.join(BUILD, 'animations.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  for (const p of model.pages) {
    if (only && p.slug !== only) continue;
    const { out, unmatched } = await recordPage(page, model, p);
    Object.assign(all, out);
    const loopCount = Object.values(out).filter((e) => e.loop).length;
    const partsCount = Object.values(out).filter((e) => e.parts).length;
    console.log(`${p.slug.padEnd(11)} recorded=${Object.keys(out).length} unmatched=${unmatched.length} loop=${loopCount} parts=${partsCount}`);
    for (const u of unmatched) console.log('  unmatched', JSON.stringify(u));
  }
  await browser.close();
  fs.writeFileSync(file, JSON.stringify(all, null, 1));
}
