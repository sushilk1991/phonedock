// The hero: a real phone plays three real runs in turn, and the agent card beside it prints Claude Code's own calls as
// the screen changes, then its answer. Every call, prompt and answer below is from the run's transcript; each call's
// time is where it lands in the clip (from the run's action log, ±0.2 s). Each clip is one or two stretches of the
// recording joined by a 0.3 s dissolve; calls made in a skipped stretch show up at the cut. `poster` is the clip time
// of the poster frame.
const TASKS = [
  {
    // Clip = recording 5.8–17.0 s, then 32.8–36.6 s (from 10.9 s in the clip).
    len: 14.7, poster: 12.7, cuts: [[0, 5.8], [10.9, 32.8]],
    prompt: 'Search Google for the best noise cancelling headphones under $200, open the top review and tell me its best overall pick.',
    lines: [
      [0, 'get_ui()'],
      [0.15, 'fill(ref: "e25", value: "best noise cancelling headphones under 200 dollars", submit: True)', 2.6],
      [6.0, 'screenshot()'],
      [8.3, 'tap(x: 228, y: 810)'],
      [10.3, 'screenshot()'],
      [10.9, 'swipe(direction: "up", distance: 0.7, return_screenshot: True)'],
      [11.0, 'swipe(direction: "up", distance: 0.6, return_screenshot: True)'],
      [11.29, 'swipe(direction: "down", distance: 0.45, return_screenshot: True)'],
    ],
    more: 1,
    answer: 'RTINGS.com picks the JBL Live 780NC as best overall under $200, but the article shows no exact price, only a “See Price” button linking to Amazon.in.',
  },
  {
    // Clip = recording 2.7–6.0 s, then 32.3–43.25 s (from 3.0 s in the clip).
    len: 13.95, poster: 13.3, cuts: [[0, 2.7], [3.0, 32.3]],
    prompt: 'Open Duolingo in the Play Store, check its rating and downloads, and read me the newest one-star reviews.',
    lines: [
      [0, 'get_ui()'],
      [0.57, 'tap(x: 224, y: 458)'],
      [3.0, 'get_ui()'],
      [3.0, 'scroll_to(text: "Ratings and reviews")'],
      [3.0, 'get_ui()'],
      [3.0, 'tap(ref: "e23")'],
      [3.0, 'screenshot()'],
      [3.0, 'tap(x: 147, y: 417)'],
      [4.3, 'screenshot(max_size: 512)'],
      [5.98, 'tap(text: "Most recent")'],
      [7.56, 'tap(text: "Rating")'],
      [9.2, 'screenshot(max_size: 512)'],
      [10.44, 'tap(x: 80, y: 925)'],
      [12.4, 'get_ui(full_text: True)'],
    ],
    more: 6,
    answer: 'Duolingo is rated 4.6 stars (about 48.8 million reviews) with 500 million+ downloads.',
  },
  {
    // Clip = recording 33.0–46.8 s.
    len: 13.8, poster: 13.0, cuts: [[0, 33.0]],
    prompt: 'Find a cold brew coffee video on YouTube, play a few seconds and tell me the title, channel and views.',
    lines: [
      [0, 'get_ui()'],
      [0, 'screenshot()'],
      [0, 'swipe(direction: "up", distance: 0.5, return_screenshot: True)'],
      [0, 'swipe(direction: "up", distance: 0.7, return_screenshot: True)'],
      [0, 'swipe(direction: "up", distance: 0.7, return_screenshot: True)'],
      [0.44, 'swipe(direction: "up", distance: 0.7, return_screenshot: True)'],
      [5.09, 'tap(x: 230, y: 350, return_screenshot: True, settle_ms: 3000)', 8.1],
      [11.47, 'tap(x: 295, y: 899)'],
      [11.9, 'wait(seconds: 6)', 99],
    ],
    more: 12,
    answer: 'The Easiest Cold Brew Ever: 2 Ways — Joshua Weissman — 4.7M views (paused at 0:51, back on the results).',
  },
];

const PROMPT_CPS = 120;  // prompt typing, characters per second
const ANSWER_CPS = 75;
const HOLD = 4.2;        // seconds the answer stays up before the next run

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const clockAt = (task, t) => {
  let src = task.cuts[0][1];
  for (const [c, s] of task.cuts) if (t >= c) src = s + (t - c);
  const s = Math.max(0, Math.floor(src));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function startDemo({ root, reduceMotion, params }) {
  const videos = [...root.querySelectorAll('[data-run]')];
  const tabs = [...root.querySelectorAll('[data-task]')];
  const log = root.querySelector('[data-log]');
  const promptEl = root.querySelector('[data-prompt]');
  const clock = root.querySelector('[data-clock]');
  const hold = root.querySelector('[data-hold]');
  const holdLabel = hold.querySelector('[data-hold-label]');
  const sr = root.querySelector('[data-sr]');
  if (!videos.length || !log) return;

  let cur = 0, phase = 'idle', phaseT = 0, shown = 0, held = false, visible = true, last = 0;
  let answerP = null, moreShown = false, answerShown = false, staticMode = false;
  const callEls = [];

  const setHeld = (h) => {
    held = h;
    hold.toggleAttribute('data-paused', h);
    holdLabel.textContent = h ? 'Play' : 'Pause';
    const v = videos[cur];
    if (phase === 'run') { if (h || !visible) v.pause(); else v.play().catch(() => {}); }
  };

  const ensureLoaded = (v) => {
    if (v.preload !== 'auto') { v.preload = 'auto'; v.load(); }
  };
  // Once a clip has its first frame, drop the poster (a later key frame) so the screen starts where the run starts.
  for (const v of videos) v.addEventListener('loadeddata', () => { if (!staticMode) v.removeAttribute('poster'); });

  const addCall = (text, running, delay = 0) => {
    const i = text.indexOf('(');
    const li = document.createElement('li');
    li.className = `ln ln-call is-new${running ? ' is-run' : ''}`;
    if (delay) li.style.animationDelay = `${delay}s`;
    li.innerHTML = `<span class="ln-dot"></span><code><span class="ns">phonedock · </span><span class="fn">${esc(text.slice(0, i))}</span>${esc(text.slice(i))}</code>`;
    log.append(li);
    return li;
  };
  const addMore = (n) => {
    const li = document.createElement('li');
    li.className = 'ln ln-more is-new';
    li.innerHTML = `<span class="ln-dot"></span><span>${n} more ${n === 1 ? 'call' : 'calls'}, then the answer</span>`;
    log.append(li);
  };
  const addAnswer = () => {
    const li = document.createElement('li');
    li.className = 'ln ln-answer is-new';
    li.innerHTML = '<span class="ln-dot"></span><p></p>';
    log.append(li);
    return li.querySelector('p');
  };
  const typeInto = (el, text, n, caret) => {
    el.textContent = text.slice(0, n);
    if (caret) { const c = document.createElement('span'); c.className = 'caret'; el.append(c); }
  };
  // Keep the log short: lines that have scrolled out of the card are dropped.
  const trim = () => { while (log.children.length > 24) log.firstElementChild.remove(); };
  // The log fills from the top; once it overflows, it pins to the newest line and fades the oldest ones out.
  const fit = () => { if (!log.classList.contains('is-full') && log.scrollHeight > log.clientHeight + 1) log.classList.add('is-full'); };

  const setTab = (i, p) => tabs.forEach((b, j) => {
    b.setAttribute('aria-pressed', String(j === i));
    b.querySelector('.task-rail span').style.setProperty('--p', j < i ? 1 : j === i ? p : 0);
  });

  function reset(i) {
    cur = i; phaseT = 0; shown = 0; moreShown = false; answerShown = false; answerP = null;
    callEls.length = 0;
    log.replaceChildren();
    log.classList.remove('is-full');
    // The card's text for screen readers: the whole run at once, since the typed version is hidden from them.
    if (sr) sr.textContent = `Recording ${i + 1} of ${TASKS.length}, ${tabs[i]?.textContent.trim()}. The prompt: ${TASKS[i].prompt} Claude Code’s answer: ${TASKS[i].answer}`;
    videos.forEach((v, j) => v.classList.toggle('is-on', j === i));
    for (const [j, v] of videos.entries()) if (j !== i && !v.paused) v.pause();
    const v = videos[i];
    ensureLoaded(v);
    if (v.readyState >= 1) v.currentTime = 0;
    clock.textContent = clockAt(TASKS[i], 0);
    setTab(i, 0);
  }

  function start(i) {
    staticMode = false;
    reset(i);
    if (videos[i].readyState >= 2) videos[i].removeAttribute('poster');
    phase = 'prompt';
    typeInto(promptEl, TASKS[i].prompt, 0, true);
  }

  // Reduced motion, or a frozen frame for screenshots: the whole run as text, and the clip's poster or frame.
  function showStatic(i, at = Infinity) {
    staticMode = true;
    reset(i);
    phase = 'static';
    const task = TASKS[i];
    const v = videos[i];
    if (Number.isFinite(at)) {
      const seek = () => { v.currentTime = Math.min(at, task.len - 0.05); };
      if (v.readyState >= 1) seek(); else v.addEventListener('loadedmetadata', seek, { once: true });
    } else {
      v.poster = v.dataset.poster;
    }
    promptEl.textContent = task.prompt;
    for (const [t, text] of task.lines) if (t <= at) addCall(text, false);
    const done = !Number.isFinite(at) || at >= task.len;
    if (done) { addMore(task.more); typeInto(addAnswer(), task.answer, task.answer.length, false); }
    for (const li of log.children) li.classList.remove('is-new');
    // The clock reads the recording time of the frame on screen: the poster's, or the frozen moment's.
    clock.textContent = clockAt(task, Number.isFinite(at) ? Math.min(at, task.len) : task.poster);
    setTab(i, done ? 1 : 0.5);
    fit();
  }

  function frame(now) {
    const dt = Math.min(0.1, (now - last) / 1000 || 0);
    last = now;
    requestAnimationFrame(frame);
    if (held || !visible || staticMode) return;
    const task = TASKS[cur];
    const v = videos[cur];
    const promptLen = task.prompt.length;
    const promptDur = promptLen / PROMPT_CPS + 0.35;
    const answerDur = 0.9 + task.answer.length / ANSWER_CPS + HOLD;
    const runDur = task.len;
    let p = 0;

    if (phase === 'prompt') {
      phaseT += dt;
      typeInto(promptEl, task.prompt, Math.min(promptLen, Math.floor(phaseT * PROMPT_CPS)), true);
      // A clip that never loads leaves the run as text, rather than a card stuck on its prompt.
      if (phaseT > promptDur + 10) { setHeld(true); showStatic(cur); return; }
      if (phaseT >= promptDur && v.readyState >= 2) {
        typeInto(promptEl, task.prompt, promptLen, false);
        phase = 'run';
        v.play().catch(() => {});
        const next = videos[(cur + 1) % videos.length];
        ensureLoaded(next);
      }
      p = Math.min(phaseT, promptDur) / (promptDur + runDur + answerDur);
    } else if (phase === 'run') {
      const t = v.currentTime;
      let batch = 0;
      while (shown < task.lines.length && task.lines[shown][0] <= t) {
        const [lt, text, until] = task.lines[shown];
        callEls.push([addCall(text, true, batch * 0.07), until ?? lt + 0.7]);
        shown++; batch++;
      }
      for (const [li, until] of callEls) if (t >= until) li.classList.remove('is-run');
      clock.textContent = clockAt(task, t);
      if (batch) trim();
      p = (promptDur + t) / (promptDur + runDur + answerDur);
      if (v.ended || (v.duration && t >= v.duration - 0.04)) { phase = 'answer'; phaseT = 0; }
    } else if (phase === 'answer') {
      phaseT += dt;
      if (!moreShown && phaseT > 0.35) {
        for (const [li] of callEls) li.classList.remove('is-run');
        addMore(task.more); moreShown = true;
      }
      if (!answerShown && phaseT > 0.9) { answerP = addAnswer(); answerShown = true; trim(); }
      if (answerP) {
        const n = Math.min(task.answer.length, Math.floor((phaseT - 0.9) * ANSWER_CPS));
        typeInto(answerP, task.answer, n, n < task.answer.length);
      }
      p = (promptDur + runDur + Math.min(phaseT, answerDur)) / (promptDur + runDur + answerDur);
      if (phaseT >= answerDur) { start((cur + 1) % TASKS.length); return; }
    }
    if (phase !== 'prompt') fit();
    setTab(cur, Math.min(1, p));
  }

  tabs.forEach((b, i) => b.addEventListener('click', () => {
    if (reduceMotion.matches && held) { showStatic(i); return; }
    start(i);
  }));
  hold.addEventListener('click', () => {
    if (staticMode) { setHeld(false); start(cur); return; }
    setHeld(!held);
  });

  new IntersectionObserver(([e]) => {
    visible = e.isIntersecting;
    const v = videos[cur];
    if (phase === 'run') { if (visible && !held) v.play().catch(() => {}); else v.pause(); }
  }, { threshold: 0.15 }).observe(root);
  document.addEventListener('visibilitychange', () => {
    visible = !document.hidden;
    if (phase === 'run' && document.hidden) videos[cur].pause();
    else if (phase === 'run' && !held) videos[cur].play().catch(() => {});
  });

  // ?at=<run>,<seconds> freezes a run at a moment (for screenshots); add a large number for the answer.
  const at = params.get('at')?.split(',').map(Number);
  if (at && at.length === 2 && TASKS[at[0]]) {
    setHeld(true);
    showStatic(at[0], at[1]);
  } else if (reduceMotion.matches) {
    setHeld(true);
    showStatic(0);
  } else {
    start(0);
  }
  requestAnimationFrame(frame);
}
