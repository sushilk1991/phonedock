// PhoneDock site: theme, copy buttons, reveals, the hero cue panel, and the lazy 3D stage.
const root = document.documentElement;
root.classList.add('js');

const params = new URLSearchParams(location.search);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const prefersDark = matchMedia('(prefers-color-scheme: dark)');
const listeners = new Set();

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
  // The light posters follow the page theme, not the system one; the narrow one keeps its width condition.
  for (const source of document.querySelectorAll('[data-poster-light]')) {
    source.media = theme !== 'light' ? 'not all' : 'narrow' in source.dataset ? '(max-width: 820px)' : 'all';
  }
  if ('posterSwap' in root.dataset) {
    const show = () => delete root.dataset.posterSwap;
    document.querySelector('[data-poster]')?.addEventListener('load', show, { once: true });
    setTimeout(show, 1500);
  }
  for (const fn of listeners) fn(theme);
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
const revealTargets = document.querySelectorAll('.sec-head, .what-lede, .roles, .chain, .calls, .handoff-media, .lineup li, .runsheet li, .book, .setup-steps, .plain-col, .faq-list');
for (const el of revealTargets) el.classList.add('rv');
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    e.target.classList.add('is-in');
    io.unobserve(e.target);
  }
}, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
for (const el of revealTargets) io.observe(el);

function whileVisible(el, on, off, margin = '0px') {
  if (!el) return;
  new IntersectionObserver(([e]) => (e.isIntersecting ? on() : off?.()), { rootMargin: margin, threshold: 0.25 }).observe(el);
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

// Recordings play only while they're on screen. With reduced motion they wait for Play. Pause always works.
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
  whileVisible(box, () => { seen = true; go(); }, () => { seen = false; video.pause(); });
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

// ---------- Hero cue panel ----------
const cueEl = document.querySelector('[data-cue]');
const cue = (() => {
  const state = cueEl.querySelector('[data-cue-state]');
  const wide = matchMedia('(min-width: 1081px)');
  const callEl = cueEl.querySelector('[data-cue-call]');
  const acts = cueEl.querySelector('[data-cue-actions]');
  const take = cueEl.querySelector('[data-cue-take]');
  const done = cueEl.querySelector('[data-cue-done]');
  let takeWaiters = []; let doneWaiters = []; let lastAt = null;
  take.addEventListener('click', () => { const w = takeWaiters; takeWaiters = []; w.forEach((r) => r('person')); });
  done.addEventListener('click', () => { const w = doneWaiters; doneWaiters = []; w.forEach((r) => r('person')); });
  const api = {
    set({ mode, label, call: callHtml }) {
      if (mode) cueEl.dataset.state = mode;
      if (label != null) state.textContent = label;
      if (callHtml != null) callEl.innerHTML = callHtml;
    },
    actions(which) {
      const f = document.activeElement;
      acts.hidden = which === 'none';
      take.hidden = which !== 'take';
      done.disabled = which !== 'done';
      // If the focused button just went away, move focus to what the panel offers next, never to the page top.
      if (!cueEl.contains(f) || f === cueEl || (f.offsetParent !== null && !f.disabled)) return;
      const hold = cueEl.querySelector('[data-hold]');
      const next = which === 'take' ? take : which === 'done' ? done : hold?.offsetParent ? hold : cueEl;
      if (next === cueEl) cueEl.tabIndex = -1;
      next.focus({ preventScroll: true });
    },
    whenTake() { return new Promise((r) => takeWaiters.push(r)); },
    whenDone() { return new Promise((r) => doneWaiters.push(r)); },
    // Sit the panel just above the PhoneDock window in the scene, centred on it. (x, y) is the middle of the window's
    // top edge in stage pixels. Below 1081px the panel stays in the flow under the stage.
    place(x, y) {
      lastAt = [x, y];
      if (!wide.matches) { cueEl.classList.remove('is-placed'); cueEl.style.removeProperty('--cue-x'); cueEl.style.removeProperty('--cue-y'); return; }
      const w = cueEl.offsetWidth, h = cueEl.offsetHeight, hero = cueEl.parentElement;
      const left = Math.max(16, Math.min(hero.clientWidth - w - 16, x - w / 2));
      const top = Math.max(72, y - h - 14);
      cueEl.style.setProperty('--cue-x', `${Math.round(left)}px`);
      cueEl.style.setProperty('--cue-y', `${Math.round(top)}px`);
      cueEl.classList.add('is-placed');
    },
  };
  // The handoff state adds a row of buttons: re-place on any size change, so the panel grows upward, off the window.
  new ResizeObserver(() => { if (lastAt) api.place(...lastAt); }).observe(cueEl);
  return api;
})();

function staticCue() {
  // No animation: the panel holds the handoff moment, and its buttons still answer.
  cueEl.classList.add('is-static');
  // Nothing moves here, so the panel can announce what changes after each click.
  cueEl.querySelector('.cue-text')?.setAttribute('aria-live', 'polite');
  cue.set({ mode: 'handoff', label: 'Claude Code is waiting for you', call: 'Approve the Face ID prompt, then tap Done.' });
  cue.actions('take');
  cue.whenTake().then(() => {
    cue.set({ mode: 'you', label: 'You’re driving', call: 'Agents are locked out while you have it.' });
    cue.actions('done');
    return cue.whenDone();
  }).then(() => {
    cue.set({ mode: 'agent', label: 'Claude Code is driving', call: 'The agent carries on from where it stopped.' });
    cue.actions('none');
  });
}

// Until the live stage takes over (or for good, without it), sit the panel above the window in the poster picture:
// object-fit: cover maths on the anchor (the window's top edge) measured when the poster was rendered.
let stageLive = false;
function posterCue() {
  const [fx, fy] = (stageEl.dataset.anchor || '').split(',').map(Number);
  if (!Number.isFinite(fx) || !Number.isFinite(fy)) return;
  const pos = () => {
    if (stageLive) return;
    const W = stageEl.clientWidth, H = stageEl.clientHeight;
    const k = Math.max(W / 1600, H / 1000);
    const ox = 0, oy = (H - 1000 * k) * 0.5; // object-position: 0% 50%
    cue.place(ox + fx * 1600 * k, oy + fy * 1000 * k);
  };
  pos();
  new ResizeObserver(pos).observe(stageEl);
}

// ---------- The 3D stage (lazy) ----------
// A throwaway test context costs as much as the real one: check for the API here, and make the stage's one context
// in boot(), before downloading three.js.
const webglOK = () => 'WebGL2RenderingContext' in window;
const stageEl = document.querySelector('[data-stage]');
const canvas = document.querySelector('[data-stage-canvas]');
const saveData = navigator.connection?.saveData === true;
const freezeAt = params.has('freeze') ? params.get('freeze') : null;
posterCue();

if ((reduceMotion.matches && freezeAt == null) || saveData || !webglOK()) {
  staticCue();
} else {
  const boot = () => {
    const gl = canvas.getContext('webgl2', { antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: freezeAt != null });
    if (!gl) { staticCue(); return; }
    return import('./stage.js')
      .then((m) => { stageLive = true; return m.start({
        canvas, gl, stageEl, cue, freezeAt,
        theme: resolvedTheme(),
        onTheme: (fn) => listeners.add(fn),
        currentTheme: resolvedTheme,
        holdButton: document.querySelector('[data-hold]'),
      }); })
      .catch((err) => { console.warn('Stage fell back to the poster:', err); stageLive = false; staticCue(); posterCue(); });
  };
  if (freezeAt != null) boot();
  else if (document.readyState === 'complete') setTimeout(boot, 60);
  else addEventListener('load', () => (window.requestIdleCallback ? requestIdleCallback(boot, { timeout: 900 }) : setTimeout(boot, 120)), { once: true });
}
