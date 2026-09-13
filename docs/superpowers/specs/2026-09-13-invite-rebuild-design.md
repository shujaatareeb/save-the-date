# Wedding invitation at `/invite` — layer-faithful rebuild of the Canva site

Date: 2026-09-13
Status: approved in conversation, pending written review

## Goal

Serve the Canva wedding invitation (`https://misbahareeb.my.canva.site/`) from
this repo at `https://misbahxareeb.us.com/invite/`, on GitHub Pages, with the
same layers, positions, fonts and per-element entrance animations as the Canva
original. Mobile first: phones are the primary viewer.

Canva cannot publish to a path on a domain it does not own, and its published
site refuses to be iframed (`frame-ancestors 'self' *.canva.com`), so the
content has to be rebuilt here.

## Source of truth

The published Canva page embeds its full design model in an inline script:

```
window['bootstrap'] = JSON.parse('...');
```

Keys are minified but stable. Verified against the rendered DOM:

| path | meaning |
|---|---|
| `page.A.A[]` | pages (9 in the export, 7 published) |
| `page.A.A[i].B` | page title (`Envelope`, `Save the date`, `Timeline`, `Mehendi`, `Nikah`, `Reception`, `Reception`, `Dress Code`, `Timeline`) |
| `page.A.A[i].a` | page id, matches `page.Z.g[].K` |
| `page.Z.g[]` | published routes, in order: id `K`, title `O`, slug `L` |
| `page.A.A[i].t[]` | sections, top to bottom |
| `…t[j].C` | section canvas `{A: width, B: height}` — width is always 1366 |
| `…t[j].D.C` | section background colour, optional |
| `…t[j].E[]` | elements, bottom to top (DOM order = z-order) |
| element `A?` | kind: `I` image, `K` text, `H` group, `J` embed / app |
| element `A`, `B` | top, left, canvas px |
| element `C`, `D` | height, width, canvas px |
| element `E` | rotation, degrees |
| element `F` | transparency, 0 = opaque |
| element `_` | element id |
| element `a.B.A.A` | media id for images |
| element `a.B.B` | crop rect `{A: left, B: top, C: width, D: height}` of the media inside the frame |
| text `a.C.C[]` | style runs: `C` font ref (`<fontId>,<weight index>`), `G` font size, `I` weight, `M` colour, `c` align, `0` text-transform, `q` font-style |
| `page.B[]` | fonts: `A` id, `C` family name, `D` files |
| `page.E[]` | media: `id`, `type` (`RASTER`), `files[]` with URLs at several sizes |
| `page.F[]` | animated stickers / video: `id`, `files[]`, `width`, `height`, `durationSeconds`, `posterframes` |

Still to decode in the extract step, with the rendered DOM as the oracle:
text string storage (`a.C.A`, `a.C.B`, `a.C.D`), group children (`H` elements'
`b` / `c`), links (`X` on buttons, hash targets like `#page-4`), and animation
descriptors (candidates: element `P`, `BA`–`BE`, `X`, `3`, `b`, `d`, `e`, `h`).
The extractor must fail loudly on anything it cannot classify.

Measured rendering rules of the Canva runtime:

- Desktop: canvas rendered 1:1, centred horizontally, background layers bleed.
- Mobile: the canvas is **not** scaled to the viewport. The runtime fits the
  content's bounding box to the viewport width (0.79 at 375px on the envelope
  page, whose content column is ~470 canvas px wide) and lets backgrounds crop
  at the sides.

## Architecture

Build-time generator. Node scripts run once and emit static files; nothing is
rendered from JSON in the browser.

```
invite/
  index.html          generated
  invite.css          generated
  invite.js           hand-written runtime, small, no dependencies
  assets/             optimised media + fonts, hash-named
  build/
    fetch.mjs         pull Canva HTML, extract bootstrap blob → canva.json
    extract.mjs       canva.json → model.json (clean, named keys)
    assets.mjs        download referenced media, resize, WebP, fonts, petals video
    render.mjs        model.json → index.html + invite.css
    canva.json        checked in (≈1.1 MB), so rebuilds are reproducible
    model.json        checked in
    cache/            raw downloads, gitignored
```

Re-running `fetch → extract → assets → render` regenerates everything when the
Canva design changes.

### model.json shape

```
{
  pages: [{ id, slug, title, sections: [{ width, height, background, elements }] }],
  elements: image | text | group | shape | embed
    common: { id, kind, top, left, width, height, rotation, opacity, link?, animation? }
    image:  { media, crop: { left, top, width, height } }
    text:   { runs: [{ text, font, size, weight, italic, color, transform }], align, lineHeight, letterSpacing }
    group:  { children: [element] }
    embed:  { provider, url }   // countdown app; rendered natively, never as iframe
  media:  { [id]: { width, height, src, type: 'raster' | 'video' } }
  fonts:  { [id]: { family, google: bool, files } }
}
```

### Rendering

- Each `<section>` has a fixed canvas: 1366 × design height. Inside it, one
  `.stage` div holds the elements, absolutely positioned in canvas px, scaled
  with `transform: scale(k)`, origin top centre.
- Images sit inside a crop frame (`overflow: hidden`), with the `<img>` offset
  and sized from the crop rect.
- Text is real text with the mapped font, size, weight, colour, letter-spacing,
  line-height, case and alignment from the model.
- Groups are nested divs carrying their own transform.
- Z-order is DOM order.
- Seven `<section data-page>`: `envelope`, `home`, `timeline`, `mehendi`,
  `nikah`, `reception`, `dress-code`. Slugs are stable; hash targets in the
  Canva links map onto them.
- Canva's own footer ("Designed with Canva", policy links) is dropped.

### Scaling rule (mobile first)

Per section, in `invite.js`:

```
contentBox = union of rects of non-background elements
             (background = element covering ≥ 90% of the section area)
k = clamp((viewportWidth − 2·12) / contentBox.width, kMin, 1)
section.style.height = designHeight · k
```

One rule, no breakpoints. Phones (~390px) get k ≈ 0.78 on the envelope page
and the content fills the width; desktops get k = 1, centred; tablets land in
between. `overflow: hidden` on the section clips the bleeding background, as
Canva does on mobile. Recomputed on resize.

### Assets

- Download only media that a published page references, at the largest size
  that is ≤ 2× the rendered size, convert to WebP, name by content hash.
- Fonts: map Canva family names to Google Fonts where the family is the same
  open font; otherwise self-host the woff2. Every face gets a fallback stack.
- Petals sticker (5.76 s) becomes a looping muted `<video>` (webm + mp4) with a
  poster frame, `pointer-events: none`.
- Budget: whole site < 12 MB, envelope page < 1.5 MB.
- Lazy per page: elements of inactive pages carry `data-src`; `src` is set
  when the page becomes active. Images also carry `loading="lazy"`.

### Animations

- Each element's Canva effect (rise, fade, pan, wipe, breathe, pop, …) maps to
  a CSS keyframe set; per-element delay and duration come from the model.
- Trigger: IntersectionObserver adds `.in` when the element enters the
  viewport, once. Envelope page plays on load.
- Unknown effect → fade + rise, logged at build time.
- Countdown: native JS, `DD:HH:MM:SS` with DAYS / HOURS / MINS / SECS labels,
  same frame image and font as the Canva embed, target
  `2026-10-10T00:00:00+05:30`, 1 s tick.

### Runtime `invite.js`

Router (hash → active page, scroll to top, browser back works, default
`#envelope`), scaler, reveal observer, countdown, lazy activation, petals
autoplay. No network calls beyond assets. With JS disabled every page renders
stacked in order; only the envelope click, countdown and per-element reveals
are lost.

### Failure handling

- Build: a missing media file fails the build naming the element; never a
  silent blank. Unknown element kinds render as an empty box with a data
  attribute and appear in a warning list at the end of the build.
- Runtime: blocked video autoplay leaves the poster frame; nothing throws.

## Testing

Existing Playwright harness, same port (8734) and style as `test/screenshots.mjs`.

- `test/invite-layout.mjs` — build, serve, load every page at 390 / 768 / 1366
  widths. Assert no horizontal scroll, every content element inside the
  viewport, k within expected range, no failed requests, no console errors.
- `test/invite-diff.mjs` — screenshot each page at 1366 and compare against
  reference screenshots of the Canva original captured once into `test/ref/`,
  loose threshold (5%) to catch gross layout breaks.
- `test/invite-shots.mjs` — mobile frames into `test/shots/invite/` for
  eyeballing.
- Build checks: 7 pages, expected element counts, every media and font
  resolved.

## Out of scope

- Editing the design itself; the Canva document stays the editing surface.
- RSVP, guest list, any backend.
- Linking `/` to `/invite/` (separate, later decision).

## Assumptions

- Countdown target is midnight IST, 10 October 2026.
- Canva element PNGs are reused as they appear in the published design
  (personal use of the couple's own published design).
- The vinyl record on the home page is decorative unless the model shows an
  audio element; if it does, it becomes tap-to-play.
