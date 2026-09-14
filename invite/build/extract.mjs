// invite/build/extract.mjs — turn Canva's minified design blob into a model
// with names a person can read.
//
//   node invite/build/extract.mjs      # canva.json → model.json
//
// Key meanings were established against the rendered DOM; see the spec.
// Anything this file does not recognise is an error, not a guess.
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, isMain } from './lib.mjs';

export const PAGE_SLUGS = { 0: 'envelope', 3: 'home', 4: 'timeline', 5: 'mehendi', 6: 'nikah', 7: 'reception', 8: 'reception', 9: 'dress-code', b: 'timeline' };
const KINDS = { I: 'image', K: 'text', H: 'group', J: 'shape', O: 'embed' };
const WEIGHTS = { normal: 400, bold: 700, heavy: 900 };

export function resolveLink(href) {
  if (!href) return null;
  if (href.startsWith('#page-')) return `#${PAGE_SLUGS[href.slice(6)] || 'home'}`;
  return href;
}

function decodeAnim(x) {
  if (!x || x['A?'] !== 'B') return null;
  const p = x.B || {};
  return {
    effect: x.A,
    durationMs: p.G?.A != null ? Math.round(p.G.A / 1000) : null,
    params: { a: p.A ?? null, b: p.B ?? null, c: p.C ?? null, d: p.D ?? null, video: p.G?.C?.A ?? null },
  };
}

function decodeCrop(c, fallback) {
  if (!c) return { top: 0, left: 0, width: fallback.width, height: fallback.height };
  return { top: c.A || 0, left: c.B || 0, height: c.C ?? fallback.height, width: c.D ?? fallback.width };
}

function pickStyle(o) {
  const s = {};
  if (o.C) { const [font, idx] = o.C.split(','); s.font = font; s.styleIndex = Number(idx) || 0; }
  if (o.G) s.size = parseFloat(o.G);
  if (o.I) s.weight = WEIGHTS[o.I] || 400;
  if (o.K) s.italic = o.K === 'italic';
  if (o.M) s.color = o.M;
  if (o.O) s.decoration = o.O;
  if (o.Q) s.link = resolveLink(o.Q);
  if (o.W) s.letterSpacing = o.W;
  if (o.Y) s.lineHeight = o.Y;
  if (o.c) s.align = o.c;
  if (o['0']) s.transform = o['0'];
  return s;
}

function decodeTextBlock(t, lines) {
  const text = t.A.join('');
  const bounds = t.D || [0, text.length];
  const runs = [];
  let prev = { font: null, styleIndex: 0, size: 16, weight: 400, italic: false, color: '#000000', decoration: 'none', link: null, letterSpacing: null, lineHeight: null, align: 'center', transform: 'none' };
  for (let i = 0; i + 1 < bounds.length; i++) {
    prev = { ...prev, ...pickStyle(t.C[i] || {}) };
    runs.push({ start: bounds[i], end: bounds[i + 1], ...prev });
  }
  for (const r of runs) if (!r.font) throw new Error('text run without a font');
  return { text, lines: lines?.length ? lines : [text.length], runs };
}

function decodeElement(raw) {
  const kind = KINDS[raw['A?']];
  if (!kind) throw new Error(`unknown element kind ${raw['A?']} on ${raw._}`);
  const el = {
    id: raw._, kind,
    top: raw.A || 0, left: raw.B || 0, height: raw.C || 0, width: raw.D || 0,
    rotation: raw.E || 0, opacity: Math.round((1 - (raw.F || 0)) * 100) / 100,
    link: resolveLink(raw.G), anim: decodeAnim(raw.X),
  };
  if (kind === 'image') {
    // Stills keep their media under a.B, the one animated sticker (petals) under a.I.
    const still = raw.a?.B, video = raw.a?.I;
    if (still?.A?.A) { el.media = still.A.A; el.crop = decodeCrop(still.B, el); }
    else if (video?.A) { el.media = video.A; el.crop = decodeCrop(video.B, el); }
    else throw new Error(`image ${raw._} has no media`);
  } else if (kind === 'text') {
    Object.assign(el, decodeTextBlock(raw.a.C, raw.b?.A));
    el.effects = (raw.j?.A || []).map((e) => ({ type: e.A, ...e.B }));
  } else if (kind === 'group') {
    if (raw.z) {
      el.kind = 'embed';
      el.url = raw.c?.[0]?.a || '';
    } else {
      el.nativeWidth = raw.b || el.width;
      el.nativeHeight = raw.a || el.height;
      el.children = (raw.c || []).map((c) => decodeElement(c));
    }
  } else if (kind === 'shape') {
    el.viewBox = { width: raw.a?.D || el.width, height: raw.a?.C || el.height };
    el.paths = (raw.b || []).map((p) => ({
      d: p.A,
      fill: p.B?.A ? { media: p.B.B.A.A, crop: decodeCrop(p.B.B.B, el.viewBox) } : { color: p.B?.C || 'none' },
    }));
    const inner = raw.f?.[0]?.A?.C;
    if (inner && inner.A.join('').trim()) el.text = decodeTextBlock(inner);
  } else if (kind === 'embed') {
    el.url = raw.a || '';
  }
  return el;
}

// Axis-aligned bounds of a possibly rotated element box.
function bounds(el) {
  const r = (el.rotation * Math.PI) / 180;
  const cx = el.left + el.width / 2, cy = el.top + el.height / 2;
  const hw = (Math.abs(Math.cos(r)) * el.width + Math.abs(Math.sin(r)) * el.height) / 2;
  const hh = (Math.abs(Math.sin(r)) * el.width + Math.abs(Math.cos(r)) * el.height) / 2;
  return { left: cx - hw, top: cy - hh, right: cx + hw, bottom: cy + hh };
}

// The column the runtime fits to a phone: everything that is not a full-width
// bleed (backgrounds, the petals layer), clamped to the canvas so decorations
// hanging off the sides do not widen it.
export function contentBox(section) {
  const W = section.width;
  const bleeds = (b) => b.left <= 0 && b.right >= W;
  const boxes = section.elements.map(bounds).filter((b) => !bleeds(b))
    .map((b) => ({ left: Math.max(0, b.left), right: Math.min(W, b.right), top: Math.max(0, b.top), bottom: Math.min(section.height, b.bottom) }))
    .filter((b) => b.right > b.left && b.bottom > b.top);
  if (!boxes.length) return { left: 0, top: 0, width: W, height: section.height };
  const left = Math.min(...boxes.map((b) => b.left)), top = Math.min(...boxes.map((b) => b.top));
  const right = Math.max(...boxes.map((b) => b.right)), bottom = Math.max(...boxes.map((b) => b.bottom));
  return { left, top, width: right - left, height: bottom - top };
}

export function extractModel(canva) {
  const doc = canva.page;
  const published = doc.Z.g.map((r) => r.K);
  const byId = new Map(doc.A.A.map((p) => [p.a, p]));
  const pages = published.map((id) => {
    const p = byId.get(id);
    if (!p) throw new Error(`route ${id} has no page`);
    const slug = PAGE_SLUGS[p.P];
    if (!slug) throw new Error(`page ${p.P} "${p.B}" has no slug`);
    const page = { id: p.a, number: String(p.P), slug, title: p.B, sections: [] };
    for (const s of p.t) {
      const section = { width: s.C.A, height: s.C.B, background: s.D?.C || null, elements: s.E.map((e) => decodeElement(e)) };
      section.content = contentBox(section);
      page.sections.push(section);
    }
    return page;
  });
  const media = {};
  const LAYER_TYPES = { BACKGROUND_A: 'background-a', BACKGROUND_R: 'background-r', BACKGROUND_G: 'background-g', BACKGROUND_B: 'background-b', RECOLORABLE: 'recolor' };
  for (const m of doc.E) {
    const f = m.files[0];
    const prev = media[m.id];
    if (prev && prev.width >= f.width) continue;           // keep the largest variant
    const entry = { type: m.type === 'VECTOR' ? 'vector' : 'raster', url: f.url, width: f.width, height: f.height, mime: f.mimeType };
    if (f.spritesheet) {
      const meta = m.spritesheetMetadata;
      if (!meta) throw new Error(`spritesheet ${m.id} without metadata`);
      entry.sprites = { wide: meta.spritesWide, high: meta.spritesHigh, layers: meta.layers.map((l) => {
        const type = LAYER_TYPES[l.type];
        if (!type) throw new Error(`unknown sprite layer ${l.type} on ${m.id}`);
        return l.color ? { type, color: l.color } : { type };
      }) };
    }
    media[m.id] = entry;
  }
  for (const v of doc.F) {
    const f = v.files[v.files.length - 1];
    media[v.id] = { type: 'video', url: f.url, width: v.width, height: v.height, duration: v.durationSeconds, poster: v.posterframes?.[0]?.A || null };
  }
  const fonts = {};
  for (const f of doc.B) fonts[f.A] = { family: f.C, styles: f.D.map((s) => ({ style: s.style, url: s.files[0].url })) };
  return { pages, media, fonts };
}

if (isMain(import.meta.url)) {
  const canva = JSON.parse(fs.readFileSync(path.join(BUILD, 'canva.json'), 'utf8'));
  const model = extractModel(canva);
  fs.writeFileSync(path.join(BUILD, 'model.json'), JSON.stringify(model, null, 1));
  const count = (els) => els.reduce((n, e) => n + 1 + (e.children ? count(e.children) : 0), 0);
  for (const p of model.pages) console.log(`${p.slug.padEnd(11)} sections=${p.sections.length} elements=${p.sections.reduce((n, s) => n + count(s.elements), 0)}`);
}
