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

// Frames relative to the last sample, which is always treated as the resting
// state — including for a loop, so its "entrance" (if any) reads relative to
// where it settles rather than to wherever it happened to start.
export function normalise(samples, triggerMs) {
  const rest = samples.at(-1);
  const restT = parseTransform(rest.transform);
  const first = samples[0], last = samples.at(-1);
  const startMs = first.t - triggerMs;
  const durationMs = Math.max(1, last.t - first.t);
  const toFrame = (s) => {
    const tf = parseTransform(s.transform);
    return {
      t: round((s.t - first.t) / durationMs, 3),
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
  if (frames.length === 1) frames.push({ ...frames[0] });
  frames[0].t = 0; frames[frames.length - 1].t = 1;
  return { startMs: Math.max(0, Math.round(startMs)), durationMs: Math.round(durationMs), frames: distinctT(frames) };
}

// Over a long timeline two neighbouring samples can round to the same t (or
// onto an end's pinned 0 or 1); keep the first of each run so t is strictly
// increasing, and always keep both ends.
const distinctT = (frames) => frames.filter((f, i, arr) => i === 0 || i === arr.length - 1 || (f.t > arr[i - 1].t && f.t < 1));

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

// Every element of a page at absolute canvas coordinates. Group children are
// placed through their group (position + scale). `alt` carries the cumulative
// section offset for pages whose sections Canva merged into one container.
export function flattenPage(pageModel, sectionLeft) {
  const out = [];
  let offsetY = 0;
  pageModel.sections.forEach((section, si) => {
    const visit = (els, ox, oy, sx, sy) => {
      for (const el of els) {
        const x = ox + el.left * sx, y = oy + el.top * sy;
        out.push({ el, section: si, x: x + sectionLeft, y, alt: y + offsetY });
        if (el.kind === 'group') {
          const gsx = sx * (el.width / (el.nativeWidth || el.width)), gsy = sy * (el.height / (el.nativeHeight || el.height));
          visit(el.children, x, y, gsx, gsy);
        }
      }
    };
    visit(section.elements, 0, 0, 1, 1);
    offsetY += section.height;
  });
  return out;
}

export function matchAbsolute(abs, flat) {
  let best = null, bestScore = TOLERANCE;
  for (const c of flat) {
    const drot = Math.min(Math.abs(((abs.rot || 0) - (c.el.rotation || 0)) % 360), 20) * 0.1;
    for (const y of [c.y, c.alt]) {
      const s = Math.abs(abs.x - c.x) + Math.abs(abs.y - y) + drot;
      if (s < bestScore) { best = c; bestScore = s; }
    }
  }
  return best;
}

// Combine the nodes that animate one element into a single sample timeline.
// Each CSS property is taken from the node that varies it most.
export function mergeSamples(nodeSamples) {
  const props = ['opacity', 'transform', 'filter', 'clip'];
  const owner = {};
  for (const p of props) {
    let best = null, distinct = 1;
    for (const samples of nodeSamples) {
      const n = new Set(samples.map((s) => s[p])).size;
      if (n > distinct) { distinct = n; best = samples; }
    }
    owner[p] = best || nodeSamples[0];
  }
  const times = [...new Set(nodeSamples.flat().map((s) => s.t))].sort((a, b) => a - b);
  const at = (samples, p, t) => { let v = samples[0][p]; for (const s of samples) { if (s.t > t) break; v = s[p]; } return v; };
  return times.map((t) => ({ t, opacity: at(owner.opacity, 'opacity', t), transform: at(owner.transform, 'transform', t), filter: at(owner.filter, 'filter', t), clip: at(owner.clip, 'clip', t) }));
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

// abs is computed at collect time, when entrance effects are at rest; idle
// loops are off by their sway amplitude, which the tolerance absorbs.
const COLLECT = `(() => {
  const S = window.__rec; clearInterval(S.timer);
  const tr = (s) => { const m = /translate\\(\\s*([-\\d.e]+)px\\s*,\\s*([-\\d.e]+)px/.exec(s || ''); return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0]; };
  const rot = (s) => { const m = /rotate\\(\\s*([-\\d.e]+)deg/.exec(s || ''); return m ? parseFloat(m[1]) : 0; };
  const absOf = (el) => {
    let x = 0, y = 0, r = 0, depth = 0;
    for (let p = el; p && p.tagName !== 'MAIN'; p = p.parentElement, depth++) {
      const t = p.style && p.style.transform;
      if (t) { const [dx, dy] = tr(t); x += dx; y += dy; if (!r) r = rot(t); }
    }
    return { x, y, rot: r, depth };
  };
  return S.nodes.filter(r => r.samples.length > 1).map(r => ({
    samples: r.samples, isVideo: r.el.tagName === 'VIDEO', abs: absOf(r.el), tag: r.el.tagName,
  }));
})()`;

// Turn what COLLECT sampled into one animation entry per model element.
// Nodes are matched on absolute resting position (sum of translates up the
// ancestor chain) against the model flattened to absolute coordinates, then
// every node that lands on the same element is merged into one timeline.
export function assemble(nodes, pageModel, sectionLeft) {
  const flat = flattenPage(pageModel, sectionLeft);
  const byElement = new Map();
  const unmatched = [];
  for (const node of nodes) {
    if (node.isVideo) continue;
    const hit = matchAbsolute(node.abs, flat);
    if (!hit) { unmatched.push({ page: pageModel.slug, abs: node.abs, tag: node.tag }); continue; }
    if (!byElement.has(hit.el.id)) byElement.set(hit.el.id, { el: hit.el, nodes: [] });
    byElement.get(hit.el.id).nodes.push(node);
  }
  const entries = [...byElement.values()].map(({ el, nodes }) => {
    const starts = nodes.map((n) => n.samples[0].t).sort((a, b) => a - b);
    const isText = el.kind === 'text';
    // per-character reveals: many short-lived nodes on one text element → keep the earliest, note the stagger
    const parts = isText && nodes.length >= 3 ? nodes.length : 0;
    const merged = parts ? nodes.reduce((a, b) => (a.samples[0].t <= b.samples[0].t ? a : b)).samples : mergeSamples(nodes.map((n) => n.samples));
    const gaps = starts.slice(1).map((t, i) => t - starts[i]).sort((a, b) => a - b);
    return { el, samples: merged, start: starts[0], parts, stagger: parts ? gaps[Math.floor(gaps.length / 2)] || 0 : 0 };
  });
  const clustered = clusterStarts(entries.map((e) => e.start));
  const out = {};
  entries.forEach((e, i) => {
    const loop = isLooping(e.samples);
    const entry = { effect: e.el.anim?.effect ?? null, loop, ...normalise(e.samples, e.start - clustered[i]) };
    if (e.parts) { entry.parts = e.parts; entry.stagger = e.stagger; }
    out[e.el.id] = entry;
  });
  return { out, unmatched };
}

export async function recordPage(browser, model, pageModel) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  try {
    // Installed before any of the page's own scripts run, so sampling starts
    // at document start — nothing an early-firing entrance can miss.
    await page.addInitScript(SAMPLER);
    await page.goto(`${SITE}#page-${pageModel.number}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(STEP_WAIT_MS);
    const sectionLeft = await page.evaluate(() => document.querySelector('main section').getBoundingClientRect().left);
    for (let guard = 0; guard < 40; guard++) {
      const { before, after } = await page.evaluate(SCROLL_STEP);
      if (after <= before) break;
      await page.waitForTimeout(STEP_WAIT_MS);
    }
    const nodes = await page.evaluate(COLLECT);
    return assemble(nodes, pageModel, sectionLeft);
  } finally {
    await page.close();
  }
}

if (isMain(import.meta.url)) {
  const model = JSON.parse(fs.readFileSync(path.join(BUILD, 'model.json'), 'utf8'));
  const only = process.argv[2];
  const file = path.join(BUILD, 'animations.json');
  const all = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const browser = await chromium.launch();
  try {
    for (const p of model.pages) {
      if (only && p.slug !== only) continue;
      const { out, unmatched } = await recordPage(browser, model, p);
      Object.assign(all, out);
      // written after every page so an exception later on keeps what came before
      fs.writeFileSync(file, JSON.stringify(all, null, 1));
      const loopCount = Object.values(out).filter((e) => e.loop).length;
      const partsCount = Object.values(out).filter((e) => e.parts).length;
      console.log(`${p.slug.padEnd(11)} recorded=${Object.keys(out).length} unmatched=${unmatched.length} loop=${loopCount} parts=${partsCount}`);
      for (const u of unmatched) console.log('  unmatched', JSON.stringify(u));
    }
  } finally {
    await browser.close();
  }
}
