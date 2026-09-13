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

export function extractBootstrap(html) {
  const m = html.match(/window\['bootstrap'\] = JSON\.parse\('((?:[^'\\]|\\.)*)'\);/s);
  if (!m) throw new Error('bootstrap blob not found');
  // The blob is a JS single-quoted string literal. Let JS undo the escaping.
  const literal = new Function(`return '${m[1]}';`)();
  return JSON.parse(literal);
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
