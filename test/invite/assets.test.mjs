import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { usedMedia, planFonts, pickFace, styleToFace, pageBytes, spriteRect, assetKey, applyRecolor, recolorSvg, compositeCacheName, hashName } from '../../invite/build/assets.mjs';
import os from 'node:os';
import path from 'node:path';

const model = JSON.parse(fs.readFileSync(new URL('../../invite/build/model.json', import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(new URL('../../invite/build/assets.json', import.meta.url)));

test('collects every media id the published pages reference, with the widest use', () => {
  const used = usedMedia(model);
  assert.ok(used.has('MAHUE4PPVlo'), 'envelope background');
  assert.ok(used.has('VAFGRrnMAsY'), 'petals sticker');
  assert.ok(used.has('MAHULz87mAs'), 'photo strip fill inside a shape');
  assert.ok(used.get('MAHUE4PPVlo').maxWidth > 1500);
  // Keys are assetKey(media, recolor) — a recoloured entry's key carries an
  // '@' suffix, so look the underlying media id up via the entry's own
  // `media` field rather than the map key itself.
  for (const [key, use] of used) assert.ok(model.media[use.media], key);
});

test('plans one font face per (font, weight, slant) actually used', () => {
  const faces = planFonts(model);
  const keys = faces.map((f) => f.key);
  assert.ok(keys.includes('YAFcf99lyzk-HEAVY'));
  assert.equal(new Set(keys).size, keys.length);
  for (const f of faces) assert.match(f.url, /^_assets\/fonts\//);
  for (const f of faces) assert.equal(f.key, `${f.fontId}-${f.style}`);
});

// Canva's run style names a font as "<id>,<n>" — the number is not an index
// into the font's style list. The live page registers every style of the font
// under one family and lets font-weight/font-style pick the face, so a run
// with no weight set (400) on a font listed BOLD-first must get the REGULAR.
test('picks the face by the run\'s weight and slant, not by the number after the comma', () => {
  const symphony = planFonts(model).filter((f) => f.fontId === 'YAF7Scfb7Ns');
  assert.equal(symphony.length, 1, 'one Symphony face in use');
  assert.equal(symphony[0].style, 'REGULAR');
  assert.equal(symphony[0].weight, 400);
  assert.equal(symphony[0].url, model.fonts.YAF7Scfb7Ns.styles.find((s) => s.style === 'REGULAR').url);
});

test('matches the nearest weight within the same slant, and falls back across slants', () => {
  const styles = (...names) => names.map((style) => ({ style, url: `_assets/fonts/${style}.woff` }));
  assert.equal(pickFace(styles('BOLD', 'REGULAR'), 400, false).style, 'REGULAR');
  assert.equal(pickFace(styles('BOLD', 'REGULAR'), 700, false).style, 'BOLD');
  assert.equal(pickFace(styles('REGULAR', 'ITALICS', 'BOLD_ITALICS'), 700, true).style, 'BOLD_ITALICS');
  assert.equal(pickFace(styles('REGULAR', 'ITALICS', 'BOLD_ITALICS'), 400, true).style, 'ITALICS');
  assert.equal(pickFace(styles('MEDIUM'), 400, false).style, 'MEDIUM');
  assert.equal(pickFace(styles('LIGHT', 'BOLD'), 400, false).style, 'LIGHT');
  assert.equal(pickFace(styles('REGULAR'), 700, true).style, 'REGULAR');
});

test('maps Canva style names onto weight and italic', () => {
  assert.deepEqual(styleToFace('REGULAR'), { weight: 400, italic: false });
  assert.deepEqual(styleToFace('BOLD'), { weight: 700, italic: false });
  assert.deepEqual(styleToFace('ITALICS'), { weight: 400, italic: true });
  assert.deepEqual(styleToFace('BOLD_ITALICS'), { weight: 700, italic: true });
  assert.deepEqual(styleToFace('LIGHT'), { weight: 300, italic: false });
  assert.deepEqual(styleToFace('ULTRA_BOLD'), { weight: 800, italic: false });
  assert.deepEqual(styleToFace('ULTRA_BOLD_ITALICS'), { weight: 800, italic: true });
  assert.throws(() => styleToFace('WOBBLY'), /unknown font style/);
});

test('the envelope page stays under its 1.5 MB budget', () => {
  const bytes = pageBytes(model, manifest, 'envelope');
  assert.ok(bytes > 200_000 && bytes < 1_500_000, `${bytes} bytes`);
});

test('locates sprite k in a wide-by-high sheet', () => {
  assert.deepEqual(spriteRect(14400, 1585, 6, 1, 2), { x: 4800, y: 0, w: 2400, h: 1585 });
  assert.deepEqual(spriteRect(2400, 218, 3, 2, 4), { x: 800, y: 109, w: 800, h: 109 });
});

test('spritesheet media are shipped as single composited images', () => {
  const m = manifest.media['MAG66LCSz84'];
  assert.match(m.src, /\.webp$/);
  assert.ok(m.width <= 2400 && m.height <= 1585 && Math.abs(m.width / m.height - 2400 / 1585) < 0.01, JSON.stringify(m));
});

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

// Canva's own SVGs mostly leave their paths unfilled and let them fall to the
// SVG default, black — and the design's colour map for such a layer is keyed
// on that black. Rewriting only literal fills left the timeline's paint
// splatter black on the page; the root takes the mapped colour so every
// unfilled path inherits it, and paths that do name a fill keep their own map.
test('a map entry for black recolours paths that never named a fill', () => {
  const svg = '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g><path d="M0 0h1"/><path fill="#EEBAD5" d="M1 1h1"/></g></svg>';
  const out = recolorSvg(svg, { '#000000': '#ddc1a4', '#eebad5': '#e8e0d3' });
  assert.match(out, /<svg [^>]*fill="#ddc1a4"[^>]*>/);
  assert.match(out, /<path fill="#e8e0d3" d="M1 1h1"\/>/);
  assert.equal((out.match(/<svg /g) || []).length, 1);
  // A root that already names a fill has it rewritten rather than doubled.
  const rooted = recolorSvg('<svg xmlns="http://www.w3.org/2000/svg" fill="#000000"><path d="M0 0h1"/></svg>', { '#000000': '#ddc1a4' });
  assert.equal(rooted, '<svg xmlns="http://www.w3.org/2000/svg" fill="#ddc1a4"><path d="M0 0h1"/></svg>');
  // No black in the map: the root is left alone.
  assert.equal(recolorSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>', { '#eebad5': '#e8e0d3' }), '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>');
});

test('the manifest carries a recoloured variant for the heart flourish', () => {
  // LBq7bt3xrnV5lSC1 is the small heart-and-squiggle flourish under "WE ARE
  // GETTING MARRIED!" (not the purple ribbon plate, which is a separate,
  // unrecoloured element) — it's the one element in the envelope page whose
  // a.B.C recolour map is { '#000000': '#715449' }.
  const el = model.pages.find((p) => p.slug === 'envelope').sections[0].elements
    .find((e) => e.id === 'LBq7bt3xrnV5lSC1');
  assert.ok(el, 'fixture assumption: LBq7bt3xrnV5lSC1 exists on the envelope page');
  const key = assetKey(el.media, el.recolor);
  assert.notEqual(key, el.media, 'fixture assumption: this element carries a recolour');
  assert.ok(manifest.media[key], `no recoloured variant ${key} in manifest`);
  assert.match(manifest.media[key].src, /\.webp$/);
  // Its media id is used only by this one (always-recoloured) element, so the
  // plain, unrecoloured key must not appear in the manifest.
  assert.equal(manifest.media[el.media], undefined, `unexpected unrecoloured ${el.media} in manifest`);
});

test('composite cache names include what was composited, not just the source basename', () => {
  const sprites = { wide: 2, high: 1, layers: [{ type: 'background-a' }] };
  const plain = compositeCacheName('C:/cache/abc123.png', sprites, null);
  const recoloured = compositeCacheName('C:/cache/abc123.png', sprites, { '#000000': '#715449' });
  assert.match(plain, /^abc123\.png\.[0-9a-f]{8}\.composite\.png$/);
  assert.match(recoloured, /^abc123\.png\.[0-9a-f]{8}\.composite\.png$/);
  assert.notEqual(plain, recoloured, 'recoloured variant must not collide with the plain composite');
});

test('names an output after its source and recipe, so a composite hashes the same on every machine', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-hash-'));
  const sheet = path.join(dir, 'sheet.png');
  fs.writeFileSync(sheet, 'spritesheet bytes');
  const recipe = JSON.stringify({ sprites: [{ x: 0, y: 0, w: 1, h: 1 }], recolor: null });
  assert.equal(hashName(sheet, '.webp', recipe), hashName(sheet, '.webp', recipe));
  assert.notEqual(hashName(sheet, '.webp', recipe), hashName(sheet, '.webp'));
  assert.notEqual(hashName(sheet, '.webp', recipe), hashName(sheet, '.webp', recipe.replace('null', '{"#000000":"#ffffff"}')));
  assert.match(hashName(sheet, '.webp', recipe), /^[0-9a-f]{12}\.webp$/);
  fs.rmSync(dir, { recursive: true });
});

test('matte videos ship a webm and an h264 mp4, and no poster', () => {
  const videos = Object.entries(manifest.media).filter(([, m]) => m.kind === 'video');
  assert.equal(videos.length, 2, 'two effect-30 mattes in the deck');
  for (const [id, m] of videos) {
    assert.match(m.src, /^assets\/[0-9a-f]{12}\.webm$/, id);
    assert.match(m.mp4, /^assets\/[0-9a-f]{12}\.mp4$/, id);
    assert.equal(m.poster, undefined, `${id} needs no poster: the matte is never shown`);
    assert.ok(fs.existsSync(new URL(`../../invite/${m.mp4}`, import.meta.url)), `${m.mp4} on disk`);
  }
});

// The countdown on the live page is a third-party widget set in Abril Fatface
// (OFL), which it carries as a 2.5 KB subset inside its SVG. That subset is
// checked in under invite/build and ships like any other face.
test('ships the countdown widget\'s Abril Fatface subset as a face of its own', () => {
  const face = manifest.fonts['countdown-REGULAR'];
  assert.ok(face, 'countdown face in the manifest');
  assert.equal(face.fontId, 'countdown');
  assert.equal(face.family, 'Abril Fatface');
  assert.match(face.src, /^assets\/fonts\/[0-9a-f]{12}\.woff2$/);
  assert.ok(fs.existsSync(new URL(`../../invite/${face.src}`, import.meta.url)), `${face.src} on disk`);
  assert.ok(pageBytes(model, manifest, 'home') > pageBytes({ ...model, pages: model.pages.filter((p) => p.slug === 'home').map((p) => ({ ...p, sections: p.sections.map((s) => ({ ...s, elements: s.elements.filter((e) => e.kind !== 'embed') })) })) }, manifest, 'home'), 'the home page budget counts it');
});

// The faces were shipped whole — 1.5 MB of WOFF for a few hundred glyphs.
// Every face now goes out as a WOFF2 subset of the characters its runs set
// (with the upper case of anything a run transforms to upper case, and the
// space), which every page pulls before its text can show.
test('plans each face with the characters its runs set', () => {
  const face = planFonts(model).find((f) => f.fontId === 'YAGNIDZJMxo'); // Parfumerie Script: "For Details", "Save the Date"
  assert.ok(face.text.includes('F') && face.text.includes('D') && face.text.includes(' '), face.text);
  assert.ok(face.text.length < 40, `only what is set: ${face.text.length} characters`);
  const upper = planFonts(model).find((f) => f.fontId === 'YAEtfuYOYZQ'); // The Youngest: "view details" shown in upper case
  assert.ok(upper.text.includes('V') && upper.text.includes('v'), 'upper-cased runs keep both cases');
});

test('ships every face as a WOFF2 subset', () => {
  for (const [key, f] of Object.entries(manifest.fonts)) {
    assert.match(f.src, /^assets\/fonts\/[0-9a-f]{12}\.woff2$/, key);
    const bytes = fs.statSync(new URL(`../../invite/${f.src}`, import.meta.url)).size;
    assert.ok(bytes < 80_000, `${key}: ${bytes} bytes`);
  }
  const total = Object.values(manifest.fonts).reduce((n, f) => n + fs.statSync(new URL(`../../invite/${f.src}`, import.meta.url)).size, 0);
  assert.ok(total < 400_000, `all faces together: ${total} bytes`);
});

// Every still went out at twice its drawn width, which a retina desktop
// needs and a phone at k ≈ 0.3 does not: each still that is drawn smaller
// than its source now also ships at its drawn width, and the manifest says
// how wide each encoding really is so the page can offer both.
test('encodes a phone-sized variant of every still drawn smaller than its source', () => {
  let withSmall = 0, without = 0;
  for (const [id, m] of Object.entries(manifest.media)) {
    if (m.kind !== 'image' || m.src.endsWith('.svg')) continue;
    assert.ok(Number.isInteger(m.w) && m.w > 0, `${id}: encoded width`);
    if (m.srcS) {
      withSmall++;
      assert.match(m.srcS, /^assets\/[0-9a-f]{12}\.webp$/, id);
      assert.ok(m.ws < m.w, `${id}: small ${m.ws} < big ${m.w}`);
      assert.ok(fs.existsSync(new URL(`../../invite/${m.srcS}`, import.meta.url)), `${id}: ${m.srcS} on disk`);
      assert.ok(fs.statSync(new URL(`../../invite/${m.srcS}`, import.meta.url)).size < fs.statSync(new URL(`../../invite/${m.src}`, import.meta.url)).size, `${id}: the small one is smaller`);
    } else without++;
  }
  assert.ok(withSmall > 60, `${withSmall} stills with a phone variant`);
  assert.ok(without >= 0);
});

// AVIF keeps these translucent watercolour washes at a fraction of WebP's
// bytes (a 889 KB wash is 104 KB), and iOS 16.4+, Chrome and Firefox all
// decode it. Every still ships an AVIF beside each WebP encoding; the WebP
// stays as the fallback for older browsers.
test('encodes an AVIF beside every WebP still', () => {
  let n = 0, saved = 0, webp = 0;
  for (const [id, m] of Object.entries(manifest.media)) {
    if (m.kind !== 'image' || m.src.endsWith('.svg')) continue;
    n++;
    assert.match(m.avif, /^assets\/[0-9a-f]{12}\.avif$/, id);
    assert.ok(fs.existsSync(new URL(`../../invite/${m.avif}`, import.meta.url)), `${id}: ${m.avif} on disk`);
    if (m.srcS) { assert.match(m.avifS, /^assets\/[0-9a-f]{12}\.avif$/, id); assert.ok(fs.existsSync(new URL(`../../invite/${m.avifS}`, import.meta.url))); }
    const w = fs.statSync(new URL(`../../invite/${m.src}`, import.meta.url)).size, a = fs.statSync(new URL(`../../invite/${m.avif}`, import.meta.url)).size;
    webp += w; saved += w - a;
  }
  assert.ok(n > 90);
  assert.ok(saved > webp * 0.4, `AVIF saves ${Math.round((saved / webp) * 100)}% over WebP across the deck`);
});
