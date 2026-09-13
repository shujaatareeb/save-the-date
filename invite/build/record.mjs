// invite/build/record.mjs — watch the live Canva page animate and write down
// what every element did.
//
//   node invite/build/record.mjs             # all pages → build/animations.json
//   node invite/build/record.mjs envelope    # one page
//
// Canva animates by rewriting inline styles each frame. We sample those at
// 40 ms while each section scrolls into view, then hand each sampled node
// back to its model element by resting position and rotation.
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { BUILD, isMain, round } from './lib.mjs';
import { SITE } from './fetch.mjs';

const VIEWPORT = { width: 1366, height: 900 };
const SAMPLE_MS = 40;
const WATCH_MS = 6000;
const MAX_FRAMES = 20;

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

export function matchElement(node, section, sectionLeft) {
  let best = null, bestScore = 3;
  const consider = (el, x, y) => {
    const score = Math.abs(node.x - x) + Math.abs(node.y - y) + Math.abs(((node.rot || 0) - (el.rotation || 0)) % 360) * 0.5;
    if (score < bestScore) { best = el; bestScore = score; }
  };
  const visit = (els, nested) => {
    for (const el of els) {
      consider(el, nested ? el.left : el.left + sectionLeft, el.top);
      if (el.kind === 'group') visit(el.children, true);
    }
  };
  visit(section.elements, false);
  return best;
}

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

const COLLECT = `(() => {
  const S = window.__rec; clearInterval(S.timer);
  const sections = [...document.querySelectorAll('main section')];
  return S.nodes.filter(r => r.samples.length > 1).map(r => {
    const section = sections.findIndex(s => s.contains(r.el));
    return { section, samples: r.samples, isVideo: r.el.tagName === 'VIDEO' };
  });
})()`;

export async function recordPage(page, model, pageModel) {
  await page.goto(`${SITE}#page-${pageModel.number}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  const triggers = [];
  await page.evaluate(SAMPLER);
  const sectionLeft = await page.evaluate(() => document.querySelector('main section').getBoundingClientRect().left);
  const count = await page.evaluate(() => document.querySelectorAll('main section').length);
  for (let i = 0; i < count; i++) {
    const t = await page.evaluate((i) => {
      const s = document.querySelectorAll('main section')[i];
      // window.scrollTo is a no-op here: the page scrolls inside a nested
      // overflow:scroll container, not the window. scrollIntoView finds
      // whatever that real scrolling ancestor is.
      s.scrollIntoView({ block: 'start' });
      return Math.round(performance.now() - window.__rec.t0);
    }, i);
    triggers.push(t);
    await page.waitForTimeout(WATCH_MS);
  }
  const nodes = await page.evaluate(COLLECT);
  const out = {};
  const unmatched = [];
  for (const node of nodes) {
    if (node.isVideo || node.section < 0) continue;
    const section = pageModel.sections[node.section];
    if (!section) continue;
    const rest = parseTransform(node.samples.at(-1).transform);
    const el = matchElement(rest, section, sectionLeft);
    if (!el) { unmatched.push({ page: pageModel.slug, section: node.section, rest }); continue; }
    if (out[el.id] && out[el.id].frames.length >= node.samples.length) continue;
    out[el.id] = { effect: el.anim?.effect ?? null, ...normalise(node.samples, triggers[node.section]) };
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
    console.log(`${p.slug.padEnd(11)} recorded=${Object.keys(out).length} unmatched=${unmatched.length}`);
    for (const u of unmatched) console.log('  unmatched', JSON.stringify(u));
  }
  await browser.close();
  fs.writeFileSync(file, JSON.stringify(all, null, 1));
}
