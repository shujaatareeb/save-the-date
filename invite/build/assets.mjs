// invite/build/assets.mjs — fetch the media the published pages use and shrink it.
//
//   node invite/build/assets.mjs                # writes invite/assets/*, invite/build/assets.json
//
// Raw downloads land in build/cache/ (gitignored) so re-runs only re-encode.
// Encoding goes through the ffmpeg already in node_modules: stills → WebP at
// no more than 2× their rendered width, the petals GIF → animated WebP (keeps
// alpha), the two effect MP4s → muted WebM.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { BUILD, ASSETS, CACHE, INVITE, isMain } from './lib.mjs';
import { SITE } from './fetch.mjs';

const run = promisify(execFile);
export const ffmpeg = async (args) => { await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args]); };

const STYLE_WEIGHTS = { THIN: 100, EXTRA_LIGHT: 200, LIGHT: 300, REGULAR: 400, MEDIUM: 500, SEMI_BOLD: 600, BOLD: 700, EXTRA_BOLD: 800, BLACK: 900, HEAVY: 900 };
export function styleToFace(style) {
  const italic = /ITALIC/.test(style);
  const base = style.replace(/_?ITALICS?$/, '') || 'REGULAR';
  return { weight: STYLE_WEIGHTS[base] ?? 400, italic };
}

const walk = (els, fn, scale = 1) => {
  for (const el of els) {
    fn(el, scale);
    if (el.kind === 'group') walk(el.children, fn, scale * (el.width / (el.nativeWidth || el.width)));
  }
};

export function usedMedia(model) {
  const used = new Map();
  const note = (id, width) => {
    const cur = used.get(id) || { maxWidth: 0 };
    cur.maxWidth = Math.max(cur.maxWidth, width);
    used.set(id, cur);
  };
  for (const p of model.pages) for (const s of p.sections) walk(s.elements, (el, k) => {
    if (el.kind === 'image') note(el.media, el.crop.width * k);
    if (el.kind === 'shape') for (const path of el.paths) if (path.fill.media) note(path.fill.media, (path.fill.crop.width / el.viewBox.width) * el.width * k);
    if (el.anim?.params.video) note(el.anim.params.video, el.width * k);
  });
  return used;
}

export function planFonts(model) {
  const seen = new Map();
  const add = (run) => {
    const key = `${run.font}-${run.styleIndex}`;
    if (seen.has(key)) return;
    const font = model.fonts[run.font];
    const style = font.styles[run.styleIndex] || font.styles[0];
    seen.set(key, { key, fontId: run.font, styleIndex: run.styleIndex, url: style.url, family: font.family, ...styleToFace(style.style) });
  };
  for (const p of model.pages) for (const s of p.sections) walk(s.elements, (el) => {
    if (el.kind === 'text') el.runs.forEach(add);
    if (el.kind === 'shape' && el.text) el.text.runs.forEach(add);
  });
  return [...seen.values()];
}

async function download(url) {
  fs.mkdirSync(CACHE, { recursive: true });
  const file = path.join(CACHE, url.replace(/[\/\\]/g, '_'));
  if (!fs.existsSync(file)) {
    const res = await fetch(SITE + url);
    if (!res.ok) throw new Error(`${res.status} fetching ${url}`);
    fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

const hashName = (file, ext) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12) + ext;

// ffmpeg has no SVG decoder in any build (it doesn't rasterise vectors), and a
// handful of media the model marks `type: 'raster'` are actually SVG source
// (mime image/svg+xml) — copy those through untouched; browsers render SVG
// natively, often better than a rasterised WebP would.
async function copyThrough(src, ext) {
  const out = path.join(ASSETS, hashName(src, ext));
  if (!fs.existsSync(out)) fs.copyFileSync(src, out);
  return out;
}

async function encodeStill(src, maxWidth, naturalWidth) {
  const out = path.join(ASSETS, hashName(src, '.webp'));
  if (!fs.existsSync(out)) {
    const target = Math.min(naturalWidth, Math.ceil(maxWidth * 2));
    const vf = target < naturalWidth ? ['-vf', `scale=${target}:-2`] : [];
    await ffmpeg(['-i', src, ...vf, '-c:v', 'libwebp', '-quality', '80', '-compression_level', '6', out]);
  }
  return out;
}

async function encodeAnimated(src) {
  const out = path.join(ASSETS, hashName(src, '.webp'));
  if (!fs.existsSync(out)) await ffmpeg(['-i', src, '-vf', 'fps=15,scale=480:-2', '-c:v', 'libwebp_anim', '-loop', '0', '-quality', '55', '-an', out]);
  return out;
}

async function encodeVideo(src) {
  const out = path.join(ASSETS, hashName(src, '.webm'));
  if (!fs.existsSync(out)) await ffmpeg(['-i', src, '-vf', 'scale=960:-2', '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '36', '-an', out]);
  return out;
}

export async function buildAssets(model) {
  fs.mkdirSync(ASSETS, { recursive: true });
  const manifest = { media: {}, fonts: {} };
  for (const [id, use] of usedMedia(model)) {
    const m = model.media[id];
    const src = await download(m.url);
    let out, kind = 'image', poster = null;
    if (m.mime === 'image/svg+xml') out = await copyThrough(src, '.svg');
    else if (m.type === 'raster') out = await encodeStill(src, use.maxWidth, m.width);
    else if (m.url.endsWith('.gif')) { out = await encodeAnimated(src); kind = 'anim'; }
    else {
      out = await encodeVideo(src); kind = 'video';
      if (m.poster) poster = path.relative(INVITE, await encodeStill(await download(m.poster), use.maxWidth, m.width)).replace(/\\/g, '/');
    }
    manifest.media[id] = { src: path.relative(INVITE, out).replace(/\\/g, '/'), width: m.width, height: m.height, kind, ...(poster && { poster }) };
  }
  for (const face of planFonts(model)) {
    const src = await download(face.url);
    const out = path.join(ASSETS, 'fonts', hashName(src, path.extname(face.url).toLowerCase()));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    if (!fs.existsSync(out)) fs.copyFileSync(src, out);
    manifest.fonts[face.key] = { family: face.family, src: path.relative(INVITE, out).replace(/\\/g, '/'), weight: face.weight, italic: face.italic };
  }
  fs.writeFileSync(path.join(BUILD, 'assets.json'), JSON.stringify(manifest, null, 1));
  return manifest;
}

if (isMain(import.meta.url)) {
  const model = JSON.parse(fs.readFileSync(path.join(BUILD, 'model.json'), 'utf8'));
  const manifest = await buildAssets(model);
  const total = fs.readdirSync(ASSETS, { recursive: true }).reduce((n, f) => { const p = path.join(ASSETS, f); return n + (fs.statSync(p).isFile() ? fs.statSync(p).size : 0); }, 0);
  console.log(`media=${Object.keys(manifest.media).length} fonts=${Object.keys(manifest.fonts).length} assets=${(total / 1e6).toFixed(1)}MB`);
  if (total > 12e6) { console.error('assets exceed the 12 MB budget'); process.exit(1); }
}
