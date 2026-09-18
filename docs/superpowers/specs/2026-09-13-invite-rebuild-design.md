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
k = clamp((viewportWidth − 2·12) / contentBox.width, 0.25, 1)
section.style.height = designHeight · k
```

The lower bound only guards against a section whose content box is wider than
the canvas; every measured section stays well above it.

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

## As built

Where the shipped `invite/` departs from the sections above, and why. Every
item was checked against the live Canva page rather than assumed.

- **Scaling.** `PAD` is 8, not 12, and `k` on the envelope page at 390 wide is
  0.831. On a desktop the whole 1366 canvas is centred when it fits the
  viewport, as Canva does — centring the content column there put every page
  62 px right of the original and was most of what the home-page diff saw.
  The column is centred only when the viewport is narrower than the canvas
  (tablets), which is the case that rule was for.
- **Fonts.** All 13 faces are self-hosted from Canva's own files, kept as the
  WOFF (one OTF) they were served as rather than re-encoded to WOFF2; none
  are mapped to Google Fonts. Canva's run style names a font as `"<id>,<n>"`
  and `n` is not an index into the style list — the live page registers every
  style of a font under one family and lets `font-weight`/`font-style` choose.
  The build does the same: one `f-<id>` family per Canva font, each face in
  use declared under it with its weight and slant.
- **Text effects.** Shadow, echo and lift are sized as the live page computes
  them: offset and blur in sixteenths of the run's font size, the angle
  measured from straight down (`dx = −sin`, `dy = cos`), the stored
  `transparency` used as the alpha, echo as two copies at one and two steps
  (α .5 / .3), lift a straight drop of 3/80 of the size with blur and alpha
  growing linearly with intensity. Outline and background remain
  approximations. Canva also disables `calt`/`liga` and isolates every glyph
  in its own span; at 1:1 the glyphs and advances matched without that, so
  the build leaves the browser's defaults.
- **Effect 30 is a matte, not a sparkle.** The video on an effect-30 element
  is a luma matte (black to white) that Canva composites the picture through
  on a canvas. The runtime does the same: the matte plays off-DOM (VP9 WebM,
  with a baseline H.264 MP4 for iPhones), each frame's luma becomes the alpha
  of a small mask, and the picture is drawn onto a canvas over the element
  and cut to it; when the matte ends or cannot play, the plain `<img>` takes
  over. `mix-blend-mode` was never an option — WebKit ignores it on `<video>`.
- **Stickers.** The one animated sticker (petals) ships as an animated WebP at
  15 fps / 480 px, not a `<video>` — WebP carries alpha where VP9 in a
  `<video>` does not on Safari. No posters: the only videos are mattes and
  are never shown.
- **Animations.** Entrances come from recordings of the live page (Task 4),
  not from an effect-id → keyframe table, and an element the recorder has
  nothing for is simply shown static — the "fade + rise" fallback was
  dropped. A recorded *loop* is its entrance, played once and held: sampled
  on the live page, every one of the 21 loops in the deck but the two hearts
  sits still once its entrance is over (the recorder calls an entry a loop
  whenever the node kept changing until the window closed, which an
  entrance's easing tail does too), and played as sways those tails were a
  2–5 Hz shake. The things that do keep moving on the live page are each a
  rule of their own, measured there: the button pulse (opacity .35↔1 every
  1.1 s, scale .85↔1.14 every .9 s with a quick swell and slow release, on
  eleven buttons with no animation of their own — recognised by its
  signature), the two hearts (the pulse's scale half; effect 2 with a
  recorded scale swing ≥ .2), and the vinyl record (a loop whose recorded
  rotation only ever grows; one turn every 20.3 s at the recorded speed —
  the recorder now writes rotation). Two texts (effect 18) write on one
  character every 72 ms. Pages re-mount their entrances on every visit, as
  Canva does. An element's entrance waits for its own pictures.
- **Loading.** Once a page's own pictures are in, the pages it links to are
  warmed in a quiet moment, so the envelope tap lands on a painted home page
  (a lazy picture on a hidden page never fetches by itself; warming asks
  outright). Every still drawn smaller than its source ships at its drawn
  width as well as at 2×, offered through `srcset` with a `sizes` formula that
  is the scaler's rule for the section; phones take the small ones (home
  1.7 MB instead of 2.8, timeline 1.2 instead of 2.3), retina desktops the
  big. Faces are WOFF2 subsets of the characters they set (192 KB for all
  fourteen, from 1.47 MB); the envelope's are preloaded. On a 1.6 Mbps /
  150 ms phone the envelope is complete in 6.5 s (was 17.7) and home is
  warm behind it by 11.5 s. The envelope itself stays ~1.1 MB of pictures:
  its narrow column is zoomed to k .83 on a phone, which at 3× needs the big
  encodings, and its paper textures are noise that lower WebP quality
  barely shrinks.
- **SVG recolours.** Canva's vector stickers mostly leave paths unfilled and
  key the colour map on the default black; a mapping for `#000000` therefore
  also goes on the root `<svg>`.
- **Composited spritesheets** are named after their source and recipe, not
  the PNG Chromium happened to write, so the same input hashes the same on
  every machine that runs the build.
- **Countdown.** The live page's is a third-party widget (betterimages.ai):
  an 800×400 SVG in Abril Fatface, digits 140 px two to a unit, 40 px
  labels, all `#715449` under a letterpress filter, counting to
  `2026-10-10T21:00` *in the viewer's local time* — not midnight IST as
  assumed above. Ours is that SVG drawn by hand with the widget's own 2.5 KB
  font subset (OFL, checked in under `invite/build/`), the same deadline. The
  reference screenshot shows an empty frame there because the widget does
  not render headless.
- **Budget.** On disk `invite/` is 12.0 MB (166 WebP across two encodings,
  4 SVG, 2 WebM + 2 MP4 mattes, 14 font subsets), but no visitor pulls more
  than one encoding of anything: a retina desktop takes at most home 2.79,
  timeline 2.32, mehendi 1.36, reception 1.32, envelope 1.08, nikah 0.45,
  dress-code 0.35 MB; a phone home 1.69, timeline 1.24, reception 0.96,
  mehendi 0.81, envelope 0.75, nikah 0.42, dress-code 0.35 MB.
- **Fidelity gate** at 1366 wide (mean channel difference on a 64×512
  thumbnail, threshold 13): envelope 2.4, home 7.4, timeline 6.1, mehendi
  5.9, nikah 3.3, reception 3.2, dress-code 3.0.
