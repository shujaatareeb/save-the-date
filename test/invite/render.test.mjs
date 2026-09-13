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
