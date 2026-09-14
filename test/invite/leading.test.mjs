// Computed-layout tests for text leading and superscript size.
//
// The string-level tests in render.test.mjs cannot catch either bug these
// cover: `line-height:0.74em` on a wrapper with no font size *reads* correct
// and emits correct, but resolves against the inherited 16px and collapses the
// lines onto each other. These measure what the browser actually computed.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { serve } from './serve.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const model = JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', 'invite', 'build', 'model.json'), 'utf8'));

// Every text block Canva broke over more than one line, with the leading it
// stored for the block's first run.
function multiLineBlocks() {
  const out = [];
  for (const page of model.pages) for (const section of page.sections) (function walk(els) {
    for (const el of els) {
      if (el.kind === 'text' && el.lines?.length > 1) {
        const first = el.runs[0] || {};
        out.push({ slug: page.slug, id: el.id, lines: el.lines.length, size: first.size, lineHeight: first.lineHeight });
      }
      if (el.children) walk(el.children);
    }
  })(section.elements);
  return out;
}

// Read the leading the browser actually resolved on the run itself, against
// that run's own font size. Both are used values from the same element, so the
// ratio is free of the stage and group transforms scaling the geometry around
// them. This is what the wrapper bug corrupted: `0.74em` on a `.tin` with no
// font size resolved against the inherited 16px and reached the run as 11.84px,
// a ratio of 0.07 rather than 0.74.
const measure = (id) => `(() => {
  const el = document.querySelector('[data-id="${id}"]');
  if (!el) return null;
  const lns = [...el.querySelectorAll('.ln')];
  if (lns.length < 2) return null;
  const span = lns[0].querySelector('span') || lns[0];
  const cs = getComputedStyle(span);
  const fontSize = parseFloat(cs.fontSize);
  // A keyword line-height comes back as "normal" rather than a length, so fall
  // back to the line box the browser laid out. offsetHeight is the untransformed
  // layout height, which keeps it in the same space as fontSize.
  const lineHeight = parseFloat(cs.lineHeight) || lns[0].offsetHeight;
  return { fontSize, lineHeight, ratio: lineHeight / fontSize };
})()`;

let browser, site;
test.before(async () => { browser = await chromium.launch(); site = await serve(); });
test.after(async () => { await browser.close(); await site.close(); });

const blocks = multiLineBlocks();

test('every multi-line block was found in the rendered page', async () => {
  assert.ok(blocks.length >= 8, `expected the model's multi-line blocks, got ${blocks.length}`);
});

for (const block of blocks) {
  const label = block.lineHeight ? `at its stored ${block.lineHeight}` : 'at the face\'s own normal leading';
  test(`${block.slug}: ${block.id} leads its ${block.lines} lines ${label}`, async () => {
    const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
    await page.goto(`${site.url}/invite/#${block.slug}`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const m = await page.evaluate(measure(block.id));
    await page.close();

    assert.ok(m, `no measurable multi-line box for ${block.id}`);

    if (block.lineHeight) {
      // Canva stores the leading relative to the run's own font size, so the
      // measured ratio must come back as that same multiplier.
      const want = parseFloat(block.lineHeight);
      assert.ok(Math.abs(m.ratio - want) < 0.02,
        `leading ratio ${m.ratio.toFixed(3)} != stored ${want} (${m.lineHeight.toFixed(2)}px leading on ${m.fontSize.toFixed(2)}px text)`);
    } else {
      // No stored value: `normal` leaves it to the face, which is never tight
      // enough to collide. The bug produced ratios around 0.07.
      assert.ok(m.ratio >= 0.8,
        `leading ratio ${m.ratio.toFixed(3)} is too tight to clear the glyphs (${m.lineHeight.toFixed(2)}px leading on ${m.fontSize.toFixed(2)}px text)`);
    }
  });
}

test('a superscript run draws at 60% of its own size, not of its parent', async () => {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  await page.goto(`${site.url}/invite/#home`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(400);
  const m = await page.evaluate(`(() => {
    const sup = [...document.querySelectorAll('[data-id] .ln span')].find((s) => getComputedStyle(s).verticalAlign === 'super');
    if (!sup) return null;
    const sib = [...sup.parentElement.querySelectorAll('span')].find((s) => s !== sup);
    return { sup: parseFloat(getComputedStyle(sup).fontSize), sib: parseFloat(getComputedStyle(sib).fontSize) };
  })()`);
  await page.close();

  assert.ok(m, 'no superscript run found on #home');
  // 0.6em would have resolved against the parent .ln instead, landing near 9.6px.
  assert.ok(Math.abs(m.sup / m.sib - 0.6) < 0.02,
    `superscript is ${m.sup.toFixed(1)}px beside a ${m.sib.toFixed(1)}px sibling (ratio ${(m.sup / m.sib).toFixed(3)})`);
});
