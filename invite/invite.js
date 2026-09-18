// invite/invite.js — the little that has to happen in the browser.
//
// Everything visual is already in the HTML. This file only:
//   · shows one page at a time by hash (#envelope, #home, #timeline, …)
//   · scales each section so its content column fits the viewport (mobile first)
//   · adds .in to animated elements as they scroll into view
//   · draws an effect-30 picture in through its luma matte on a canvas
//   · swaps data-src → src (and data-href → href) for the page being shown,
//     then for the pages it links to, so the next tap lands on a page that is there
//   · ticks the countdown
(() => {
  'use strict';
  const DEFAULT = 'envelope';
  // The widget on the live page counts to "2026-10-10T21:00" with no zone: nine
  // in the evening wherever the guest happens to be.
  const TARGET = new Date(2026, 9, 10, 21, 0, 0).getTime();
  const PAD = 8;
  const CANVAS = 1366; // design width; every section is laid out on it
  const pages = [...document.querySelectorAll('.page')];
  const bySlug = (slug) => pages.find((p) => p.dataset.page === slug);

  // --- scaling -------------------------------------------------------------
  function scaleSection(sec) {
    const stage = sec.querySelector('.stage');
    if (!stage) return;
    const vw = document.documentElement.clientWidth;
    const cw = +sec.dataset.cw, cl = +sec.dataset.cl, h = +sec.dataset.h;
    const k = Math.min(1, Math.max(0.25, (vw - 2 * PAD) / cw));
    // Centre the whole canvas when it fits, as Canva does on a desktop; when the
    // viewport is narrower than the canvas, centre the content column instead so
    // a tablet never crops it — and on a phone that column is what k fits.
    const tx = vw >= CANVAS * k && k === 1 ? (vw - CANVAS) / 2 : vw / 2 - (cl + cw / 2) * k;
    sec.style.height = `${h * k}px`;
    stage.style.transform = `translate(${tx}px,0) scale(${k})`;
  }
  function scale() {
    const active = document.querySelector('.page.active');
    if (active) active.querySelectorAll('.sec').forEach(scaleSection);
  }

  // --- matte reveal ---------------------------------------------------------
  // Canva's effect 30: the element's picture is composited through a video
  // that runs black to white, so it wipes or blooms in. The matte plays
  // off-DOM; each frame its luma becomes the alpha of a small mask, the
  // picture is drawn onto a canvas over the element and cut to that mask.
  // When the matte ends (or cannot play at all) the canvas goes and the
  // plain <img> underneath takes over.
  const MASK = 192; // long side of the luma mask, in px — the mattes are soft blobs
  function reveal(el) {
    if (el.dataset.mtDone) return;
    el.dataset.mtDone = '1';
    const img = el.querySelector('img');
    if (!img || !el.dataset.matte) return;
    const video = document.createElement('video');
    video.muted = true; video.playsInline = true; video.preload = 'auto';
    const webm = video.canPlayType('video/webm; codecs="vp9"');
    const src = webm ? el.dataset.matte : el.dataset.matteMp4;
    if (!src) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    const mask = document.createElement('canvas');
    const mctx = mask.getContext('2d', { willReadFrequently: true });
    if (!ctx || !mctx) return;
    let done = false, raf = 0;
    const finish = () => {
      if (done) return;
      done = true;
      cancelAnimationFrame(raf);
      el.classList.remove('mt-run');
      canvas.remove();
      video.removeAttribute('src'); video.load();
    };
    const frame = () => {
      if (done) return;
      if (video.readyState >= 2 && img.complete && img.naturalWidth) {
        const s = Math.min(2, devicePixelRatio || 1);
        const W = Math.round(el.offsetWidth * s), H = Math.round(el.offsetHeight * s);
        if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
        const vw = video.videoWidth || 16, vh = video.videoHeight || 9;
        const mw = vw >= vh ? MASK : Math.round((MASK * vw) / vh), mh = vw >= vh ? Math.round((MASK * vh) / vw) : MASK;
        if (mask.width !== mw || mask.height !== mh) { mask.width = mw; mask.height = mh; }
        mctx.drawImage(video, 0, 0, mw, mh);
        const px = mctx.getImageData(0, 0, mw, mh), d = px.data;
        for (let i = 0; i < d.length; i += 4) { d[i + 3] = d[i]; d[i] = d[i + 1] = d[i + 2] = 0; }
        mctx.putImageData(px, 0, 0);
        const st = img.style;
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, W, H);
        ctx.drawImage(img, parseFloat(st.left) * s, parseFloat(st.top) * s, parseFloat(st.width) * s, parseFloat(st.height) * s);
        ctx.globalCompositeOperation = 'destination-in';
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(mask, 0, 0, W, H);
      }
      raf = requestAnimationFrame(frame);
    };
    video.addEventListener('ended', finish);
    video.addEventListener('error', finish);
    el.classList.add('mt-run');
    el.appendChild(canvas);
    video.src = src;
    const play = video.play();
    if (play && play.catch) play.catch(finish);
    // A matte that never starts (blocked autoplay, a stalled download) must not
    // hold the picture hostage: give it a few seconds, then just show it.
    setTimeout(() => { if (!done && video.currentTime === 0) finish(); }, 4000);
    frame();
  }

  // Resolves once every picture under `scope` that has a src has loaded (or
  // failed), or after `ms` — a picture that never comes must not hold anything.
  function whenLoaded(scope, ms) {
    const pending = [...scope.querySelectorAll('img[src]')].filter((i) => !i.complete);
    if (!pending.length) return Promise.resolve();
    const all = Promise.all(pending.map((i) => new Promise((res) => { i.addEventListener('load', res, { once: true }); i.addEventListener('error', res, { once: true }); })));
    return Promise.race([all, new Promise((res) => setTimeout(res, ms))]);
  }

  // --- reveal ---------------------------------------------------------------
  // An entrance over a picture that has not arrived is a pop, not an entrance:
  // an element's reveal waits for its own pictures (briefly) before it starts.
  const enter = (el) => {
    if (el.dataset.entering) return;
    el.dataset.entering = '1';
    whenLoaded(el, 2500).then(() => { el.classList.add('in'); if (el.classList.contains('mt')) reveal(el); });
  };
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { enter(e.target); io.unobserve(e.target); }
      }, { threshold: 0.05 })
    : null;
  function watch(page) {
    page.querySelectorAll('.el.an:not(.in),.el.mt:not(.in)').forEach((el) => (io ? io.observe(el) : enter(el)));
    // Fallback: some environments (notably headless browsers mid-layout) don't fire the
    // IntersectionObserver's initial callback for elements already in view when observed.
    requestAnimationFrame(() => page.querySelectorAll('.el.an:not(.in),.el.mt:not(.in)').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) enter(el);
    }));
  }

  // --- lazy assets --------------------------------------------------------------
  function activate(page, eager = false) {
    page.querySelectorAll('[data-src]').forEach((n) => { n.src = n.dataset.src; n.removeAttribute('data-src'); if (n.tagName === 'VIDEO') n.play?.().catch(() => {}); });
    page.querySelectorAll('[data-href]').forEach((n) => { n.setAttribute('href', n.dataset.href); n.removeAttribute('data-href'); });
    // A lazy picture on a page that is not displayed never fetches; warming
    // a hidden page has to ask for its pictures outright.
    if (eager) page.querySelectorAll('img[loading="lazy"]').forEach((i) => { i.loading = 'eager'; });
  }
  // Once the shown page's own pictures are in, fetch those of every page it
  // links to, so the tap that follows lands on a page that is already there
  // rather than on a blank one that fills in. Fetching only: nothing plays.
  function warm(page) {
    const slugs = new Set([...page.querySelectorAll('a[href^="#"]')].map((a) => a.getAttribute('href').slice(1)));
    const next = [...slugs].map(bySlug).filter((p) => p && p !== page);
    // Only once this page's own pictures are all in — on a slow link the
    // warm-up must never compete with what the guest is looking at — and
    // then in a quiet moment.
    const idle = (fn) => ('requestIdleCallback' in window ? requestIdleCallback(fn, { timeout: 2000 }) : setTimeout(fn, 300));
    whenLoaded(page, 30000).then(() => idle(() => { if (page.classList.contains('active')) next.forEach((p) => activate(p, true)); }));
  }

  // Canva mounts a page afresh each time you arrive, so its entrances play
  // again when you come back. Leaving a page forgets what it revealed.
  function reset(page) {
    page.querySelectorAll('.el.in, .el[data-entering], .el[data-mt-done]').forEach((el) => {
      el.classList.remove('in', 'mt-run');
      delete el.dataset.entering;
      delete el.dataset.mtDone;
      el.querySelectorAll(':scope > canvas').forEach((c) => c.remove());
    });
    if (io) page.querySelectorAll('.el.an, .el.mt').forEach((el) => io.unobserve(el));
  }

  // --- routing ----------------------------------------------------------------------
  function show(slug) {
    const page = bySlug(slug) || bySlug(DEFAULT);
    if (!page) return;
    pages.forEach((p) => { if (p !== page && p.classList.contains('active')) reset(p); });
    pages.forEach((p) => p.classList.toggle('active', p === page));
    activate(page);
    scale();
    window.scrollTo(0, 0);
    watch(page);
    warm(page);
  }
  const current = () => { try { return decodeURIComponent(location.hash.slice(1)) || DEFAULT; } catch { return DEFAULT; } };

  // --- countdown ----------------------------------------------------------------------
  const slots = { d: document.querySelectorAll('[data-cd="d"]'), h: document.querySelectorAll('[data-cd="h"]'), m: document.querySelectorAll('[data-cd="m"]'), s: document.querySelectorAll('[data-cd="s"]') };
  function tick() {
    const left = Math.max(0, TARGET - Date.now());
    const v = { d: Math.floor(left / 864e5), h: Math.floor(left / 36e5) % 24, m: Math.floor(left / 6e4) % 60, s: Math.floor(left / 1e3) % 60 };
    for (const u in v) slots[u].forEach((n) => {
      const [tens, ones] = String(v[u]).padStart(2, '0');
      const t = n.querySelectorAll('tspan');
      if (t.length === 2) { t[0].textContent = tens; t[1].textContent = ones; } else n.textContent = tens + ones;
    });
  }
  if (slots.s.length) { tick(); setInterval(tick, 1000); }

  // --- go -----------------------------------------------------------------------------
  window.addEventListener('hashchange', () => show(current()));
  window.addEventListener('resize', scale);
  show(current());
  window.__invite = { scale, show };
})();
