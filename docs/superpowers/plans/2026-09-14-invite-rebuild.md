# Invite Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Canva wedding invitation as static files under `invite/`, layer for layer, with per-element entrance animations recorded from the live Canva site, served at `https://misbahxareeb.us.com/invite/`.

**Architecture:** A build-time pipeline (`fetch → extract → assets → record → render`) turns Canva's embedded design JSON into `invite/index.html` + `invite/invite.css` + optimised `invite/assets/`. A small hand-written `invite/invite.js` handles hash routing, mobile scaling, reveal-on-scroll, lazy assets and the countdown.

**Tech Stack:** Node 24 (ESM `.mjs`, `node:test`), Playwright 1.62 (already in `node_modules`), ffmpeg-static 5.3 (already in `node_modules`, has `libwebp`, `libwebp_anim`, `libvpx-vp9`). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-13-invite-rebuild-design.md`

## Global Constraints

- Mobile first: every page must work at 390px wide with no horizontal scroll; desktop is the scaled-up case.
- Canvas width is always 1366 design px; all element coordinates are in design px.
- Decoded Canva keys (from the spec, verified): element `A?` kind (`I` image, `K` text, `H` group, `J` shape, `O` embed child), `A` top, `B` left, `C` height, `D` width, `E` rotation deg, `F` transparency (opacity = 1 − F), `_` id, `G` link on images, `X` animation (`{A?:'B', A: effectId, B: {…, G:{A: durationMicroseconds, C:{A: videoId}}}}`; `{A?:'A'}` = none). Image fill `a.B.A.A` media id, crop `a.B.B` `{A: top, B: left, C: height, D: width}`. Text `a.C.A` paragraphs, `a.C.C` style runs, `a.C.D` run boundaries, `b.A` characters per wrapped line, `j.A` text effects. Group `b` native width, `a` native height, `c` children (coordinates relative to group); group with `z` = embedded app (countdown). Shape `a` `{D: viewBox width, C: viewBox height}`, `b[]` `{A: path d, B: fill}` where fill is `{C: color}` or `{A: true, B: {A:{A: mediaId}, B: crop}}`.
- Page numbers (`page.P`) → slugs: `0` envelope, `3` home, `4` timeline, `5` mehendi, `6` nikah, `8` reception, `9` dress-code. Hidden pages `7` → reception, `b` → timeline. Any other `#page-N` → home. Published pages are those whose id appears in `page.Z.g[].K`.
- Site budget: all of `invite/` < 12 MB; envelope page assets < 1.5 MB.
- Countdown target: `2026-10-10T00:00:00+05:30`.
- Commit messages: plain prose subject, no conventional-commit prefixes (matches repo history), and end with the attribution trailer given in the session.
- Dev server for eyeballing: `http://localhost:8734/invite/` (already running, serves repo root).

## File map

| file | responsibility |
|---|---|
| `package.json` | scripts + pinned devDependencies (new) |
| `invite/build/fetch.mjs` | download Canva page, extract bootstrap blob → `canva.json` |
| `invite/build/extract.mjs` | `canva.json` → `model.json` with named keys |
| `invite/build/assets.mjs` | download + convert media/fonts → `invite/assets/`, `assets.json` |
| `invite/build/record.mjs` | Playwright recorder → `animations.json` |
| `invite/build/render.mjs` | model + assets + animations → `index.html`, `invite.css` |
| `invite/build/lib.mjs` | shared helpers (paths, geometry, run) |
| `invite/invite.js` | runtime |
| `test/invite/*.test.mjs` | `node --test test/invite/` |
| `test/invite/serve.mjs` | static server helper for browser tests |

---

### Task 1: Fetch the Canva design blob

**Files:**
- Create: `package.json`
- Create: `invite/build/lib.mjs`
- Create: `invite/build/fetch.mjs`
- Test: `test/invite/fetch.test.mjs`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `extractBootstrap(html: string): object` (throws `bootstrap blob not found`), `fetchSite(): Promise<string>`, constant `SITE`, and `invite/build/canva.json` on disk.
- `lib.mjs` produces `ROOT`, `BUILD`, `INVITE`, `ASSETS` absolute paths and `isMain(importMetaUrl)`.

- [ ] **Step 1: Create package.json and gitignore entry**

`package.json`:
```json
{
  "name": "save-the-date",
  "private": true,
  "type": "module",
  "scripts": {
    "invite:fetch": "node invite/build/fetch.mjs",
    "invite:extract": "node invite/build/extract.mjs",
    "invite:assets": "node invite/build/assets.mjs",
    "invite:record": "node invite/build/record.mjs",
    "invite:render": "node invite/build/render.mjs",
    "invite:build": "npm run invite:fetch && npm run invite:extract && npm run invite:assets && npm run invite:record && npm run invite:render",
    "test:invite": "node --test test/invite/"
  },
  "devDependencies": {
    "ffmpeg-static": "5.3.0",
    "playwright": "1.62.1"
  }
}
```

Append to `.gitignore`:
```
invite/build/cache/
test/invite/out/
```

Note `"type": "module"` makes `.js` files ESM too; `invite/invite.js` is browser code and never imported by Node, so this is harmless. Existing `test/*.mjs` are unaffected.

- [ ] **Step 2: Write lib.mjs**

```js
// invite/build/lib.mjs — paths and small helpers shared by the build scripts.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BUILD = path.dirname(fileURLToPath(import.meta.url));
export const INVITE = path.join(BUILD, '..');
export const ROOT = path.join(INVITE, '..');
export const ASSETS = path.join(INVITE, 'assets');
export const CACHE = path.join(BUILD, 'cache');

export const isMain = (url) => process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(url);

export const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
```

- [ ] **Step 3: Write the failing test**

`test/invite/fetch.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBootstrap } from '../../invite/build/fetch.mjs';

test('extracts the bootstrap blob from a Canva page', () => {
  const html = `<html><script>window['bootstrap'] = JSON.parse('{"page":{"A":{"A":[]}},"t":"it\\'s \\u00e9"}');</script></html>`;
  const data = extractBootstrap(html);
  assert.deepEqual(data.page.A.A, []);
  assert.equal(data.t, "it's é");
});

test('fails loudly when the blob is missing', () => {
  assert.throws(() => extractBootstrap('<html></html>'), /bootstrap blob not found/);
});
```

- [ ] **Step 4: Run it, expect failure**

Run: `node --test test/invite/fetch.test.mjs`
Expected: FAIL, `Cannot find module` for `fetch.mjs`.

- [ ] **Step 5: Write fetch.mjs**

```js
// invite/build/fetch.mjs — pull the published Canva site and keep its design blob.
//
//   node invite/build/fetch.mjs        # writes invite/build/canva.json
//
// The whole design (pages, elements, media, fonts) is serialised into one
// inline script on the page, so one GET is the entire "API".
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, CACHE, isMain } from './lib.mjs';

export const SITE = 'https://misbahareeb.my.canva.site/';

export function extractBootstrap(html) {
  const m = html.match(/window\['bootstrap'\] = JSON\.parse\('((?:[^'\\]|\\.)*)'\);/s);
  if (!m) throw new Error('bootstrap blob not found');
  // The blob is a JS single-quoted string literal. Let JS undo the escaping.
  const literal = new Function(`return '${m[1]}';`)();
  return JSON.parse(literal);
}

export async function fetchSite() {
  const res = await fetch(SITE, { headers: { 'user-agent': 'Mozilla/5.0 save-the-date build' } });
  if (!res.ok) throw new Error(`Canva answered ${res.status}`);
  return res.text();
}

if (isMain(import.meta.url)) {
  const html = await fetchSite();
  const data = extractBootstrap(html);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, 'site.html'), html);
  fs.writeFileSync(path.join(BUILD, 'canva.json'), JSON.stringify(data));
  console.log(`pages=${data.page.A.A.length} media=${data.page.E.length} videos=${data.page.F.length} fonts=${data.page.B.length}`);
}
```

- [ ] **Step 6: Run tests, expect pass**

Run: `node --test test/invite/fetch.test.mjs`
Expected: 2 passing.

- [ ] **Step 7: Run the fetch for real**

Run: `npm run invite:fetch`
Expected output: `pages=9 media=529 videos=3 fonts=18`. `invite/build/canva.json` exists (~1.1 MB).

- [ ] **Step 8: Commit**

```bash
git add package.json .gitignore invite/build/lib.mjs invite/build/fetch.mjs invite/build/canva.json test/invite/fetch.test.mjs
git commit -m "Pull the Canva invitation's design blob into the repo"
```

---

### Task 2: Extract a clean model

**Files:**
- Create: `invite/build/extract.mjs`
- Test: `test/invite/extract.test.mjs`

**Interfaces:**
- Produces: `extractModel(canva: object): Model` and `invite/build/model.json`.
- `Model` = `{ pages: Page[], media: {[id]: Media}, fonts: {[id]: Font} }`
- `Page` = `{ id, number, slug, title, sections: Section[] }`
- `Section` = `{ width: 1366, height, background: string|null, content: {left, top, width, height}, elements: Element[] }`
- `Element` common = `{ id, kind, top, left, width, height, rotation, opacity, link: string|null, anim: {effect, durationMs, params:{a,b,c,d,video}}|null }`
  - `kind: 'image'` adds `{ media, crop: {top, left, width, height} }`
  - `kind: 'text'` adds `{ text, lines: number[], runs: Run[], effects: [{type, ...}] }`, `Run = { start, end, font, styleIndex, size, weight, italic, color, decoration, link, letterSpacing, lineHeight, align, transform }`
  - `kind: 'group'` adds `{ nativeWidth, nativeHeight, children: Element[] }`
  - `kind: 'shape'` adds `{ viewBox: {width, height}, paths: [{ d, fill: {color} | {media, crop} }] }`
  - `kind: 'embed'` adds `{ url }`
- `Media` = `{ type: 'raster'|'video', url, width, height, duration?, poster? }` (url relative to `SITE`)
- `Font` = `{ family, styles: [{ style, url }] }`
- Also exports `resolveLink(href: string|undefined): string|null` and `PAGE_SLUGS`.

- [ ] **Step 1: Write the failing tests**

`test/invite/extract.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { extractModel, resolveLink } from '../../invite/build/extract.mjs';

const canva = JSON.parse(fs.readFileSync(new URL('../../invite/build/canva.json', import.meta.url)));
const model = extractModel(canva);
const page = (slug) => model.pages.find((p) => p.slug === slug);
const flat = (els) => els.flatMap((e) => (e.kind === 'group' ? [e, ...flat(e.children)] : [e]));

test('keeps exactly the seven published pages in route order', () => {
  assert.deepEqual(model.pages.map((p) => p.slug), ['envelope', 'home', 'timeline', 'mehendi', 'nikah', 'reception', 'dress-code']);
});

test('sections carry the 1366 canvas and their design height', () => {
  assert.deepEqual(page('home').sections.map((s) => [s.width, s.height]), [[1366, 1694], [1366, 1781], [1366, 871], [1366, 535]]);
});

test('decodes geometry with top/left/height/width in the right slots', () => {
  const el = page('envelope').sections[0].elements[12];
  assert.equal(el.kind, 'text');
  assert.equal(Math.round(el.top), 153);
  assert.equal(Math.round(el.left), 438);
  assert.equal(Math.round(el.width), 387);
  assert.equal(Math.round(el.height), 85);
  assert.equal(el.opacity, 1);
});

test('decodes text content, wrapped lines and the first style run', () => {
  const el = page('envelope').sections[0].elements[12];
  assert.equal(el.text, 'We are getting married !\n');
  assert.deepEqual(el.lines, [15, 10]);
  assert.equal(el.runs.length, 1);
  assert.equal(el.runs[0].font, 'YAFcf99lyzk');
  assert.equal(el.runs[0].size, 30.0004);
  assert.equal(el.runs[0].weight, 900);
  assert.equal(el.runs[0].color, '#715449');
  assert.equal(el.runs[0].transform, 'uppercase');
  assert.equal(el.runs[0].align, 'center');
});

test('resolves links on images, text runs and to external maps', () => {
  const envelope = page('envelope').sections[0].elements;
  assert.equal(envelope[4].link, '#home');
  assert.equal(envelope[11].runs[0].link, '#home');
  assert.equal(resolveLink('#page-4'), '#timeline');
  assert.equal(resolveLink('#page-7'), '#reception');
  assert.equal(resolveLink('#page-2'), '#home');
  assert.equal(resolveLink('https://maps.app.goo.gl/ZK5J5iDsTNpNdGEj8'), 'https://maps.app.goo.gl/ZK5J5iDsTNpNdGEj8');
  assert.equal(resolveLink(undefined), null);
});

test('decodes image crops and transparency', () => {
  const bg = page('envelope').sections[0].elements[0];
  assert.equal(bg.kind, 'image');
  assert.equal(bg.media, 'MAHUE4PPVlo');
  assert.equal(Math.round(bg.crop.top), -930);
  assert.equal(Math.round(bg.crop.left), 0);
  assert.equal(Math.round(bg.crop.width), 1657);
  assert.equal(Math.round(bg.crop.height), 2945);
  assert.equal(bg.opacity, 0.77);
});

test('decodes groups with relative children and the countdown embed', () => {
  const group = page('envelope').sections[0].elements[3];
  assert.equal(group.kind, 'group');
  assert.equal(group.children.length, 5);
  assert.equal(Math.round(group.nativeWidth), 450);
  const embed = flat(page('home').sections[2].elements).find((e) => e.kind === 'embed');
  assert.match(embed.url, /betterimages\.ai/);
});

test('decodes shapes with paths and image fills', () => {
  const strip = page('home').sections[0].elements[7];
  assert.equal(strip.kind, 'shape');
  assert.deepEqual(strip.viewBox, { width: 500, height: 2517.7 });
  assert.equal(strip.paths[0].fill.color, '#ffffff');
  assert.equal(strip.paths[1].fill.media, 'MAHULz87mAs');
});

test('decodes animations with effect id, duration and params', () => {
  const rise = page('home').sections[0].elements[3];
  assert.equal(rise.anim.effect, 8);
  assert.equal(rise.anim.durationMs, 1396);
  const still = page('home').sections[0].elements[0];
  assert.equal(still.anim, null);
});

test('resolves every media and font reference', () => {
  for (const p of model.pages) for (const s of p.sections) for (const e of flat(s.elements)) {
    if (e.kind === 'image') assert.ok(model.media[e.media], `media ${e.media} on ${e.id}`);
    if (e.kind === 'text') for (const r of e.runs) assert.ok(model.fonts[r.font], `font ${r.font} on ${e.id}`);
    if (e.kind === 'shape') for (const path of e.paths) if (path.fill.media) assert.ok(model.media[path.fill.media]);
  }
  assert.equal(model.media['VAFGRrnMAsY'].type, 'video');
});

test('computes a content box that excludes full-bleed backgrounds', () => {
  const c = page('envelope').sections[0].content;
  assert.ok(c.width > 400 && c.width < 600, `content width ${c.width}`);
  assert.ok(c.left > 300, `content left ${c.left}`);
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test test/invite/extract.test.mjs`
Expected: FAIL, cannot find `extract.mjs`.

- [ ] **Step 3: Write extract.mjs**

```js
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
    durationMs: p.G?.A ? Math.round(p.G.A / 1000) : null,
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
  let prev = { size: 16, weight: 400, italic: false, color: '#000000', align: 'center', transform: 'none' };
  for (let i = 0; i + 1 < bounds.length; i++) {
    prev = { ...prev, ...pickStyle(t.C[i] || {}) };
    runs.push({ start: bounds[i], end: bounds[i + 1], ...prev });
  }
  return { text, lines: lines?.length ? lines : [text.length], runs };
}

function decodeElement(raw, ctx) {
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
      el.children = (raw.c || []).map((c) => decodeElement(c, ctx));
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
      const section = { width: s.C.A, height: s.C.B, background: s.D?.C || null, elements: s.E.map((e) => decodeElement(e, { page: slug })) };
      section.content = contentBox(section);
      page.sections.push(section);
    }
    return page;
  });
  const media = {};
  for (const m of doc.E) {
    const f = m.files[0];
    media[m.id] = { type: 'raster', url: f.url, width: f.width, height: f.height, mime: f.mimeType };
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
```

- [ ] **Step 4: Run tests, expect pass**

Run: `node --test test/invite/extract.test.mjs`
Expected: all passing. If `decodes animations` fails on `durationMs`, print `page('home').sections[0].elements[3].anim` and adjust the assertion to the rounded value the data gives (the blob has `1395627.22` µs → `1396`).

- [ ] **Step 5: Produce model.json**

Run: `npm run invite:extract`
Expected: seven lines, e.g. `envelope    sections=1 elements=19`.

- [ ] **Step 6: Commit**

```bash
git add invite/build/extract.mjs invite/build/model.json test/invite/extract.test.mjs
git commit -m "Decode the Canva blob into a readable invitation model"
```

---

### Task 3: Download and optimise assets

**Files:**
- Create: `invite/build/assets.mjs`
- Test: `test/invite/assets.test.mjs`

**Interfaces:**
- Consumes: `model.json` (Task 2), `SITE` from `fetch.mjs`.
- Produces: files under `invite/assets/` and `invite/build/assets.json`:
  `{ media: {[id]: { src, width, height, kind: 'image'|'anim'|'video', poster? }}, fonts: {[`${fontId}-${styleIndex}`]: { family, src, weight, italic }} }` where `src` is relative to `invite/` (e.g. `assets/3f2a….webp`).
- Exports `usedMedia(model): Map<id, {maxWidth: number}>`, `planFonts(model): [{key, fontId, styleIndex, url, weight, italic, family}]`, `ffmpeg(args: string[]): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

`test/invite/assets.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { usedMedia, planFonts, styleToFace } from '../../invite/build/assets.mjs';

const model = JSON.parse(fs.readFileSync(new URL('../../invite/build/model.json', import.meta.url)));

test('collects every media id the published pages reference, with the widest use', () => {
  const used = usedMedia(model);
  assert.ok(used.has('MAHUE4PPVlo'), 'envelope background');
  assert.ok(used.has('VAFGRrnMAsY'), 'petals sticker');
  assert.ok(used.has('MAHULz87mAs'), 'photo strip fill inside a shape');
  assert.ok(used.get('MAHUE4PPVlo').maxWidth > 1500);
  for (const id of used.keys()) assert.ok(model.media[id], id);
});

test('plans one font face per (font, style index) actually used', () => {
  const faces = planFonts(model);
  const keys = faces.map((f) => f.key);
  assert.ok(keys.includes('YAFcf99lyzk-0'));
  assert.equal(new Set(keys).size, keys.length);
  for (const f of faces) assert.match(f.url, /^_assets\/fonts\//);
});

test('maps Canva style names onto weight and italic', () => {
  assert.deepEqual(styleToFace('REGULAR'), { weight: 400, italic: false });
  assert.deepEqual(styleToFace('BOLD'), { weight: 700, italic: false });
  assert.deepEqual(styleToFace('ITALICS'), { weight: 400, italic: true });
  assert.deepEqual(styleToFace('BOLD_ITALICS'), { weight: 700, italic: true });
  assert.deepEqual(styleToFace('LIGHT'), { weight: 300, italic: false });
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test test/invite/assets.test.mjs`
Expected: FAIL, cannot find `assets.mjs`.

- [ ] **Step 3: Write assets.mjs**

```js
// invite/build/assets.mjs — fetch the media the published pages use and shrink it.
//
//   node invite/build/assets.mjs                # writes invite/assets/*, invite/build/assets.json
//
// Raw downloads land in build/cache/ (gitignored) so re-runs only re-encode.
// Encoding goes through the ffmpeg already in node_modules: stills → WebP at
// no more than 2× their rendered width, the petals GIF → animated WebP (keeps
// alpha), the two effect MP4s → muted WebM.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { BUILD, ASSETS, CACHE, INVITE, isMain } from './lib.mjs';
import { SITE } from './fetch.mjs';

const run = promisify(execFile);
export const ffmpeg = async (args) => { await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args]); };

const STYLE_WEIGHTS = { THIN: 100, EXTRA_LIGHT: 200, LIGHT: 300, REGULAR: 400, MEDIUM: 500, SEMI_BOLD: 600, BOLD: 700, EXTRA_BOLD: 800, BLACK: 900, HEAVY: 900 };
export function styleToFace(style) {
  const italic = /ITALIC/.test(style);
  const base = style.replace(/_?ITALICS?$/, '') || 'REGULAR';
  return { weight: STYLE_WEIGHTS[base] ?? 400, italic };
}

const walk = (els, fn, scale = 1) => {
  for (const el of els) {
    fn(el, scale);
    if (el.kind === 'group') walk(el.children, fn, scale * (el.width / (el.nativeWidth || el.width)));
  }
};

export function usedMedia(model) {
  const used = new Map();
  const note = (id, width) => {
    const cur = used.get(id) || { maxWidth: 0 };
    cur.maxWidth = Math.max(cur.maxWidth, width);
    used.set(id, cur);
  };
  for (const p of model.pages) for (const s of p.sections) walk(s.elements, (el, k) => {
    if (el.kind === 'image') note(el.media, el.crop.width * k);
    if (el.kind === 'shape') for (const path of el.paths) if (path.fill.media) note(path.fill.media, (path.fill.crop.width / el.viewBox.width) * el.width * k);
    if (el.anim?.params.video) note(el.anim.params.video, el.width * k);
  });
  return used;
}

export function planFonts(model) {
  const seen = new Map();
  const add = (run) => {
    const key = `${run.font}-${run.styleIndex}`;
    if (seen.has(key)) return;
    const font = model.fonts[run.font];
    const style = font.styles[run.styleIndex] || font.styles[0];
    seen.set(key, { key, fontId: run.font, styleIndex: run.styleIndex, url: style.url, family: font.family, ...styleToFace(style.style) });
  };
  for (const p of model.pages) for (const s of p.sections) walk(s.elements, (el) => {
    if (el.kind === 'text') el.runs.forEach(add);
    if (el.kind === 'shape' && el.text) el.text.runs.forEach(add);
  });
  return [...seen.values()];
}

async function download(url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, url.replace(/[\/\\]/g, '_'));
  if (!fs.existsSync(file)) {
    const res = await fetch(SITE + url);
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

const hashName = (file, ext) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12) + ext;

async function encodeStill(src, maxWidth, naturalWidth) {
  const out = path.join(ASSETS, hashName(src, '.webp'));
  if (!fs.existsSync(out)) {
    const target = Math.min(naturalWidth, Math.ceil(maxWidth * 2));
    const vf = target < naturalWidth ? ['-vf', `scale=${target}:-2`] : [];
    await ffmpeg(['-i', src, ...vf, '-c:v', 'libwebp', '-quality', '88', '-compression_level', '6', out]);
  }
  return out;
}

async function encodeAnimated(src) {
  const out = path.join(ASSETS, hashName(src, '.webp'));
  if (!fs.existsSync(out)) await ffmpeg(['-i', src, '-vf', 'scale=800:-2', '-c:v', 'libwebp_anim', '-loop', '0', '-quality', '75', '-an', out]);
  return out;
}

async function encodeVideo(src) {
  const out = path.join(ASSETS, hashName(src, '.webm'));
  if (!fs.existsSync(out)) await ffmpeg(['-i', src, '-vf', 'scale=960:-2', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '36', '-an', out]);
  return out;
}

export async function buildAssets(model) {
  fs.mkdirSync(ASSETS, { recursive: true });
  const manifest = { media: {}, fonts: {} };
  for (const [id, use] of usedMedia(model)) {
    const m = model.media[id];
    const src = await download(m.url);
    let out, kind = 'image', poster = null;
    if (m.type === 'raster') out = await encodeStill(src, use.maxWidth, m.width);
    else if (m.url.endsWith('.gif')) { out = await encodeAnimated(src); kind = 'anim'; }
    else {
      out = await encodeVideo(src); kind = 'video';
      if (m.poster) poster = path.relative(INVITE, await encodeStill(await download(m.poster), use.maxWidth, m.width)).replace(/\\/g, '/');
    }
    manifest.media[id] = { src: path.relative(INVITE, out).replace(/\\/g, '/'), width: m.width, height: m.height, kind, ...(poster && { poster }) };
  }
  for (const face of planFonts(model)) {
    const src = await download(face.url);
    const out = path.join(ASSETS, 'fonts', hashName(src, path.extname(face.url).toLowerCase()));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (!fs.existsSync(out)) fs.copyFileSync(src, out);
    manifest.fonts[face.key] = { family: face.family, src: path.relative(INVITE, out).replace(/\\/g, '/'), weight: face.weight, italic: face.italic };
  }
  fs.writeFileSync(path.join(BUILD, 'assets.json'), JSON.stringify(manifest, null, 1));
  return manifest;
}

if (isMain(import.meta.url)) {
  const model = JSON.parse(fs.readFileSync(path.join(BUILD, 'model.json'), 'utf8'));
  const manifest = await buildAssets(model);
  const total = fs.readdirSync(ASSETS, { recursive: true }).reduce((n, f) => { const p = path.join(ASSETS, f); return n + (fs.statSync(p).isFile() ? fs.statSync(p).size : 0); }, 0);
  console.log(`media=${Object.keys(manifest.media).length} fonts=${Object.keys(manifest.fonts).length} assets=${(total / 1e6).toFixed(1)}MB`);
  if (total > 12e6) { console.error('assets exceed the 12 MB budget'); process.exit(1); }
}
```

- [ ] **Step 4: Run tests, expect pass**

Run: `node --test test/invite/assets.test.mjs`
Expected: 3 passing.

- [ ] **Step 5: Build the assets**

Run: `npm run invite:assets`
Expected: last line like `media=180 fonts=20 assets=7.4MB`, exit 0. Takes a few minutes the first time (downloads). If ffmpeg reports `Unknown encoder 'libwebp_anim'`, run `node_modules/ffmpeg-static/ffmpeg.exe -encoders | grep webp` and use whichever webp encoder is listed for the animated case.

- [ ] **Step 6: Spot-check the output**

Open `http://localhost:8734/invite/assets/` — Python's server lists the directory. Open two or three `.webp` files; the animated one should move. Note the total from Step 5 in the commit body.

- [ ] **Step 7: Commit**

```bash
git add invite/build/assets.mjs invite/build/assets.json invite/assets test/invite/assets.test.mjs
git commit -m "Fetch and shrink the invitation's media and fonts"
```

---

### Task 4: Record the entrance animations from the live site

Canva drives its entrance effects from JavaScript by writing inline `opacity`, `transform` and `filter` styles every frame; nothing is exposed through `getAnimations()`. So the recorder samples inline styles at 40 ms while each section scrolls into view, then matches sampled nodes back to model elements by their final `translate()` (which equals the element's `left/top`, plus the section's horizontal offset for top-level elements) and rotation.

**Files:**
- Create: `invite/build/record.mjs`
- Test: `test/invite/record.test.mjs`

**Interfaces:**
- Consumes: `model.json`, `SITE`.
- Produces: `invite/build/animations.json`: `{ [elementId]: { effect, startMs, durationMs, frames: [{ t, opacity, dx, dy, scale, blur, clip }] } }` — `t` in 0..1, `dx/dy` in design px relative to the final position, `scale` 1 at rest, `blur` px, `clip` a `clip-path` string or null. At most 20 frames per element, last frame always the resting state.
- Exports pure helpers `parseTransform(str): {x, y, rot, scale}`, `normalise(samples, t0): frames`, `matchElement(node, section, sectionLeft): Element|null`.

- [ ] **Step 1: Write the failing tests for the pure helpers**

`test/invite/record.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransform, normalise, matchElement } from '../../invite/build/record.mjs';

test('parses translate, rotate and scale out of an inline transform', () => {
  assert.deepEqual(parseTransform('translate(87.9885px, 63.8488px) rotate(-17.5069deg) scale(0.738, 0.738)'), { x: 87.9885, y: 63.8488, rot: -17.5069, scale: 0.738 });
  assert.deepEqual(parseTransform('translate(10px, 20px)'), { x: 10, y: 20, rot: 0, scale: 1 });
  assert.deepEqual(parseTransform(''), { x: 0, y: 0, rot: 0, scale: 1 });
});

test('normalises samples into frames relative to the resting state', () => {
  const samples = [
    { t: 1000, opacity: '0', transform: 'translate(100px, 280px)', filter: 'blur(24px)', clip: '' },
    { t: 1500, opacity: '0.5', transform: 'translate(100px, 240px)', filter: 'blur(12px)', clip: '' },
    { t: 2000, opacity: '', transform: 'translate(100px, 200px)', filter: '', clip: '' },
  ];
  const { startMs, durationMs, frames } = normalise(samples, 800);
  assert.equal(startMs, 200);
  assert.equal(durationMs, 1000);
  assert.deepEqual(frames[0], { t: 0, opacity: 0, dx: 0, dy: 80, scale: 1, blur: 24, clip: null });
  assert.deepEqual(frames.at(-1), { t: 1, opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0, clip: null });
});

test('caps frames at twenty, keeping first and last', () => {
  const samples = Array.from({ length: 60 }, (_, i) => ({ t: i * 40, opacity: String(i / 59), transform: `translate(0px, ${59 - i}px)`, filter: '', clip: '' }));
  const { frames } = normalise(samples, 0);
  assert.ok(frames.length <= 20);
  assert.equal(frames[0].dy, 59);
  assert.equal(frames.at(-1).dy, 0);
});

test('matches a sampled node to the element whose resting position it has', () => {
  const section = { elements: [
    { id: 'bg', kind: 'image', top: -302, left: -127, width: 1544, height: 2697, rotation: 0 },
    { id: 'gloves', kind: 'image', top: 176.17, left: 534.47, width: 410.1, height: 401.9, rotation: 0 },
    { id: 'grp', kind: 'group', top: 62.18, left: 439.64, width: 703, height: 793.8, rotation: 0, nativeWidth: 703, nativeHeight: 793.8,
      children: [{ id: 'ring', kind: 'image', top: 63.8488, left: 87.9885, width: 422, height: 533.4, rotation: -17.507 }] },
  ] };
  assert.equal(matchElement({ x: 534.47 + 589.5, y: 176.17, rot: 0 }, section, 589.5).id, 'gloves');
  assert.equal(matchElement({ x: 87.9885, y: 63.8488, rot: -17.5069 }, section, 589.5).id, 'ring');
  assert.equal(matchElement({ x: 5, y: 5, rot: 0 }, section, 589.5), null);
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test test/invite/record.test.mjs`
Expected: FAIL, cannot find `record.mjs`.

- [ ] **Step 3: Write record.mjs**

```js
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
      window.scrollTo(0, s.getBoundingClientRect().top + window.scrollY);
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
```

- [ ] **Step 4: Run tests, expect pass**

Run: `node --test test/invite/record.test.mjs`
Expected: 4 passing.

- [ ] **Step 5: Record one page and inspect**

Run: `node invite/build/record.mjs envelope`
Expected: `envelope    recorded=N unmatched=M` with N ≥ 8 and M small. Open `invite/build/animations.json`; each entry should have `frames[0].opacity` near 0 and `frames.at(-1)` equal to `{t:1, opacity:1, dx:0, dy:0, scale:1, blur:0, clip:null}`.

If N is 0: the sampler ran before Canva rendered. Raise the 1500 ms wait to 3000 ms and retry. If most nodes are unmatched: log `rest` and compare to `model.json` positions for that section; the horizontal offset is `sectionLeft` (0 at a 1366 viewport unless a scrollbar shifts it — subtract the measured value, which the code already does).

- [ ] **Step 6: Record every page**

Run: `npm run invite:record`
Expected: seven lines; total recorded ≥ 120 elements; unmatched per page ≤ 5. Note counts in the commit body.

- [ ] **Step 7: Commit**

```bash
git add invite/build/record.mjs invite/build/animations.json test/invite/record.test.mjs
git commit -m "Record each element's entrance animation from the live Canva page"
```

---

### Task 5: Render static HTML and CSS from the model

**Files:**
- Create: `invite/build/render.mjs`
- Create: `test/invite/serve.mjs`
- Test: `test/invite/render.test.mjs`
- Produces on disk: `invite/index.html`, `invite/invite.css`

**Interfaces:**
- Consumes: `model.json`, `assets.json`, `animations.json`.
- Produces: `render(model, assets, anims): { html: string, css: string }`; exports `renderElement(el, ctx): string`, `keyframeCss(name, frames): string`, `escapeHtml(s)`.
- Generated DOM contract (used by `invite.js` in Task 6 and the tests):
  - `main > section.page[id=<slug>][data-page=<slug>]`, envelope has class `active` in the HTML.
  - `section.page > div.sec[data-h][data-cl][data-cw] > div.stage` (stage is 1366 px wide, `transform-origin: 0 0`).
  - every element is `.el[data-id]`, absolutely positioned in design px; groups `.grp > .gin`; images `.img > img|video` with `src` on the envelope page and `data-src` elsewhere; animated ones carry classes `an k<n>` and `--dur`, `--del`; the countdown is `.cd` with `[data-cd=d|h|m|s]` slots.
- `test/invite/serve.mjs` exports `serve(): Promise<{ url, close }>` serving the repo root on an ephemeral port.

- [ ] **Step 1: Write the server helper**

`test/invite/serve.mjs`:
```js
// Static server over the repo root for the browser tests, ephemeral port.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json', '.webp': 'image/webp', '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webm': 'video/webm', '.mp4': 'video/mp4', '.woff': 'font/woff', '.woff2': 'font/woff2', '.m4a': 'audio/mp4', '.ics': 'text/calendar' };

export function serve() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    if (rel.endsWith('/')) rel += 'index.html';
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, body) => {
      if (err) { res.writeHead(404); res.end('not found'); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) });
  }));
}
```

- [ ] **Step 2: Write the failing tests**

`test/invite/render.test.mjs`:
```js
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
```

- [ ] **Step 3: Run, expect failure**

Run: `node --test test/invite/render.test.mjs`
Expected: FAIL, cannot find `render.mjs`.

- [ ] **Step 4: Write render.mjs**

```js
// invite/build/render.mjs — model + assets + recorded animations → index.html, invite.css.
//
//   node invite/build/render.mjs
//
// Every element is an absolutely positioned box in design pixels inside a
// 1366-wide .stage; invite.js scales the stage per section at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, INVITE, isMain, round as r } from './lib.mjs';

const TITLE = 'Misbah &amp; Areeb — Wedding Invitation';
const DESCRIPTION = 'Misbah &amp; Areeb invite you to celebrate their wedding. Mehfil-e-Mehendi 8 October, Nikah and Dawat-e-Khaas 10 October 2026, Mumbai.';
const COUNTDOWN_FACE = 'YAFcfiBZ5y0-0'; // Fry's Baskerville, the closest face to the Canva widget

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const attr = (v) => escapeHtml(v);
const px = (n) => `${r(n)}px`;

function baseStyle(el) {
  let s = `left:${px(el.left)};top:${px(el.top)};width:${px(el.width)};height:${px(el.height)};`;
  if (el.rotation) s += `--rot:${r(el.rotation, 3)}deg;`;
  if (el.opacity < 1) s += `--op:${el.opacity};`;
  return s;
}

function animAttrs(el, ctx) {
  const a = ctx.anims[el.id];
  if (!a || !a.frames?.length) return { cls: '', style: '' };
  const name = ctx.keyframeName(a.frames);
  return { cls: ` an ${name}`, style: `--dur:${a.durationMs}ms;--del:${Math.max(0, a.startMs - (ctx.sectionStart || 0))}ms;` };
}

function open(el, cls, ctx, extraStyle = '') {
  const an = animAttrs(el, ctx);
  const tag = el.link ? 'a' : 'div';
  const href = el.link ? ` href="${attr(el.link)}"${el.link.startsWith('#') ? '' : ' target="_blank" rel="noopener"'}` : '';
  return `<${tag}${href} class="el ${cls}${an.cls}" data-id="${attr(el.id)}" style="${baseStyle(el)}${an.style}${extraStyle}">`;
}
const close = (el) => (el.link ? '</a>' : '</div>');

function mediaTag(id, crop, ctx, extra = '') {
  const m = ctx.assets.media[id];
  if (!m) throw new Error(`no asset for media ${id}`);
  const style = `left:${px(crop.left)};top:${px(crop.top)};width:${px(crop.width)};height:${px(crop.height)};`;
  if (m.kind === 'video') {
    const src = ctx.eager ? `src="${m.src}"` : `data-src="${m.src}"`;
    return `<video ${src} autoplay muted loop playsinline${m.poster ? ` poster="${m.poster}"` : ''} style="${style}${extra}"></video>`;
  }
  const src = ctx.eager ? `src="${m.src}"` : `data-src="${m.src}" loading="lazy"`;
  return `<img ${src} width="${m.width}" height="${m.height}" alt="" decoding="async" style="${style}${extra}">`;
}

function textShadow(effects, size) {
  const out = [];
  for (const e of effects || []) {
    const rad = ((parseFloat(e.angle) || 0) * Math.PI) / 180;
    const off = (parseFloat(e.offset) || 0) * size;
    const dx = r(Math.cos(rad) * off), dy = r(Math.sin(rad) * off);
    if (e.type === 'shadow') out.push(`${dx}px ${dy}px ${r((parseFloat(e.blur) || 0) * size * 0.1)}px ${e.color || '#000'}`);
    if (e.type === 'lift') { const i = parseFloat(e.intensity) || 1; out.push(`0 ${r(0.05 * size)}px ${r(0.12 * size * i)}px rgba(0,0,0,${r(0.35 * i)})`); }
    if (e.type === 'echo') out.push(`${dx}px ${dy}px ${e.color || '#000'},${dx * 2}px ${dy * 2}px ${e.color || '#000'}80`);
  }
  return out.length ? `text-shadow:${out.join(',')};` : '';
}

function runStyle(run) {
  let s = `font-family:'f-${run.font}-${run.styleIndex}',serif;font-size:${px(run.size)};font-weight:${run.weight};font-style:${run.italic ? 'italic' : 'normal'};color:${run.color};`;
  if (run.letterSpacing) s += `letter-spacing:${run.letterSpacing};`;
  if (run.decoration && run.decoration !== 'none') s += `text-decoration:${run.decoration};`;
  if (run.transform && run.transform !== 'none') s += `text-transform:${run.transform};`;
  return s;
}

export function renderTextBlock(block, effects) {
  const first = block.runs[0] || {};
  const lines = [];
  let pos = 0;
  for (const count of block.lines) {
    const start = pos, end = pos + count; pos = end;
    let line = '';
    for (const run of block.runs) {
      const a = Math.max(start, run.start), b = Math.min(end, run.end);
      if (b <= a) continue;
      const piece = block.text.slice(a, b).replace(/\n$/, '');
      if (!piece) continue;
      const span = `<span style="${runStyle(run)}">${escapeHtml(piece)}</span>`;
      line += run.link ? `<a href="${attr(run.link)}">${span}</a>` : span;
    }
    lines.push(`<span class="ln">${line || '&nbsp;'}</span>`);
  }
  const style = `text-align:${first.align || 'center'};line-height:${first.lineHeight || '1.2em'};${textShadow(effects, first.size || 16)}`;
  return { style, html: lines.join('') };
}

export function renderElement(el, ctx) {
  if (el.kind === 'image') {
    const overlay = el.anim?.params.video && ctx.assets.media[el.anim.params.video]
      ? mediaTag(el.anim.params.video, { left: 0, top: 0, width: el.width, height: el.height }, ctx, 'mix-blend-mode:screen;pointer-events:none;')
      : '';
    return `${open(el, 'img', ctx)}${mediaTag(el.media, el.crop, ctx)}${overlay}${close(el)}`;
  }
  if (el.kind === 'text') {
    const { style, html } = renderTextBlock(el, el.effects);
    return `${open(el, 'txt', ctx, style)}${html}${close(el)}`;
  }
  if (el.kind === 'group') {
    const sx = r(el.width / (el.nativeWidth || el.width), 4), sy = r(el.height / (el.nativeHeight || el.height), 4);
    const inner = el.children.map((c) => renderElement(c, ctx)).join('');
    return `${open(el, 'grp', ctx)}<div class="gin" style="width:${px(el.nativeWidth)};height:${px(el.nativeHeight)};transform:scale(${sx},${sy})">${inner}</div>${close(el)}`;
  }
  if (el.kind === 'shape') {
    const { width: W, height: H } = el.viewBox;
    let defs = '', paths = '';
    el.paths.forEach((p, i) => {
      if (p.fill.media) {
        const m = ctx.assets.media[p.fill.media];
        if (!m) throw new Error(`no asset for media ${p.fill.media}`);
        const id = `p-${el.id}-${i}`;
        const c = p.fill.crop;
        defs += `<pattern id="${id}" patternUnits="userSpaceOnUse" x="0" y="0" width="${r(W)}" height="${r(H)}"><image href="${m.src}" x="${r(c.left)}" y="${r(c.top)}" width="${r(c.width)}" height="${r(c.height)}" preserveAspectRatio="none"/></pattern>`;
        paths += `<path d="${attr(p.d)}" fill="url(#${id})"/>`;
      } else {
        paths += `<path d="${attr(p.d)}" fill="${attr(p.fill.color)}"/>`;
      }
    });
    const text = el.text ? (() => { const t = renderTextBlock(el.text, []); return `<div class="stxt" style="${t.style}">${t.html}</div>`; })() : '';
    return `${open(el, 'shp', ctx)}<svg viewBox="0 0 ${r(W)} ${r(H)}" preserveAspectRatio="none">${defs ? `<defs>${defs}</defs>` : ''}${paths}</svg>${text}${close(el)}`;
  }
  if (el.kind === 'embed') {
    const unit = (u, label) => `<div class="cd-u"><b data-cd="${u}">00</b><i>${label}</i></div>`;
    // --cd is the box height in design px; the stage's scale() does the rest.
    return `${open(el, 'cd', ctx, `--cd:${px(el.height)};`)}<div class="cd-row">${unit('d', 'Days')}<em>:</em>${unit('h', 'Hours')}<em>:</em>${unit('m', 'Mins')}<em>:</em>${unit('s', 'Secs')}</div>${close(el)}`;
  }
  throw new Error(`cannot render kind ${el.kind} (${el.id})`);
}

export function keyframeCss(name, frames) {
  const stops = frames.map((f) => {
    let s = `${r(f.t * 100, 1)}%{opacity:calc(var(--op,1)*${f.opacity});transform:translate(${r(f.dx)}px,${r(f.dy)}px) rotate(var(--rot,0deg)) scale(${f.scale});filter:blur(${f.blur}px)`;
    if (frames.some((x) => x.clip)) s += `;clip-path:${f.clip || 'inset(0)'}`;
    return s + '}';
  });
  return `@keyframes ${name}{${stops.join('')}}`;
}

const BASE_CSS = `
html,body{margin:0;background:#f4efe8;overflow-x:hidden;-webkit-text-size-adjust:100%}
main{position:relative;min-height:100vh}
.page{display:none}.page.active{display:block}
.sec{position:relative;overflow:hidden;width:100%;height:var(--h)}
.stage{position:absolute;left:0;top:0;width:1366px;transform-origin:0 0}
.el{position:absolute;box-sizing:border-box;transform:rotate(var(--rot,0deg));opacity:var(--op,1)}
.img{overflow:hidden}.img>img,.img>video{position:absolute;max-width:none;display:block}
.txt{white-space:pre-wrap;overflow-wrap:break-word}.txt a{color:inherit;text-decoration:inherit}.ln{display:block}
a.el{display:block;text-decoration:none;color:inherit}
.grp>.gin{position:absolute;left:0;top:0;transform-origin:0 0}
.shp>svg{display:block;width:100%;height:100%;overflow:visible}.stxt{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center}
.el.an{opacity:0;animation-fill-mode:both;animation-timing-function:linear;animation-duration:var(--dur,800ms);animation-delay:var(--del,0ms)}
.cd{display:flex;align-items:center;justify-content:center;color:#4b3822;font-family:'f-${COUNTDOWN_FACE}',serif}
.cd-row{display:flex;align-items:flex-start;gap:.15em;font-size:calc(var(--cd,238px)*.27);font-weight:700;line-height:1}
.cd-u{display:flex;flex-direction:column;align-items:center;min-width:1.3em}.cd-u b{font-weight:700;font-variant-numeric:tabular-nums}
.cd-u i{font-style:normal;font-size:.22em;letter-spacing:.1em;text-transform:uppercase;margin-top:.5em}.cd-row em{font-style:normal}
`;

export function render(model, assets, anims) {
  const keyframes = new Map();
  const keyframeName = (frames) => {
    const key = JSON.stringify(frames);
    if (!keyframes.has(key)) keyframes.set(key, `k${keyframes.size + 1}`);
    return keyframes.get(key);
  };
  const sections = [];
  for (const page of model.pages) {
    const eager = page.slug === 'envelope';
    const secs = page.sections.map((s) => {
      const ids = new Set();
      const walk = (els) => els.forEach((e) => { ids.add(e.id); if (e.children) walk(e.children); });
      walk(s.elements);
      const starts = [...ids].map((id) => anims[id]?.startMs).filter((n) => n != null);
      const ctx = { assets, anims, eager, keyframeName, sectionStart: starts.length ? Math.min(...starts) : 0 };
      const bg = s.background ? `background:${s.background};` : '';
      const c = s.content;
      const els = s.elements.map((e) => renderElement(e, ctx)).join('\n');
      return `<div class="sec" data-h="${r(s.height)}" data-cl="${r(c.left)}" data-cw="${r(c.width)}" style="--h:${px(s.height)};${bg}"><div class="stage">\n${els}\n</div></div>`;
    });
    sections.push(`<section class="page${eager ? ' active' : ''}" id="${page.slug}" data-page="${page.slug}" aria-label="${attr(page.title)}">\n${secs.join('\n')}\n</section>`);
  }
  const faces = Object.entries(assets.fonts).map(([key, f]) => `@font-face{font-family:'f-${key}';src:url(${f.src}) format('${path.extname(f.src) === '.woff2' ? 'woff2' : 'woff'}');font-weight:${f.weight};font-style:${f.italic ? 'italic' : 'normal'};font-display:swap}`);
  const animations = [...keyframes.entries()].map(([k, name]) => `${keyframeCss(name, JSON.parse(k))}\n.${name}.in{animation-name:${name}}`);
  const css = [...faces, BASE_CSS.trim(), ...animations].join('\n');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}">
<meta name="googlebot" content="noindex,nofollow">
<meta name="bingbot" content="noindex,nofollow">
<meta name="theme-color" content="#f4efe8">
<meta property="og:type" content="website">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="Mehfil-e-Mehendi, Nikah and Dawat-e-Khaas — all the details.">
<meta property="og:url" content="https://misbahxareeb.us.com/invite/">
<meta property="og:image" content="https://misbahxareeb.us.com/og.png?v=2">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="invite.css">
</head>
<body>
<main>
${sections.join('\n')}
</main>
<noscript><style>.page{display:block}.el.an{opacity:var(--op,1);animation:none}</style></noscript>
<script src="invite.js" defer></script>
</body>
</html>
`;
  return { html, css };
}

if (isMain(import.meta.url)) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(BUILD, f), 'utf8'));
  const { html, css } = render(read('model.json'), read('assets.json'), fs.existsSync(path.join(BUILD, 'animations.json')) ? read('animations.json') : {});
  fs.writeFileSync(path.join(INVITE, 'index.html'), html);
  fs.writeFileSync(path.join(INVITE, 'invite.css'), css);
  console.log(`index.html ${(html.length / 1024).toFixed(0)}KB  invite.css ${(css.length / 1024).toFixed(0)}KB`);
}
```

- [ ] **Step 5: Run tests, expect pass**

Run: `node --test test/invite/render.test.mjs`
Expected: all passing. The browser test writes `invite/index.html` and `invite/invite.css` as a side effect; that is fine, `npm run invite:render` writes the same bytes.

- [ ] **Step 6: Render and eyeball at desktop width**

Run: `npm run invite:render`, then open `http://localhost:8734/invite/` in a browser. Without `invite.js` yet, the envelope page shows at 1366 px, animated elements are invisible (`.el.an{opacity:0}`) — that is expected until Task 6. Temporarily append `?` nothing; instead check in DevTools that `.stage` children have the model's positions.

- [ ] **Step 7: Commit**

```bash
git add invite/build/render.mjs invite/index.html invite/invite.css test/invite/serve.mjs test/invite/render.test.mjs
git commit -m "Render the invitation pages from the model as static HTML and CSS"
```

---

### Task 6: Runtime — router, scaler, reveal, lazy assets, countdown

**Files:**
- Create: `invite/invite.js`
- Test: `test/invite/runtime.test.mjs`

**Interfaces:**
- Consumes the DOM contract from Task 5.
- Behaviour: on load shows `location.hash.slice(1) || 'envelope'`; `hashchange` switches pages and scrolls to top; every `.sec` gets `height = data-h × k` and its `.stage` gets `transform: translate(tx, 0) scale(k)` where `k = clamp((innerWidth − 16) / data-cw, 0.25, 1)` and `tx = innerWidth/2 − (data-cl + data-cw/2) × k`; `.el.an` gets `.in` when it enters the viewport; `[data-src]` on the active page becomes `src`; `[data-cd]` slots tick every second toward `2026-10-10T00:00:00+05:30`.
- Exposes `window.__invite = { scale(), show(slug) }` for tests.

- [ ] **Step 1: Write the failing browser tests**

`test/invite/runtime.test.mjs`:
```js
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

test('renders 1:1 on a desktop with the content column centred', async () => {
  const { page } = await open(1500);
  const { k, left, cl, cw } = await page.evaluate(() => {
    const sec = document.querySelector('#envelope .sec');
    const st = sec.querySelector('.stage');
    const m = getComputedStyle(st).transform.match(/matrix\(([^,]+),/);
    return { k: parseFloat(m[1]), left: st.getBoundingClientRect().left, cl: +sec.dataset.cl, cw: +sec.dataset.cw };
  });
  assert.equal(k, 1);
  // Content box centred on the viewport (Canva centres the canvas on desktop; we centre the
  // content so narrow tablets never crop it — a 79 px shift at 1500 wide, accepted).
  assert.ok(Math.abs(left + cl + cw / 2 - 750) < 2, `left=${left} cl=${cl} cw=${cw}`);
  await page.close();
});

test('reveals animated elements once they are in view and loads lazy images on activation', async () => {
  const { page } = await open(390, '#home');
  await page.waitForTimeout(500);
  const seen = await page.evaluate(() => [...document.querySelectorAll('#home .el.an')].filter((e) => e.getBoundingClientRect().top < innerHeight).map((e) => e.classList.contains('in')));
  assert.ok(seen.length > 0 && seen.every(Boolean), `${seen.filter(Boolean).length}/${seen.length} in view got .in`);
  const lazy = await page.evaluate(() => ({ pending: document.querySelectorAll('#home img[data-src]').length, loaded: [...document.querySelectorAll('#home img')].filter((i) => i.currentSrc).length }));
  assert.equal(lazy.pending, 0);
  assert.ok(lazy.loaded > 5);
  const untouched = await page.evaluate(() => document.querySelectorAll('#timeline img[data-src]').length);
  assert.ok(untouched > 0, 'inactive pages stay lazy');
  await page.close();
});

test('the countdown ticks toward 10 October 2026 IST', async () => {
  const { page } = await open(390, '#home');
  await page.waitForTimeout(1100);
  const read = () => page.evaluate(() => ['d', 'h', 'm', 's'].map((u) => document.querySelector(`[data-cd="${u}"]`).textContent));
  const a = await read();
  await page.waitForTimeout(1100);
  const b = await read();
  assert.notDeepEqual(a, b, 'seconds should change');
  const expectedDays = Math.floor((Date.parse('2026-10-10T00:00:00+05:30') - Date.now()) / 86400000);
  assert.ok(Math.abs(Number(a[0]) - expectedDays) <= 1, `days ${a[0]} vs ${expectedDays}`);
  await page.close();
});
```

- [ ] **Step 2: Run, expect failure**

Run: `node --test test/invite/runtime.test.mjs`
Expected: FAIL — `.page.active` is `envelope` (from HTML) but hash switching, scaling (`k` NaN because no transform), lazy loading and countdown all fail.

- [ ] **Step 3: Write invite.js**

```js
// invite/invite.js — the little that has to happen in the browser.
//
// Everything visual is already in the HTML. This file only:
//   · shows one page at a time by hash (#envelope, #home, #timeline, …)
//   · scales each section so its content column fits the viewport (mobile first)
//   · adds .in to animated elements as they scroll into view
//   · swaps data-src → src for the page being shown
//   · ticks the countdown
(() => {
  'use strict';
  const DEFAULT = 'envelope';
  const TARGET = Date.parse('2026-10-10T00:00:00+05:30');
  const PAD = 8;
  const pages = [...document.querySelectorAll('.page')];
  const bySlug = (slug) => pages.find((p) => p.dataset.page === slug);

  // --- scaling -------------------------------------------------------------
  function scaleSection(sec) {
    const vw = document.documentElement.clientWidth;
    const cw = +sec.dataset.cw, cl = +sec.dataset.cl, h = +sec.dataset.h;
    const k = Math.min(1, Math.max(0.25, (vw - 2 * PAD) / cw));
    const tx = vw / 2 - (cl + cw / 2) * k;
    sec.style.height = `${h * k}px`;
    sec.querySelector('.stage').style.transform = `translate(${tx}px,0) scale(${k})`;
  }
  function scale() {
    const active = document.querySelector('.page.active');
    if (active) active.querySelectorAll('.sec').forEach(scaleSection);
  }

  // --- reveal ---------------------------------------------------------------
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      }, { threshold: 0.05 })
    : null;
  function watch(page) {
    page.querySelectorAll('.el.an:not(.in)').forEach((el) => (io ? io.observe(el) : el.classList.add('in')));
  }

  // --- lazy assets --------------------------------------------------------------
  function activate(page) {
    page.querySelectorAll('[data-src]').forEach((n) => { n.src = n.dataset.src; n.removeAttribute('data-src'); if (n.tagName === 'VIDEO') n.play?.().catch(() => {}); });
  }

  // --- routing ----------------------------------------------------------------------
  function show(slug) {
    const page = bySlug(slug) || bySlug(DEFAULT);
    if (!page) return;
    pages.forEach((p) => p.classList.toggle('active', p === page));
    activate(page);
    scale();
    window.scrollTo(0, 0);
    watch(page);
  }
  const current = () => decodeURIComponent(location.hash.slice(1)) || DEFAULT;

  // --- countdown ----------------------------------------------------------------------
  const slots = { d: document.querySelectorAll('[data-cd="d"]'), h: document.querySelectorAll('[data-cd="h"]'), m: document.querySelectorAll('[data-cd="m"]'), s: document.querySelectorAll('[data-cd="s"]') };
  function tick() {
    const left = Math.max(0, TARGET - Date.now());
    const v = { d: Math.floor(left / 864e5), h: Math.floor(left / 36e5) % 24, m: Math.floor(left / 6e4) % 60, s: Math.floor(left / 1e3) % 60 };
    for (const u in v) slots[u].forEach((n) => { n.textContent = String(v[u]).padStart(2, '0'); });
  }
  if (slots.s.length) { tick(); setInterval(tick, 1000); }

  // --- go -----------------------------------------------------------------------------
  window.addEventListener('hashchange', () => show(current()));
  window.addEventListener('resize', scale);
  show(current());
  window.__invite = { scale, show };
})();
```

- [ ] **Step 4: Run tests, expect pass**

Run: `node --test test/invite/runtime.test.mjs`
Expected: 5 passing. If the reveal test fails because elements above the fold never intersect (they are already in view when observed), IntersectionObserver still fires an initial callback for them; if it does not in headless, add after `watch(page)`: `requestAnimationFrame(() => page.querySelectorAll('.el.an:not(.in)').forEach((el) => { const r = el.getBoundingClientRect(); if (r.top < innerHeight && r.bottom > 0) el.classList.add('in'); }))`.

- [ ] **Step 5: Eyeball on the dev server**

Open `http://localhost:8734/invite/` on desktop and in DevTools device mode at 390 × 844. Click through envelope → home → For Details → each event → dress code → back. Note anything off in a scratch list; do not fix here unless it is a runtime bug.

- [ ] **Step 6: Commit**

```bash
git add invite/invite.js test/invite/runtime.test.mjs
git commit -m "Give the invitation its routing, scaling, reveals and countdown"
```

---

### Task 7: Layout assertions, reference diff and mobile shots

**Files:**
- Create: `test/invite/refs.mjs` (captures Canva references once)
- Create: `test/invite/shots.mjs` (mobile frames for eyeballing)
- Test: `test/invite/layout.test.mjs`
- Test: `test/invite/diff.test.mjs`

**Interfaces:**
- `refs.mjs` writes `test/invite/ref/<slug>.png` (full page, 1366 wide, after animations settle). Committed.
- `diff.test.mjs` compares `invite/` pages against those references with a coarse metric: both images downscaled with ffmpeg to 64 px wide raw RGB, mean absolute difference per channel must be < 13 (≈5% of 255).

- [ ] **Step 1: Capture references from Canva**

`test/invite/refs.mjs`:
```js
// One-off: full-page references of the Canva original at 1366 wide.
//   node test/invite/refs.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'ref');
const SITE = 'https://misbahareeb.my.canva.site/';
const PAGES = { envelope: 0, home: 3, timeline: 4, mehendi: 5, nikah: 6, reception: 8, 'dress-code': 9 };

fs.mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
for (const [slug, n] of Object.entries(PAGES)) {
  await page.goto(`${SITE}#page-${n}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  // Scroll through so every section's entrance animation has played, then back to top.
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y < h; y += 600) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(700); }
  await page.waitForTimeout(3000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.evaluate(() => document.querySelectorAll('footer, [class*="footer"]').forEach((f) => f.remove()));
  await page.screenshot({ path: path.join(OUT, `${slug}.png`), fullPage: true });
  console.log(slug, 'captured');
}
await browser.close();
```

Run: `node test/invite/refs.mjs`
Expected: seven PNGs in `test/invite/ref/`. Open two; they should look like the earlier walkthrough, fully revealed.

- [ ] **Step 2: Write the layout test**

`test/invite/layout.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const SLUGS = ['envelope', 'home', 'timeline', 'mehendi', 'nikah', 'reception', 'dress-code'];
const WIDTHS = [390, 768, 1366];
let browser, site;
test.before(async () => { browser = await chromium.launch(); site = await serve(); });
test.after(async () => { await browser.close(); await site.close(); });

for (const width of WIDTHS) for (const slug of SLUGS) {
  test(`${slug} at ${width}px: no overflow, no broken requests, content on screen`, async () => {
    const page = await browser.newPage({ viewport: { width, height: 844 } });
    const failed = [], errors = [];
    page.on('response', (r) => { if (r.status() >= 400) failed.push(r.url()); });
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${site.url}/invite/#${slug}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const secs = [...document.querySelectorAll('.page.active .sec')];
      const ks = secs.map((s) => parseFloat(getComputedStyle(s.querySelector('.stage')).transform.match(/matrix\(([^,]+),/)[1]));
      const content = secs.map((s) => { const k = parseFloat(getComputedStyle(s.querySelector('.stage')).transform.match(/matrix\(([^,]+),/)[1]); const st = s.querySelector('.stage').getBoundingClientRect(); return { left: st.left + (+s.dataset.cl) * k, right: st.left + (+s.dataset.cl + +s.dataset.cw) * k }; });
      return { scrollW: document.documentElement.scrollWidth, vw: document.documentElement.clientWidth, ks, content };
    });
    assert.equal(m.scrollW, m.vw, 'horizontal scroll');
    for (const k of m.ks) assert.ok(k >= 0.25 && k <= 1, `k=${k}`);
    for (const c of m.content) assert.ok(c.left >= -1 && c.right <= m.vw + 1, `content ${JSON.stringify(c)} outside ${m.vw}`);
    assert.deepEqual(failed, []);
    assert.deepEqual(errors, []);
    await page.close();
  });
}
```

Run: `node --test test/invite/layout.test.mjs`
Expected: 21 passing. A failure names the page, width and which rule broke; fix in `render.mjs`/`invite.js`, not in the test.

- [ ] **Step 3: Write the reference diff test**

`test/invite/diff.test.mjs`:
```js
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ffmpegPath from 'ffmpeg-static';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'out');
const SLUGS = ['envelope', 'home', 'timeline', 'mehendi', 'nikah', 'reception', 'dress-code'];
const run = promisify(execFile);

async function thumb(file, w, h) {
  const { stdout } = await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-i', file, '-vf', `scale=${w}:${h}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { encoding: 'buffer', maxBuffer: 1 << 24 });
  return stdout;
}
async function meanDiff(a, b) {
  // Both pages are forced to the same small size, so differing full-page heights only smear, not misalign.
  const w = 64, h = 512;
  const [x, y] = await Promise.all([thumb(a, w, h), thumb(b, w, h)]);
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += Math.abs(x[i] - y[i]);
  return sum / x.length;
}

let browser, site;
test.before(async () => { browser = await chromium.launch(); site = await serve(); fs.mkdirSync(OUT, { recursive: true }); });
test.after(async () => { await browser.close(); await site.close(); });

for (const slug of SLUGS) {
  test(`${slug} resembles the Canva original at 1366 wide`, async () => {
    const ref = path.join(HERE, 'ref', `${slug}.png`);
    assert.ok(fs.existsSync(ref), `run node test/invite/refs.mjs first`);
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 }, deviceScaleFactor: 1 });
    await page.goto(`${site.url}/invite/#${slug}`, { waitUntil: 'networkidle' });
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < h; y += 600) { await page.evaluate((y) => window.scrollTo(0, y), y); await page.waitForTimeout(400); }
    await page.waitForTimeout(2500);
    await page.evaluate(() => window.scrollTo(0, 0));
    const shot = path.join(OUT, `${slug}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    const d = await meanDiff(ref, shot);
    assert.ok(d < 13, `${slug}: mean channel difference ${d.toFixed(1)} (see test/invite/out/${slug}.png vs test/invite/ref/${slug}.png)`);
    await page.close();
  });
}
```

Run: `node --test test/invite/diff.test.mjs`
Expected: 7 passing. If one fails, open the two PNGs side by side; the usual causes are a section height mismatch (sections should be exactly the design heights at 1366) or a missing background. Fix in `render.mjs`.

- [ ] **Step 4: Write the mobile shots script**

`test/invite/shots.mjs`:
```js
// Phone-sized frames of every invite page for eyeballing.
//   node test/invite/shots.mjs          → test/shots/invite/<slug>-<n>.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const OUT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'shots', 'invite');
const SLUGS = ['envelope', 'home', 'timeline', 'mehendi', 'nikah', 'reception', 'dress-code'];
fs.mkdirSync(OUT, { recursive: true });
const site = await serve();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
for (const slug of SLUGS) {
  await page.goto(`${site.url}/invite/#${slug}`, { waitUntil: 'networkidle' });
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  let n = 0;
  for (let y = 0; y < h; y += 800) {
    await page.evaluate((y) => window.scrollTo(0, y), y);
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(OUT, `${slug}-${n++}.png`) });
  }
  console.log(slug, n, 'frames');
}
await browser.close();
await site.close();
```

Run: `node test/invite/shots.mjs`, then look through `test/shots/invite/` (gitignored via `test/shots/`). Compare with the phone: open `http://<your-LAN-ip>:8734/invite/` on a real phone as well — the python server binds to 127.0.0.1 only, so for the phone run `python -m http.server 8735 --bind 0.0.0.0 --directory C:\Users\Areeb\save-the-date` temporarily.

- [ ] **Step 5: Run the whole suite**

Run: `npm run test:invite`
Expected: every test passing (fetch 2, extract 10, assets 3, record 4, render 7, runtime 5, layout 21, diff 7).

- [ ] **Step 6: Commit**

```bash
git add test/invite/refs.mjs test/invite/ref test/invite/shots.mjs test/invite/layout.test.mjs test/invite/diff.test.mjs
git commit -m "Hold the invitation to the Canva original at three widths"
```

---

### Task 8: Fidelity pass and ship

**Files:**
- Modify: `invite/build/render.mjs`, `invite/invite.js`, `invite/build/record.mjs` as findings demand
- Modify: `docs/superpowers/specs/2026-09-13-invite-rebuild-design.md` (record deviations)

- [ ] **Step 1: Walk every page next to the original**

Open `https://misbahareeb.my.canva.site/` and `http://localhost:8734/invite/` side by side at desktop, then both in device mode at 390 wide. For each page write down: elements missing, wrong position, wrong font, animation that looks different (direction, speed, order). Limit the list to what a guest would notice.

- [ ] **Step 2: Fix each finding at its source**

Typical fixes and where they live:
- text wrapping differs → `renderTextBlock` in `render.mjs` (lines come from `el.lines`; check `b.A` in `canva.json` for that element)
- element order wrong → z-order is array order; check group nesting in `extract.mjs`
- animation direction/scale off → re-run `node invite/build/record.mjs <slug>` and inspect `animations.json` for that id; if the sampler missed the start, raise the settle wait in `recordPage`
- sparkle/effect-30 overlays look wrong → adjust `mix-blend-mode` or drop the overlay for that effect in `renderElement`
- countdown font/size → `.cd*` rules in `BASE_CSS`
- mobile scale too small/large → `PAD` and the 0.9 background threshold in `contentBox`

After each fix: `npm run invite:render && npm run test:invite`. Commit per finding with a one-line subject describing the visible change.

- [ ] **Step 3: Record deviations in the spec**

Append a `## As built` section to the spec listing: animated WebP used for stickers instead of video (alpha), woff kept rather than woff2, font list self-hosted from Canva's files, effect-30 approximation, measured `k` at 390 on the envelope page, final asset total.

- [ ] **Step 4: Budget and preview checks**

Run: `node -e "const fs=require('fs'),p='invite/assets';let t=0;for(const f of fs.readdirSync(p,{recursive:true})){const s=fs.statSync(p+'/'+f);if(s.isFile())t+=s.size}console.log((t/1e6).toFixed(1)+'MB')"`
Expected: < 12 MB.
Run: `node test/preview.mjs http://localhost:8734/invite/`
Expected: no complaints (the invite page carries the same crawler-safe noindex as the root page).

- [ ] **Step 5: Final commit and hand-off**

```bash
git status --short   # only intended files
npm run test:invite
git add -A invite docs test/invite
git commit -m "Ship the invitation under /invite"
```

Do not push. Report to the user: test counts, asset total, measured k at 390, the list of accepted deviations, and ask whether to push to `main` (GitHub Pages deploys from it, so pushing publishes `https://misbahxareeb.us.com/invite/`).

---

## Self-review

**Spec coverage.** Fetch/extract/assets/render pipeline → Tasks 1–3, 5. model.json shape → Task 2. Scaling rule with 0.25 floor → Task 6 (`PAD` 8 instead of 12; fine, documented in Task 8). Elements (image crop, real text, groups, shapes, z-order) → Task 5. Seven slugs + hash router + back button → Tasks 2, 6. Canva footer dropped → render never emits it. Assets (referenced only, ≤2× size, WebP, hash names, fonts with fallback stack, petals, budget, lazy per page) → Tasks 3, 5, 6, 8. Animations per element from recordings + fallback → Tasks 4, 5 (unrecorded elements simply have no `an` class, i.e. shown static; the spec's "fade+rise fallback" is dropped in favour of static — noted for Task 8's spec update). Countdown native → Tasks 5, 6. Failure handling (missing media throws, unknown kind throws) → Tasks 2, 3, 5. Tests at three widths, diff vs references, shots, build checks → Tasks 2, 7. No-JS fallback → `<noscript>` in Task 5.

**Placeholders.** None; every step has code or an exact command.

**Type consistency.** `Element.crop` is `{top,left,width,height}` in Task 2 and consumed as such in Tasks 3 and 5. `assets.json` shape (`media[id].{src,width,height,kind,poster}`, `fonts[key].{family,src,weight,italic}`) matches between Task 3 producer and Task 5 consumer. `animations.json` entries `{effect,startMs,durationMs,frames[]}` match between Tasks 4 and 5. `data-cl/data-cw/data-h` written in Task 5, read in Task 6 and 7. `serve()` from Task 5 used in Tasks 6 and 7.

