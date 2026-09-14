import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { usedMedia, planFonts, styleToFace, pageBytes, spriteRect } from '../../invite/build/assets.mjs';

const model = JSON.parse(fs.readFileSync(new URL('../../invite/build/model.json', import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(new URL('../../invite/build/assets.json', import.meta.url)));

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
