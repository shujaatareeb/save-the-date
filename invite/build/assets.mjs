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
import { chromium } from 'playwright';
import { BUILD, ASSETS, CACHE, INVITE, isMain } from './lib.mjs';
import { SITE } from './fetch.mjs';

const run = promisify(execFile);
export const ffmpeg = async (args) => { await run(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args]); };

const STYLE_WEIGHTS = { THIN: 100, EXTRA_LIGHT: 200, ULTRA_LIGHT: 200, LIGHT: 300, REGULAR: 400, MEDIUM: 500, SEMI_BOLD: 600, BOLD: 700, EXTRA_BOLD: 800, ULTRA_BOLD: 800, BLACK: 900, HEAVY: 900 };
export function styleToFace(style) {
  const italic = /ITALIC/.test(style);
  const base = style.replace(/_?ITALICS?$/, '') || 'REGULAR';
  if (!(base in STYLE_WEIGHTS)) throw new Error(`unknown font style ${style}`);
  return { weight: STYLE_WEIGHTS[base], italic };
}

const walk = (els, fn, scale = 1) => {
  for (const el of els) {
    fn(el, scale);
    if (el.kind === 'group') walk(el.children, fn, scale * (el.width / (el.nativeWidth || el.width)));
  }
};

// A recoloured element needs its own encoded asset — different elements can
// share a media id but recolour it differently — so entries are keyed by
// assetKey(media, recolor), not the bare media id. Shape pattern fills and
// effect-video overlays never carry a recolour, so their key is the media id.
export function assetKey(mediaId, recolor) {
  if (!recolor || !Object.keys(recolor).length) return mediaId;
  const canon = JSON.stringify(Object.fromEntries(Object.entries(recolor).map(([k, v]) => [k.toLowerCase(), v.toLowerCase()]).sort()));
  return `${mediaId}@${crypto.createHash('sha1').update(canon).digest('hex').slice(0, 8)}`;
}
const toHex = (c) => {
  if (c.startsWith('#')) return c.toLowerCase();
  const [r, g, b] = c.match(/\d+/g).map(Number);
  return '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
};
export function applyRecolor(color, map) { const hex = toHex(color); return (map && map[hex]) || hex; }
export function recolorSvg(svg, map) {
  return svg.replace(/#[0-9a-fA-F]{6}\b/g, (hex) => map[hex.toLowerCase()] || hex);
}

export function usedMedia(model) {
  const used = new Map();
  const note = (media, recolor, width) => {
    const key = assetKey(media, recolor);
    const cur = used.get(key) || { media, recolor: recolor || null, maxWidth: 0 };
    cur.maxWidth = Math.max(cur.maxWidth, width);
    used.set(key, cur);
  };
  for (const p of model.pages) for (const s of p.sections) walk(s.elements, (el, k) => {
    if (el.kind === 'image') note(el.media, el.recolor, el.crop.width * k);
    if (el.kind === 'shape') for (const path of el.paths) if (path.fill.media) note(path.fill.media, null, (path.fill.crop.width / el.viewBox.width) * el.width * k);
    if (el.anim?.params.video) note(el.anim.params.video, null, el.width * k);
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

// A recoloured SVG is content that never existed on disk, so it is named by
// the content hash of the recoloured text itself, not the source file.
function writeRecoloredSvg(src, recolor) {
  const text = recolorSvg(fs.readFileSync(src, 'utf8'), recolor);
  const out = path.join(ASSETS, crypto.createHash('sha1').update(text).digest('hex').slice(0, 12) + '.svg');
  if (!fs.existsSync(out)) fs.writeFileSync(out, text);
  return out;
}

export function spriteRect(sheetWidth, sheetHeight, wide, high, k) {
  const w = sheetWidth / wide, h = sheetHeight / high;
  return { x: (k % wide) * w, y: Math.floor(k / wide) * h, w, h };
}

// Runs in a browser page: luminance of each sprite is that layer's alpha.
// `recolor` (a plain hex->hex map, or null) travels with the page.evaluate
// argument since this function is re-serialised into the browser and cannot
// close over assets.mjs's own applyRecolor — so hex handling is reimplemented
// locally here. NOTE: recolorHex/hexToRgb below are a hand-copy of
// applyRecolor/toHex's logic for the hex-already-lower-case case; if
// applyRecolor's hex handling ever changes, update this in-page copy too.
const COMPOSITE = async ({ dataUrl, sprites, recolor }) => {
  const img = new Image(); img.src = dataUrl; await img.decode();
  const W = img.naturalWidth / sprites.wide, H = img.naturalHeight / sprites.high;
  const out = document.createElement('canvas'); out.width = W; out.height = H; const ctx = out.getContext('2d');
  const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H; const t = tmp.getContext('2d');
  const read = (k) => { t.clearRect(0, 0, W, H); t.drawImage(img, (k % sprites.wide) * W, Math.floor(k / sprites.wide) * H, W, H, 0, 0, W, H); return t.getImageData(0, 0, W, H); };
  const recolorHex = (hex) => (recolor && recolor[hex]) || hex;
  const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const channels = {};
  sprites.layers.forEach((l, k) => { if (l.type.startsWith('background-')) channels[l.type.slice(-1)] = read(k).data; });
  // Draw the base whenever ANY background-* channel exists — a lone
  // background-a layer (alpha only, implicit black fill) is common and must
  // still be drawn, so the base is never gated on channels.a alone. Missing
  // r/g/b default to black (recoloured through the map when the map has an
  // entry for #000000); missing alpha defaults to fully opaque.
  if (channels.a || channels.r || channels.g || channels.b) {
    const [br, bg, bb] = hexToRgb(recolorHex('#000000'));
    const d = t.createImageData(W, H), p = d.data;
    for (let i = 0; i < p.length; i += 4) {
      p[i] = channels.r ? channels.r[i] : br;
      p[i + 1] = channels.g ? channels.g[i] : bg;
      p[i + 2] = channels.b ? channels.b[i] : bb;
      p[i + 3] = channels.a ? channels.a[i] : 255;
    }
    t.putImageData(d, 0, 0); ctx.drawImage(tmp, 0, 0);
  }
  sprites.layers.forEach((l, k) => {
    if (l.type !== 'recolor') return;
    const [lr, lg, lb] = l.color.match(/\d+/g).map(Number);
    const hex = '#' + [lr, lg, lb].map((n) => n.toString(16).padStart(2, '0')).join('');
    const [r, g, b] = hexToRgb(recolorHex(hex));
    const d = read(k), p = d.data;
    for (let i = 0; i < p.length; i += 4) { const lum = p[i]; p[i] = r; p[i + 1] = g; p[i + 2] = b; p[i + 3] = lum; }
    t.putImageData(d, 0, 0); ctx.drawImage(tmp, 0, 0);
  });
  return out.toDataURL('image/png');
};

let browserPromise = null;
export async function compositeSheet(pngPath, sprites, outPath, recolor = null) {
  browserPromise ||= chromium.launch();
  const page = await (await browserPromise).newPage();
  try {
    const dataUrl = `data:image/png;base64,${fs.readFileSync(pngPath).toString('base64')}`;
    const result = await page.evaluate(COMPOSITE, { dataUrl, sprites, recolor });
    fs.writeFileSync(outPath, Buffer.from(result.split(',')[1], 'base64'));
  } finally { await page.close(); }
}
export async function closeCompositor() { if (browserPromise) { await (await browserPromise).close(); browserPromise = null; } }

// Cache file name includes what was composited (the sprite layout and any
// recolour map), not just the source basename, so a recoloured variant never
// collides with the plain composite (or another element's different map)
// for the same source spritesheet.
export function compositeCacheName(src, sprites, recolor) {
  const hash = crypto.createHash('sha1').update(JSON.stringify({ sprites, recolor: recolor || null })).digest('hex').slice(0, 8);
  return `${path.basename(src)}.${hash}.composite.png`;
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

// Bytes a single page pulls: its media plus the font faces its text uses.
export function pageBytes(model, manifest, slug) {
  const page = model.pages.find((p) => p.slug === slug);
  const sub = { ...model, pages: [page] };
  const files = new Set();
  for (const id of usedMedia(sub).keys()) { const m = manifest.media[id]; files.add(m.src); if (m.poster) files.add(m.poster); }
  for (const face of planFonts(sub)) files.add(manifest.fonts[face.key].src);
  let total = 0;
  for (const f of files) total += fs.statSync(path.join(INVITE, f)).size;
  return total;
}

export async function buildAssets(model) {
  fs.mkdirSync(ASSETS, { recursive: true });
  const manifest = { media: {}, fonts: {} };
  try {
    for (const [key, use] of usedMedia(model)) {
      const m = model.media[use.media];
      // Recolouring is only implemented for spritesheets (layer colours) and
      // SVGs (fill hex replacement) — a plain raster still, a GIF or a video
      // has no recolour path, so fail loud instead of silently shipping the
      // un-recoloured image.
      if (use.recolor && m.mime !== 'image/svg+xml' && !m.sprites) {
        throw new Error(`recolour on a plain raster ${key} is not supported`);
      }
      const src = await download(m.url);
      let out, kind = 'image', poster = null;
      if (m.mime === 'image/svg+xml') out = use.recolor ? writeRecoloredSvg(src, use.recolor) : await copyThrough(src, '.svg');
      else if (m.type === 'raster' || m.type === 'vector') {
        let stillSrc = src;
        if (m.sprites) {
          const flat = path.join(CACHE, compositeCacheName(src, m.sprites, use.recolor));
          if (!fs.existsSync(flat)) await compositeSheet(src, m.sprites, flat, use.recolor);
          stillSrc = flat;
        }
        out = await encodeStill(stillSrc, use.maxWidth, m.width);
      }
      else if (m.url.endsWith('.gif')) { out = await encodeAnimated(src); kind = 'anim'; }
      else {
        out = await encodeVideo(src); kind = 'video';
        if (m.poster) poster = path.relative(INVITE, await encodeStill(await download(m.poster), use.maxWidth, m.width)).replace(/\\/g, '/');
      }
      manifest.media[key] = { src: path.relative(INVITE, out).replace(/\\/g, '/'), width: m.width, height: m.height, kind, ...(poster && { poster }) };
    }
    for (const face of planFonts(model)) {
      const src = await download(face.url);
      const out = path.join(ASSETS, 'fonts', hashName(src, path.extname(face.url).toLowerCase()));
      fs.mkdirSync(path.dirname(out), { recursive: true });
      if (!fs.existsSync(out)) fs.copyFileSync(src, out);
      manifest.fonts[face.key] = { family: face.family, src: path.relative(INVITE, out).replace(/\\/g, '/'), weight: face.weight, italic: face.italic };
    }
    fs.writeFileSync(path.join(BUILD, 'assets.json'), JSON.stringify(manifest, null, 1));
  } finally {
    await closeCompositor();
  }
  return manifest;
}

if (isMain(import.meta.url)) {
  const model = JSON.parse(fs.readFileSync(path.join(BUILD, 'model.json'), 'utf8'));
  const manifest = await buildAssets(model);
  const total = fs.readdirSync(ASSETS, { recursive: true }).reduce((n, f) => { const p = path.join(ASSETS, f); return n + (fs.statSync(p).isFile() ? fs.statSync(p).size : 0); }, 0);
  console.log(`media=${Object.keys(manifest.media).length} fonts=${Object.keys(manifest.fonts).length} assets=${(total / 1e6).toFixed(1)}MB`);
  if (total > 12e6) { console.error('assets exceed the 12 MB budget'); process.exit(1); }
  const envelope = pageBytes(model, manifest, 'envelope');
  console.log(`envelope page ${(envelope / 1e6).toFixed(2)}MB`);
  if (envelope > 1.5e6) { console.error('envelope page exceeds the 1.5 MB budget'); process.exit(1); }
}
