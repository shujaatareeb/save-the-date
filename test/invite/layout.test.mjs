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
      // a cover section (nothing but bleeds) is fitted to the screen's height and crops its sides by
      // design; a sparse one is re-laid-out element by element, so its column says nothing
      const content = secs.filter((s) => !('cover' in s.dataset) && !('sparse' in s.dataset)).map((s) => { const k = parseFloat(getComputedStyle(s.querySelector('.stage')).transform.match(/matrix\(([^,]+),/)[1]); const st = s.querySelector('.stage').getBoundingClientRect(); return { left: st.left + (+s.dataset.cl) * k, right: st.left + (+s.dataset.cl + +s.dataset.cw) * k }; });
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
