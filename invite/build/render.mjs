// invite/build/render.mjs — model + assets + recorded animations → index.html, invite.css.
//
//   node invite/build/render.mjs
//
// Every element is an absolutely positioned box in design pixels inside a
// 1366-wide .stage; invite.js scales the stage per section at runtime.
import fs from 'node:fs';
import path from 'node:path';
import { BUILD, INVITE, isMain, round as r } from './lib.mjs';
import { assetKey, planFonts } from './assets.mjs';

const FONT_FORMATS = { '.woff2': 'woff2', '.woff': 'woff', '.ttf': 'truetype', '.otf': 'opentype' };
// A wrong format() hint lets a browser skip the source outright, so an unknown
// extension throws rather than guessing 'woff' at a file that is not woff.
function fontFormat(src) {
  const fmt = FONT_FORMATS[path.extname(src).toLowerCase()];
  if (!fmt) throw new Error(`unknown font format: ${src}`);
  return fmt;
}

const TITLE = 'Misbah &amp; Areeb — Wedding Invitation';
const DESCRIPTION = 'Misbah &amp; Areeb invite you to celebrate their wedding. Mehfil-e-Mehendi 8 October, Nikah and Dawat-e-Khaas 10 October 2026, Mumbai.';

export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const attr = (v) => escapeHtml(v);
const px = (n) => `${r(n)}px`;

function baseStyle(el) {
  let s = `left:${px(el.left)};top:${px(el.top)};width:${px(el.width)};height:${px(el.height)};`;
  if (el.rotation) s += `--rot:${r(el.rotation, 3)}deg;`;
  if (el.opacity < 1) s += `--op:${el.opacity};`;
  return s;
}

// Canva pulses its buttons — opacity 0.35↔1 every 1.1 s and, on most, scale
// 0.85↔1.14 every 0.9 s — without any animation on the element itself. The
// recorder cannot sample that fast and aliases it into a slow drift, so it is
// recognised by its signature instead: no effect on the element, a recorded
// loop, and an opacity floor at Canva's 0.35 (a little above where the
// sampler never quite caught the bottom). The pulse is then emitted as CSS.
export function isPulse(el, a) {
  if (el.anim?.effect || !a?.loop) return false;
  const floor = Math.min(...a.frames.map((f) => f.opacity));
  return floor >= 0.3 && floor <= 0.45;
}
const scaleSwing = (a) => Math.max(...a.frames.map((f) => f.scale)) - Math.min(...a.frames.map((f) => f.scale));
const pulseScales = (a) => scaleSwing(a) > 0.05;
// The two hearts (round the 10 on the home calendar and on the nikah card)
// beat on the live page — scale .85↔1.14 every .9 s, a quick swell and a slow
// release, no change in opacity — and are the only effect-2 elements whose
// recorded loop swings its scale by more than a whisker.
export function isHeartbeat(el, a) {
  return el.anim?.effect === 2 && !!a?.loop && scaleSwing(a) >= 0.2;
}
// The vinyl record on the home page turns for ever (17.7°/s on the live page).
// A loop whose rotation only ever grows — never turning back, more than a
// full turn over the window — is a spin; its speed over the settled part of
// the recording gives the period of one turn.
export function spinPeriodMs(a, settle) {
  if (!a?.loop) return 0;
  const drs = a.frames.map((f) => f.dr || 0);
  const steps = drs.slice(1).map((d, i) => d - drs[i]);
  if (!steps.length || !steps.every((d) => d > 0) || drs.at(-1) - drs[0] < 360) return 0;
  const from = a.frames[settle], to = a.frames.at(-1);
  const rate = (to.dr || 0) - (from.dr || 0), span = a.durationMs * (to.t - from.t);
  return rate > 0 && span > 0 ? Math.round((360 * span) / rate) : 0;
}

function animAttrs(el, ctx) {
  const a = ctx.anims[el.id];
  if (!a) return { cls: '', style: '' };
  if (isPulse(el, a)) { ctx.pulses.used = true; return { cls: pulseScales(a) ? ' pl pls' : ' pl', style: '' }; }
  const del = `--del:${Math.max(0, a.startMs - (ctx.sectionStart || 0))}ms;`;
  // Write-on: characters fade in one after another, 72 ms apart (measured on
  // the live page for both such texts), each for as long as the recorder saw
  // the first one take. No block keyframes on top.
  if (a.writeOn) { ctx.pulses.writeOn = true; return { cls: ' an wr', style: `--dur:${Math.max(300, a.durationMs)}ms;${del}--step:72ms;` }; }
  if (!a.loop) {
    const g = ctx.groupFor('once', a.frames);
    return { cls: ` an ${g.name}`, style: `--dur:${a.durationMs}ms;${del}` };
  }
  // A loop is its entrance, played once and held (see processEntry); the two
  // hearts beat on after theirs.
  const g = ctx.groupFor('once', a.entrance);
  if (a.spinMs) { ctx.pulses.spin = true; return { cls: ` an ${g.name} sp`, style: `--dur:${a.entranceMs}ms;${del}--kf:${g.name};--spin:${a.spinMs}ms;` }; }
  if (isHeartbeat(el, a)) { ctx.pulses.heartbeat = true; return { cls: ` an ${g.name} hb`, style: `--dur:${a.entranceMs}ms;${del}--kf:${g.name};` }; }
  return { cls: ` an ${g.name}`, style: `--dur:${a.entranceMs}ms;${del}` };
}

function open(el, cls, ctx, extraStyle = '', extraAttrs = '', animate = true) {
  const an = animate ? animAttrs(el, ctx) : { cls: '', style: '' };
  const tag = el.link ? 'a' : 'div';
  const href = el.link ? ` href="${attr(el.link)}"${el.link.startsWith('#') ? '' : ' target="_blank" rel="noopener"'}` : '';
  return `<${tag}${href} class="el ${cls}${an.cls}" data-id="${attr(el.id)}"${extraAttrs} style="${baseStyle(el)}${an.style}${extraStyle}">`;
}
const close = (el) => (el.link ? '</a>' : '</div>');

// A still that has a phone encoding is offered at both through srcset, with
// a sizes formula that is the scaler's own rule for the section: the picture
// is drawn `dw` design px wide (its crop, times any group scale), and the
// section scales by (vw − 2·PAD) / cw until the column fits, then 1. The
// browser then picks by real device pixels. Lazy pages carry the same as
// data attributes for the runtime to swap in.
function mediaTag(key, crop, ctx, extra = '') {
  const m = ctx.assets.media[key];
  if (!m) throw new Error(`no asset for media ${key}`);
  const style = `left:${px(crop.left)};top:${px(crop.top)};width:${px(crop.width)};height:${px(crop.height)};`;
  if (m.kind === 'video') throw new Error(`media ${key} is a video; only a matte may be one, and mattes go through matteAttrs`);
  const at = ctx.eager ? '' : 'data-';
  let srcs = `${at}src="${m.src}"`;
  if (m.srcS && ctx.cw) {
    const dw = crop.width * (ctx.k || 1);
    srcs += ` ${at}srcset="${m.srcS} ${m.ws}w, ${m.src} ${m.w}w" ${at}sizes="(max-width: ${Math.round(ctx.cw + 15)}px) calc((100vw - 16px) * ${r(dw / ctx.cw, 4)}), ${r(dw)}px"`;
  }
  if (!ctx.eager) srcs += ' loading="lazy"';
  return `<img ${srcs} width="${m.width}" height="${m.height}" alt="" decoding="async" style="${style}${extra}">`;
}

// #rrggbb -> [r,g,b]; also accepts the 3-digit shorthand.
function hexToRgb(hex) {
  const h = (hex || '#000000').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16) || 0;
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const toRgba = (hex, alpha) => { const [rr, g, b] = hexToRgb(hex); return `rgba(${rr},${g},${b},${r(alpha, 2)})`; };

// Canva's text effects, as the live page computes them (read off its
// text-shadow for eight effects across the deck; every one fits exactly):
//   · offset and blur are in sixteenths of the run's font size
//   · the angle turns from straight down: dx = -sin, dy = cos
//   · shadow "transparency" is the alpha as stored, not its complement
//   · echo is two copies, one and two steps out, at .5 and .3
//   · lift drops straight down 3/80 of the size; blur and alpha grow linearly
//     with intensity (blur .0375→.28125 of the size, alpha .05→.6)
// The block's own scale-to-box transform applies on top, as it does there.
const unit = (e, key, fontSize) => ((parseFloat(e[key]) || 0) * fontSize) / 16;
function angled(e, d) {
  const rad = ((parseFloat(e.angle) || 0) * Math.PI) / 180;
  return { dx: r(-Math.sin(rad) * d), dy: r(Math.cos(rad) * d) };
}
const clamp01 = (v, fallback) => (Number.isFinite(v) ? Math.min(Math.max(v, 0), 1) : fallback);

export function textEffects(effects, fontSize) {
  const shadowParts = [];
  let stroke = '', background = '';
  for (const e of effects || []) {
    if (e.type === 'shadow') {
      const { dx, dy } = angled(e, unit(e, 'offset', fontSize));
      const alpha = clamp01(parseFloat(e.transparency), 0.5);
      shadowParts.push(`${dx}px ${dy}px ${r(unit(e, 'blur', fontSize))}px ${toRgba(e.color, alpha)}`);
    } else if (e.type === 'lift') {
      const i = clamp01(parseFloat(e.intensity), 1);
      const dy = r(0.0375 * fontSize), blur = r((0.0375 + 0.24375 * i) * fontSize);
      shadowParts.push(`0px ${dy}px ${blur}px rgba(0,0,0,${r(0.05 + 0.55 * i, 3)})`);
    } else if (e.type === 'echo') {
      const { dx, dy } = angled(e, unit(e, 'offset', fontSize));
      shadowParts.push(`${dx}px ${dy}px ${toRgba(e.color, 0.5)}`);
      shadowParts.push(`${r(dx * 2)}px ${r(dy * 2)}px ${toRgba(e.color, 0.3)}`);
    } else if (e.type === 'outline') {
      const thick = r((parseFloat(e.thickness) || 0) * 0.05 * fontSize, 2);
      stroke = `-webkit-text-stroke:${thick}px ${attr(e.color || '#000')};paint-order:stroke fill;`;
    } else if (e.type === 'background') {
      const transparency = parseFloat(e.transparency);
      const a = Number.isFinite(transparency) ? Math.min(Math.max(1 - transparency, 0), 1) : 1;
      const spread = parseFloat(e.spread) || 0;
      const roundness = parseFloat(e.roundness) || 0;
      background = `background:${toRgba(e.color, a)};padding:${r(0.1 * spread, 3)}em ${r(0.25 * spread, 3)}em;border-radius:${r(0.5 * roundness, 3)}em;box-decoration-break:clone;`;
    }
  }
  return { shadow: shadowParts.length ? `text-shadow:${shadowParts.join(',')};` : '', stroke, background };
}

// Canva stores leading as a multiplier of the run's own font size ("0.74em").
// The .tin wrapper carries no font size, so an em value there resolves against
// the inherited 16px and collapses the lines onto each other — emit it in
// pixels against the first run instead. With nothing stored, `normal` lets
// each face supply its own metrics rather than inventing a flat multiplier.
export function blockLeading(first) {
  if (!first.lineHeight) return 'normal';
  const m = /^([\d.]+)em$/.exec(String(first.lineHeight).trim());
  if (!m) throw new Error(`unsupported line height: ${first.lineHeight}`);
  return px(parseFloat(m[1]) * (first.size || 16));
}

function runStyle(run, backgroundCss) {
  // A superscript run draws at 60% of its own size. As `0.6em` that would
  // resolve against the parent .ln rather than this run, so fold it in here.
  const size = run.super ? run.size * 0.6 : run.size;
  let s = `font-family:'f-${run.font}',serif;font-size:${px(size)};font-weight:${run.weight};font-style:${run.italic ? 'italic' : 'normal'};color:${run.color};`;
  if (run.letterSpacing) s += `letter-spacing:${run.letterSpacing};`;
  if (run.decoration && run.decoration !== 'none') s += `text-decoration:${run.decoration};`;
  if (run.transform && run.transform !== 'none') s += `text-transform:${run.transform};`;
  if (run.super) s += `vertical-align:super;`;
  if (backgroundCss) s += backgroundCss;
  return s;
}

// Returns the block's `.tin`-ready pieces: `style` (text-align/line-height/
// shadow/stroke, meant for the `.tin` wrapper) and `inner` (the `.tin`
// wrapper's own width/height/scale, laying the block out at its natural size
// and scaling it into its box — Canva's exact line breaks then hold). A block
// with no naturals (shape text) gets `width:100%` and no transform.
// `perChar` wraps every character (spaces included) in its own span numbered
// in reading order, for a write-on entrance (see animAttrs).
export function renderTextBlock(block, effects, perChar = false) {
  const first = block.runs[0] || {};
  const fx = textEffects(effects, first.size || 16);
  const lines = [];
  let pos = 0, ch = 0;
  for (const count of block.lines) {
    const start = pos, end = pos + count; pos = end;
    let line = '';
    for (const run of block.runs) {
      const a = Math.max(start, run.start), b = Math.min(end, run.end);
      if (b <= a) continue;
      const piece = block.text.slice(a, b).replace(/\n$/, '');
      if (!piece) continue;
      const text = perChar ? [...piece].map((c) => `<span class="ch" style="--i:${ch++}">${escapeHtml(c)}</span>`).join('') : escapeHtml(piece);
      const span = `<span style="${runStyle(run, fx.background)}">${text}</span>`;
      line += run.link ? `<a href="${attr(run.link)}">${span}</a>` : span;
    }
    lines.push(`<span class="ln">${line || '&nbsp;'}</span>`);
  }
  const style = `text-align:${first.align || 'center'};line-height:${blockLeading(first)};${fx.shadow}${fx.stroke}`;
  const sx = block.naturalWidth ? r(block.width / block.naturalWidth, 4) : null;
  const sy = block.naturalHeight ? r(block.height / block.naturalHeight, 4) : null;
  const inner = sx && sy ? `width:${px(block.naturalWidth)};height:${px(block.naturalHeight)};transform:scale(${sx},${sy});` : 'width:100%;';
  return { style, html: lines.join(''), inner };
}

// Canva's effect 30 carries a video that is not a picture but a luma matte —
// black to white over a second or three — which the live page composites over
// the element on a canvas so the picture wipes or blooms in. The build hands
// the runtime the matte's two encodings and nothing else: the recorded wrapper
// animation for such an element is only the recorder watching a canvas it
// could not see into, so it is dropped, and the matte is the whole entrance.
function matteAttrs(el, ctx) {
  const id = el.anim?.params?.video;
  const m = id && ctx.assets.media[id];
  if (!m) return '';
  if (m.kind !== 'video') throw new Error(`animation video ${id} on ${el.id} is not a video asset`);
  return ` data-matte="${m.src}"${m.mp4 ? ` data-matte-mp4="${m.mp4}"` : ''}`;
}

export function renderElement(el, ctx) {
  if (el.kind === 'image') {
    const matte = matteAttrs(el, ctx);
    return `${open(el, matte ? 'img mt' : 'img', ctx, '', matte, !matte)}${mediaTag(assetKey(el.media, el.recolor), el.crop, ctx)}${close(el)}`;
  }
  if (el.kind === 'text') {
    const { style, html, inner } = renderTextBlock(el, el.effects, !!ctx.anims[el.id]?.writeOn);
    return `${open(el, 'txt', ctx)}<div class="tin" style="${inner}${style}">${html}</div>${close(el)}`;
  }
  if (el.kind === 'group') {
    const sx = r(el.width / (el.nativeWidth || el.width), 4), sy = r(el.height / (el.nativeHeight || el.height), 4);
    const inner = el.children.map((c) => renderElement(c, { ...ctx, k: (ctx.k || 1) * sx })).join('');
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
  if (el.kind === 'embed') return `${open(el, 'cd', ctx)}${COUNTDOWN_SVG}${close(el)}`;
  throw new Error(`cannot render kind ${el.kind} (${el.id})`);
}

// A filter — even blur(0px) — keeps the element on a compositing layer of
// its own, so keyframes only carry one when some frame actually blurs.
export function keyframeCss(name, frames) {
  const blurs = frames.some((f) => f.blur > 0);
  const stops = frames.map((f) => {
    const rot = f.dr ? `rotate(calc(var(--rot,0deg) + ${r(f.dr, 1)}deg))` : 'rotate(var(--rot,0deg))';
    let s = `${r(f.t * 100, 1)}%{opacity:calc(var(--op,1)*${f.opacity});transform:translate(${r(f.dx)}px,${r(f.dy)}px) ${rot} scale(${f.scale})${blurs ? `;filter:blur(${f.blur}px)` : ''}`;
    if (frames.some((x) => x.clip)) s += `;clip-path:${f.clip || 'inset(0)'}`;
    return s + '}';
  });
  return `@keyframes ${name}{${stops.join('')}}`;
}

// Canva's button pulse (see isPulse), emitted once when any element uses it.
const PULSE_CSS = `.el.pl{animation:plo 1.11s ease-in-out infinite}.el.pl.pls{animation:plo 1.11s ease-in-out infinite,pls .9s ease-in-out infinite}
@keyframes plo{0%,100%{opacity:var(--op,1)}50%{opacity:calc(var(--op,1)*.35)}}
@keyframes pls{0%,100%{transform:rotate(var(--rot,0deg)) scale(.85)}34%{transform:rotate(var(--rot,0deg)) scale(1.14)}}`;

// The hearts' beat (see isHeartbeat): the pulse's scale half, taking over the
// transform once the recorded entrance has played out.
const HEARTBEAT_CSS = `.el.hb.in{animation-name:var(--kf),hb;animation-duration:var(--dur),.9s;animation-delay:var(--del),calc(var(--del) + var(--dur));animation-iteration-count:1,infinite;animation-direction:normal,normal;animation-fill-mode:both,none;animation-timing-function:linear,ease-in-out}
@keyframes hb{0%,100%{transform:rotate(var(--rot,0deg)) scale(.85)}34%{transform:rotate(var(--rot,0deg)) scale(1.14)}}`;

// A spin (see spinPeriodMs): one linear turn per --spin, from the moment the element enters.
const SPIN_CSS = `.el.sp.in{animation-name:var(--kf),sp;animation-duration:var(--dur),var(--spin);animation-delay:var(--del),0ms;animation-iteration-count:1,infinite;animation-direction:normal,normal;animation-fill-mode:both,none;animation-timing-function:linear,linear}
@keyframes sp{from{transform:rotate(var(--rot,0deg))}to{transform:rotate(calc(var(--rot,0deg) + 360deg))}}`;

// Canva's write-on text entrance (see animAttrs), emitted once when used.
const WRITE_ON_CSS = `.el.wr.in{opacity:var(--op,1);animation:none}
.el.wr .ch{opacity:0}.el.wr.in .ch{animation:wr var(--dur,800ms) linear both;animation-delay:calc(var(--del,0ms) + var(--i)*var(--step,72ms))}
@keyframes wr{from{opacity:0}to{opacity:1}}`;

// The countdown on the live page is a third-party widget: an 800×400 SVG with
// Abril Fatface digits 140 px tall on y 199.5 (the widget's odometer reels
// declare them at 94.5 and translate the reel), two per unit centred 80
// apart, colons between, 40 px labels on y 300, all #715449, under a
// letterpress filter
// (a lightened copy up-left, a darkened one down-right). This is that SVG,
// drawn by hand; the runtime writes the digits.
const COUNTDOWN_FILTER = (id, dx) => `<filter id="${id}" x="-50%" y="-100%" width="200%" height="300%"><feOffset in="SourceAlpha" dx="${-dx}" dy="${-dx}" result="topLeft"/><feComponentTransfer in="topLeft" result="lightShadow"><feFuncR type="linear" slope="1.5" intercept="0.2"/><feFuncG type="linear" slope="1.5" intercept="0.2"/><feFuncB type="linear" slope="1.5" intercept="0.2"/></feComponentTransfer><feOffset in="SourceAlpha" dx="${dx}" dy="${dx}" result="bottomRight"/><feComponentTransfer in="bottomRight" result="darkShadow"><feFuncR type="linear" slope="0.5" intercept="-0.2"/><feFuncG type="linear" slope="0.5" intercept="-0.2"/><feFuncB type="linear" slope="0.5" intercept="-0.2"/></feComponentTransfer><feMerge><feMergeNode in="lightShadow"/><feMergeNode in="darkShadow"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`;
const COUNTDOWN_SVG = (() => {
  const units = [['d', 60, 140], ['h', 260, 340], ['m', 460, 540], ['s', 660, 740]];
  const digits = units.map(([u, a, b]) => `<text data-cd="${u}" y="199.5" dominant-baseline="central" filter="url(#cd-fx-d)"><tspan x="${a}">0</tspan><tspan x="${b}">0</tspan></text>`);
  const colons = [200, 400, 600].map((x) => `<text x="${x}" y="199.5" dominant-baseline="central" filter="url(#cd-fx-d)">:</text>`);
  const labels = [[100, 'DAYS'], [300, 'HOURS'], [500, 'MINS'], [700, 'SECS']].map(([x, l]) => `<text x="${x}" y="300" dominant-baseline="central" filter="url(#cd-fx-l)">${l}</text>`);
  return `<svg viewBox="0 0 800 400" preserveAspectRatio="xMidYMid slice"><defs>${COUNTDOWN_FILTER('cd-fx-d', 2)}${COUNTDOWN_FILTER('cd-fx-l', 0)}</defs><g class="cd-l">${labels.join('')}</g><g class="cd-d">${digits.join('')}${colons.join('')}</g></svg>`;
})();

const BASE_CSS = `
html,body{margin:0;background:#f4efe8;overflow-x:hidden;-webkit-text-size-adjust:100%}
main{position:relative;min-height:100vh}
.page{display:none}.page.active{display:block}
.sec{position:relative;overflow:hidden;width:100%;height:var(--h);content-visibility:auto}
.stage{position:absolute;left:0;top:0;width:1366px;transform-origin:0 0}
.el{position:absolute;box-sizing:border-box;transform:rotate(var(--rot,0deg));opacity:var(--op,1)}
.img{overflow:hidden}.img>img,.img>video{position:absolute;max-width:none;display:block}
.txt{overflow-wrap:break-word}.txt a{color:inherit;text-decoration:inherit}.ln{display:block}
.txt>.tin{position:absolute;left:0;top:0;transform-origin:0 0;white-space:pre-wrap}
a.el{display:block;text-decoration:none;color:inherit}
.grp>.gin{position:absolute;left:0;top:0;transform-origin:0 0}
.shp>svg{display:block;width:100%;height:100%;overflow:visible}.stxt{position:absolute;inset:0;display:flex;flex-direction:column;justify-content:center;white-space:pre-wrap}
.el.an{opacity:0;animation-fill-mode:both;animation-timing-function:linear;animation-duration:var(--dur,800ms);animation-delay:var(--del,0ms)}
.el.an.done:not(.hb):not(.sp):not(.wr){animation:none;opacity:var(--op,1);transform:rotate(var(--rot,0deg))}
.el.mt:not(.in){opacity:0}.el.mt.mt-run>img{visibility:hidden}.el.mt>canvas{position:absolute;left:0;top:0;width:100%;height:100%;display:block;pointer-events:none}
.cd>svg{display:block;width:100%;height:100%;overflow:visible}
.cd text{text-anchor:middle;font-family:'f-countdown',serif;font-weight:400;fill:#715449;text-rendering:geometricPrecision;user-select:none}
.cd-d text{font-size:140px}.cd-l text{font-size:40px}
`;

const RESTING_FRAME = { t: 1, opacity: 1, dx: 0, dy: 0, scale: 1, blur: 0, clip: null }; // dr (rotation) absent = 0

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
    if (Math.abs(f.dx) > 0.5 || Math.abs(f.dy) > 0.5 || Math.abs(f.dr || 0) > 1) moved = true;
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
  // Every distinct entrance gets its own kN; elements with the same frames share one.
  const animGroups = new Map();
  const pulses = { used: false, writeOn: false, heartbeat: false, spin: false }; // which on-demand CSS blocks the deck needs
  const groupFor = (kind, entrance) => {
    const key = JSON.stringify({ kind, entrance });
    let g = animGroups.get(key);
    if (!g) { g = { name: `k${animGroups.size + 1}`, kind, entrance }; animGroups.set(key, g); }
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
    // A text the recorder saw in parts (one short-lived node per character) is
    // Canva's write-on: the frames belong to the earliest character alone and
    // only its length matters — every character fades that long, in turn.
    if (entry.parts) return { ...entry, writeOn: true };
    const hygiened = hygieneFrames(entry.frames);
    const { frames, durationMs } = trimLeadingHold(hygiened, entry.durationMs);
    if (!entry.loop) {
      const snapped = frames.slice(0, -1).concat([RESTING_FRAME]);
      if (isInvisibleFrames(snapped)) return null;
      const cappedDurationMs = frames.length === 2 && durationMs > 2000 ? 800 : durationMs;
      return { ...entry, frames: snapped, durationMs: cappedDurationMs };
    }
    // The recorder calls an entry a loop whenever the node kept changing until
    // the window closed — an entrance's long easing tail does that too. Sampled
    // on the live page, every "loop" in the deck but the two hearts sits still
    // once its entrance is over, and played as an alternating sway those tails
    // were a 2–5 Hz shake. So a loop is its entrance, played once and held; the
    // sway is dropped. (Hearts get their beat in animAttrs; see isHeartbeat.)
    const { entrance, i } = splitLoop(frames);
    if (!entrance) return null;
    const entranceMs = Math.round(durationMs * frames[i].t);
    const cappedEntranceMs = entrance.length === 2 && entranceMs > 2000 ? 800 : entranceMs;
    // A spin owns the transform from the first frame; its entrance keeps the fade only.
    const spinMs = spinPeriodMs({ ...entry, frames }, i);
    const frames2 = spinMs ? entrance.map(({ dr, ...f }) => f) : entrance;
    return { ...entry, frames, entrance: frames2, entranceMs: cappedEntranceMs, durationMs, spinMs };
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
      const c = s.content;
      const ctx = { assets, anims: elementAnims, eager, groupFor, pulses, cw: c.width, sectionStart: starts.length ? Math.min(...starts) : 0 };
      const bg = s.background ? `background:${s.background};` : '';
      const els = s.elements.map((e) => renderElement(e, ctx)).join('\n');
      return `<div class="sec" data-h="${r(s.height)}" data-cl="${r(c.left)}" data-cw="${r(c.width)}" style="--h:${px(s.height)};${bg}"><div class="stage">\n${els}\n</div></div>`;
    });
    sections.push(`<section class="page${eager ? ' active' : ''}" id="${page.slug}" data-page="${page.slug}" aria-label="${attr(page.title)}">\n${secs.join('\n')}\n</section>`);
  }
  // One family per Canva font id, every face in use declared under it with its
  // own weight and slant, so a run's font-weight/font-style pick the file the
  // way they do on the live page.
  const faces = Object.values(assets.fonts).map((f) => `@font-face{font-family:'f-${f.fontId}';src:url(${f.src}) format('${fontFormat(f.src)}');font-weight:${f.weight};font-style:${f.italic ? 'italic' : 'normal'};font-display:swap}`);
  const animations = [...animGroups.values()].map((g) => {
    if (g.kind !== 'once') throw new Error(`unexpected animation group kind ${g.kind}`);
    return `${keyframeCss(g.name, g.entrance)}\n.${g.name}.in{animation-name:${g.name}}`;
  });
  const css = [...faces, BASE_CSS.trim(), ...(pulses.used ? [PULSE_CSS] : []), ...(pulses.writeOn ? [WRITE_ON_CSS] : []), ...animations, ...(pulses.heartbeat ? [HEARTBEAT_CSS] : []), ...(pulses.spin ? [SPIN_CSS] : [])].join('\n');
  // The envelope's faces, a few KB each now, are worth asking for up front.
  const envelope = model.pages.find((p) => p.slug === 'envelope');
  const preloads = envelope ? [...new Set(planFonts({ ...model, pages: [envelope] }).map((f) => assets.fonts[f.key]?.src).filter(Boolean))].map((src) => `<link rel="preload" href="${src}" as="font" type="font/woff2" crossorigin>\n`).join('') : '';
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
${preloads}<link rel="stylesheet" href="invite.css">
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
