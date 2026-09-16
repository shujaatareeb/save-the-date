// invite/invite.js — the little that has to happen in the browser.
//
// Everything visual is already in the HTML. This file only:
//   · shows one page at a time by hash (#envelope, #home, #timeline, …)
//   · scales each section so its content column fits the viewport (mobile first)
//   · adds .in to animated elements as they scroll into view
//   · draws an effect-30 picture in through its luma matte on a canvas
//   · swaps data-src → src (and data-href → href) for the page being shown
//   · ticks the countdown
(() => {
  'use strict';
  const DEFAULT = 'envelope';
  const TARGET = Date.parse('2026-10-10T00:00:00+05:30');
  const PAD = 8;
  const pages = [...document.querySelectorAll('.page')];
  const bySlug = (slug) => pages.find((p) => p.dataset.page === slug);

  // --- scaling -------------------------------------------------------------
  function scaleSection(sec) {
    const stage = sec.querySelector('.stage');
    if (!stage) return;
    const vw = document.documentElement.clientWidth;
    const cw = +sec.dataset.cw, cl = +sec.dataset.cl, h = +sec.dataset.h;
    const k = Math.min(1, Math.max(0.25, (vw - 2 * PAD) / cw));
    const tx = vw / 2 - (cl + cw / 2) * k;
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

  // --- reveal ---------------------------------------------------------------
  const enter = (el) => { el.classList.add('in'); if (el.classList.contains('mt')) reveal(el); };
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
  function activate(page) {
    page.querySelectorAll('[data-src]').forEach((n) => { n.src = n.dataset.src; n.removeAttribute('data-src'); if (n.tagName === 'VIDEO') n.play?.().catch(() => {}); });
    page.querySelectorAll('[data-href]').forEach((n) => { n.setAttribute('href', n.dataset.href); n.removeAttribute('data-href'); });
  }

  // --- routing ----------------------------------------------------------------------
  function show(slug) {
    const page = bySlug(slug) || bySlug(DEFAULT);
    if (!page) return;
    pages.forEach((p) => p.classList.toggle('active', p === page));
    activate(page);
    scale();
    window.scrollTo(0, 0);
    watch(page);
  }
  const current = () => { try { return decodeURIComponent(location.hash.slice(1)) || DEFAULT; } catch { return DEFAULT; } };

  // --- countdown ----------------------------------------------------------------------
  const slots = { d: document.querySelectorAll('[data-cd="d"]'), h: document.querySelectorAll('[data-cd="h"]'), m: document.querySelectorAll('[data-cd="m"]'), s: document.querySelectorAll('[data-cd="s"]') };
  function tick() {
    const left = Math.max(0, TARGET - Date.now());
    const v = { d: Math.floor(left / 864e5), h: Math.floor(left / 36e5) % 24, m: Math.floor(left / 6e4) % 60, s: Math.floor(left / 1e3) % 60 };
    for (const u in v) slots[u].forEach((n) => { n.textContent = String(v[u]).padStart(2, '0'); });
  }
  if (slots.s.length) { tick(); setInterval(tick, 1000); }

  // --- go -----------------------------------------------------------------------------
  window.addEventListener('hashchange', () => show(current()));
  window.addEventListener('resize', scale);
  show(current());
  window.__invite = { scale, show };
})();
