// invite/build/fetch.mjs — pull the published Canva site and keep its design blob.
//
//   node invite/build/fetch.mjs        # writes invite/build/canva.json
//
// The whole design (pages, elements, media, fonts) is serialised into one
// inline script on the page, so one GET is the entire "API".
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, CACHE, isMain } from './lib.mjs';

export const SITE = 'https://misbahareeb.my.canva.site/';

const SIMPLE_ESCAPES = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };

// Undo JS single-quoted string-literal escaping without evaluating anything.
export function unescapeJsString(s) {
  return s.replace(/\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/g, (_, brace, u4, x2, ch) => {
    if (brace) return String.fromCodePoint(parseInt(brace, 16));
    if (u4) return String.fromCharCode(parseInt(u4, 16));
    if (x2) return String.fromCharCode(parseInt(x2, 16));
    if (ch === '\r\n' || ch === '\n' || ch === '\r' || ch === '\u2028' || ch === '\u2029') return ''; // line continuation
    return SIMPLE_ESCAPES[ch] ?? ch; // \' \" \\ \/ and anything else stand for themselves
  });
}

export function extractBootstrap(html) {
  const m = html.match(/window\['bootstrap'\] = JSON\.parse\('((?:[^'\\]|\\.)*)'\);/);
  if (!m) throw new Error('bootstrap blob not found');
  return JSON.parse(unescapeJsString(m[1]));
}

export async function fetchSite() {
  const res = await fetch(SITE, { headers: { 'user-agent': 'Mozilla/5.0 save-the-date build' } });
  if (!res.ok) throw new Error(`Canva answered ${res.status}`);
  return res.text();
}

if (isMain(import.meta.url)) {
  const html = await fetchSite();
  const data = extractBootstrap(html);
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(path.join(CACHE, 'site.html'), html);
  fs.writeFileSync(path.join(BUILD, 'canva.json'), JSON.stringify(data));
  console.log(`pages=${data.page.A.A.length} media=${data.page.E.length} videos=${data.page.F.length} fonts=${data.page.B.length}`);
}
