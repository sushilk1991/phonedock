// PhoneDock site: theme, copy buttons, reveals, the recordings, and the hero's real runs with the agent card.
import { startDemo } from './demo.js';

const root = document.documentElement;
root.classList.add('js');

const params = new URLSearchParams(location.search);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const prefersDark = matchMedia('(prefers-color-scheme: dark)');

// ---------- Theme ----------
function resolvedTheme() {
  const t = root.dataset.theme;
  if (t === 'light' || t === 'dark') return t;
  return prefersDark.matches ? 'dark' : 'light';
}
function applyTheme() {
  const theme = resolvedTheme();
  root.dataset.resolved = theme;
  document.querySelector('[data-theme-toggle]')?.setAttribute('aria-label', theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
}
if (params.get('theme') === 'light' || params.get('theme') === 'dark') root.dataset.theme = params.get('theme');
applyTheme();
prefersDark.addEventListener('change', applyTheme);
document.querySelector('[data-theme-toggle]')?.addEventListener('click', () => {
  root.dataset.theme = resolvedTheme() === 'light' ? 'dark' : 'light';
  try { localStorage.setItem('pd-theme', root.dataset.theme); } catch (e) { /* private mode */ }
  applyTheme();
});

// ---------- Nav ----------
const nav = document.querySelector('.nav');
const onScroll = () => nav?.classList.toggle('is-scrolled', scrollY > 24);
addEventListener('scroll', onScroll, { passive: true });
onScroll();

// ---------- Copy buttons ----------
for (const btn of document.querySelectorAll('[data-copy]')) {
  btn.addEventListener('click', async () => {
    const text = btn.parentElement.querySelector('[data-copy-src]')?.textContent.trim() ?? '';
    const label = btn.querySelector('[data-copy-label]');
    try {
      await navigator.clipboard.writeText(text);
      label.textContent = 'Copied';
    } catch (e) {
      const range = document.createRange();
      range.selectNodeContents(btn.parentElement.querySelector('[data-copy-src]'));
      const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
      label.textContent = 'Press ⌘C';
    }
    btn.classList.add('is-done');
    clearTimeout(btn._t);
    btn._t = setTimeout(() => { label.textContent = 'Copy'; btn.classList.remove('is-done'); }, 2200);
  });
}

// ---------- Reveals and section lights ----------
const revealTargets = document.querySelectorAll('.sec-head, .what-lede, .roles, .chain, .calls, .handoff-media, .runs .run, .runsheet li, .fleet, .targets, .book, .setup-steps, .plain-col, .faq-list');
for (const el of revealTargets) el.classList.add('rv');
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('is-in');
    io.unobserve(e.target);
  }
}, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
for (const el of revealTargets) io.observe(el);

function whileVisible(el, on, off, threshold = 0.25) {
  if (!el) return;
  new IntersectionObserver(([e]) => (e.isIntersecting ? on() : off?.()), { threshold }).observe(el);
}
const chain = document.querySelector('[data-chain]');
whileVisible(chain, () => chain.classList.add('is-on'), () => chain.classList.remove('is-on'));

// How it works: draw a wire from each agent name into the hub, and from the hub out to each device.
(() => {
  const svg = chain?.querySelector('.chain-wires');
  const hub = chain?.querySelector('.chain-hub');
  if (!svg || !hub) return;
  const range = document.createRange();
  const curve = (x1, y1, x2, y2) => { const m = (x1 + x2) / 2; return `M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}`; };
  const path = (d, cls) => `<path class="${cls}" pathLength="100" d="${d}"/>`;
  const draw = () => {
    if (getComputedStyle(svg).display === 'none') return;
    const box = chain.getBoundingClientRect();
    const h = hub.getBoundingClientRect();
    const hy = Math.round(h.top + h.height / 2 - box.top);
    const hl = Math.round(h.left - box.left), hr = Math.round(h.right - box.left);
    const mid = (r) => Math.round(r.top + r.height / 2 - box.top);
    const into = [...chain.querySelectorAll('.chain-agents li')].map((li) => {
      range.selectNodeContents(li);
      const r = range.getBoundingClientRect();
      return curve(Math.round(r.right - box.left) + 14, mid(r), hl, hy);
    });
    const out = [...chain.querySelectorAll('.chain-devices li')].map((li) => {
      const r = li.getBoundingClientRect();
      return curve(hr, hy, Math.round(r.left - box.left) - 8, mid(r));
    });
    svg.setAttribute('viewBox', `0 0 ${Math.round(box.width)} ${Math.round(box.height)}`);
    svg.removeAttribute('preserveAspectRatio');
    svg.innerHTML = [...into, ...out].map((d) => path(d, 'wire')).join('')
      + (into[0] ? path(into[0], 'wire wire-live') : '') + (out[1] ? path(out[1], 'wire wire-live wire-live-2') : '');
  };
  new ResizeObserver(draw).observe(chain);
  document.fonts?.ready.then(draw);
})();
const curtain = document.querySelector('.curtain');
whileVisible(curtain, () => curtain.classList.add('is-lit'));

// Recordings load and play only while they're on screen. With reduced motion they show their poster and wait for
// Play. Pause always works.
for (const box of document.querySelectorAll('[data-clip]')) {
  const video = box.querySelector('video');
  const btn = box.querySelector('[data-clip-hold]');
  if (!video || !btn) continue;
  const label = btn.querySelector('[data-hold-label]');
  let held = reduceMotion.matches; let seen = false;
  const sync = () => { btn.toggleAttribute('data-paused', video.paused); label.textContent = video.paused ? 'Play' : 'Pause'; };
  const go = () => { if (!held && seen) video.play().catch(sync); };
  video.addEventListener('play', sync);
  video.addEventListener('pause', sync);
  btn.addEventListener('click', () => {
    held = !video.paused;
    if (held) video.pause(); else video.play().catch(sync);
  });
  whileVisible(box, () => { seen = true; go(); }, () => { seen = false; video.pause(); }, 0.35);
  sync();
}

// The handoff steps light up with the recording: it asks (3s), you take over (7s), you hand it back (13.5s).
(() => {
  const video = document.querySelector('[data-handoff-video]');
  const steps = [...document.querySelectorAll('[data-handoff-steps] li')];
  if (!video || !steps.length) return;
  let lit = null; let moved = false;
  const light = () => {
    const t = video.currentTime;
    if (t > 0) moved = true;
    // Until the recording moves, the poster shows the request, so the first step is lit.
    const n = !moved ? 0 : t < 3 ? -1 : t < 7 ? 0 : t < 13.5 ? 1 : 2;
    if (n === lit) return;
    lit = n;
    steps.forEach((li, i) => li.classList.toggle('is-lit', i === n));
  };
  video.addEventListener('timeupdate', light);
  video.addEventListener('seeked', light);
  light();
})();

// ---------- The hero's real runs ----------
const demo = document.querySelector('[data-demo]');
if (demo) startDemo({ root: demo, reduceMotion, params });
