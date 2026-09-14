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

### Task 9: Composite Canva's vector spritesheets

Added during execution. 46 of the 529 media entries are `type: "VECTOR"`; 22 of those in use on published pages are *spritesheets*: one PNG holding N sprites side by side (`spritesheetMetadata.spritesWide × spritesHigh`), each sprite a grayscale mask for one layer. Rendered raw they are black rectangles (17 elements across envelope, home, timeline, nikah, reception). Verified live against the envelope's gold glitter: a sprite's luminance is the layer's alpha; `RECOLORABLE` layers are filled with their `color`; `BACKGROUND_R/G/B` sprites give the base image's channels and `BACKGROUND_A` its alpha (an `A` alone is treated as black with that alpha). Layers composite in order. Each media id also appears up to three times in `page.E` (800 / 1600 / 2400 px variants) — the declared `width × height` is the size of ONE sprite, and the PNG is `wide × width` by `high × height`.

Runs after Task 5 and before Task 6.

**Files:**
- Modify: `invite/build/extract.mjs` (media table)
- Modify: `invite/build/assets.mjs` (composite step)
- Test: `test/invite/extract.test.mjs`, `test/invite/assets.test.mjs`
- Regenerate: `invite/build/model.json`, `invite/build/assets.json`, `invite/assets/`, `invite/index.html`, `invite/invite.css`

**Interfaces:**
- `model.media[id]` gains `type: 'vector'` and, for spritesheets, `sprites: { wide, high, layers: [{ type: 'background-a'|'background-r'|'background-g'|'background-b'|'recolor', color?: 'rgb(r, g, b)' }] }`. When an id appears several times, the entry with the largest `width` wins (explicitly, not by array order).
- `assets.mjs` exports `spriteRect(sheetWidth, sheetHeight, wide, high, k) → {x, y, w, h}` and `compositeSheet(pngPath, sprites, outPath): Promise<void>` (Playwright canvas). Manifest `media[id].width/height` become the composite's (one sprite's) dimensions.

- [ ] **Step 1: Failing tests**

Append to `test/invite/extract.test.mjs`:
```js
test('keeps the largest variant of a media id and carries spritesheet layers', () => {
  const m = model.media['MAG66LCSz84'];
  assert.equal(m.type, 'vector');
  assert.equal(m.width, 2400);
  assert.deepEqual(m.sprites.layers[0], { type: 'background-a' });
  assert.deepEqual(m.sprites.layers[1], { type: 'recolor', color: 'rgb(250, 249, 216)' });
  assert.equal(m.sprites.wide, 6);
  assert.equal(m.sprites.high, 1);
  assert.equal(model.media['MAHKwKua_Z8'].sprites, undefined);
});
```
Append to `test/invite/assets.test.mjs`:
```js
import { spriteRect } from '../../invite/build/assets.mjs';
test('locates sprite k in a wide-by-high sheet', () => {
  assert.deepEqual(spriteRect(14400, 1585, 6, 1, 2), { x: 4800, y: 0, w: 2400, h: 1585 });
  assert.deepEqual(spriteRect(2400, 218, 3, 2, 4), { x: 800, y: 109, w: 800, h: 109 });
});
test('spritesheet media are shipped as single composited images', () => {
  const m = manifest.media['MAG66LCSz84'];
  assert.match(m.src, /\.webp$/);
  assert.ok(m.width <= 2400 && m.height <= 1585 && Math.abs(m.width / m.height - 2400 / 1585) < 0.01, JSON.stringify(m));
});
```
Run both files; expect the new tests to fail.

- [ ] **Step 2: extract.mjs media table**

Replace the `for (const m of doc.E)` loop with:
```js
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
```

- [ ] **Step 3: assets.mjs composite step**

Add:
```js
import { chromium } from 'playwright';

export function spriteRect(sheetWidth, sheetHeight, wide, high, k) {
  const w = sheetWidth / wide, h = sheetHeight / high;
  return { x: (k % wide) * w, y: Math.floor(k / wide) * h, w, h };
}

// Runs in a browser page: luminance of each sprite is that layer's alpha.
const COMPOSITE = async ({ dataUrl, sprites }) => {
  const img = new Image(); img.src = dataUrl; await img.decode();
  const W = img.naturalWidth / sprites.wide, H = img.naturalHeight / sprites.high;
  const out = document.createElement('canvas'); out.width = W; out.height = H; const ctx = out.getContext('2d');
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; const t = tmp.getContext('2d');
  const read = (k) => { t.clearRect(0, 0, W, H); t.drawImage(img, (k % sprites.wide) * W, Math.floor(k / sprites.wide) * H, W, H, 0, 0, W, H); return t.getImageData(0, 0, W, H); };
  const channels = {};
  sprites.layers.forEach((l, k) => { if (l.type.startsWith('background-')) channels[l.type.slice(-1)] = read(k).data; });
  if (channels.a) {
    const d = t.createImageData(W, H), p = d.data;
    for (let i = 0; i < p.length; i += 4) { p[i] = channels.r ? channels.r[i] : 0; p[i + 1] = channels.g ? channels.g[i] : 0; p[i + 2] = channels.b ? channels.b[i] : 0; p[i + 3] = channels.a[i]; }
    t.putImageData(d, 0, 0); ctx.drawImage(tmp, 0, 0);
  }
  sprites.layers.forEach((l, k) => {
    if (l.type !== 'recolor') return;
    const [r, g, b] = l.color.match(/\d+/g).map(Number);
    const d = read(k), p = d.data;
    for (let i = 0; i < p.length; i += 4) { const lum = p[i]; p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = lum; }
    t.putImageData(d, 0, 0); ctx.drawImage(tmp, 0, 0);
  });
  return out.toDataURL('image/png');
};

let browserPromise = null;
export async function compositeSheet(pngPath, sprites, outPath) {
  browserPromise ||= chromium.launch();
  const page = await (await browserPromise).newPage();
  try {
    const dataUrl = `data:image/png;base64,${fs.readFileSync(pngPath).toString('base64')}`;
    const result = await page.evaluate(COMPOSITE, { dataUrl, sprites });
    fs.writeFileSync(outPath, Buffer.from(result.split(',')[1], 'base64'));
  } finally { await page.close(); }
}
export async function closeCompositor() { if (browserPromise) { await (await browserPromise).close(); browserPromise = null; } }
```
In `buildAssets`, for `m.type === 'raster' || m.type === 'vector'` stills: if `m.sprites`, first `const flat = path.join(CACHE, path.basename(src, '.png') + '.composite.png'); if (!fs.existsSync(flat)) await compositeSheet(src, m.sprites, flat);` then `encodeStill(flat, use.maxWidth, m.width)`. Manifest `width/height` for sprites = `m.width`, `m.height` (already the sprite size). Call `await closeCompositor()` before writing the manifest. Keep the SVG passthrough for `image/svg+xml`.

- [ ] **Step 4: Regenerate and verify**

`npm run invite:extract && rm -rf invite/assets && npm run invite:assets && npm run invite:render`, then `node --test test/invite/extract.test.mjs test/invite/assets.test.mjs test/invite/render.test.mjs`. Open `http://localhost:8734/invite/`: the gold glitter around CLICK TO OPEN must be gold glitter, not a black box; check the same on `#home` (7 elements) and `#timeline` (5). Budgets still hold (the asset script exits non-zero otherwise).

- [ ] **Step 5: Commit**

```bash
git add invite/build/extract.mjs invite/build/assets.mjs invite/build/model.json invite/build/assets.json invite/assets invite/index.html invite/invite.css test/invite/extract.test.mjs test/invite/assets.test.mjs
git commit -m "Composite Canva's vector spritesheets into real images"
```

---

### Task 10: Processed media and per-element recolours

Added during execution. Two more facts from the blob, both verified on the envelope page:

- 57 image elements carry a second media id under `a.B.I` — the *processed* version Canva actually displays (background removed, effects applied). Using `a.B.A` shows the raw photo (the envelope with its table backdrop, the wax seal on a white square).
- 12 elements carry a recolour map under `a.B.C`, e.g. `{"#d3a100": "#be817c"}`: palette colours of a vector graphic replaced per element. 7 are spritesheets (their layer colours, including the implicit black of a lone `background-a`, go through the map), 5 are SVGs (fill colours in the file go through the map). Without it the CLICK TO OPEN ribbon is maroon instead of purple.

Runs after Task 9 and before Task 6.

**Files:**
- Modify: `invite/build/extract.mjs`, `invite/build/assets.mjs`, `invite/build/render.mjs`
- Test: `test/invite/extract.test.mjs`, `test/invite/assets.test.mjs`, `test/invite/render.test.mjs`
- Regenerate: `model.json`, `assets.json`, `invite/assets/`, `index.html`, `invite.css`

**Interfaces:**
- Image elements: `media` = `a.B.I.A` when present else `a.B.A.A`; new optional `recolor: { [fromHex]: toHex }` (only when non-empty; keys and values lower-case `#rrggbb`).
- `assets.mjs` exports `assetKey(mediaId, recolor)` → `mediaId` when no recolour, else `mediaId + '@' + first 8 hex of sha1(JSON of the map with sorted keys)`. `usedMedia` and the manifest are keyed by `assetKey`; `render.mjs` looks media up through the same function (import it).
- Exports `applyRecolor(color: 'rgb(r, g, b)'|'#rrggbb', map) → '#rrggbb'` and `recolorSvg(svgText, map) → string`.

- [ ] **Step 1: Failing tests**

`test/invite/extract.test.mjs`:
```js
test('prefers the processed media and carries per-element recolours', () => {
  const els = page('envelope').sections[0].elements;
  assert.equal(els[4].media, 'MAHUFZUveVY');                       // background-removed envelope
  assert.deepEqual(els[7].recolor, { '#000000': '#715449' });
  assert.equal(els[0].recolor, undefined);
});
```
`test/invite/assets.test.mjs`:
```js
import { assetKey, applyRecolor, recolorSvg } from '../../invite/build/assets.mjs';
test('asset keys separate recoloured variants', () => {
  assert.equal(assetKey('MAG66LCSz84', undefined), 'MAG66LCSz84');
  const k = assetKey('MAG66LCSz84', { '#d3a100': '#be817c' });
  assert.match(k, /^MAG66LCSz84@[0-9a-f]{8}$/);
  assert.equal(k, assetKey('MAG66LCSz84', { '#D3A100': '#BE817C' }));
});
test('recolours layer colours and svg fills through the map', () => {
  assert.equal(applyRecolor('rgb(211, 161, 0)', { '#d3a100': '#be817c' }), '#be817c');
  assert.equal(applyRecolor('rgb(1, 2, 3)', { '#d3a100': '#be817c' }), '#010203');
  assert.equal(recolorSvg('<path fill="#EEBAD5"/><path style="fill:#eebad5"/>', { '#eebad5': '#e8e0d3' }), '<path fill="#e8e0d3"/><path style="fill:#e8e0d3"/>');
});
test('the manifest carries a recoloured variant for the ribbon', () => {
  const key = Object.keys(manifest.media).find((k) => k.startsWith('MAHStM-bLg0@') || /@/.test(k));
  assert.ok(key, 'no recoloured variant in manifest');
});
```
`test/invite/render.test.mjs`: in the "renders images inside a crop frame" test add `assert.match(eager, /assets\/[a-f0-9]+\.webp/)` unchanged, and a new assertion that the envelope's element `LBq7bt3xrnV5lSC1` (recoloured spritesheet) renders an `<img>` whose `src` equals `assets.media[assetKey('<its media>', {'#000000':'#715449'})].src` — import `assetKey` in the test.

Run the three files; expect the new tests to fail.

- [ ] **Step 2: extract.mjs**

In the image branch:
```js
    const still = raw.a?.B, video = raw.a?.I;
    if (still?.A?.A) {
      el.media = still.I?.A || still.A.A;
      el.crop = decodeCrop(still.B, el);
      const map = still.C && Object.keys(still.C).length ? still.C : null;
      if (map) el.recolor = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]));
    } else if (video?.A) { … unchanged … }
```

- [ ] **Step 3: assets.mjs**

```js
export function assetKey(mediaId, recolor) {
  if (!recolor || !Object.keys(recolor).length) return mediaId;
  const canon = JSON.stringify(Object.fromEntries(Object.entries(recolor).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]).sort()));
  return `${mediaId}@${crypto.createHash('sha1').update(canon).digest('hex').slice(0, 8)}`;
}
const toHex = (c) => {
  if (c.startsWith('#')) return c.toLowerCase();
  const [r, g, b] = c.match(/\d+/g).map(Number);
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
};
export function applyRecolor(color, map) { const hex = toHex(color); return (map && map[hex]) || hex; }
export function recolorSvg(svg, map) {
  return svg.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => map[hex.toLowerCase()] || hex);
}
```
`usedMedia(model)` now records `used.set(assetKey(el.media, el.recolor), { media: el.media, recolor: el.recolor || null, maxWidth })` (shape fills and anim videos have no recolour: key = media id). `buildAssets` iterates these entries; for spritesheets pass the map into the composite (layer colours via `applyRecolor(l.color, map)`, and the lone `background-a` base uses `applyRecolor('#000000', map)` instead of black); for SVGs with a map write `recolorSvg(text, map)` to a variant file named by content hash; cache composites as `<source>.<key hash>.composite.png` so variants do not collide. Manifest `media[key]`.

- [ ] **Step 4: render.mjs**

`import { assetKey } from './assets.mjs';` and in `renderElement`'s image branch resolve `ctx.assets.media[assetKey(el.media, el.recolor)]`; `mediaTag` takes the resolved key. Everything else unchanged.

- [ ] **Step 5: Regenerate, verify, commit**

`npm run invite:extract && rm -rf invite/assets && npm run invite:assets && npm run invite:render`, then `node --test test/invite/*.test.mjs` (only the `invite.js` 404 may fail). Eyeball `http://localhost:8734/invite/` with the console snippet from Task 9: envelope cut out cleanly, wax seal round, ribbon purple. Commit: `Show the processed media and honour per-element recolours`.

---

### Task 11: Split entrance and idle phases of looping animations

Added during execution. Idle effects (sway, breathe) were recorded as `loop: true` and normalised against the FIRST sample, so when an element also slides in first, its "loop" includes the entrance: the divider parks 387 px left, the ribbon 208 px right. Fix: normalise every entry against its resting (last) sample, and let the renderer split a looping entry into a one-shot entrance followed by an infinite alternating idle.

Runs after Task 10 and before Task 6.

**Files:**
- Modify: `invite/build/record.mjs`, `invite/build/render.mjs`
- Test: `test/invite/record.test.mjs`, `test/invite/render.test.mjs`
- Regenerate: `animations.json`, `index.html`, `invite.css`

**Interfaces:**
- `record.mjs`: `normaliseLoop` removed; `assemble` uses `normalise(samples, trigger)` for every entry; `loop` flag kept.
- `render.mjs` exports `splitLoop(frames) → { entrance: Frame[] | null, idle: Frame[] | null }`: `entrance` = frames from 0 up to and including the settle index `i` (first index such that every later frame is within 3 px / 3 % opacity / scale 0.01 / blur 0 of the last frame), re-timed to 0..1, or `null` when `i === 0`; `idle` = frames from `i` to the end re-timed to 0..1, or `null` when fewer than 3 frames or invisible by the ruling-4 filter measured against its own last frame. CSS per looping element: entrance keyframes `kN` (once, fill both) then idle keyframes `kNi` starting at `--del + --dur` with `animation-iteration-count: infinite; animation-direction: alternate; animation-fill-mode: forwards` (no backwards fill, so it cannot pre-empt the entrance). Element gets `--idur:<idle ms>`.

- [ ] **Step 1: Failing tests**

`test/invite/record.test.mjs`: change the loop test to assert `normalise` (not `normaliseLoop`) on the oscillating sample set gives `frames.at(-1)` at rest and `frames[0].dy === 20` when the first sample sits 20 px above the last; remove the `normaliseLoop` import.
`test/invite/render.test.mjs`:
```js
import { splitLoop } from '../../invite/build/render.mjs';
test('splits a recorded loop into its entrance and its idle sway', () => {
  const f = (t, dy, op = 1) => ({ t, opacity: op, dx: 0, dy, scale: 1, blur: 0, clip: null });
  const frames = [f(0, 80, 0), f(0.1, 40, 0.5), f(0.2, 0), f(0.4, 2), f(0.6, -2), f(0.8, 2), f(1, 0)];
  const { entrance, idle } = splitLoop(frames);
  assert.deepEqual(entrance.map((x) => [x.t, x.dy]), [[0, 80], [0.5, 40], [1, 0]]);
  assert.equal(idle.length, 5); assert.equal(idle[0].t, 0); assert.equal(idle.at(-1).t, 1);
  assert.equal(splitLoop([f(0, 2), f(0.5, -2), f(1, 0)]).entrance, null);
  assert.equal(splitLoop([f(0, 80, 0), f(1, 0)]).idle, null);
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
```

- [ ] **Step 2: record.mjs**

Delete `normaliseLoop`; in `assemble` use `normalise(e.samples, e.start - clustered[i])` for all entries; keep `loop: isLooping(e.samples)`. Re-run `npm run invite:record` (all pages) and confirm with the monotonic one-liner from Task 4 that it still prints 0, and that every entry's last frame is `dx:0, dy:0, scale:1, blur:0`.

- [ ] **Step 3: render.mjs**

```js
const close = (a, b) => Math.abs(a.dx - b.dx) + Math.abs(a.dy - b.dy) <= 3 && Math.abs(a.opacity - b.opacity) <= 0.03 && Math.abs(a.scale - b.scale) <= 0.01 && a.blur === b.blur;
const retime = (frames) => { const t0 = frames[0].t, span = frames.at(-1).t - t0 || 1; return frames.map((f, i) => ({ ...f, t: i === 0 ? 0 : i === frames.length - 1 ? 1 : r((f.t - t0) / span, 3) })); };
export function splitLoop(frames) {
  const rest = frames.at(-1);
  let i = frames.length - 1;
  while (i > 0 && close(frames[i - 1], rest)) i--;
  const entrance = i > 0 ? retime(frames.slice(0, i + 1).map((f, k, arr) => (k === arr.length - 1 ? { ...rest, t: f.t } : f))) : null;
  const tail = frames.slice(i);
  const idle = tail.length >= 3 && !isInvisibleFrames(tail) ? retime(tail) : null;
  return { entrance, idle };
}
```
where `isInvisibleFrames` is the existing ruling-4 check factored to take a frame array. In the per-element animation resolution: non-loop → as today; loop → `splitLoop`; if both parts exist emit `kN` (entrance) and `kNi` (idle, keyframes with the idle frames), element style adds `--idur:${idleMs}ms` where `idleMs = durationMs × (1 − settleFraction)` and `--dur` becomes the entrance's share; class rule `.kN.in{animation-name:kN,kNi;animation-duration:var(--dur),var(--idur);animation-delay:var(--del),calc(var(--del) + var(--dur));animation-iteration-count:1,infinite;animation-direction:normal,alternate;animation-fill-mode:both,forwards;animation-timing-function:linear,ease-in-out}`. If only idle: `.kNi.in{animation-name:kNi;animation-iteration-count:infinite;animation-direction:alternate;…}` with `--dur` = idle duration. If only entrance: as a non-loop entry. Remove the old `.el.an.loop.in` rule and the `loop` class.

- [ ] **Step 4: Regenerate, verify, commit**

`npm run invite:render`, `node --test test/invite/*.test.mjs`. Eyeball: with the console snippet, the divider sits centred under the ribbon and the ribbon over the envelope, both gently swaying. Commit: `Play recorded loops as an entrance followed by an idle sway`.

---

### Task 12: Hidden sections and the real text model

Added during execution, from the Task 7 diff failures. Three decoding gaps in `extract.mjs`:

- Sections carry the same hidden flag as pages: `R: true` means Canva does not render them (Timeline has two; we rendered a duplicate "Wedding Events" block).
- Text runs: `a.C.D` is a list of run **lengths** (`[0, 8, 1, 6, 1]` for `"Misbah \n" "&\n" "Areeb\n"`), not boundaries; run 0 has length 0 and carries the base style; later `a.C.C[i]` entries are deltas (string keys override, boolean keys mean "same as previous"). Reading them as boundaries produced `Misbah ` + `isbah`.
- Text lines: `b.A` may be empty (`Wedding\nTimeline`), in which case the paragraphs in `a.C.A` are the lines.
- Text scale: `e`/`f` are the text's natural width/height at the declared font size; Canva scales the block to the box (`D / e`), e.g. "Days left until our Wedding" is declared at 25 px and shown at ×5.03.
- Superscript runs: style keys `6` (font-size factor, e.g. `0.6em`) and `8` (baseline shift, e.g. `0.43em`) mark the `th` in `10th`.

**Files:** modify `invite/build/extract.mjs`; test `test/invite/extract.test.mjs`; regenerate `model.json`.

**Interfaces:**
- `Section` objects for hidden sections are dropped (`page.sections` shrinks; Timeline goes from 3 to 1).
- Text element gains `naturalWidth: number|null`, `naturalHeight: number|null`; `runs[]` gain `super: boolean` (true when key `6` or `8` present) and are built from cumulative lengths; zero-length runs are dropped; `lines` falls back to paragraph lengths (`a.C.A.map(p => p.length)`) when `b.A` is empty.

- [ ] **Step 1: Failing tests** (append to `test/invite/extract.test.mjs`)
```js
test('drops sections Canva hides and keeps the rest in order', () => {
  assert.equal(page('timeline').sections.length, 1);
  assert.equal(page('home').sections.length, 4);
});
test('reads multi-run text as cumulative run lengths with delta styles', () => {
  const names = flat(page('home').sections[1].elements).find((e) => e.kind === 'text' && e.text.startsWith('Misbah'));
  assert.equal(names.text, 'Misbah \n&\nAreeb\n');
  assert.deepEqual(names.runs.map((r) => [r.start, r.end]), [[0, 8], [8, 9], [9, 15], [15, 16]]);
  assert.deepEqual(names.lines, [8, 2, 6]);
  for (const r of names.runs) assert.equal(r.font, names.runs[0].font);
});
test('falls back to paragraphs when Canva stored no wrapped lines', () => {
  const title = flat(page('timeline').sections[0].elements).find((e) => e.kind === 'text' && e.text.startsWith('Wedding'));
  assert.deepEqual(title.lines, [8, 10]);
});
test('carries the natural text size and superscript runs', () => {
  const days = flat(page('home').sections[2].elements).find((e) => e.kind === 'text' && /Days left/.test(e.text));
  assert.ok(Math.abs(days.naturalWidth - 186) < 2, String(days.naturalWidth));
  const date = flat(page('home').sections[1].elements).find((e) => e.kind === 'text' && /10th October/.test(e.text));
  const sup = date.runs.find((r) => date.text.slice(r.start, r.end) === 'th');
  assert.equal(sup.super, true);
  assert.equal(date.runs[0].super, false);
});
```

- [ ] **Step 2: extract.mjs**

In `extractModel`, filter sections: `for (const s of p.t) { if (s.R === true) continue; … }`.

Replace `decodeTextBlock`:
```js
function decodeTextBlock(t, lines, natural) {
  const text = t.A.join('');
  const lengths = t.D || [text.length];
  const runs = [];
  let prev = { font: null, styleIndex: 0, size: 16, weight: 400, italic: false, color: '#000000', decoration: 'none', link: null, letterSpacing: null, lineHeight: null, align: 'center', transform: 'none', super: false };
  let pos = 0;
  lengths.forEach((len, i) => {
    const delta = t.C[i] || {};
    prev = { ...prev, ...pickStyle(delta), super: Boolean(delta['6'] || delta['8']) };
    if (len > 0) runs.push({ start: pos, end: pos + len, ...prev });
    pos += len;
  });
  for (const r of runs) if (!r.font) throw new Error('text run without a font');
  const lineLengths = lines?.length ? lines : t.A.map((p) => p.length);
  return { text, lines: lineLengths, runs, naturalWidth: natural?.width ?? null, naturalHeight: natural?.height ?? null };
}
```
Call sites: `decodeTextBlock(raw.a.C, raw.b?.A, { width: raw.e, height: raw.f })` for text elements; shape text `decodeTextBlock(inner, undefined, null)`. `pickStyle` unchanged except: `super` is not a style key (handled above).

- [ ] **Step 3: Regenerate, verify, commit**

`npm run invite:extract`, `node --test test/invite/extract.test.mjs` (all passing), then `npm run invite:render` and the full suite — render tests still pass (they pin single-run text). Commit: `Skip hidden sections and read text runs, lines and scale the way Canva stores them`.

---

### Task 13: Render text at its scaled size with its effects

Added during execution. With Task 12's model the renderer must: lay the text out at its natural size and scale the block to the box (Canva's exact line breaks then hold); render superscripts; approximate the five text effects seen in the data (`shadow`, `lift`, `echo`, `outline`, `background`) at sane sizes — the current shadow math emits `106px -106px` offsets.

**Files:** modify `invite/build/render.mjs`; test `test/invite/render.test.mjs`; regenerate `index.html`, `invite.css`.

**Interfaces:**
- Text element markup: `<div class="el txt" style="left;top;width;height;…"><div class="tin" style="width:<natural>px;height:<natural>px;transform:scale(sx,sy);text-align;line-height;text-shadow…">…lines…</div></div>` where `sx = width/naturalWidth`, `sy = height/naturalHeight` when both naturals are present; otherwise `.tin` has `width:100%` and no transform. CSS `.txt>.tin{position:absolute;left:0;top:0;transform-origin:0 0;white-space:pre-wrap}`.
- Superscript run spans get `vertical-align:super;font-size:0.6em`.
- Effects (fontSize = the run's declared size, so the block scale applies on top):
  - `shadow {angle, blur, color, offset, transparency}` → `text-shadow: dx dy blurPx rgba` with `d = min(parseFloat(offset), 1) × 0.5 × fontSize`, `dx = cos(angle°)·d`, `dy = −sin(angle°)·d`, `blurPx = parseFloat(blur) × 0.1 × fontSize`, alpha `1 − parseFloat(transparency)` (0..1, default 1).
  - `lift {intensity}` → `0 0.05em 0.12em rgba(0,0,0, 0.35·i)`.
  - `echo {angle, color, offset}` → two copies at `d` and `2d` with `d = min(offset,1) × 0.5 × fontSize`, second at 50% alpha.
  - `outline {color, thickness}` → `-webkit-text-stroke: (thickness × 0.05 × fontSize)px color; paint-order: stroke fill`.
  - `background {color, roundness, spread, transparency}` → on each run span: `background: rgba(color, 1 − transparency); padding: (0.1·spread)em (0.25·spread)em; border-radius: (0.5·roundness)em; box-decoration-break: clone`.
- Exports `textEffects(effects, fontSize) → { shadow: string|'', stroke: string|'', background: string|'' }` for unit testing.

- [ ] **Step 1: Failing tests** (append to `test/invite/render.test.mjs`)
```js
import { textEffects } from '../../invite/build/render.mjs';
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
```
(If `renderElement`'s ctx now needs other fields — e.g. `anims` lookups — pass what the current signature requires; the assertions are what matter.)

- [ ] **Step 2: render.mjs**

`renderTextBlock(block, effects)` returns `{ style, html, inner }` where `inner` is the `.tin` opening style; in `renderElement`'s text branch:
```js
    const sx = el.naturalWidth ? r(el.width / el.naturalWidth, 4) : null;
    const sy = el.naturalHeight ? r(el.height / el.naturalHeight, 4) : null;
    const inner = sx && sy ? `width:${px(el.naturalWidth)};height:${px(el.naturalHeight)};transform:scale(${sx},${sy});` : 'width:100%;';
    return `${open(el, 'txt', ctx)}<div class="tin" style="${inner}${style}">${html}</div>${close(el)}`;
```
Run spans add `vertical-align:super;font-size:0.6em;` when `run.super`. Move `text-shadow`/stroke onto `.tin` (from `textEffects(effects, firstRun.size)`), background onto run spans. Add `.txt>.tin{position:absolute;left:0;top:0;transform-origin:0 0;white-space:pre-wrap}` to `BASE_CSS` and drop `white-space` from `.txt`.

- [ ] **Step 3: Regenerate, verify, commit**

`npm run invite:render`, full suite, eyeball `#home` and `#timeline`: "Days left until our Wedding" large script, "Misbah & Areeb" on the card, "10th October 2026" with a small `th`, no giant black shadows. Commit: `Lay text out at its natural size and scale it into its box`.

---

### Task 14: Find the entrance by the reveal, not by the sway

Added during execution. `splitLoop` settles on translate within 3 px of rest; an idle sway larger than that never settles, so a 40-second recording plays as one 40-second fade (elements look missing for tens of seconds). The entrance ends when the *reveal* properties settle — opacity, blur, scale — and translate is within the idle amplitude (measured on the tail) plus 3 px.

**Files:** modify `invite/build/render.mjs`; test `test/invite/render.test.mjs`; regenerate.

- [ ] **Step 1: Failing test**
```js
test('an entrance followed by a wide slow sway still ends when the reveal settles', () => {
  const f = (t, dy, op, dx = 0) => ({ t, opacity: op, dx, dy, scale: 1, blur: 0, clip: null });
  const frames = [f(0, 80, 0), f(0.02, 40, 0.5), f(0.04, 0, 1), f(0.3, 12, 1), f(0.55, -12, 1), f(0.8, 12, 1), f(1, 0, 1)];
  const { entrance, idle, i } = splitLoop(frames);
  assert.equal(i, 2);
  assert.equal(entrance.length, 3);
  assert.equal(idle.length, 5);
});
```

- [ ] **Step 2: render.mjs**
```js
function tailAmplitude(frames) {
  const tail = frames.slice(Math.floor(frames.length * 0.6));
  return Math.max(0, ...tail.map((f) => Math.max(Math.abs(f.dx), Math.abs(f.dy))));
}
function settleIndex(frames) {
  const rest = frames.at(-1);
  const amp = tailAmplitude(frames) + 3;
  const revealed = (f) => Math.abs(f.opacity - rest.opacity) <= 0.03 && Math.abs(f.scale - rest.scale) <= 0.01 && f.blur === rest.blur && Math.abs(f.dx) <= amp && Math.abs(f.dy) <= amp;
  let i = 0;
  while (i < frames.length - 1 && !revealed(frames[i])) i++;
  return i;
}
```
`splitLoop` uses this `settleIndex` (first frame from the start that counts as revealed) instead of walking back from the end. Keep the existing tests passing (re-check the earlier `splitLoop` fixture: `[80,0]→[40,.5]→[0,1]→2→−2→2→0` still splits at index 2).

- [ ] **Step 3: Regenerate, verify, commit**

`npm run invite:render`, full suite. Then re-run `node --test test/invite/diff.test.mjs`: expected to move all seven pages under the threshold; report each page's value. Eyeball `#home`: the invitation card, "Dress code" label, banner and bouquet appear within ~2 s of scrolling to them. Commit: `End an entrance when the reveal settles, not when the sway does`.

---

## Self-review

**Spec coverage.** Fetch/extract/assets/render pipeline → Tasks 1–3, 5. model.json shape → Task 2. Scaling rule with 0.25 floor → Task 6 (`PAD` 8 instead of 12; fine, documented in Task 8). Elements (image crop, real text, groups, shapes, z-order) → Task 5. Seven slugs + hash router + back button → Tasks 2, 6. Canva footer dropped → render never emits it. Assets (referenced only, ≤2× size, WebP, hash names, fonts with fallback stack, petals, budget, lazy per page) → Tasks 3, 5, 6, 8. Animations per element from recordings + fallback → Tasks 4, 5 (unrecorded elements simply have no `an` class, i.e. shown static; the spec's "fade+rise fallback" is dropped in favour of static — noted for Task 8's spec update). Countdown native → Tasks 5, 6. Failure handling (missing media throws, unknown kind throws) → Tasks 2, 3, 5. Tests at three widths, diff vs references, shots, build checks → Tasks 2, 7. No-JS fallback → `<noscript>` in Task 5.

**Placeholders.** None; every step has code or an exact command.

**Type consistency.** `Element.crop` is `{top,left,width,height}` in Task 2 and consumed as such in Tasks 3 and 5. `assets.json` shape (`media[id].{src,width,height,kind,poster}`, `fonts[key].{family,src,weight,italic}`) matches between Task 3 producer and Task 5 consumer. `animations.json` entries `{effect,startMs,durationMs,frames[]}` match between Tasks 4 and 5. `data-cl/data-cw/data-h` written in Task 5, read in Task 6 and 7. `serve()` from Task 5 used in Tasks 6 and 7.

