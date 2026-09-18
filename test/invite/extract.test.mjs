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

test('every text run carries the full run interface', () => {
  const keys = ['start', 'end', 'font', 'styleIndex', 'size', 'weight', 'italic', 'color', 'decoration', 'link', 'letterSpacing', 'lineHeight', 'align', 'transform', 'super'];
  for (const p of model.pages) for (const s of p.sections) for (const e of flat(s.elements)) {
    const blocks = e.kind === 'text' ? [e] : e.kind === 'shape' && e.text ? [e.text] : [];
    for (const b of blocks) for (const r of b.runs) for (const k of keys) assert.ok(k in r, `${k} missing on ${e.id}`);
  }
});

test('prefers the processed media and carries per-element recolours', () => {
  const els = page('envelope').sections[0].elements;
  assert.equal(els[4].media, 'MAHUFZUveVY');                       // background-removed envelope
  assert.deepEqual(els[7].recolor, { '#000000': '#715449' });
  assert.equal(els[0].recolor, undefined);
});

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

// A sparse section — a few centred lines inside one wide frame shape, like the
// home page's "Thank you" — is re-laid-out by Canva on a phone: the text scaled
// up to read and the frame stretched to hug it. The frame is the one wide
// non-bleed shape or image whose other content is much narrower than it; it
// is left out of the content column (so the text sets the scale) and marked
// for the runtime to stretch.
test('leaves a sparse section\'s frame out of its content column and marks it', () => {
  const model = extractModel(canva);
  const home = model.pages.find((p) => p.slug === 'home');
  const thanks = home.sections[3];
  assert.equal(thanks.frame, 'LBmXYWhntCSrpFtH');
  assert.ok(thanks.content.width < 700 && thanks.content.width > 600, `content column ${thanks.content.width}`);
  // no other section has a frame
  const framed = model.pages.flatMap((p) => p.sections.filter((s) => s.frame).map((s) => p.slug));
  assert.deepEqual(framed, ['home']);
});

// A shape path may be drawn with a stroke (`b[].C`: width, colour) and no
// fill — the thin frames round the countdown and the thank-you block are
// exactly that, and rendered as fill-only they were invisible.
test('keeps a path\'s stroke', () => {
  const model = extractModel(canva);
  const find = (id) => { let hit; model.pages.forEach((p) => p.sections.forEach((s) => { const w = (els) => els.forEach((e) => { if (e.id === id) hit = e; if (e.children) w(e.children); }); w(s.elements); })); return hit; };
  assert.deepEqual(find('LBmXYWhntCSrpFtH').paths[0].stroke, { width: 1, color: '#715449' });
  assert.deepEqual(find('LBxLcThlXtcKV5sJ').paths[0].stroke, { width: 1, color: '#ae8d3f' });
  assert.equal(find('LBmXYWhntCSrpFtH').paths[0].fill.color, 'none');
  const stroked = []; model.pages.forEach((p) => p.sections.forEach((s) => s.elements.forEach((e) => { if (e.kind === 'shape' && e.paths.some((x) => x.stroke)) stroked.push(e.id); })));
  assert.equal(stroked.length, 2);
});

// A section with no content elements at all — the dress-code page is one
// full-canvas picture over a background — has no column to fit. Canva fits
// such a section to the screen's height instead and lets the sides crop.
test('marks a section with nothing but bleeds as one to fit by height', () => {
  const model = extractModel(canva);
  const dress = model.pages.find((p) => p.slug === 'dress-code');
  assert.equal(dress.sections[0].cover, true);
  assert.equal(dress.sections[1].cover, undefined);
  const covered = model.pages.flatMap((p) => p.sections.map((s, i) => s.cover ? `${p.slug}:${i}` : null).filter(Boolean));
  assert.deepEqual(covered, ['dress-code:0']);
});
