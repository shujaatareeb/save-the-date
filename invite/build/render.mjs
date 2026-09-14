// invite/build/render.mjs — model + assets + recorded animations → index.html, invite.css.
//
//   node invite/build/render.mjs
//
// Every element is an absolutely positioned box in design pixels inside a
// 1366-wide .stage; invite.js scales the stage per section at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, INVITE, isMain, round as r } from './lib.mjs';
import { assetKey } from './assets.mjs';

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
  if (!a) return { cls: '', style: '' };
  const del = `--del:${Math.max(0, a.startMs - (ctx.sectionStart || 0))}ms;`;
  if (!a.loop) {
    const g = ctx.groupFor('once', a.frames, null);
    return { cls: ` an ${g.name}`, style: `--dur:${a.durationMs}ms;${del}` };
  }
  // A loop splits into an entrance (played once) and an idle sway (played
  // forever, alternating) — either part may be absent (see splitLoop).
  if (a.entrance && a.idle) {
    const g = ctx.groupFor('split', a.entrance, a.idle);
    return { cls: ` an ${g.name}`, style: `--dur:${a.entranceMs}ms;--idur:${a.idleMs}ms;${del}` };
  }
  if (a.entrance) {
    // Nothing to sway once settled: play the entrance and hold, like a non-loop entry.
    const g = ctx.groupFor('once', a.entrance, null);
    return { cls: ` an ${g.name}`, style: `--dur:${a.entranceMs}ms;${del}` };
  }
  const g = ctx.groupFor('idleOnly', null, a.idle);
  return { cls: ` an ${g.name}i`, style: `--dur:${a.idleMs}ms;${del}` };
}

function open(el, cls, ctx, extraStyle = '') {
  const an = animAttrs(el, ctx);
  const tag = el.link ? 'a' : 'div';
  const href = el.link ? ` href="${attr(el.link)}"${el.link.startsWith('#') ? '' : ' target="_blank" rel="noopener"'}` : '';
  return `<${tag}${href} class="el ${cls}${an.cls}" data-id="${attr(el.id)}" style="${baseStyle(el)}${an.style}${extraStyle}">`;
}
const close = (el) => (el.link ? '</a>' : '</div>');

function mediaTag(key, crop, ctx, extra = '') {
  const m = ctx.assets.media[key];
  if (!m) throw new Error(`no asset for media ${key}`);
  const style = `left:${px(crop.left)};top:${px(crop.top)};width:${px(crop.width)};height:${px(crop.height)};`;
  if (m.kind === 'video') {
    const src = ctx.eager ? `src="${m.src}"` : `data-src="${m.src}"`;
    return `<video ${src} autoplay muted loop playsinline${m.poster ? ` poster="${m.poster}"` : ''} style="${style}${extra}"></video>`;
  }
  const src = ctx.eager ? `src="${m.src}"` : `data-src="${m.src}" loading="lazy"`;
  return `<img ${src} width="${m.width}" height="${m.height}" alt="" decoding="async" style="${style}${extra}">`;
}

// #rrggbb -> [r,g,b]; also accepts the 3-digit shorthand.
function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toRgba = (hex, alpha) => { const [rr, g, b] = hexToRgb(hex); return `rgba(${rr},${g},${b},${r(alpha, 2)})`; };

// Approximates Canva's five text effects at sane sizes (fontSize is the run's
// declared size — the block's own scale-to-box transform applies on top).
// shadow/echo offsets are capped at 1 (Canva stores them well past 1) before
// being scaled down to at most half an em; lift and its blur are plain em
// units so they track font-size for free.
export function textEffects(effects, fontSize) {
  const shadowParts = [];
  let stroke = '', background = '';
  for (const e of effects || []) {
    if (e.type === 'shadow') {
      const rad = ((parseFloat(e.angle) || 0) * Math.PI) / 180;
      const d = Math.min(parseFloat(e.offset) || 0, 1) * 0.5 * fontSize;
      const dx = r(Math.cos(rad) * d), dy = r(-Math.sin(rad) * d);
      const blurPx = r((parseFloat(e.blur) || 0) * 0.1 * fontSize);
      const alpha = 1 - (parseFloat(e.transparency) || 0);
      shadowParts.push(`${dx}px ${dy}px ${blurPx}px ${toRgba(e.color, alpha)}`);
    } else if (e.type === 'lift') {
      const i = parseFloat(e.intensity) || 1;
      shadowParts.push(`0 0.05em 0.12em rgba(0,0,0,${r(0.35 * i, 2)})`);
    } else if (e.type === 'echo') {
      const rad = ((parseFloat(e.angle) || 0) * Math.PI) / 180;
      const d = Math.min(parseFloat(e.offset) || 0, 1) * 0.5 * fontSize;
      const dx = r(Math.cos(rad) * d), dy = r(-Math.sin(rad) * d);
      shadowParts.push(`${dx}px ${dy}px ${toRgba(e.color, 1)}`);
      shadowParts.push(`${r(dx * 2)}px ${r(dy * 2)}px ${toRgba(e.color, 0.5)}`);
    } else if (e.type === 'outline') {
      const thick = r((parseFloat(e.thickness) || 0) * 0.05 * fontSize, 2);
      stroke = `-webkit-text-stroke:${thick}px ${e.color || '#000'};paint-order:stroke fill;`;
    } else if (e.type === 'background') {
      const alpha = parseFloat(e.transparency);
      const a = Number.isFinite(alpha) ? Math.min(Math.max(alpha, 0), 1) : 1;
      const spread = parseFloat(e.spread) || 0;
      const roundness = parseFloat(e.roundness) || 0;
      background = `background:${toRgba(e.color, a)};padding:${r(0.1 * spread, 3)}em ${r(0.25 * spread, 3)}em;border-radius:${r(0.5 * roundness, 3)}em;box-decoration-break:clone;`;
    }
  }
  return { shadow: shadowParts.length ? `text-shadow:${shadowParts.join(',')};` : '', stroke, background };
}

function runStyle(run, backgroundCss) {
  let s = `font-family:'f-${run.font}-${run.styleIndex}',serif;font-size:${px(run.size)};font-weight:${run.weight};font-style:${run.italic ? 'italic' : 'normal'};color:${run.color};`;
  if (run.letterSpacing) s += `letter-spacing:${run.letterSpacing};`;
  if (run.decoration && run.decoration !== 'none') s += `text-decoration:${run.decoration};`;
  if (run.transform && run.transform !== 'none') s += `text-transform:${run.transform};`;
  if (run.super) s += `vertical-align:super;font-size:0.6em;`;
  if (backgroundCss) s += backgroundCss;
  return s;
}

// Returns the block's `.tin`-ready pieces: `style` (text-align/line-height/
// shadow/stroke, meant for the `.tin` wrapper) and `inner` (the `.tin`
// wrapper's own width/height/scale, laying the block out at its natural size
// and scaling it into its box — Canva's exact line breaks then hold). A block
// with no naturals (shape text) gets `width:100%` and no transform.
export function renderTextBlock(block, effects) {
  const first = block.runs[0] || {};
  const fx = textEffects(effects, first.size || 16);
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
      const span = `<span style="${runStyle(run, fx.background)}">${escapeHtml(piece)}</span>`;
      line += run.link ? `<a href="${attr(run.link)}">${span}</a>` : span;
    }
    lines.push(`<span class="ln">${line || '&nbsp;'}</span>`);
  }
  const style = `text-align:${first.align || 'center'};line-height:${first.lineHeight || '1.2em'};${fx.shadow}${fx.stroke}`;
  const sx = block.naturalWidth ? r(block.width / block.naturalWidth, 4) : null;
  const sy = block.naturalHeight ? r(block.height / block.naturalHeight, 4) : null;
  const inner = sx && sy ? `width:${px(block.naturalWidth)};height:${px(block.naturalHeight)};transform:scale(${sx},${sy});` : 'width:100%;';
  return { style, html: lines.join(''), inner };
}

export function renderElement(el, ctx) {
  if (el.kind === 'image') {
    const overlay = el.anim?.params?.video && ctx.assets.media[el.anim.params.video]
      ? mediaTag(el.anim.params.video, { left: 0, top: 0, width: el.width, height: el.height }, ctx, 'mix-blend-mode:screen;pointer-events:none;')
      : '';
    return `${open(el, 'img', ctx)}${mediaTag(assetKey(el.media, el.recolor), el.crop, ctx)}${overlay}${close(el)}`;
  }
  if (el.kind === 'text') {
    const { style, html, inner } = renderTextBlock(el, el.effects);
    return `${open(el, 'txt', ctx)}<div class="tin" style="${inner}${style}">${html}</div>${close(el)}`;
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
.txt{overflow-wrap:break-word}.txt a{color:inherit;text-decoration:inherit}.ln{display:block}
.txt>.tin{position:absolute;left:0;top:0;transform-origin:0 0;white-space:pre-wrap}
a.el{display:block;text-decoration:none;color:inherit}
.grp>.gin{position:absolute;left:0;top:0;transform-origin:0 0}
.shp>svg{display:block;width:100%;height:100%;overflow:visible}.stxt{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center}
.el.an{opacity:0;animation-fill-mode:both;animation-timing-function:linear;animation-duration:var(--dur,800ms);animation-delay:var(--del,0ms)}
.cd{display:flex;align-items:center;justify-content:center;color:#4b3822;font-family:'f-${COUNTDOWN_FACE}',serif}
.cd-row{display:flex;align-items:flex-start;gap:.15em;font-size:calc(var(--cd,238px)*.27);font-weight:700;line-height:1}
.cd-u{display:flex;flex-direction:column;align-items:center;min-width:1.3em}.cd-u b{font-weight:700;font-variant-numeric:tabular-nums}
.cd-u i{font-style:normal;font-size:.22em;letter-spacing:.1em;text-transform:uppercase;margin-top:.5em}.cd-row em{font-style:normal}
`;

const RESTING_FRAME = { t: 1, opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0, clip: null };

// A recording often opens with the hidden start state held for seconds until the
// element scrolled into view; the sampler records no frames during a hold, so the
// hold shows up as a large gap before frame 1. Start the entrance one sample before
// the first change.
export function trimLeadingHold(frames, durationMs, sampleMs = 40) {
  if (frames.length < 3 || frames[1].t <= 0.3) return { frames, durationMs };
  const t0 = Math.max(0, frames[1].t - sampleMs / durationMs);
  const span = 1 - t0 || 1;
  const out = [{ ...frames[0], t: 0 }, ...frames.slice(1).map((f, i, arr) => ({ ...f, t: i === arr.length - 1 ? 1 : r((f.t - t0) / span, 3) }))];
  return { frames: out, durationMs: Math.max(1, Math.round(durationMs * span)) };
}

// Sort an entry's frames by t ascending and drop any frame whose t equals the
// previous one's — the render must not depend on already-clean data.
function hygieneFrames(frames) {
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  return sorted.filter((f, i) => i === 0 || f.t !== sorted[i - 1].t);
}

// After hygiene, a frame array counts as invisible (and is skipped) when it
// never moves more than 0.5px, never scales outside 0.99..1.01, never blurs,
// and opacity stays within 0.02 of its final value. Shared by non-loop entries
// (against their whole timeline) and splitLoop (against just the idle tail).
function isInvisibleFrames(frames) {
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

// A recorded loop's frames read forward from wherever the sampler first saw
// them, but they always end at rest (record.mjs normalises every entry, loops
// included, against their last sample). Split them at the point the entrance
// is *revealed* — opacity, scale and blur at rest, and translate no wider
// than the idle sway itself gets (measured on the tail) plus a little slop —
// so a slide-in-then-slow-wide-sway loop plays its slide once instead of
// treating the whole sway as still-arriving because it never gets as close to
// rest as a fixed tolerance would demand. retime/tailAmplitude/settleIndex
// are its private helpers.
const retime = (frames) => { const t0 = frames[0].t, span = frames.at(-1).t - t0 || 1; return frames.map((f, i) => ({ ...f, t: i === 0 ? 0 : i === frames.length - 1 ? 1 : r((f.t - t0) / span, 3) })); };
function tailAmplitude(frames) {
  const tail = frames.slice(Math.floor(frames.length * 0.6));
  return Math.max(0, ...tail.map((f) => Math.max(Math.abs(f.dx), Math.abs(f.dy))));
}
function settleIndex(frames) {
  const rest = frames.at(-1);
  const amp = tailAmplitude(frames) + 3;
  const revealed = (f) => Math.abs(f.opacity - rest.opacity) <= 0.03 && Math.abs(f.scale - rest.scale) <= 0.01 && f.blur === rest.blur && Math.abs(f.dx) <= amp && Math.abs(f.dy) <= amp;
  let i = 0;
  while (i < frames.length - 1 && !revealed(frames[i])) i++;
  return i;
}
// entrance: frames 0..i re-timed to 0..1, or null when i is 0 (nothing to settle from).
// idle: frames i..end re-timed to 0..1, or null when the tail is too short or invisible.
// i (the settle index) is returned too, so a caller that also needs it (to split durationMs
// proportionally) doesn't have to walk the frames a second time.
export function splitLoop(frames) {
  const rest = frames.at(-1);
  const i = settleIndex(frames);
  const entrance = i > 0 ? retime(frames.slice(0, i + 1).map((f, k, arr) => (k === arr.length - 1 ? { ...rest, t: f.t } : f))) : null;
  const tail = frames.slice(i);
  const idle = tail.length >= 3 && !isInvisibleFrames(tail) ? retime(tail) : null;
  return { entrance, idle, i };
}

export function render(model, assets, anims) {
  // Every distinct (kind, entrance, idle) combination gets its own kN — keying on the full
  // shape (not just entrance) means two elements that happen to share an entrance but sway
  // differently afterward never collide on one name and clobber each other's idle keyframes.
  // kind is 'once' (plain one-shot: entrance holds the frames, idle is null), 'split' (entrance
  // then idle) or 'idleOnly' (idle holds the frames, entrance is null).
  const animGroups = new Map();
  const groupFor = (kind, entrance, idle) => {
    const key = JSON.stringify({ kind, entrance, idle });
    let g = animGroups.get(key);
    if (!g) { g = { name: `k${animGroups.size + 1}`, kind, entrance, idle }; animGroups.set(key, g); }
    return g;
  };

  // Resolve each element's animation entry once: its own entry by id, or —
  // when it has none but its model anim names an effect — the first entry
  // (in file order) with that same effect that is itself visible after
  // hygiene (an invisible donor is skipped in favour of the next one with
  // the same effect; if none is visible the element stays static).
  // animations.json itself is never modified.
  function processEntry(entry) {
    if (!entry.frames?.length) return null;
    const hygiened = hygieneFrames(entry.frames);
    const { frames, durationMs } = trimLeadingHold(hygiened, entry.durationMs);
    if (!entry.loop) {
      const snapped = frames.slice(0, -1).concat([RESTING_FRAME]);
      if (isInvisibleFrames(snapped)) return null;
      return { ...entry, frames: snapped, durationMs };
    }
    const { entrance, idle, i } = splitLoop(frames);
    if (!entrance && !idle) return null;
    const entranceMs = Math.round(durationMs * frames[i].t);
    const idleMs = durationMs - entranceMs;
    return { ...entry, frames, entrance, idle, entranceMs, idleMs, durationMs };
  }
  const processedById = new Map();
  for (const [id, entry] of Object.entries(anims)) processedById.set(id, processEntry(entry));
  const byEffect = new Map();
  for (const [id, entry] of Object.entries(anims)) {
    if (entry.effect == null || byEffect.has(entry.effect)) continue;
    const processed = processedById.get(id);
    if (processed) byEffect.set(entry.effect, processed);
  }
  const resolvedCache = new Map();
  function resolveAnim(el) {
    if (resolvedCache.has(el.id)) return resolvedCache.get(el.id);
    let result = null;
    if (anims[el.id]) {
      const own = processedById.get(el.id);
      if (own) result = { ...own, borrowed: false };
    } else if (el.anim?.effect != null) {
      const donor = byEffect.get(el.anim.effect);
      // A borrowed profile carries an unrelated element's timing — zero its
      // startMs so it doesn't skew this section's sectionStart, and mark it
      // so sectionStart's min-over-starts excludes it.
      if (donor) result = { ...donor, borrowed: true, startMs: 0 };
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
      const ctx = { assets, anims: elementAnims, eager, groupFor, sectionStart: starts.length ? Math.min(...starts) : 0 };
      const bg = s.background ? `background:${s.background};` : '';
      const c = s.content;
      const els = s.elements.map((e) => renderElement(e, ctx)).join('\n');
      return `<div class="sec" data-h="${r(s.height)}" data-cl="${r(c.left)}" data-cw="${r(c.width)}" style="--h:${px(s.height)};${bg}"><div class="stage">\n${els}\n</div></div>`;
    });
    sections.push(`<section class="page${eager ? ' active' : ''}" id="${page.slug}" data-page="${page.slug}" aria-label="${attr(page.title)}">\n${secs.join('\n')}\n</section>`);
  }
  const faces = Object.entries(assets.fonts).map(([key, f]) => `@font-face{font-family:'f-${key}';src:url(${f.src}) format('${path.extname(f.src) === '.woff2' ? 'woff2' : 'woff'}');font-weight:${f.weight};font-style:${f.italic ? 'italic' : 'normal'};font-display:swap}`);
  const animations = [...animGroups.values()].map((g) => {
    if (g.kind === 'split') {
      return `${keyframeCss(g.name, g.entrance)}\n${keyframeCss(`${g.name}i`, g.idle)}\n.${g.name}.in{animation-name:${g.name},${g.name}i;animation-duration:var(--dur),var(--idur);animation-delay:var(--del),calc(var(--del) + var(--dur));animation-iteration-count:1,infinite;animation-direction:normal,alternate;animation-fill-mode:both,forwards;animation-timing-function:linear,ease-in-out}`;
    }
    if (g.kind === 'idleOnly') {
      // Only animation-name/-iteration-count/-direction/-fill-mode/-timing-function are
      // overridden here; duration and delay fall through to the .el.an base rule's --dur/--del.
      return `${keyframeCss(`${g.name}i`, g.idle)}\n.${g.name}i.in{animation-name:${g.name}i;animation-iteration-count:infinite;animation-direction:alternate;animation-fill-mode:forwards;animation-timing-function:ease-in-out}`;
    }
    return `${keyframeCss(g.name, g.entrance)}\n.${g.name}.in{animation-name:${g.name}}`;
  });
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
