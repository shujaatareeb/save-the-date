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
  const keys = ['start', 'end', 'font', 'styleIndex', 'size', 'weight', 'italic', 'color', 'decoration', 'link', 'letterSpacing', 'lineHeight', 'align', 'transform'];
  for (const p of model.pages) for (const s of p.sections) for (const e of flat(s.elements)) {
    const blocks = e.kind === 'text' ? [e] : e.kind === 'shape' && e.text ? [e.text] : [];
    for (const b of blocks) for (const r of b.runs) for (const k of keys) assert.ok(k in r, `${k} missing on ${e.id}`);
  }
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
