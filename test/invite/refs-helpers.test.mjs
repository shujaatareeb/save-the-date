import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceScreenshotOptions } from './refs-helpers.mjs';

test('clips a reference to the measured scroll height', () => {
  assert.deepEqual(referenceScreenshotOptions(1732), {
    fullPage: true,
    clip: { x: 0, y: 0, width: 1366, height: 1732 },
  });
});

test('rejects a non-positive measured scroll height', () => {
  assert.throws(() => referenceScreenshotOptions(0), /measured height/);
});
