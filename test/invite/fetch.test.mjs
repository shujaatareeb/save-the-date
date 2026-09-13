import test from 'node:test';
import assert from 'node:assert/strict';
import { extractBootstrap, unescapeJsString } from '../../invite/build/fetch.mjs';

test('extracts the bootstrap blob from a Canva page', () => {
  const html = `<html><script>window['bootstrap'] = JSON.parse('{"page":{"A":{"A":[]}},"t":"it\\'s \\u00e9"}');</script></html>`;
  const data = extractBootstrap(html);
  assert.deepEqual(data.page.A.A, []);
  assert.equal(data.t, "it's é");
});

test('fails loudly when the blob is missing', () => {
  assert.throws(() => extractBootstrap('<html></html>'), /bootstrap blob not found/);
});

test('unescapes JS string-literal escapes without evaluating', () => {
  assert.equal(unescapeJsString(String.raw`a\'b\"c\\d\/e\né\x41\u{1F600}`), `a'b"c\\d/e\néA😀`);
});
