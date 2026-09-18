# Codex fidelity review — 18 September 2026

## What came of it (verified afterwards, outside the sandbox)

Each item below was checked against the live Canva site in real browsers the
same day. Keep this section in mind before reading the rest: the audit ran
without network or browser access, so its geometry was reasoned from source,
and its headline claim did not survive contact with a screenshot.

| Codex item | Verdict | What was done |
|---|---|---|
| 1. Mobile scaling: Canva scales the whole 1366 canvas, ours the content column | **Wrong premise.** Canva fits the content column on phones too; envelope and home at 390 wide line up with ours element for element. | Nothing — the rule stays. |
| 2. Two home animations missing (`LBx2hFJCMqCggSF4`, `LBTsJDh8fRLwBhKl`) | **Already animated** — both borrow a donor profile. The real gap next to them was effect 18 (write-on), which render ignored. | Write-on implemented (`Write texts on one character at a time where Canva does`). |
| 3. Entrances do not replay on the way back | **Confirmed.** Canva mounts a page afresh; the banner replays 0→1 over ~1 s on return. | Fixed (`Play a page's entrances again when you come back to it`). |
| 4. No page transition | **Nothing to match.** Canva switches pages instantly too; only the new page's entrances play. | Nothing. |
| 5. Countdown approximation | **Confirmed, and worse than stated:** the widget is Abril Fatface, and it counts to 21:00 *local* on 10 October, not midnight IST — a day out. | Rebuilt as the widget's SVG with its font subset and deadline (`Draw the countdown as the widget draws it…`). |
| (not in the list) Blank screen after the envelope tap on a phone | **Found by the burst captures the audit could not take**: the next page's pictures only started downloading on the tap. | Fixed (`Warm the next page's pictures early and hold each entrance until its own are in`). |

## Outcome

**Blocked: this is not a completed 1:1 visual review.** The execution environment
did not permit a fresh render of either site, so there is no compliant
side-by-side screenshot evidence and no screenshot-verified visual-difference
list. Per the grounding rule, the stale files in `test/invite/ref/` were not
used as evidence and no visual conclusion has been inferred from them.

The source/DOM audit below is still useful. It establishes a large,
deterministic mobile geometry divergence in the current scaling rule, confirms
the generated route/link topology, and identifies motion/behaviour items that
the next browser-enabled run must verify. No source fix was made because the
required before/after visual loop could not be performed and the sandbox also
prevented creation of the requested branch.

## Why fresh evidence could not be captured

| Required capability | Attempt | Result |
| --- | --- | --- |
| Create `codex-review` | `git switch -c codex-review` | Denied while creating `.git/refs/heads/codex-review.lock` (`EPERM`). The worktree remained on `main`. |
| Load live Canva in shell/Playwright | `curl` and the provided URL | No DNS configuration; the host could not be resolved. Direct DNS-over-HTTPS attempts were also blocked. |
| Load live Canva in the in-app browser | Browser runtime discovery | No browser backend was available (`[]`). |
| Serve ours locally | `serve()` from `test/invite/serve.mjs` | Binding `127.0.0.1` was denied (`listen EPERM`). |
| Render ours in Chromium via `file://` | Playwright Chromium 1.62 | Browser process aborted because the macOS rendezvous service was denied (`Permission denied (1100)`). |
| Render ours in WebKit via `file://` | Playwright WebKit 1.62 | Browser process aborted (`Abort trap: 6`). |

The diagnostic record is at
`test/invite/out/codex/capture-blocked.txt`. There are intentionally no PNGs in
that directory: an error page, stale reference, or synthetic approximation
would not satisfy the request for a fresh Canva-versus-ours comparison.

## Ranked screenshot-verified difference list

None. A ranked visual list would be fabricated without fresh screenshots of
both sides. The following list is instead a ranking of **unverified risks and
deterministic source differences**. It must not be represented as a completed
visual comparison.

### 1. Mobile uses section/content-column scaling rather than Canva's whole-canvas scaling

- **Status:** Deterministically confirmed in source and geometry; not visually
  verified in this session.
- **Likely guest impact:** Very high, especially on the envelope and the final
  dress-code footer. At 390 px, the envelope is rendered at 0.8312 rather than
  0.2855, a 2.91× element-size ratio. The 40 px dress-code footer is capped at
  scale 1 rather than 0.2855, a 3.50× ratio. Full-width event pages go the
  other direction: the 8 px inset makes them 4.1% smaller than a 390/1366
  whole-canvas render.
- **Root cause:** `scaleSection()` in `invite/invite.js` computes
  `k = (vw - 16) / contentWidth`, caps it at 1, and centres the content column
  whenever the viewport is narrower than the canvas. Each section computes
  its own `k`.
- **Fix:** If visual capture confirms the requirement, use one page-wide
  `k = min(1, vw / 1366)` for every section on phones and position the whole
  canvas consistently. Do not special-case narrow-content sections. This was
  deliberately not implemented because the task reserves this judgement call.
- **Screenshot evidence:** None; capture was blocked. Diagnostic:
  `/Users/shujatareeb/Projects/save-the-date/test/invite/out/codex/capture-blocked.txt`.

The exact 390 px scale matrix is:

| Page/section | Ours | Whole canvas | Relative size | Ours height | Whole-canvas height |
| --- | ---: | ---: | ---: | ---: | ---: |
| envelope 0 | 0.8312 | 0.2855 | 2.91× | 822.9 | 282.7 |
| home 0 | 0.3140 | 0.2855 | 1.10× | 531.9 | 483.6 |
| home 1 | 0.3076 | 0.2855 | 1.08× | 547.9 | 508.5 |
| home 2 | 0.2738 | 0.2855 | 0.96× | 238.5 | 248.7 |
| home 3 | 0.3027 | 0.2855 | 1.06× | 161.9 | 152.7 |
| timeline 0 | 0.2738 | 0.2855 | 0.96× | 779.2 | 812.5 |
| mehendi 0 | 0.2746 | 0.2855 | 0.96× | 624.6 | 649.5 |
| nikah 0 | 0.2738 | 0.2855 | 0.96× | 622.1 | 648.7 |
| reception 0 | 0.2738 | 0.2855 | 0.96× | 592.2 | 617.5 |
| dress-code 0 | 0.2738 | 0.2855 | 0.96× | 653.3 | 681.2 |
| dress-code 1 | 1.0000 | 0.2855 | 3.50× | 40.0 | 11.4 |

### 2. Two Canva-authored home animations have no recorded runtime animation

- **Status:** Confirmed in model/animation data; guest-visible effect is
  unverified.
- **Root cause:** `invite/build/model.json` marks group
  `LBx2hFJCMqCggSF4` (effect 2) and text `LBTsJDh8fRLwBhKl` (effect 18) as
  animated, but neither ID exists in `invite/build/animations.json`.
  `animAttrs()` in `invite/build/render.mjs` intentionally emits no animation
  when a recording is missing.
- **Fix:** Re-record those elements against the live page and diagnose their
  matching failures in `recordPage()`/`assemble()` in
  `invite/build/record.mjs`; only add a targeted fallback if fresh motion
  bursts establish the exact effect.
- **Screenshot evidence:** None; live capture was blocked. Diagnostic:
  `/Users/shujatareeb/Projects/save-the-date/test/invite/out/codex/capture-blocked.txt`.

Animation coverage from the current data is 53/55 Canva-authored animated
elements: envelope 7/7, home 32/34, timeline 8/8, mehendi 5/5, nikah 1/1,
reception 0/0, dress-code 0/0.

### 3. Returning to a previously visited route cannot replay entrance animations

- **Status:** Confirmed runtime behaviour; whether Canva replays them is
  unverified.
- **Root cause:** `enter()` permanently adds `.in`; `watch()` only selects
  `.el.an:not(.in), .el.mt:not(.in)`. `show()` hides and shows pages without
  clearing their reveal state.
- **Fix:** First verify Canva with a route → back → route motion burst. If Canva
  replays, disconnect observations and reset only one-shot reveal classes when
  a page is deactivated, without restarting idle loops unnecessarily.
- **Screenshot evidence:** None; browser capture and navigation were blocked.
  Diagnostic:
  `/Users/shujatareeb/Projects/save-the-date/test/invite/out/codex/capture-blocked.txt`.

### 4. Page changes have no explicit transition

- **Status:** Confirmed in ours; Canva behaviour is unverified.
- **Root cause:** `show()` in `invite/invite.js` synchronously toggles
  `.active`, activates assets, rescales, and jumps to scroll position zero.
  There is no outgoing/incoming page transition.
- **Fix:** Capture envelope-open and inter-page navigation at 150 ms intervals
  on Canva. Add a transition only if the source demonstrates one, preserving
  hash history and reduced-motion behaviour.
- **Screenshot evidence:** None; browser capture was blocked. Diagnostic:
  `/Users/shujatareeb/Projects/save-the-date/test/invite/out/codex/capture-blocked.txt`.

### 5. The countdown is a deliberate native approximation

- **Status:** Known deliberate deviation from the design spec; visual and
  temporal fidelity are unverified in this session.
- **Root cause:** `renderElement()` in `invite/build/render.mjs` replaces the
  Canva embed with native countdown markup, and `tick()` in
  `invite/invite.js` targets `2026-10-10T00:00:00+05:30`.
- **Fix:** Freshly capture Canva's widget on a real browser, compare type,
  spacing, labels, separators, time zone, and tick cadence, then adjust the
  native CSS/runtime if needed.
- **Screenshot evidence:** None; the live widget could not be loaded.
  Diagnostic:
  `/Users/shujatareeb/Projects/save-the-date/test/invite/out/codex/capture-blocked.txt`.

## Mobile scaling recommendation

**Recommendation: switch to one whole-canvas scale on phone, subject to one
fresh side-by-side confirmation before implementation.** The current rule does
not merely change background crop. It changes the physical size and vertical
rhythm of the invitation, and it does so inconsistently by section. The
2.91× envelope and 3.50× dress-code footer ratios are large enough that guests
are very likely to perceive a different composition. The four home sections
also render at four different scales, so typography and decorative motifs can
change size at section boundaries.

The exact proposed mobile rule is conceptually:

```js
const k = Math.min(1, vw / CANVAS);
const tx = (vw - CANVAS * k) / 2;
```

Every section on the active page should use that same `k` and whole-canvas
translation. The desktop `k = 1` centring behaviour can remain. This report
does **not** recommend preserving the 8 px phone inset if Canva truly fills the
viewport width.

Required evidence paths do not exist because both browser paths were blocked.
The failure record is:

- `/Users/shujatareeb/Projects/save-the-date/test/invite/out/codex/capture-blocked.txt`

## Source/DOM behaviour audit

- The seven generated routes and source page numbers agree:
  envelope/0, home/3, timeline/4, mehendi/5, nikah/6, reception/8,
  dress-code/9.
- Internal links are converted by `resolveLink()` in
  `invite/build/extract.mjs` to the rebuilt slugs. Envelope → home, home →
  timeline/dress-code/envelope, timeline → each event/home, event pages →
  timeline, and dress-code → home are present in `invite/index.html`.
- Hash navigation naturally creates browser-history entries, and `show()`
  resets scroll to zero. Tap targets, back navigation, and scroll-container
  feel still require real browser verification.
- Eleven pulsing buttons are emitted as CSS loops, consistent with the recorded
  signature described in the final “As built” spec. Timing cannot be compared
  without a fresh Canva motion burst.
- The effect-30 matte, lazy loading, WebKit fallback, text wrapping, font
  selection, and layer positioning have test coverage, but their visual result
  could not be inspected in this session.

## Test result

`npm run test:invite` did **not** pass in this environment: **82 passed, 52
failed, 134 total**. The failures are browser infrastructure failures:
Chromium cannot start under the sandbox and localhost binding is denied. No
assertion failure was reached in those browser-dependent cases.

A browser-free subset covering fetch parsing, extraction, assets, animation
record processing, and reference helpers passed **51/51**.

## Implementation and Git result

- Requested branch: `codex-review`.
- Actual branch: still `main`; branch creation was denied before repository
  files were changed.
- Product/source fixes: none.
- Commits: none.
- Pushes: none.
- Main history: unchanged at `aed7675`.

Because the branch could not be created, making and committing a speculative
visual fix would have violated the action-safety requirement. The only files
produced by this blocked review are this report and the capture diagnostic.

## What a browser-enabled continuation must do

1. Grant write access to `.git` and permit Chromium/WebKit processes, localhost
   binding, DNS, and outbound HTTPS to the Canva URL.
2. Create `codex-review` from `aed7675` before source edits.
3. Capture every route at 390×844 DPR 3 in WebKit and Chromium and at
   1366×900, scrolling slowly before settled captures.
4. Save matching Canva/ours 150 ms bursts for every reveal region and the
   envelope/navigation interactions under `test/invite/out/codex/`.
5. Replace this provisional ranking with screenshot-backed findings; implement
   only contained fixes; re-capture both sides after every fix.
6. Run the full invite suite and commit only after it passes.
