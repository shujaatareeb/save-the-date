// invite/build/render.mjs — model + assets + recorded animations → index.html, invite.css.
//
//   node invite/build/render.mjs
//
// Every element is an absolutely positioned box in design pixels inside a
// 1366-wide .stage; invite.js scales the stage per section at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, INVITE, isMain, round as r } from './lib.mjs';

const TITLE = 'Misbah &amp; Areeb — Wedding Invitation';
const DESCRIPTION = 'Misbah &amp; Areeb invite you to celebrate their wedding. Mehfil-e-Mehendi 8 October, Nikah and Dawat-e-Khaas 10 October 2026, Mumbai.';
const COUNTDOWN_FACE = 'YAFcfiBZ5y0-0'; // Fry's Baskerville, the closest face to the Canva widget

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const attr = (v) => escapeHtml(v);
const px = (n) => `${r(n)}px`;

function baseStyle(el) {
  let s = `left:${px(el.left)};top:${px(el.top)};width:${px(el.width)};height:${px(el.height)};`;
  if (el.rotation) s += `--rot:${r(el.rotation, 3)}deg;`;
  if (el.opacity < 1) s += `--op:${el.opacity};`;
  return s;
}

function animAttrs(el, ctx) {
  const a = ctx.anims[el.id];
  if (!a || !a.frames?.length) return { cls: '', style: '' };
  const name = ctx.keyframeName(a.frames);
  const loopCls = a.loop ? ' loop' : '';
  return { cls: ` an ${name}${loopCls}`, style: `--dur:${a.durationMs}ms;--del:${Math.max(0, a.startMs - (ctx.sectionStart || 0))}ms;` };
}

function open(el, cls, ctx, extraStyle = '') {
  const an = animAttrs(el, ctx);
  const tag = el.link ? 'a' : 'div';
  const href = el.link ? ` href="${attr(el.link)}"${el.link.startsWith('#') ? '' : ' target="_blank" rel="noopener"'}` : '';
  return `<${tag}${href} class="el ${cls}${an.cls}" data-id="${attr(el.id)}" style="${baseStyle(el)}${an.style}${extraStyle}">`;
}
const close = (el) => (el.link ? '</a>' : '</div>');

function mediaTag(id, crop, ctx, extra = '') {
  const m = ctx.assets.media[id];
  if (!m) throw new Error(`no asset for media ${id}`);
  const style = `left:${px(crop.left)};top:${px(crop.top)};width:${px(crop.width)};height:${px(crop.height)};`;
  if (m.kind === 'video') {
    const src = ctx.eager ? `src="${m.src}"` : `data-src="${m.src}"`;
    return `<video ${src} autoplay muted loop playsinline${m.poster ? ` poster="${m.poster}"` : ''} style="${style}${extra}"></video>`;
  }
  const src = ctx.eager ? `src="${m.src}"` : `data-src="${m.src}" loading="lazy"`;
  return `<img ${src} width="${m.width}" height="${m.height}" alt="" decoding="async" style="${style}${extra}">`;
}

function textShadow(effects, size) {
  const out = [];
  for (const e of effects || []) {
    const rad = ((parseFloat(e.angle) || 0) * Math.PI) / 180;
    const off = (parseFloat(e.offset) || 0) * size;
    const dx = r(Math.cos(rad) * off), dy = r(Math.sin(rad) * off);
    if (e.type === 'shadow') out.push(`${dx}px ${dy}px ${r((parseFloat(e.blur) || 0) * size * 0.1)}px ${e.color || '#000'}`);
    if (e.type === 'lift') { const i = parseFloat(e.intensity) || 1; out.push(`0 ${r(0.05 * size)}px ${r(0.12 * size * i)}px rgba(0,0,0,${r(0.35 * i)})`); }
    if (e.type === 'echo') out.push(`${dx}px ${dy}px ${e.color || '#000'},${dx * 2}px ${dy * 2}px ${e.color || '#000'}80`);
  }
  return out.length ? `text-shadow:${out.join(',')};` : '';
}

function runStyle(run) {
  let s = `font-family:'f-${run.font}-${run.styleIndex}',serif;font-size:${px(run.size)};font-weight:${run.weight};font-style:${run.italic ? 'italic' : 'normal'};color:${run.color};`;
  if (run.letterSpacing) s += `letter-spacing:${run.letterSpacing};`;
  if (run.decoration && run.decoration !== 'none') s += `text-decoration:${run.decoration};`;
  if (run.transform && run.transform !== 'none') s += `text-transform:${run.transform};`;
  return s;
}

export function renderTextBlock(block, effects) {
  const first = block.runs[0] || {};
  const lines = [];
  let pos = 0;
  for (const count of block.lines) {
    const start = pos, end = pos + count; pos = end;
    let line = '';
    for (const run of block.runs) {
      const a = Math.max(start, run.start), b = Math.min(end, run.end);
      if (b <= a) continue;
      const piece = block.text.slice(a, b).replace(/\n$/, '');
      if (!piece) continue;
      const span = `<span style="${runStyle(run)}">${escapeHtml(piece)}</span>`;
      line += run.link ? `<a href="${attr(run.link)}">${span}</a>` : span;
    }
    lines.push(`<span class="ln">${line || '&nbsp;'}</span>`);
  }
  const style = `text-align:${first.align || 'center'};line-height:${first.lineHeight || '1.2em'};${textShadow(effects, first.size || 16)}`;
  return { style, html: lines.join('') };
}

export function renderElement(el, ctx) {
  if (el.kind === 'image') {
    const overlay = el.anim?.params?.video && ctx.assets.media[el.anim.params.video]
      ? mediaTag(el.anim.params.video, { left: 0, top: 0, width: el.width, height: el.height }, ctx, 'mix-blend-mode:screen;pointer-events:none;')
      : '';
    return `${open(el, 'img', ctx)}${mediaTag(el.media, el.crop, ctx)}${overlay}${close(el)}`;
  }
  if (el.kind === 'text') {
    const { style, html } = renderTextBlock(el, el.effects);
    return `${open(el, 'txt', ctx, style)}${html}${close(el)}`;
  }
  if (el.kind === 'group') {
    const sx = r(el.width / (el.nativeWidth || el.width), 4), sy = r(el.height / (el.nativeHeight || el.height), 4);
    const inner = el.children.map((c) => renderElement(c, ctx)).join('');
    return `${open(el, 'grp', ctx)}<div class="gin" style="width:${px(el.nativeWidth)};height:${px(el.nativeHeight)};transform:scale(${sx},${sy})">${inner}</div>${close(el)}`;
  }
  if (el.kind === 'shape') {
    const { width: W, height: H } = el.viewBox;
    let defs = '', paths = '';
    el.paths.forEach((p, i) => {
      if (p.fill.media) {
        const m = ctx.assets.media[p.fill.media];
        if (!m) throw new Error(`no asset for media ${p.fill.media}`);
        const id = `p-${el.id}-${i}`;
        const c = p.fill.crop;
        const hrefAttr = ctx.eager ? `href="${m.src}"` : `data-href="${m.src}"`;
        defs += `<pattern id="${id}" patternUnits="userSpaceOnUse" x="0" y="0" width="${r(W)}" height="${r(H)}"><image ${hrefAttr} x="${r(c.left)}" y="${r(c.top)}" width="${r(c.width)}" height="${r(c.height)}" preserveAspectRatio="none"/></pattern>`;
        paths += `<path d="${attr(p.d)}" fill="url(#${id})"/>`;
      } else {
        paths += `<path d="${attr(p.d)}" fill="${attr(p.fill.color)}"/>`;
      }
    });
    const text = el.text ? (() => { const t = renderTextBlock(el.text, []); return `<div class="stxt" style="${t.style}">${t.html}</div>`; })() : '';
    return `${open(el, 'shp', ctx)}<svg viewBox="0 0 ${r(W)} ${r(H)}" preserveAspectRatio="none">${defs ? `<defs>${defs}</defs>` : ''}${paths}</svg>${text}${close(el)}`;
  }
  if (el.kind === 'embed') {
    const unit = (u, label) => `<div class="cd-u"><b data-cd="${u}">00</b><i>${label}</i></div>`;
    // --cd is the box height in design px; the stage's scale() does the rest.
    return `${open(el, 'cd', ctx, `--cd:${px(el.height)};`)}<div class="cd-row">${unit('d', 'Days')}<em>:</em>${unit('h', 'Hours')}<em>:</em>${unit('m', 'Mins')}<em>:</em>${unit('s', 'Secs')}</div>${close(el)}`;
  }
  throw new Error(`cannot render kind ${el.kind} (${el.id})`);
}

export function keyframeCss(name, frames) {
  const stops = frames.map((f) => {
    let s = `${r(f.t * 100, 1)}%{opacity:calc(var(--op,1)*${f.opacity});transform:translate(${r(f.dx)}px,${r(f.dy)}px) rotate(var(--rot,0deg)) scale(${f.scale});filter:blur(${f.blur}px)`;
    if (frames.some((x) => x.clip)) s += `;clip-path:${f.clip || 'inset(0)'}`;
    return s + '}';
  });
  return `@keyframes ${name}{${stops.join('')}}`;
}

const BASE_CSS = `
html,body{margin:0;background:#f4efe8;overflow-x:hidden;-webkit-text-size-adjust:100%}
main{position:relative;min-height:100vh}
.page{display:none}.page.active{display:block}
.sec{position:relative;overflow:hidden;width:100%;height:var(--h)}
.stage{position:absolute;left:0;top:0;width:1366px;transform-origin:0 0}
.el{position:absolute;box-sizing:border-box;transform:rotate(var(--rot,0deg));opacity:var(--op,1)}
.img{overflow:hidden}.img>img,.img>video{position:absolute;max-width:none;display:block}
.txt{white-space:pre-wrap;overflow-wrap:break-word}.txt a{color:inherit;text-decoration:inherit}.ln{display:block}
a.el{display:block;text-decoration:none;color:inherit}
.grp>.gin{position:absolute;left:0;top:0;transform-origin:0 0}
.shp>svg{display:block;width:100%;height:100%;overflow:visible}.stxt{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center}
.el.an{opacity:0;animation-fill-mode:both;animation-timing-function:linear;animation-duration:var(--dur,800ms);animation-delay:var(--del,0ms)}
.el.an.loop.in{animation-iteration-count:infinite;animation-direction:alternate}
.cd{display:flex;align-items:center;justify-content:center;color:#4b3822;font-family:'f-${COUNTDOWN_FACE}',serif}
.cd-row{display:flex;align-items:flex-start;gap:.15em;font-size:calc(var(--cd,238px)*.27);font-weight:700;line-height:1}
.cd-u{display:flex;flex-direction:column;align-items:center;min-width:1.3em}.cd-u b{font-weight:700;font-variant-numeric:tabular-nums}
.cd-u i{font-style:normal;font-size:.22em;letter-spacing:.1em;text-transform:uppercase;margin-top:.5em}.cd-row em{font-style:normal}
`;

const RESTING_FRAME = { t: 1, opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0, clip: null };

// Sort an entry's frames by t ascending and drop any frame whose t equals the
// previous one's — the render must not depend on already-clean data.
function hygieneFrames(frames) {
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  return sorted.filter((f, i) => i === 0 || f.t !== sorted[i - 1].t);
}

// After hygiene, an entry counts as invisible (and is skipped) when its
// frames never move more than 0.5px, never scale outside 0.99..1.01, never
// blur, and opacity stays within 0.02 of its final value.
function isInvisible(frames) {
  const finalOpacity = frames[frames.length - 1].opacity;
  let moved = false, scaled = false, blurred = false, opacityDrifted = false;
  for (const f of frames) {
    if (Math.abs(f.dx) > 0.5 || Math.abs(f.dy) > 0.5) moved = true;
    if (f.scale < 0.99 || f.scale > 1.01) scaled = true;
    if (f.blur) blurred = true;
    if (Math.abs(f.opacity - finalOpacity) > 0.02) opacityDrifted = true;
  }
  return !moved && !scaled && !blurred && !opacityDrifted;
}

export function render(model, assets, anims) {
  const keyframes = new Map();
  const keyframeName = (frames) => {
    const key = JSON.stringify(frames);
    if (!keyframes.has(key)) keyframes.set(key, `k${keyframes.size + 1}`);
    return keyframes.get(key);
  };

  // Resolve each element's animation entry once: its own entry by id, or —
  // when it has none but its model anim names an effect — the first entry
  // (in file order) with that same effect. Apply frame hygiene, snap
  // non-loop entries to rest, and drop entries that turn out invisible.
  // animations.json itself is never modified.
  const byEffect = new Map();
  for (const entry of Object.values(anims)) {
    if (entry.effect != null && !byEffect.has(entry.effect)) byEffect.set(entry.effect, entry);
  }
  const resolvedCache = new Map();
  function resolveAnim(el) {
    if (resolvedCache.has(el.id)) return resolvedCache.get(el.id);
    let entry = anims[el.id];
    let borrowed = false;
    if (!entry && el.anim?.effect != null) {
      entry = byEffect.get(el.anim.effect);
      borrowed = !!entry;
    }
    let result = null;
    if (entry && entry.frames?.length) {
      let frames = hygieneFrames(entry.frames);
      if (!entry.loop) frames = frames.slice(0, -1).concat([RESTING_FRAME]);
      // A borrowed profile carries an unrelated element's timing — zero its
      // startMs so it doesn't skew this section's sectionStart, and mark it
      // so sectionStart's min-over-starts excludes it.
      if (!isInvisible(frames)) result = { ...entry, frames, borrowed, startMs: borrowed ? 0 : entry.startMs };
    }
    resolvedCache.set(el.id, result);
    return result;
  }

  const sections = [];
  for (const page of model.pages) {
    const eager = page.slug === 'envelope';
    const secs = page.sections.map((s) => {
      const elementAnims = {};
      const walk = (els) => els.forEach((e) => {
        const a = resolveAnim(e);
        if (a) elementAnims[e.id] = a;
        if (e.children) walk(e.children);
      });
      walk(s.elements);
      const starts = Object.values(elementAnims).filter((a) => !a.borrowed).map((a) => a.startMs).filter((n) => n != null);
      const ctx = { assets, anims: elementAnims, eager, keyframeName, sectionStart: starts.length ? Math.min(...starts) : 0 };
      const bg = s.background ? `background:${s.background};` : '';
      const c = s.content;
      const els = s.elements.map((e) => renderElement(e, ctx)).join('\n');
      return `<div class="sec" data-h="${r(s.height)}" data-cl="${r(c.left)}" data-cw="${r(c.width)}" style="--h:${px(s.height)};${bg}"><div class="stage">\n${els}\n</div></div>`;
    });
    sections.push(`<section class="page${eager ? ' active' : ''}" id="${page.slug}" data-page="${page.slug}" aria-label="${attr(page.title)}">\n${secs.join('\n')}\n</section>`);
  }
  const faces = Object.entries(assets.fonts).map(([key, f]) => `@font-face{font-family:'f-${key}';src:url(${f.src}) format('${path.extname(f.src) === '.woff2' ? 'woff2' : 'woff'}');font-weight:${f.weight};font-style:${f.italic ? 'italic' : 'normal'};font-display:swap}`);
  const animations = [...keyframes.entries()].map(([k, name]) => `${keyframeCss(name, JSON.parse(k))}\n.${name}.in{animation-name:${name}}`);
  const css = [...faces, BASE_CSS.trim(), ...animations].join('\n');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>${TITLE}</title>
<meta name="description" content="${DESCRIPTION}">
<meta name="googlebot" content="noindex,nofollow">
<meta name="bingbot" content="noindex,nofollow">
<meta name="theme-color" content="#f4efe8">
<meta property="og:type" content="website">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="Mehfil-e-Mehendi, Nikah and Dawat-e-Khaas — all the details.">
<meta property="og:url" content="https://misbahxareeb.us.com/invite/">
<meta property="og:image" content="https://misbahxareeb.us.com/og.png?v=2">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="invite.css">
</head>
<body>
<main>
${sections.join('\n')}
</main>
<noscript><style>.page{display:block}.el.an{opacity:var(--op,1);animation:none}</style></noscript>
<script src="invite.js" defer></script>
</body>
</html>
`;
  return { html, css };
}

if (isMain(import.meta.url)) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(BUILD, f), 'utf8'));
  const { html, css } = render(read('model.json'), read('assets.json'), fs.existsSync(path.join(BUILD, 'animations.json')) ? read('animations.json') : {});
  fs.writeFileSync(path.join(INVITE, 'index.html'), html);
  fs.writeFileSync(path.join(INVITE, 'invite.css'), css);
  console.log(`index.html ${(html.length / 1024).toFixed(0)}KB  invite.css ${(css.length / 1024).toFixed(0)}KB`);
}
