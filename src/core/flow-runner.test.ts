import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { parseFlow } from './flow.ts';
import { junitXml, runFlow, runFlowFiles, screenNow, type FlowClient } from './flow-runner.ts';
import type { ElementMatch } from './types.ts';

// A fake PhoneDock client playing the sample app: a name field, Greet, a greeting, a Notifications switch.
function fakeApp(opts: { greetingAppearsOnAttempt?: number } = {}) {
  const st = { running: false, name: '', greeting: '', notif: false, launches: 0 };
  const calls: string[] = [];
  let lease: { owner: string } | undefined;
  const els = (): (ElementMatch & { act?: () => void })[] => {
    if (!st.running) return [{ type: 'TextView', text: 'Home', bounds: { x: 0, y: 0, width: 10, height: 10 }, center: { x: 5, y: 5 }, visible: true, exact: false, score: 1, source: 'accessibility' }];
    const e = (type: string, text: string, y: number, extra: Omit<Partial<ElementMatch>, 'score' | 'source'> & { act?: () => void } = {}) =>
      ({ type, text, bounds: { x: 0, y, width: 1080, height: 100 }, center: { x: 540, y: y + 50 }, visible: true, exact: false, score: 1, source: 'accessibility' as const, ...extra });
    const showGreeting = st.greeting && (!opts.greetingAppearsOnAttempt || st.launches >= opts.greetingAppearsOnAttempt);
    return [
      e('android.widget.TextView', 'PhoneDock Sample', 100, { id: 'dev.phonedock.sample:id/title' }),
      e('android.widget.EditText', st.name, 300, { id: 'dev.phonedock.sample:id/nameField', placeholder: 'Your name', editable: true, value: st.name }),
      e('android.widget.Button', 'Greet', 500, { clickable: true, act: () => { st.greeting = `Hello, ${st.name || 'World'}!`; } }),
      ...(showGreeting ? [e('android.widget.TextView', st.greeting, 700, { id: 'dev.phonedock.sample:id/greetingLabel' })] : []),
      e('android.widget.Switch', 'Notifications', 900, { clickable: true, checked: st.notif, act: () => { st.notif = !st.notif; } }),
      e('android.widget.TextView', st.notif ? 'Notifications on' : 'Notifications off', 1100, { id: 'dev.phonedock.sample:id/notifyStatus' }),
    ];
  };
  const summary = () => els().map((e) => e.text || e.placeholder).filter(Boolean).join(', ');
  const match = (q: { text?: string; id?: string; type?: string }) => els().filter((e) =>
    (!q.text || [e.text, e.placeholder, e.label].some((t) => t && t.toLowerCase().includes(q.text!.toLowerCase())))
    && (!q.id || (e.id ?? '').endsWith(q.id)) && (!q.type || e.type.toLowerCase().endsWith(q.type.toLowerCase())));
  const timeout = (what: string) => Object.assign(new Error('The screen did not reach the requested state in time'), { code: 'wait_timeout', status: 408, hints: [], detail: `Timed out after 50 ms waiting for ${what} to be visible (2 polls)\nScreen now (accessibility): ${summary()}` });
  const c = {
    owner: 'test:1',
    device: async (id: string) => ({ id, name: 'pdtest-fake', platform: 'android', kind: 'emulator', state: 'running', osVersion: 'Android 16 (API 36)', screen: { width: 1080, height: 2400 }, nativeId: 'x', backend: 'fake', ...(lease ? { lease } : {}) }),
    lease: async () => { calls.push('lease'); lease = { owner: 'test:1' }; return { owner: 'test:1', acquiredAt: '', expiresAt: null }; },
    releaseLease: async () => { calls.push('release'); lease = undefined; return { ok: true }; },
    launch: async (_id: string, app: string) => { calls.push(`launch ${app}`); st.running = true; st.launches++; return { ok: true }; },
    terminate: async () => { calls.push('terminate'); st.running = false; st.name = ''; st.greeting = ''; st.notif = false; return { ok: true }; },
    find: async (_id: string, q: { text?: string; id?: string; type?: string; index?: number }) => {
      const m = match(q);
      return { source: 'accessibility', total: m.length, index: q.index ?? 0, match: m[q.index ?? 0] ?? null, matches: m, summary: summary() };
    },
    waitFor: async (_id: string, q: { until: string; text?: string; id?: string; type?: string }) => {
      if (q.until === 'idle') return { ok: true, until: 'idle', elapsedMs: 1 };
      const m = match(q);
      if (q.until === 'visible' && !m.length) throw timeout(JSON.stringify(q.text ?? q.id));
      if (q.until === 'gone' && m.length) throw Object.assign(timeout(String(q.text)), { detail: `Timed out\nStill visible: x\nScreen now (accessibility): ${summary()}` });
      return { ok: true, until: q.until, elapsedMs: 1 };
    },
    fill: async (_id: string, q: { text?: string; value: string }) => {
      const f = match({ text: q.text }).find((e) => e.editable);
      if (!f) throw Object.assign(new Error('No matching field was found'), { code: 'not_found', status: 404, hints: [], detail: `No field matches\nScreen now (accessibility): ${summary()}` });
      st.name = q.value; calls.push(`fill ${q.value}`);
      return { ok: true, verified: true, finalValue: q.value, warnings: [] };
    },
    tap: async (_id: string, x: number, y: number, label?: string, meta?: unknown) => {
      calls.push(`tap ${label ?? `${x},${y}`}${meta ? ` ${JSON.stringify(meta)}` : ''}`);
      els().find((e) => y >= e.bounds.y && y < e.bounds.y + e.bounds.height)?.act?.();
      return { ok: true };
    },
    screenshot: async () => ({ data: Buffer.from('\x89PNG fake'), mime: 'image/png', deviceWidth: 1080, deviceHeight: 2400, imageWidth: 1080, imageHeight: 2400, scale: 1 }),
    uiText: async () => `UI\n${summary()}`,
    ui: async () => ({ source: 'accessibility', screen: { width: 1080, height: 2400 }, root: [], capturedAt: '' }),
    logs: async (_id: string, o: { app?: string } = {}) => (o.app ? `app log for ${o.app}` : 'device log'),
  };
  return { c: c as unknown as FlowClient, st, calls };
}

const FLOW = `name: Greet
appId: dev.phonedock.sample
platform: android
minOS: "16"
steps:
  - launch: dev.phonedock.sample
  - assert_visible: PhoneDock Sample
  - fill: { field: Your name, value: Ada }
  - tap: Greet
  - assert_visible: "Hello, Ada!"
  - tap: { text: Notifications, type: Switch }
  - assert_text: { field: id:notifyStatus, equals: Notifications on }
  - assert_not_visible: Notifications off
`;
const tmp = () => mkdtempSync(join(tmpdir(), 'pd-flow-'));

test('runner: a passing flow, lease taken and given back, taps carry their selector', async () => {
  const { c, st, calls } = fakeApp(); const dir = tmp(); const lines: string[] = [];
  try {
    const r = await runFlow(c, parseFlow(FLOW, 'flows/greet.yaml'), { deviceId: 'android-emulator:pdtest-fake', artifactsDir: dir, settle: false, timeoutMs: 50, log: (l) => lines.push(l) });
    assert.equal(r.status, 'pass', r.message ?? '');
    assert.equal(r.steps.length, 8);
    assert.ok(r.steps.every((s) => s.status === 'pass'));
    assert.equal(st.notif, true);
    assert.equal(calls[0], 'lease'); assert.equal(calls[calls.length - 1], 'release');
    assert.ok(calls.includes('terminate'), 'launch stops the app first');
    assert.ok(calls.some((x) => x.startsWith('tap Greet {"selector":{"text":"Greet"}')), calls.join('\n'));
    assert.match(lines.join('\n'), /PASS {2}1 {2}launch dev\.phonedock\.sample/);
    assert.match(lines.join('\n'), /PASS {2}7 {2}assert_text id=notifyStatus = "Notifications on"/);
    assert.ok(existsSync(join(dir, 'greet', 'report.html')), 'passing flows have a reviewable report');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: a failing step names what was expected and what is on screen, saves artifacts, skips the rest', async () => {
  const { c } = fakeApp(); const dir = tmp(); const lines: string[] = [];
  try {
    const r = await runFlow(c, parseFlow(FLOW.replace('"Hello, Ada!"', '"Hello, Bob!"')), { deviceId: 'd', artifactsDir: dir, settle: false, timeoutMs: 50, log: (l) => lines.push(l) });
    assert.equal(r.status, 'fail');
    assert.equal(r.steps[4].status, 'fail');
    assert.match(r.steps[4].message!, /^Expected "Hello, Bob!" to be visible within 50 ms, but it never appeared\.\nScreen now: PhoneDock Sample, Ada, Greet, Hello, Ada!, Notifications, Notifications off$/);
    assert.deepEqual(r.steps.slice(5).map((s) => s.status), ['skip', 'skip', 'skip']);
    assert.match(r.message!, /^step 5 \(assert_visible "Hello, Bob!"\): Expected/);
    for (const f of ['failure.png', 'ui.txt', 'ui.json', 'logs.txt', 'app.log', 'steps.txt', 'result.json']) assert.ok(existsSync(join(r.artifacts!, f)), f);
    assert.match(readFileSync(join(r.artifacts!, 'steps.txt'), 'utf8'), /FAIL {2}5 {2}assert_visible "Hello, Bob!"/);
    assert.match(lines.join('\n'), /FAIL {2}5 {2}assert_visible "Hello, Bob!"[^\n]*\n {11}Expected "Hello, Bob!"/);
    const xml = junitXml({ flows: [r], passed: 0, failed: 1, skipped: 0, ms: r.ms, artifactsDir: dir });
    assert.match(xml, /<testsuites name="phonedock flows" tests="1" failures="1"/);
    assert.match(xml, /<failure message="step 5 \(assert_visible &quot;Hello, Bob!&quot;\): Expected &quot;Hello, Bob!&quot; to be visible within 50 ms, but it never appeared\." type="FlowFailure">/);
    assert.match(xml, /Artifacts: /);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: retries a failed flow; optional steps only warn', async () => {
  const { c } = fakeApp({ greetingAppearsOnAttempt: 2 }); const dir = tmp();
  try {
    const flow = parseFlow(FLOW.replace('  - tap: Greet\n', '  - tap: { text: Skip intro }\n    optional: true\n  - tap: Greet\n'));
    const r = await runFlow(c, flow, { deviceId: 'd', artifactsDir: dir, settle: false, timeoutMs: 30, retries: 1 });
    assert.equal(r.status, 'pass', r.message ?? '');
    assert.equal(r.attempts, 2);
    assert.equal(r.steps[3].status, 'warn');
    assert.ok(existsSync(join(dir, 'greet-attempt1', 'failure.png')), 'the failed attempt kept its artifacts');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: platform and OS gates skip; invalid files fail; screenNow reads error details', async () => {
  const { c } = fakeApp(); const dir = tmp();
  try {
    const ios = await runFlow(c, parseFlow('platform: ios\nsteps:\n  - tap: x\n'), { deviceId: 'd', artifactsDir: dir, settle: false });
    assert.equal(ios.status, 'skip'); assert.match(ios.message!, /for ios/);
    const newer = await runFlow(c, parseFlow('minOS: "17"\nsteps:\n  - tap: x\n'), { deviceId: 'd', artifactsDir: dir, settle: false });
    assert.equal(newer.status, 'skip'); assert.match(newer.message!, /needs android 17 or later; pdtest-fake has 16/);
    writeFileSync(join(dir, 'a.yaml'), FLOW);
    writeFileSync(join(dir, 'b.yaml'), 'steps:\n  - tapp: x\n');
    const s = await runFlowFiles(c, [join(dir, 'a.yaml'), join(dir, 'b.yaml')], { deviceId: 'd', artifactsDir: dir, settle: false, timeoutMs: 30 });
    assert.deepEqual([s.passed, s.failed, s.skipped], [1, 1, 0]);
    assert.match(s.flows[1].message!, /invalid flow: .*b\.yaml: step 1: unknown command "tapp"/);
    assert.equal(screenNow({ detail: 'Timed out\nScreen now (ocr): A, B' }), 'A, B');
    assert.equal(screenNow({ hints: ['Screen now: C'] }), 'C');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: ${VAR} values come from the environment, missing ones fail the flow clearly', async () => {
  const { c, st } = fakeApp(); const dir = tmp();
  try {
    const flow = parseFlow('appId: dev.phonedock.sample\nsteps:\n  - launch\n  - fill: { field: Your name, value: "${WHO}" }\n');
    const ok = await runFlow(c, flow, { deviceId: 'd', artifactsDir: dir, settle: false, env: { WHO: 'Grace' } });
    assert.equal(ok.status, 'pass', ok.message ?? ''); assert.equal(st.name, 'Grace');
    const bad = await runFlow(c, flow, { deviceId: 'd', artifactsDir: dir, settle: false, env: { WHO: undefined } });
    assert.equal(bad.status, 'fail'); assert.match(bad.message!, /WHO is not set/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: launching an app that is not installed says so', async () => {
  const { c } = fakeApp(); const dir = tmp();
  const fc = c as unknown as Record<string, unknown>;
  fc.launch = async () => { throw Object.assign(new Error('Couldn’t launch the app'), { code: 'launch_failed', status: 500, hints: [], detail: 'Could not launch x: -p' }); };
  fc.apps = async () => [{ id: 'com.android.settings', system: true }];
  const flow = parseFlow('appId: dev.phonedock.sample\nsteps:\n  - launch\n');
  try {
    const r = await runFlow(c, flow, { deviceId: 'd', artifactsDir: dir, settle: false });
    assert.equal(r.status, 'fail');
    assert.match(r.message!, /dev\.phonedock\.sample isn’t installed on pdtest-fake\. Install it before the run: phonedock install pdtest-fake/);
    fc.apps = async () => [{ id: 'dev.phonedock.sample', system: false }];
    const r2 = await runFlow(c, flow, { deviceId: 'd', artifactsDir: dir, settle: false });
    assert.match(r2.message!, /Couldn’t launch the app/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: baseline assertions fail closed and never record implicitly', async () => {
  const { c } = fakeApp(); const dir = tmp();
  try {
    const flow = parseFlow('name: Baseline\nsteps:\n  - screenshot: { name: home, baseline: missing.png }\n', join(dir, 'flow.yaml'));
    const r = await runFlow(c, flow, { deviceId: 'd', artifactsDir: join(dir, 'artifacts'), baselineRoot: dir, settle: false });
    assert.equal(r.status, 'fail');
    assert.match(r.message!, /baseline.*missing|missing.*baseline/i);
    assert.equal(existsSync(join(dir, 'missing.png')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: explicit baseline recording, comparison and update share one confined root', async () => {
  const { c } = fakeApp(); const dir = tmp();
  try {
    mkdirSync(join(dir, 'flows'));
    const flow = parseFlow('name: Baseline\nsteps:\n  - screenshot: { name: home, baseline: ../baselines/home.png }\n', join(dir, 'flows', 'flow.yaml'));
    const opts = { deviceId: 'd', artifactsDir: join(dir, 'artifacts'), baselineRoot: dir, settle: false };
    const recorded = await runFlow(c, flow, { ...opts, baselineMode: 'record' });
    assert.equal(recorded.status, 'pass', recorded.message ?? '');
    assert.ok(existsSync(join(dir, 'baselines', 'home.png')));
    let compared = 0;
    const bad = await runFlow(c, flow, { ...opts, compareImages: async () => { compared++; return 0.5; } });
    assert.equal(bad.status, 'fail'); assert.equal(compared, 1);
    writeFileSync(join(dir, 'baselines', 'home.png'), 'old');
    const updated = await runFlow(c, flow, { ...opts, baselineMode: 'update' });
    assert.equal(updated.status, 'pass');
    assert.deepEqual(readFileSync(join(dir, 'baselines', 'home.png')), Buffer.from('\x89PNG fake'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: baseline traversal and symlink escapes are rejected before a baseline is written', async () => {
  const { c } = fakeApp(); const dir = tmp(); const outside = tmp();
  try {
    symlinkSync(outside, join(dir, 'escape'));
    symlinkSync(join(outside, 'missing.png'), join(dir, 'dangling.png'));
    for (const baseline of [`../${basename(outside)}/out.png`, 'escape/out.png', 'dangling.png']) {
      const flow = parseFlow(`name: Escape\nsteps:\n  - screenshot: { name: home, baseline: ${baseline} }\n`, join(dir, 'flow.yaml'));
      const r = await runFlow(c, flow, { deviceId: 'd', artifactsDir: join(dir, 'artifacts'), baselineRoot: dir, baselineMode: 'record', settle: false });
      assert.equal(r.status, 'fail'); assert.match(r.message!, /baseline.*root|outside.*root|unresolved symlink/i);
    }
    assert.equal(existsSync(join(outside, 'out.png')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('runner: updating a baseline replaces its entry without changing another hard link', async () => {
  const { c } = fakeApp(); const dir = tmp(); const outside = tmp();
  try {
    writeFileSync(join(outside, 'original.png'), 'do not change');
    linkSync(join(outside, 'original.png'), join(dir, 'baseline.png'));
    const flow = parseFlow('steps:\n  - screenshot: { name: home, baseline: baseline.png }\n', join(dir, 'flow.yaml'));
    const r = await runFlow(c, flow, { deviceId: 'd', artifactsDir: join(dir, 'artifacts'), baselineRoot: dir, baselineMode: 'update', settle: false });
    assert.equal(r.status, 'pass');
    assert.equal(readFileSync(join(outside, 'original.png'), 'utf8'), 'do not change');
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});

test('runner: reports and result artifacts redact secret steps and escape HTML', async () => {
  const { c } = fakeApp(); const dir = tmp(); const secret = 'pd-private-"493\\827\n';
  try {
    c.type = async () => ({ ok: true, delivery: 'sent', retrySafe: false });
    c.logs = async () => `error ${secret} </script><script>alert(1)</script>`;
    const oldUi = c.ui;
    c.ui = async (id) => ({ ...await oldUi(id), app: { label: secret } });
    const flow = parseFlow(JSON.stringify({ name: '<script>bad()</script>', steps: [{ type: { text: secret, secret: true } }, { assert_visible: 'missing' }] }));
    const r = await runFlow(c, flow, { deviceId: 'd', artifactsDir: dir, settle: false, timeoutMs: 0 });
    assert.equal(r.status, 'fail');
    for (const file of ['report.html', 'result.json', 'steps.txt', 'logs.txt', 'ui.json']) {
      const body = readFileSync(join(r.artifacts!, file), 'utf8');
      assert.ok(!body.includes(secret), `${file} leaked a secret`);
      assert.ok(!body.includes('493'), `${file} leaked an escaped secret`);
    }
    const report = readFileSync(join(r.artifacts!, 'report.html'), 'utf8');
    assert.ok(!report.includes('<script>bad()'));
    assert.match(report, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
    assert.match(report, /data:image\/png;base64,/);
    assert.ok(!JSON.stringify(r).includes(secret), 'returned result leaked a secret');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: optional per-action evidence captures before and after with an action point', async () => {
  const { c } = fakeApp(); const dir = tmp();
  try {
    const r = await runFlow(c, parseFlow('name: Evidence\nsteps:\n  - tap: { at: "50%,50%" }\n'), { deviceId: 'd', artifactsDir: dir, settle: false, captureSteps: true });
    assert.equal(r.status, 'pass');
    assert.ok(existsSync(r.steps[0].beforeScreenshot!));
    assert.ok(existsSync(r.steps[0].screenshot!));
    assert.deepEqual(r.steps[0].actionPoint, { x: 540, y: 1200 });
    const html = readFileSync(r.report!, 'utf8');
    assert.match(html, /<figcaption>Before<\/figcaption>/);
    assert.match(html, /<figcaption>After<\/figcaption>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: failure evidence is captured before releasing ownership', async () => {
  const { c } = fakeApp(); const dir = tmp(); let released = false; let captured = false;
  const release = c.releaseLease.bind(c), screenshot = c.screenshot.bind(c);
  c.releaseLease = async (...args) => { released = true; return release(...args); };
  c.screenshot = async (...args) => { assert.equal(released, false, 'failure screen can change after release'); captured = true; return screenshot(...args); };
  try {
    const r = await runFlow(c, parseFlow('steps:\n  - assert_visible: missing\n'), { deviceId: 'd', artifactsDir: dir, settle: false, timeoutMs: 0 });
    assert.equal(r.status, 'fail'); assert.equal(captured, true); assert.equal(released, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runner: passes interpolated launch args/env and redacts their values from logs, result.json and report.html', async () => {
  const { c } = fakeApp(); const dir = tmp();
  const launchedCalls: { app: string; opts?: unknown }[] = [];
  const argSecret = 'pd-launch-arg-secret-9911';
  const envSecret = 'pd-launch-env-secret-8822';
  c.launch = async (_id, app, opts) => { launchedCalls.push({ app, opts }); return { ok: true, delivery: 'sent', retrySafe: false }; };
  c.logs = async () => `app saw ${argSecret} and ${envSecret}`;
  try {
    const flow = parseFlow(`name: Secret launch
appId: dev.phonedock.sample
steps:
  - launch:
      arguments:
        token: "\${ARG_SECRET}"
        debug: true
      env:
        API_KEY: "\${ENV_SECRET}"
  - assert_visible: missing
`);
    const logged: string[] = [];
    const r = await runFlow(c, flow, {
      deviceId: 'd', artifactsDir: dir, settle: false, timeoutMs: 0,
      env: { ARG_SECRET: argSecret, ENV_SECRET: envSecret },
      log: (l) => logged.push(l),
    });
    assert.equal(r.status, 'fail');
    assert.deepEqual(launchedCalls, [{
      app: 'dev.phonedock.sample',
      opts: { args: { token: argSecret, debug: true }, env: { API_KEY: envSecret } },
    }]);
    assert.ok(!logged.join('\n').includes(argSecret));
    assert.ok(!logged.join('\n').includes(envSecret));
    assert.ok(!JSON.stringify(r).includes(argSecret));
    assert.ok(!JSON.stringify(r).includes(envSecret));
    for (const file of ['report.html', 'result.json', 'steps.txt', 'logs.txt']) {
      const body = readFileSync(join(r.artifacts!, file), 'utf8');
      assert.ok(!body.includes(argSecret), `${file} leaked launch arg secret`);
      assert.ok(!body.includes(envSecret), `${file} leaked launch env secret`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
