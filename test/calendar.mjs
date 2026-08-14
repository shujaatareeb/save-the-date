// What the "Add to Calendar" button points at, per platform.
//
//   node test/calendar.mjs
//
// The button is one button, but it is not one link. An .ics with a `download`
// attribute is the right answer on a desktop and the wrong one on a phone —
// iOS honours `download` by filing it away in Files, where Calendar never sees
// it. So the href is decided at runtime, and this asserts each branch actually
// gets decided the way it was meant to.
//
// Served over http rather than file:// for the same reason the screenshot
// harness does it: the page taints its canvas under file:// and half of it
// stops working.

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const PORT = 8735;

const TYPES = {
  '.html': 'text/html', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.m4a': 'audio/mp4', '.ics': 'text/calendar',
};

const server = http.createServer((req, res) => {
  const rel = req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]);
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(body);
  });
});
await new Promise((r) => server.listen(PORT, r));

// iPadOS is in here twice over: it reports itself as a Mac, and the only thing
// separating it from one is that it admits to a touch screen. Both spellings
// have to land on the Apple branch or iPad guests get a desktop download.
const PLATFORMS = [
  {
    name: 'iPhone',
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    touch: true,
    expect: { kind: 'ics', download: null },
  },
  {
    name: 'iPadOS (claims to be a Mac)',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    touch: true,
    expect: { kind: 'ics', download: null },
  },
  {
    name: 'macOS Safari',
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    touch: false,
    expect: { kind: 'ics', download: null },
  },
  {
    name: 'Android Chrome',
    ua: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36',
    touch: true,
    expect: { kind: 'google', download: null },
  },
  {
    name: 'Windows Chrome',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    touch: false,
    expect: { kind: 'ics', download: 'misbah-areeb-save-the-date.ics' },
  },
  {
    name: 'Linux Firefox',
    ua: 'Mozilla/5.0 (X11; Linux x86_64; rv:124.0) Gecko/20100101 Firefox/124.0',
    touch: false,
    expect: { kind: 'ics', download: 'misbah-areeb-save-the-date.ics' },
  },
];

function kindOf(href) {
  if (href.startsWith('https://calendar.google.com/')) return 'google';
  if (href.endsWith('/save-the-date.ics')) return 'ics';
  if (href.startsWith('blob:')) return 'blob';
  return 'unknown:' + href;
}

const browser = await chromium.launch();
const failures = [];

for (const p of PLATFORMS) {
  const context = await browser.newContext({
    userAgent: p.ua,
    hasTouch: p.touch,
    isMobile: p.touch,
    viewport: p.touch ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  });
  const page = await context.newPage();
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'load' });
  await page.waitForTimeout(400);

  const got = await page.evaluate(() => {
    const a = document.getElementById('ics');
    return {
      href: a.href,
      download: a.getAttribute('download'),
      target: a.getAttribute('target'),
      rel: a.getAttribute('rel'),
    };
  });

  const kind = kindOf(got.href);
  const problems = [];
  if (kind !== p.expect.kind) problems.push(`href kind ${kind}, wanted ${p.expect.kind}`);
  if (got.download !== p.expect.download) {
    problems.push(`download ${JSON.stringify(got.download)}, wanted ${JSON.stringify(p.expect.download)}`);
  }

  // A link that leaves for Google has to leave in a new tab, or the card is
  // gone and the scratch cannot be shown to anyone else.
  if (kind === 'google') {
    if (got.target !== '_blank') problems.push(`target ${JSON.stringify(got.target)}, wanted "_blank"`);
    if (!(got.rel || '').includes('noopener')) problems.push(`rel ${JSON.stringify(got.rel)}, wanted noopener`);
    const u = new URL(got.href);
    if (u.searchParams.get('action') !== 'TEMPLATE') problems.push('google action is not TEMPLATE');
    if (u.searchParams.get('dates') !== '20261010/20261011') {
      problems.push(`google dates ${u.searchParams.get('dates')}, wanted 20261010/20261011`);
    }
    if (u.searchParams.get('text') !== 'Misbah & Areeb — Wedding') {
      problems.push(`google text ${JSON.stringify(u.searchParams.get('text'))}`);
    }
  }

  if (problems.length) failures.push(`${p.name}: ${problems.join('; ')}`);
  console.log(`${problems.length ? 'FAIL' : 'ok  '}  ${p.name.padEnd(28)} ${kind}${got.download ? ' download=' + got.download : ''}`);

  await context.close();
}

await browser.close();
server.close();

if (failures.length) {
  console.error('\n' + failures.length + ' failing:');
  for (const f of failures) console.error('  - ' + f);
  process.exit(1);
}
console.log('\nall platforms route as intended');
