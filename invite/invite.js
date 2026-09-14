// invite/invite.js — the little that has to happen in the browser.
//
// Everything visual is already in the HTML. This file only:
//   · shows one page at a time by hash (#envelope, #home, #timeline, …)
//   · scales each section so its content column fits the viewport (mobile first)
//   · adds .in to animated elements as they scroll into view
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

  // --- reveal ---------------------------------------------------------------
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
      }, { threshold: 0.05 })
    : null;
  function watch(page) {
    page.querySelectorAll('.el.an:not(.in)').forEach((el) => (io ? io.observe(el) : el.classList.add('in')));
    // Fallback: some environments (notably headless browsers mid-layout) don't fire the
    // IntersectionObserver's initial callback for elements already in view when observed.
    requestAnimationFrame(() => page.querySelectorAll('.el.an:not(.in)').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < innerHeight && r.bottom > 0) el.classList.add('in');
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
