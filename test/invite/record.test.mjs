import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTransform, normalise, matchElement, matchOnPage, clusterStarts, flattenPage, matchAbsolute, mergeSamples } from '../../invite/build/record.mjs';

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

test('matches across sections using the cumulative offset when the DOM merged them', () => {
  const page = { sections: [
    { height: 1000, elements: [{ id: 'a', kind: 'image', top: 100, left: 200, width: 10, height: 10, rotation: 0 }] },
    { height: 800, elements: [{ id: 'b', kind: 'image', top: 50, left: 300, width: 10, height: 10, rotation: 0 }] },
  ] };
  assert.equal(matchOnPage({ x: 300, y: 50, rot: 0 }, page, 0).el.id, 'b');
  assert.equal(matchOnPage({ x: 300, y: 1050, rot: 0 }, page, 0).el.id, 'b');
  assert.equal(matchOnPage({ x: 300, y: 1050, rot: 0 }, page, 0).section, 1);
  assert.equal(matchOnPage({ x: 900, y: 900, rot: 0 }, page, 0).el, null);
});

test('clusters start times so each burst of reveals begins at zero', () => {
  assert.deepEqual(clusterStarts([5000, 5200, 5100, 12000, 12300]), [0, 200, 100, 0, 300]);
});

test('flattens groups to absolute coordinates through their scale', () => {
  const page = { sections: [{ height: 1000, elements: [
    { id: 'g', kind: 'group', top: 100, left: 200, width: 200, height: 100, nativeWidth: 100, nativeHeight: 50, rotation: 0,
      children: [{ id: 'c', kind: 'image', top: 10, left: 20, width: 5, height: 5, rotation: 0 }] },
  ] }] };
  const flat = flattenPage(page, 10);
  const c = flat.find((f) => f.el.id === 'c');
  assert.deepEqual([c.x, c.y], [10 + 200 + 40, 100 + 20]);
});

test('matches an absolute rest to the nearest flattened element within tolerance', () => {
  const flat = [{ el: { id: 'a', rotation: 0 }, x: 100, y: 50, alt: 1050 }, { el: { id: 'b', rotation: -17.5 }, x: 400, y: 300, alt: 1300 }];
  assert.equal(matchAbsolute({ x: 401, y: 1299, rot: -17.5 }, flat).el.id, 'b');
  assert.equal(matchAbsolute({ x: 100, y: 52, rot: 0 }, flat).el.id, 'a');
  assert.equal(matchAbsolute({ x: 250, y: 250, rot: 0 }, flat), null);
});

test('merges per-property timelines from several nodes into one', () => {
  const wrapper = [{ t: 0, opacity: '', transform: 'translate(0px, 80px)', filter: '', clip: '' }, { t: 500, opacity: '', transform: 'translate(0px, 0px)', filter: '', clip: '' }];
  const inner = [{ t: 0, opacity: '0', transform: '', filter: 'blur(10px)', clip: '' }, { t: 250, opacity: '0.5', transform: '', filter: 'blur(5px)', clip: '' }, { t: 500, opacity: '', transform: '', filter: '', clip: '' }];
  const merged = mergeSamples([wrapper, inner]);
  assert.deepEqual(merged.map((s) => s.t), [0, 250, 500]);
  assert.equal(merged[1].transform, 'translate(0px, 80px)');
  assert.equal(merged[1].opacity, '0.5');
  assert.equal(merged[2].transform, 'translate(0px, 0px)');
});
