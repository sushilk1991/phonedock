import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlowError, compareVersions, flowFromLog, interpolate, parseFlow, parseStep, pickAssertText, stepOut, toMaestro, writeFlow, type LogEntry, type Observation, type Step } from './flow.ts';

const SAMPLE = `# hand-written
name: Greet
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
  - tap: { at: "50%,62%" }
  - wait_for: { gone: Loading, }
  - back
`;

test('flow: parses the YAML format into steps', () => {
  const f = parseFlow(SAMPLE.replace('{ gone: Loading, }', '{ gone: Loading }'), 'flows/greet.yaml');
  assert.equal(f.name, 'Greet');
  assert.equal(f.appId, 'dev.phonedock.sample');
  assert.equal(f.platform, 'android');
  assert.equal(f.minOS, '16');
  assert.deepEqual(f.steps.map((s) => s.kind), ['launch', 'assert_visible', 'fill', 'tap', 'assert_visible', 'tap', 'assert_text', 'tap', 'wait_for', 'back']);
  assert.deepEqual(f.steps[2], { kind: 'fill', field: { text: 'Your name' }, value: 'Ada' });
  assert.deepEqual(f.steps[5], { kind: 'tap', sel: { text: 'Notifications', type: 'Switch' } });
  assert.deepEqual(f.steps[6], { kind: 'assert_text', field: { id: 'notifyStatus' }, equals: 'Notifications on' });
  assert.deepEqual(f.steps[7], { kind: 'tap', at: { x: 50, y: 62, unit: '%' }, fragile: true });
  assert.deepEqual(f.steps[8], { kind: 'wait_for', until: 'gone', sel: { text: 'Loading' } });
});

test('flow: JSON and a bare list of steps are accepted', () => {
  const f = parseFlow(JSON.stringify({ name: 'j', steps: [{ launch: 'com.x' }, 'back', { tap: 'OK' }] }), 'x.json');
  assert.deepEqual(f.steps.map((s) => s.kind), ['launch', 'back', 'tap']);
  const g = parseFlow('- launch: com.x\n- tap: Go\n', 'list.yaml');
  assert.equal(g.name, 'list');
  assert.equal(g.steps.length, 2);
});

test('flow: errors name the step and what is wrong', () => {
  const err = (src: string, re: RegExp) => assert.throws(() => parseFlow(src, 'f.yaml'), (e: unknown) => e instanceof FlowError && re.test(e.message), src);
  err('steps:\n  - tapp: Go\n', /f\.yaml: step 1: unknown command "tapp"/);
  err('steps:\n  - launch: x\n  - fill: { field: Name }\n', /step 2: fill needs value/);
  err('steps:\n  - tap: Go\n    back: 1\n', /one command per step/);
  err('steps:\n  - tap: { txt: Go }\n', /unknown selector key "txt"/);
  err('steps:\n  - swipe: sideways\n', /direction/);
  err('steps:\n  - assert_text: { field: x }\n', /equals, contains or matches/);
  err('name: x\n', /"steps:" must be a list/);
  err('steps: []\n', /no steps/);
  err('steps:\n  - tap: a: b\n', /f\.yaml: line 2/);
});

test('flow: every step writes back to the same step', () => {
  const steps: Step[] = [
    { kind: 'launch', app: 'a', stop: true }, { kind: 'launch', stop: false }, { kind: 'terminate' },
    { kind: 'tap', sel: { text: 'Go' } }, { kind: 'tap', sel: { id: 'go', index: 1 } }, { kind: 'long_press', sel: { text: 'Row' }, durationMs: 900 },
    { kind: 'double_tap', at: { x: 10, y: 20, unit: '%' }, fragile: true },
    { kind: 'fill', field: { text: 'Email' }, value: 'a@b.c', submit: true }, { kind: 'fill', field: { id: 'pw' }, value: '${PW}', secret: true },
    { kind: 'type', text: 'hi' }, { kind: 'type', text: 'x', submit: true }, { kind: 'key', key: 'enter' },
    { kind: 'back' }, { kind: 'home' }, { kind: 'hide_keyboard' },
    { kind: 'scroll_to', sel: { text: 'About' } }, { kind: 'scroll_to', sel: { text: 'Top' }, direction: 'up', max: 5 },
    { kind: 'swipe', direction: 'left' }, { kind: 'swipe', from: { x: 50, y: 80, unit: '%' }, to: { x: 50, y: 20, unit: '%' }, fragile: true },
    { kind: 'wait_for', until: 'idle' }, { kind: 'wait_for', until: 'visible', sel: { text: 'Done' } }, { kind: 'wait_for', until: 'gone', sel: { type: 'ProgressBar' } },
    { kind: 'set_appearance', mode: 'dark' }, { kind: 'rotate', orientation: 'landscape' }, { kind: 'open_url', url: 'https://x.y/z' },
    { kind: 'gesture', gesture: 'app_switcher' }, { kind: 'alert', action: 'accept' }, { kind: 'alert', action: 'button', button: 'Allow' },
    { kind: 'sleep', ms: 500 }, { kind: 'assert_visible', sel: { text: 'Hi', match: 'exact' } }, { kind: 'assert_not_visible', sel: { text: 'Error' } },
    { kind: 'assert_text', field: { id: 'name' }, contains: 'Ada' }, { kind: 'screenshot', name: 'home' },
    { kind: 'tap', sel: { text: 'Skip' }, optional: true, timeoutMs: 3000 },
  ];
  for (const s of steps) assert.deepEqual(parseStep(stepOut(s)), s, JSON.stringify(stepOut(s)));
  const text = writeFlow({ name: 'all', env: {}, steps });
  assert.deepEqual(parseFlow(text).steps, steps);
});

test('flow: ${VAR} interpolation', () => {
  assert.equal(interpolate('user ${USER_NAME}', { USER_NAME: 'ada' }), 'user ada');
  assert.equal(interpolate('${MISSING:-guest}', {}), 'guest');
  assert.throws(() => interpolate('${PW}', {}), /PW is not set/);
  assert.equal(compareVersions('26.5', '27'), -1);
  assert.equal(compareVersions('16', '16.0'), 0);
});

// A session like an agent's on the sample app: launch, read the screen (twice), fill the name, tap Greet,
// a failed wait, toggle Notifications, read the screen again.
const at = (s: number) => new Date(Date.UTC(2026, 10, 4, 12, 0, s)).toISOString();
const screen = (s: number, texts: string[], sig = texts.join('|')): Observation => ({ at: at(s), kind: 'screen', sig, texts, screen: [1080, 2424] });
const HOME = ['PhoneDock Sample', 'Greet', 'Notifications', 'Notifications off', 'Crash'];
function agentSession(): { entries: LogEntry[]; obs: Observation[] } {
  const own = 'mcp:claude';
  const entries: LogEntry[] = [
    { at: at(-1), owner: own, action: { action: 'terminate', appId: 'dev.phonedock.sample' } },
    { at: at(0), owner: own, action: { action: 'launch', appId: 'dev.phonedock.sample' } },
    // fill (marker on its first tap)
    { at: at(4), owner: own, action: { action: 'tap', x: 540, y: 420 }, via: 'fill', resolved: { x: 540, y: 420, element: { type: 'android.widget.EditText', id: 'dev.phonedock.sample:id/nameField', placeholder: 'Your name' } },
      fill: { text: 'Your name', value: 'Ada', clear: true } },
    { at: at(4), owner: own, action: { action: 'key', key: 'ctrl+a' }, via: 'fill' },
    { at: at(4), owner: own, action: { action: 'key', key: 'delete' }, via: 'fill' },
    { at: at(5), owner: own, action: { action: 'type', text: 'Ada' }, via: 'fill' },
    // tap by text (selector from the MCP tap tool)
    { at: at(7), owner: own, action: { action: 'tap', x: 160, y: 560, label: 'Greet', selector: { text: 'Greet' } } },
    { at: at(12), owner: own, action: { action: 'tap', x: 540, y: 760, label: 'Notifications', selector: { text: 'Notifications', type: 'Switch' } } },
    // someone else on the same device, and the daemon itself
    { at: at(6), owner: 'cli:other', action: { action: 'tap', x: 1, y: 1 } },
    { at: at(13), owner: 'daemon', action: { action: 'rotate', orientation: 'portrait' } },
  ];
  const obs: Observation[] = [
    screen(-5, ['Home', 'Phone', 'Chrome']),
    screen(2, HOME), screen(3, HOME),                                         // get_ui twice: no steps
    { at: at(9), kind: 'wait', owner: own, until: 'visible', query: { text: 'Hello Ada' }, ok: false, elapsedMs: 5000 },
    screen(10, ['PhoneDock Sample', 'Ada', 'Greet', 'Hello, Ada!', 'Notifications', 'Notifications off', 'Crash']),
    { at: at(11), kind: 'wait', owner: own, until: 'visible', query: { text: 'Hello, Ada!' }, ok: true, elapsedMs: 40 },
    screen(14, ['PhoneDock Sample', 'Ada', 'Greet', 'Hello, Ada!', 'Notifications', 'Notifications on', 'Crash']),
  ];
  return { entries, obs };
}

test('flow save: an agent session becomes a clean flow with assertions', () => {
  const { entries, obs } = agentSession();
  const r = flowFromLog(entries, obs, { owner: 'mcp:claude', platform: 'android', osVersion: 'Android 16 (API 36)', device: 'android-emulator:pdtest-flow-pixel', now: at(20) });
  assert.deepEqual(r.flow.steps, [
    { kind: 'launch', app: 'dev.phonedock.sample', stop: true },
    { kind: 'assert_visible', sel: { text: 'PhoneDock Sample' } },
    { kind: 'fill', field: { text: 'Your name' }, value: 'Ada' },
    { kind: 'tap', sel: { text: 'Greet' } },
    { kind: 'wait_for', until: 'visible', sel: { text: 'Hello, Ada!' } },
    { kind: 'tap', sel: { text: 'Notifications', type: 'Switch' } },
    { kind: 'assert_visible', sel: { text: 'Notifications on' } },
  ]);
  assert.equal(r.flow.appId, 'dev.phonedock.sample');
  assert.equal(r.flow.platform, 'android');
  assert.equal(r.flow.minOS, '16');
  assert.equal(r.flow.recordedOn?.screen, '1080x2424');
  assert.equal(r.stats.assertions, 2);
  assert.ok(r.dropped.some((d) => /^1 failed wait \(timed out\)$/.test(d)), r.dropped.join('; '));
  // the text is a valid flow that reads back to the same steps
  assert.deepEqual(parseFlow(r.text).steps, r.flow.steps);
  assert.match(r.text, /^# PhoneDock flow, saved by `phonedock flow save`/);
  assert.match(r.text, /- fill: \{ field: Your name, value: Ada \}/);
  assert.match(r.text, /# assertion added by flow save/);
});

test('flow save: explicit assertions replace the automatic final one; --since cuts the start', () => {
  const { entries, obs } = agentSession();
  const r = flowFromLog(entries, obs, { owner: 'mcp:claude', since: at(6), assertions: [parseStep({ assert_visible: 'Hello, Ada!' })], now: at(20) });
  assert.deepEqual(r.flow.steps.map((s) => s.kind), ['tap', 'wait_for', 'tap', 'assert_visible']);
  assert.deepEqual(r.flow.steps[3], { kind: 'assert_visible', sel: { text: 'Hello, Ada!' } });
});

test('flow save: logs without fill markers — tap field, clear, type becomes fill', () => {
  const entries: LogEntry[] = [
    { at: at(1), owner: 'a', action: { action: 'tap', x: 540, y: 420 }, via: 'fill', resolved: { x: 540, y: 420, element: { type: 'android.widget.EditText', id: 'dev.x:id/email' } } },
    { at: at(1), owner: 'a', action: { action: 'key', key: 'ctrl+a' }, via: 'fill' },
    { at: at(1), owner: 'a', action: { action: 'key', key: 'delete' }, via: 'fill' },
    { at: at(2), owner: 'a', action: { action: 'type', text: 'ada@example.com' }, via: 'fill' },
    { at: at(2), owner: 'a', action: { action: 'key', key: 'enter' }, via: 'fill' },
    // by hand: tap the password field by text, type a secret
    { at: at(3), owner: 'a', action: { action: 'tap', x: 540, y: 600, label: 'Password', selector: { text: 'Password' }, element: { type: 'android.widget.EditText', editable: true } } },
    { at: at(4), owner: 'a', action: { action: 'type', text: '•••', secret: true } },
    { at: at(5), owner: 'a', action: { action: 'key', key: 'enter' } },
  ];
  const r = flowFromLog(entries, [], { autoAssert: false, screen: { width: 1080, height: 2400 } });
  assert.deepEqual(r.flow.steps, [
    { kind: 'fill', field: { id: 'email' }, value: 'ada@example.com', submit: true },
    { kind: 'fill', field: { text: 'Password' }, value: '${SECRET_1}', submit: true, secret: true },
  ]);
  assert.ok(r.warnings.some((w) => /SECRET_1/.test(w)));
});

test('flow save: noise — retried fills, undone taps, failed scrolls, coordinate taps', () => {
  const sigA = 'A', sigB = 'B';
  const entries: LogEntry[] = [
    { at: at(1), owner: 'a', action: { action: 'tap', x: 1, y: 1 }, via: 'fill', fill: { text: 'Search', value: 'pizz' } },
    { at: at(1), owner: 'a', action: { action: 'type', text: 'pizz' }, via: 'fill' },
    { at: at(2), owner: 'a', action: { action: 'tap', x: 1, y: 1 }, via: 'fill', fill: { text: 'Search', value: 'pizza', submit: true } },
    { at: at(2), owner: 'a', action: { action: 'type', text: 'pizza' }, via: 'fill' },
    // accidental: opened Help, went back to the same screen
    { at: at(4), owner: 'a', action: { action: 'tap', x: 10, y: 10, label: 'Help', selector: { text: 'Help' } } },
    { at: at(6), owner: 'a', action: { action: 'key', key: 'back' } },
    // scroll_to: the swipes it made are not steps; a failed one is dropped
    { at: at(8), owner: 'a', action: { action: 'swipe', x1: 540, y1: 1800, x2: 540, y2: 600 }, via: 'scroll-to' },
    { at: at(11), owner: 'a', action: { action: 'tap', x: 540, y: 1200 } },
    { at: at(12), owner: 'a', action: { action: 'swipe', x1: 900, y1: 1200, x2: 100, y2: 1150 } },
    { at: at(13), owner: 'a', action: { action: 'shell', command: 'pm clear x' } },
    { at: at(14), owner: 'a', action: { action: 'install', path: '/tmp/x.apk' } },
    { at: at(15), owner: 'a', action: { action: 'record_start' } },
  ];
  const obs: Observation[] = [
    screen(3, ['Results'], sigA), screen(5, ['Help center'], sigB), screen(7, ['Results'], sigA),
    { at: at(9), kind: 'scroll_to', owner: 'a', query: { text: 'Pizza Palace' }, found: true, scrolls: 1 },
    { at: at(10), kind: 'scroll_to', owner: 'a', query: { text: 'Nope' }, found: false, scrolls: 8 },
  ];
  const r = flowFromLog(entries, obs, { autoAssert: false, screen: { width: 1080, height: 2400 } });
  assert.deepEqual(r.flow.steps, [
    { kind: 'fill', field: { text: 'Search' }, value: 'pizza', submit: true },
    { kind: 'scroll_to', sel: { text: 'Pizza Palace' } },
    { kind: 'tap', at: { x: 50, y: 49.5, unit: '%' }, fragile: true },   // the screen size the observations saw (1080x2424)
    { kind: 'swipe', direction: 'left' },
  ]);
  assert.ok(r.dropped.some((d) => /tap "Help" then back/.test(d)), r.dropped.join('; '));
  assert.ok(r.dropped.some((d) => /^1 scroll_to attempt that found nothing$/.test(d)));
  assert.ok(r.dropped.some((d) => /shell/.test(d)));
  assert.ok(r.dropped.includes('1 app install (do it in your CI setup)'), r.dropped.join('; '));
  assert.ok(r.dropped.includes('1 record_start action (not part of a flow)'), r.dropped.join('; '));
  assert.match(r.text, /# fragile: raw coordinates/);
  assert.match(r.text, /# Left out of this flow:/);
  const kept = flowFromLog(entries, obs, { autoAssert: false, keepNoise: true });
  assert.ok(kept.flow.steps.some((s) => s.kind === 'tap' && s.sel?.text === 'Help'));
});

test('flow save: a tap on a labelled element becomes a text selector; refs use the element', () => {
  const r = flowFromLog([
    { at: at(1), owner: 'a', action: { action: 'tap', x: 5, y: 5, label: 'Sign in' } },
    { at: at(2), owner: 'a', action: { action: 'tap', ref: 'e7' }, resolved: { ref: 'e7', x: 5, y: 5, element: { type: 'Button', label: 'Continue' } } },
    { at: at(3), owner: 'a', action: { action: 'tap', x: 5, y: 5 }, via: 'alert', resolved: { x: 5, y: 5, element: { text: 'Allow' } } },
    { at: at(4), owner: 'a', action: { action: 'gesture', gesture: 'go_home' } },
  ], [], { autoAssert: false });
  assert.deepEqual(r.flow.steps, [
    { kind: 'tap', sel: { text: 'Sign in' } }, { kind: 'tap', sel: { text: 'Continue' } },
    { kind: 'alert', action: 'button', button: 'Allow' }, { kind: 'home' },
  ]);
});

test('flow save: pickAssertText prefers new, digit-free, specific text', () => {
  assert.equal(pickAssertText({ texts: ['12:45', 'Settings', 'General', 'About'] }, { texts: ['Settings'] }), 'General');
  assert.equal(pickAssertText({ texts: ['OK', 'Cancel'] }, undefined), undefined);
  assert.equal(pickAssertText({ texts: ['Order 1234 placed', 'Thanks!'] }, undefined), 'Thanks!');
});

test('flow save: with an owner, screens after another owner took over are not used', () => {
  const { entries, obs } = agentSession();
  entries.push({ at: at(30), owner: 'cli:runner', action: { action: 'launch', appId: 'dev.phonedock.sample' } });
  obs.push(screen(31, ['PhoneDock Sample', 'Greet', 'Notifications', 'Notifications off', 'Crash']));
  const r = flowFromLog(entries, obs, { owner: 'mcp:claude', now: at(40) });
  assert.deepEqual(r.flow.steps[r.flow.steps.length - 1], { kind: 'assert_visible', sel: { text: 'Notifications on' } });
});

test('flow save: a wait for the element the next step uses is left out (steps wait themselves)', () => {
  const r = flowFromLog([
    { at: at(1), owner: 'a', action: { action: 'tap', x: 5, y: 5, label: 'General', selector: { text: 'General' } } },
    { at: at(3), owner: 'a', action: { action: 'tap', x: 5, y: 5, label: 'About', selector: { text: 'About' } } },
  ], [{ at: at(2), kind: 'wait', owner: 'a', until: 'visible', query: { text: 'About' }, ok: true }], { autoAssert: false });
  assert.deepEqual(r.flow.steps, [{ kind: 'tap', sel: { text: 'General' } }, { kind: 'tap', sel: { text: 'About' } }]);
});

test('flow export: Maestro mapping, unsupported steps commented out', () => {
  const f = parseFlow(`appId: dev.x
steps:
  - launch
  - fill: { field: Your name, value: Ada, submit: true }
  - tap: Greet
  - tap: { text: Notif, match: contains }
  - scroll_to: About
  - wait_for: { visible: "Hello, Ada!" }
  - assert_visible: "Hello, Ada!"
  - assert_text: { field: id:status, equals: On }
  - set_appearance: dark
  - sleep: 500
  - rotate: landscape
  - back
`);
  const { text, unsupported } = toMaestro(f);
  assert.match(text, /^appId: dev\.x\n---\n/m);
  assert.match(text, /^- launchApp$/m);
  assert.match(text, /^- tapOn: Your name\n- eraseText\n- inputText: Ada\n- pressKey: Enter$/m);
  assert.match(text, /^- tapOn: \.\*Notif\.\*$/m);
  assert.match(text, /^- scrollUntilVisible:\n {4}element: \{ text: About \}\n {4}direction: DOWN$/m);
  assert.match(text, /^- assertVisible: Hello, Ada!$/m);
  assert.match(text, /^- assertVisible: \{ id: status, text: On \}$/m);
  assert.match(text, /^# not exported: set_appearance dark/m);
  assert.match(text, /^# not exported: sleep 500 ms/m);
  assert.match(text, /^- setOrientation: LANDSCAPE_LEFT$/m);
  assert.match(text, /^- back$/m);
  assert.equal(unsupported.length, 2);
});

test('settings flow validates, round trips and exports as an unsupported Maestro comment', () => {
  const flow = parseFlow('steps:\n  - settings: { textSize: largest, increaseContrast: true }\n');
  assert.deepEqual(flow.steps[0], { kind: 'settings', settings: { textSize: 'largest', increaseContrast: true } });
  assert.deepEqual(parseStep(stepOut(flow.steps[0])), flow.steps[0]);
  assert.match(toMaestro(flow).text, /no portable Maestro device settings command/);
  assert.throws(() => parseFlow('steps:\n  - settings: { boldText: nope }\n'), /boldText must be a boolean/);
});
