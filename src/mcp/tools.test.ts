// MCP tools end to end over an in-memory transport, against a fake daemon client (no devices needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { PhoneDockClient, Device, UiTree, UiElement } from '../sdk/client.ts';
import { createMcpServer, errorResult } from './server.ts';
import { PhoneDockApiError } from '../sdk/client.ts';

type Fake = Record<string, unknown> & { calls: unknown[][] };
test('unknown-delivery errors expose the generated request ID for receipt recovery', () => {
  const error = new PhoneDockApiError('Reply lost', 'delivery_unknown', 502);
  error.delivery = 'unknown'; error.requestId = 'pdtest-lost-reply';
  const result = errorResult(error);
  assert.match(JSON.stringify(result), /pdtest-lost-reply/);
  assert.match(JSON.stringify(result), /get_request_result/);
});
const el = (ref: string, type: string, x: number, y: number, w: number, h: number, more: Partial<UiElement> = {}): UiElement =>
  ({ ref, type, bounds: { x, y, width: w, height: h }, ...more } as UiElement);

async function connect(fake: Fake) {
  const server = createMcpServer({ client: fake as unknown as PhoneDockClient, scales: new Map() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await client.callTool({ name, arguments: args }) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  return { client, call, close: () => client.close() };
}

test('runtime profile has fewer typed schemas and keeps required control and human handoff tools', async () => {
  const sizes: number[] = [];
  for (const profile of ['all', 'runtime'] as const) {
    const server = createMcpServer({ client: { owner: 'test' } as PhoneDockClient, scales: new Map(), profile });
    const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'profile-test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    try {
      const result = await client.listTools(); sizes.push(JSON.stringify(result.tools).length);
      if (profile === 'runtime') {
        const names = result.tools.map((t) => t.name);
        for (const name of ['tap', 'fill', 'get_ui', 'request_human', 'acquire_device']) assert.ok(names.includes(name));
        assert.ok(!names.includes('create_device')); assert.ok(!names.includes('shell'));
      }
    } finally { await client.close(); await server.close(); }
  }
  assert.ok(sizes[1] < sizes[0] * 0.75, sizes.join(' -> '));
});

test('UI diffs disclose renumbered refs and input carries this session snapshot', async () => {
  let n = 0; let received: unknown;
  const fake = androidFake({ width: 100, height: 200 }, { width: 100, height: 200 }, []);
  fake.ui = async () => { n++; return { source: 'accessibility', screen: { width: 100, height: 200 }, snapshotId: `snapshot-${n}`, capturedAt: '', root: [el(n === 1 ? 'e1' : 'e2', 'Button', 10, 20, 40, 40, { text: 'Continue', clickable: true })] }; };
  fake.tapRef = async (_id: string, _ref: string, opts: unknown) => { received = opts; return { ok: true }; };
  const s = await connect(fake);
  try {
    await s.call('get_ui'); const changed = await s.call('get_ui', { diff: true });
    assert.match(changed.text, /\+ .*e2.*Continue/);
    await s.call('tap', { ref: 'e2' });
    assert.equal((received as { snapshotId: string }).snapshotId, 'snapshot-2');
  } finally { await s.close(); }
});

test('wait_for refs replace the session snapshot before tap and fill', async () => {
  const fake = androidFake({ width: 100, height: 200 }, { width: 100, height: 200 }, []);
  fake.ui = async () => ({ source: 'accessibility', screen: { width: 100, height: 200 }, snapshotId: 'snapshot-a', capturedAt: '', root: [el('e1', 'Button', 10, 20, 40, 40, { text: 'Old' })] });
  fake.waitFor = async () => ({ ok: true, until: 'visible', elapsedMs: 1, snapshotId: 'snapshot-b', screen: { width: 200, height: 100 }, match: { ref: 'e1', type: 'TextField', text: 'New', center: { x: 80, y: 40 }, bounds: { x: 60, y: 20, width: 40, height: 40 } } });
  let tapOptions: any, fillOptions: any;
  fake.tapRef = async (_id: string, _ref: string, options: unknown) => { tapOptions = options; return { ok: true }; };
  fake.fill = async (_id: string, options: unknown) => { fillOptions = options; return { element: null, tapped: { x: 80, y: 40 }, warnings: [], elapsedMs: 1, verified: true }; };
  const s = await connect(fake);
  try {
    await s.call('get_ui'); await s.call('wait_for', { until: 'visible', text: 'New' });
    await s.call('tap', { ref: 'e1' }); await s.call('fill', { ref: 'e1', value: 'Ada' });
    assert.equal(tapOptions.snapshotId, 'snapshot-b'); assert.equal(fillOptions.snapshotId, 'snapshot-b');
  } finally { await s.close(); }
});

function androidFake(listScreen: { width: number; height: number }, realScreen: { width: number; height: number }, root: UiElement[]): Fake {
  const dev = { id: 'android-emulator:pdtest-x', nativeId: 'pdtest-x', name: 'pdtest-x', backend: 'android-emulator', platform: 'android',
    kind: 'virtual', state: 'running', managed: true, capabilities: [], screen: { ...listScreen, scale: 1 } } as unknown as Device;
  const calls: unknown[][] = [];
  return {
    calls, owner: 'test',
    devices: async () => [dev], resolveDevice: async () => dev,
    screen: async () => ({ ...realScreen, scale: 1 }),
    ui: async (): Promise<UiTree> => ({ source: 'accessibility', screen: { ...realScreen, scale: 1 }, root, capturedAt: '' }),
    tap: async (_id: string, x: number, y: number) => { calls.push(['tap', x, y]); return { ok: true }; },
    rotate: async (_id: string, o: string) => { calls.push(['rotate', o]); return { ok: true, orientation: 'landscape', screen: { ...realScreen, scale: 1 } }; },
  };
}

// B1 (blind test round 2): the device list still said portrait while the sample app was landscape; get_ui printed a
// portrait image space over landscape coordinates, and tap(x,y) of Greet went to the wrong place.
test('get_ui and tap(x,y) use the screen the tree was read on, not a stale device list (landscape)', async () => {
  const greet = el('e6', 'android.widget.Button', 120, 484, 232, 125, { text: 'Greet', id: 'dev.phonedock.sample:id/greetButton', clickable: true });
  const fake = androidFake({ width: 1080, height: 2424 }, { width: 2424, height: 1080 }, [greet]);
  const s = await connect(fake);
  try {
    const ui = await s.call('get_ui');
    assert.match(ui.text, /image space 1024x456 \(device 2424x1080/);
    assert.match(ui.text, /Button "Greet" id=greetButton @\(100,231\)/);
    const t = await s.call('tap', { x: 100, y: 231 });
    assert.equal(t.isError, false);
    assert.deepEqual(fake.calls.at(-1), ['tap', 237, 547]);   // Greet's centre (236, 546.5) in device pixels
    assert.doesNotMatch(t.text, /turned/);                   // the device itself confirms landscape: no false warning
  } finally { await s.close(); }
});

test('rotate: the screen it really ended up on becomes the image space; a later x,y tap uses it', async () => {
  const fake = androidFake({ width: 1080, height: 2424 }, { width: 2424, height: 1080 }, []);
  const s = await connect(fake);
  try {
    const r = await s.call('rotate', { orientation: 'landscape' });
    assert.match(r.text, /Rotated pdtest-x to landscape \(2424x1080; x,y are now in the 1024x456 image space\)/);
    await s.call('tap', { x: 1000, y: 400 });
    assert.deepEqual(fake.calls.at(-1), ['tap', 2367, 947]);
  } finally { await s.close(); }
});

test('tap(x,y) warns when the device has turned since the agent last looked', async () => {
  // the agent saw portrait (get_ui), then the app turned the screen by itself
  let real = { width: 1080, height: 2424 };
  const fake = androidFake({ width: 1080, height: 2424 }, real, []);
  fake.ui = async (): Promise<UiTree> => ({ source: 'accessibility', screen: { ...real, scale: 1 }, root: [], capturedAt: '' });
  const s = await connect(fake);
  try {
    await s.call('get_ui');
    real = { width: 2424, height: 1080 };
    fake.screen = async () => ({ ...real, scale: 1 });
    const turned = { ...(await (fake.resolveDevice as () => Promise<Device>)()), screen: { ...real, scale: 1 } };
    fake.devices = async () => [turned];
    fake.resolveDevice = async () => turned;
    const t = await s.call('tap', { device: 'pdtest-x', x: 200, y: 500 });
    assert.match(t.text, /has turned to landscape \(2424x1080\) since your last screenshot\/get_ui \(456x1024\)/);
  } finally { await s.close(); }
});

// M2: every tool has a title; inventory reads are read-only, ordinary input is not destructive, deletes are.
// get_ui/screenshot stay unmarked on purpose (a client may run read-only calls concurrently with the tap before them).
test('tools/list: titles and annotations', async () => {
  const s = await connect(androidFake({ width: 1080, height: 2424 }, { width: 1080, height: 2424 }, []));
  try {
    const { tools } = await s.client.listTools();
    const by = new Map(tools.map((t) => [t.name, t]));
    for (const t of tools) assert.ok(t.annotations?.title || t.title, `${t.name} has a title`);
    assert.equal(by.get('list_devices')?.annotations?.readOnlyHint, true);
    assert.equal(by.get('tap')?.annotations?.destructiveHint, false);
    assert.notEqual(by.get('tap')?.annotations?.readOnlyHint, true);
    assert.notEqual(by.get('get_ui')?.annotations?.readOnlyHint, true);
    assert.notEqual(by.get('screenshot')?.annotations?.readOnlyHint, true);
    for (const n of ['delete_device', 'uninstall_app']) assert.equal(by.get(n)?.annotations?.destructiveHint, true, n);
  } finally { await s.close(); }
});

test('get_ui cuts long texts and says so; full_text shows them whole', async () => {
  const long = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.';
  const s = await connect(androidFake({ width: 1080, height: 2424 }, { width: 1080, height: 2424 }, [el('e1', 'android.widget.TextView', 0, 100, 1080, 300, { text: long })]));
  try {
    const cut = await s.call('get_ui');
    assert.match(cut.text, /full_text=true shows them whole/);
    assert.ok(!cut.text.includes(long));
    const whole = await s.call('get_ui', { full_text: true });
    assert.ok(whole.text.includes(JSON.stringify(long)));
    assert.doesNotMatch(whole.text, /full_text=true/);
  } finally { await s.close(); }
});

test('launch_app says whether the app came to the front', async () => {
  const fake = androidFake({ width: 1080, height: 2424 }, { width: 1080, height: 2424 }, []);
  const s = await connect(fake);
  try {
    fake.launch = async () => ({ ok: true, inFront: true, foreground: 'dev.phonedock.sample' });
    assert.match((await s.call('launch_app', { app_id: 'dev.phonedock.sample', settle_ms: 0 })).text, /Launched dev\.phonedock\.sample\. It is in front\./);
    fake.launch = async () => ({ ok: true, inFront: false, foreground: null, relaunched: true });
    assert.match((await s.call('launch_app', { app_id: 'com.example.app', settle_ms: 0 })).text,
      /But it is not in front: the home screen is showing even after launching it again/);
  } finally { await s.close(); }
});

// L1/L6: an installed runtime that can't be used says so; crash times are local, like the reports themselves.
test('list_os_images flags unusable images; list_crashes shows local times', async () => {
  const fake = androidFake({ width: 1080, height: 2424 }, { width: 1080, height: 2424 }, []);
  fake.backends = async () => [{ id: 'ios-simulator', availability: { ok: true } }];
  fake.images = async () => [
    { id: 'iOS-26-5', backend: 'ios-simulator', platform: 'ios', name: 'iOS 26.5 (23F77) · Simulator', installed: true },
    { id: 'iOS-27-0', backend: 'ios-simulator', platform: 'ios', name: 'iOS 27.0 (24A434) · Simulator', installed: true, usable: false, notes: 'Not usable on this Mac: creating a simulator on it failed' },
  ];
  const at = '2026-11-04T13:50:13.000Z';
  fake.crashes = async () => [{ id: 'c1', time: at, appId: 'dev.phonedock.sample', kind: 'crash' }];
  const s = await connect(fake);
  try {
    const l = (await s.call('list_os_images')).text.split('\n');
    assert.doesNotMatch(l.find((x) => x.includes('iOS-26-5')) ?? '', /NOT USABLE/);
    assert.match(l.find((x) => x.includes('iOS-27-0')) ?? '', /installed=yes \| NOT USABLE: creating a simulator on it failed$/);
    const { localTime } = await import('./tools-extra.ts');
    const c = (await s.call('list_crashes')).text;
    assert.ok(c.includes(`c1 | ${localTime(at)} |`), c);
    assert.match(localTime(at), /^\d{4}-\d\d-\d\d \d\d:\d\d:13 [+-]\d{4}$/);
    const d = new Date(at);
    assert.equal(localTime(at).slice(11, 13), String(d.getHours()).padStart(2, '0'));   // the Mac's zone, not UTC
  } finally { await s.close(); }
});

// L3: taking over a lease whose owner process has exited says so, and from whom.
test('acquire_device names the stale lease it reclaimed', async () => {
  const fake = androidFake({ width: 1080, height: 2424 }, { width: 1080, height: 2424 }, []);
  const dev = await (fake.resolveDevice as () => Promise<Device>)();
  fake.acquire = async () => ({ device: dev, lease: { owner: 'mcp:test:1', acquiredAt: '', expiresAt: null, ttlSec: 600, reclaimedFrom: 'mcp:claude-code:4242' } });
  const s = await connect(fake);
  try {
    assert.match((await s.call('acquire_device', { device: 'pdtest-x' })).text,
      /It was leased by mcp:claude-code:4242, whose process has exited: that stale lease was reclaimed for you\./);
    fake.acquire = async () => ({ device: dev, lease: { owner: 'mcp:test:1', acquiredAt: '', expiresAt: null, ttlSec: 600 } });
    assert.doesNotMatch((await s.call('acquire_device', { device: 'pdtest-x' })).text, /reclaimed/);
  } finally { await s.close(); }
});

// L7: settle_ms is waited out even without return_screenshot (it was silently ignored).
test('settle_ms without return_screenshot still waits', async () => {
  const s = await connect(androidFake({ width: 1080, height: 2424 }, { width: 1080, height: 2424 }, []));
  try {
    let t0 = Date.now(); await s.call('tap', { x: 10, y: 10, settle_ms: 300 });
    assert.ok(Date.now() - t0 >= 290, `waited ${Date.now() - t0} ms`);
    t0 = Date.now(); await s.call('tap', { x: 10, y: 10 });
    assert.ok(Date.now() - t0 < 250, 'no settle_ms, no wait');
  } finally { await s.close(); }
});

test('create_device forwards optional disguise, carrier and seed into spec.options.disguise', async () => {
  const seen: unknown[] = [];
  const createdDevice = {
    id: 'android-emulator:pdtest-vp', backend: 'android-emulator', nativeId: 'pdtest-vp', name: 'pdtest-vp',
    platform: 'android', kind: 'virtual', state: 'stopped', managed: true, capabilities: [],
  } as unknown as Device;
  const fake: Fake = {
    calls: [],
    createDeviceAsync: async (spec: unknown) => {
      seen.push(spec);
      return { job: { id: 'job_1', kind: 'create', state: 'done', progress: [], result: createdDevice, startedAt: '' } };
    },
  };
  const s = await connect(fake);
  try {
    const r1 = await s.call('create_device', {
      backend: 'android-emulator', name: 'pdtest-vp', disguise: 'pixel_8', carrier: 'ee_uk', seed: 'abcdef01',
    });
    assert.equal(r1.isError, false, r1.text);
    assert.deepEqual((seen[0] as Record<string, unknown>).options, {
      disguise: { enabled: true, profile: 'pixel_8', carrier: 'ee_uk', seed: 'abcdef01' },
    });

    const r2 = await s.call('create_device', { backend: 'android-emulator', name: 'pdtest-plain' });
    assert.equal(r2.isError, false, r2.text);
    assert.equal((seen[1] as Record<string, unknown>).options, undefined);
  } finally { await s.close(); }
});

test('launch_app forwards args/env (and arguments alias) without echoing secret values', async () => {
  const launched: unknown[] = [];
  const fake = androidFake({ width: 1080, height: 2424 }, { width: 1080, height: 2424 }, []);
  fake.launch = async (_id: string, appId: string, opts?: unknown) => {
    launched.push({ appId, opts });
    return { ok: true, inFront: true, delivery: 'sent', retrySafe: false };
  };
  const s = await connect(fake);
  try {
    const secret = 'pd-mcp-launch-secret-7733';
    const r1 = await s.call('launch_app', { app_id: 'com.example.app', arguments: { token: secret, debug: true }, env: { API_KEY: secret }, settle_ms: 0 });
    assert.equal(r1.isError, false, r1.text);
    assert.match(r1.text, /Launched com\.example\.app \(with 2 args, 1 env var\)\./);
    assert.ok(!r1.text.includes(secret), 'MCP launch_app output leaked secret');
    assert.deepEqual(launched[0], {
      appId: 'com.example.app',
      opts: { expect: undefined, args: { token: secret, debug: true }, env: { API_KEY: secret } },
    });
  } finally { await s.close(); }
});

test('observe="ui"|"both": compact outline, default settle, unchanged suppression, snapshot ref binding, conflict error, and batch support', async () => {
  const tree1: UiTree = {
    source: 'accessibility',
    screen: { width: 1080, height: 2400 },
    capturedAt: '2026-11-23T10:00:00.000Z',
    snapshotId: 'snap-obs-1',
    root: [el('e1', 'Button', 100, 200, 200, 80, { text: 'General', clickable: true })],
  };
  const tree2: UiTree = {
    source: 'accessibility',
    screen: { width: 1080, height: 2400 },
    capturedAt: '2026-11-23T10:00:02.000Z',
    snapshotId: 'snap-obs-2',
    root: [el('e1', 'Button', 100, 200, 200, 80, { text: 'About', clickable: true })],
  };
  let currentTree = tree1;
  let tapCalls: unknown[] = [];
  let tapRefCalls: unknown[] = [];
  let launchCalls: unknown[] = [];
  let uiCalls = 0;
  let shotCalls = 0;

  const fake = androidFake({ width: 1080, height: 2400 }, { width: 1080, height: 2400 }, tree1.root);
  fake.ui = async () => { uiCalls++; return currentTree; };
  fake.screenshot = async () => {
    shotCalls++;
    return { data: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg', deviceWidth: 1080, deviceHeight: 2400, imageWidth: 461, imageHeight: 1024, scale: 2.3438 };
  };
  fake.tap = async (_id: string, x: number, y: number, _label?: string, meta?: Record<string, unknown>) => {
    tapCalls.push({ x, y, meta });
    return { ok: true, delivery: 'sent', retrySafe: false, ...(meta?.returnUi ? { ui: currentTree } : {}) };
  };
  fake.tapRef = async (_id: string, ref: string, opts?: Record<string, unknown>) => {
    tapRefCalls.push({ ref, opts });
    return { ok: true, delivery: 'sent', retrySafe: false, resolved: { ref, x: 200, y: 240 }, ...(opts?.returnUi ? { ui: currentTree } : {}) };
  };
  fake.launch = async (_id: string, appId: string, opts?: Record<string, unknown>) => {
    launchCalls.push({ appId, opts });
    return { ok: true, inFront: true, delivery: 'sent', retrySafe: false, ...(opts?.returnUi ? { ui: currentTree } : {}) };
  };

  const s = await connect(fake);
  try {
    // 1) Conflicting observe="ui" + return_screenshot=true fails BEFORE sending input
    const conflict = await s.call('tap', { x: 10, y: 10, observe: 'ui', return_screenshot: true });
    assert.equal(conflict.isError, true);
    assert.match(conflict.text, /Conflicting options/);
    assert.equal(tapCalls.length, 0);

    // 2) tap with observe="ui" forwards returnUi + default settleMs=700 to daemon and renders compact outline without extra get_ui
    const r1 = await s.call('tap', { x: 10, y: 10, observe: 'ui' });
    assert.equal(r1.isError, false, r1.text);
    assert.equal((tapCalls[0] as { meta?: Record<string, unknown> }).meta?.returnUi, true);
    assert.equal((tapCalls[0] as { meta?: Record<string, unknown> }).meta?.settleMs, 700);
    assert.equal(uiCalls, 0, 'daemon pre-captured UI must not trigger a second c.ui() call');
    assert.match(r1.text, /obs=#1 hash=[0-9a-f]{16} snapshot=snap-obs-1/);
    assert.match(r1.text, /e1 Button "General"/);

    // 3) Immediate tap(ref="e1", observe="ui") uses bound snapshotId from prior observe="ui" and suppresses unchanged screen
    const r2 = await s.call('tap', { ref: 'e1', observe: 'ui', settle_ms: 0 });
    assert.equal(r2.isError, false, r2.text);
    assert.equal((tapRefCalls[0] as { opts?: Record<string, unknown> }).opts?.snapshotId, 'snap-obs-1');
    assert.equal((tapRefCalls[0] as { opts?: Record<string, unknown> }).opts?.settleMs, 0);
    assert.match(r2.text, /Screen unchanged \(obs=#2, hash=[0-9a-f]{16}, snapshot=snap-obs-1\)\./);

    // 4) Screen changes -> full outline emitted again; launch_app defaults to settleMs=1500 (or 0 with expect)
    currentTree = tree2;
    const r3 = await s.call('launch_app', { app_id: 'com.example.app', observe: 'ui' });
    assert.equal(r3.isError, false, r3.text);
    assert.equal((launchCalls[0] as { opts?: Record<string, unknown> }).opts?.settleMs, 1500);
    assert.match(r3.text, /obs=#3 hash=[0-9a-f]{16} snapshot=snap-obs-2/);
    assert.match(r3.text, /e1 Button "About"/);

    const r4 = await s.call('launch_app', { app_id: 'com.example.app', observe: 'ui', expect: { visible: 'About' } });
    assert.equal(r4.isError, false, r4.text);
    assert.equal((launchCalls[1] as { opts?: Record<string, unknown> }).opts?.settleMs, 0, 'expect skips default settle');

    // 5) observe="both" returns UI + screenshot in a single settle
    shotCalls = 0;
    const rBoth = await s.client.callTool({ name: 'tap', arguments: { x: 10, y: 10, observe: 'both', settle_ms: 0 } }) as { content: { type: string; text?: string }[]; isError?: boolean };
    assert.equal(!!rBoth.isError, false);
    assert.equal(shotCalls, 1);
    assert.ok(rBoth.content.some((c) => c.type === 'image'));
    assert.ok(rBoth.content.some((c) => c.type === 'text' && (c.text ?? '').includes('obs=#5')));

    // 6) batch supports per-step observe and observe_at_end, and rejects observe_at_end/screenshot_at_end conflicts
    const badBatch = await s.call('batch', { steps: [{ tool: 'tap', args: { x: 1, y: 1 } }], observe_at_end: 'ui', screenshot_at_end: true });
    assert.equal(badBatch.isError, true);
    assert.match(badBatch.text, /Conflicting options/);

    currentTree = tree1;
    const okBatch = await s.call('batch', {
      steps: [{ tool: 'tap', args: { x: 1, y: 1, observe: 'ui', settle_ms: 0 } }],
      observe_at_end: 'ui',
      settle_ms: 0,
    });
    assert.equal(okBatch.isError, false, okBatch.text);
    assert.match(okBatch.text, /e1 Button "General"/);
    assert.match(okBatch.text, /Screen unchanged \(obs=#7/);
  } finally { await s.close(); }
});

test('observe regressions: failed screenshot preserves delivered action, batch never suppresses against dropped step, observe_at_end settles', async () => {
  const treeA: UiTree = {
    source: 'accessibility',
    screen: { width: 1080, height: 2400 },
    capturedAt: '2026-11-23T10:00:00.000Z',
    snapshotId: 'snap-a',
    root: [el('e1', 'Button', 100, 200, 200, 80, { text: 'Alpha', clickable: true })],
  };
  const treeB: UiTree = {
    source: 'accessibility',
    screen: { width: 1080, height: 2400 },
    capturedAt: '2026-11-23T10:00:01.000Z',
    snapshotId: 'snap-b',
    root: [el('e1', 'Button', 100, 200, 200, 80, { text: 'Beta', clickable: true })],
  };
  const treeC: UiTree = {
    source: 'accessibility',
    screen: { width: 1080, height: 2400 },
    capturedAt: '2026-11-23T10:00:02.000Z',
    snapshotId: 'snap-c',
    root: [el('e1', 'Button', 100, 200, 200, 80, { text: 'Gamma', clickable: true })],
  };
  let currentTree = treeA;
  let failShot = false;

  const fake = androidFake({ width: 1080, height: 2400 }, { width: 1080, height: 2400 }, treeA.root);
  fake.ui = async () => currentTree;
  fake.screenshot = async () => {
    if (failShot) throw new Error('framebuffer timeout');
    return { data: Buffer.from([0xff, 0xd8, 0xff]), mime: 'image/jpeg', deviceWidth: 1080, deviceHeight: 2400, imageWidth: 461, imageHeight: 1024, scale: 2.3438 };
  };
  fake.tap = async (_id: string, _x: number, _y: number, _label?: string, meta?: Record<string, unknown>) => ({
    ok: true,
    delivery: 'sent',
    retrySafe: false,
    ...(meta?.expect ? { expect: { ok: true, outcome: 'verified', message: 'Verified: "Gamma" is on screen (0.1 s).' } } : {}),
    ...(meta?.returnUi ? { ui: currentTree } : {}),
  });

  const s = await connect(fake);
  try {
    // Item 2: observe="both" with a throwing screenshot keeps action summary + UI and does NOT mark delivered action failed
    failShot = true;
    const bothFailedShot = await s.call('tap', { x: 10, y: 10, observe: 'both', settle_ms: 0 });
    assert.equal(bothFailedShot.isError, false, bothFailedShot.text);
    assert.match(bothFailedShot.text, /Tapped/);
    assert.match(bothFailedShot.text, /e1 Button "Alpha"/);
    assert.match(bothFailedShot.text, /Screenshot unavailable \(framebuffer timeout\)/);

    const imgFailedShot = await s.call('tap', { x: 10, y: 10, observe: 'image', settle_ms: 0 });
    assert.equal(imgFailedShot.isError, false, imgFailedShot.text);
    assert.match(imgFailedShot.text, /Tapped/);
    assert.match(imgFailedShot.text, /Screenshot unavailable \(framebuffer timeout\)/);
    failShot = false;

    // Item 5a: batch with two observe="ui" steps on a new screen -> Step 1 is shortened, so Step 2 MUST emit full tree + refs
    currentTree = treeB;
    const batchTwoObs = await s.call('batch', {
      steps: [
        { tool: 'tap', args: { x: 1, y: 1, observe: 'ui', settle_ms: 0 } },
        { tool: 'tap', args: { x: 2, y: 2, observe: 'ui', settle_ms: 0 } },
      ],
    });
    assert.equal(batchTwoObs.isError, false, batchTwoObs.text);
    assert.match(batchTwoObs.text, /Output of the last step:[\s\S]*e1 Button "Beta"/);
    assert.doesNotMatch(batchTwoObs.text, /Output of the last step:[\s\S]*Screen unchanged/);

    // Item 5b: batch with Step 1 observe="ui", Step 2 plain tap, and observe_at_end="ui" on a new screen -> end block emits full tree + refs
    currentTree = treeC;
    const batchEndObs = await s.call('batch', {
      steps: [
        { tool: 'tap', args: { x: 1, y: 1, observe: 'ui', settle_ms: 0 } },
        { tool: 'tap', args: { x: 2, y: 2 } },
      ],
      observe_at_end: 'ui',
      settle_ms: 0,
    });
    assert.equal(batchEndObs.isError, false, batchEndObs.text);
    assert.match(batchEndObs.text, /e1 Button "Gamma"/);
    assert.doesNotMatch(batchEndObs.text, /Screen unchanged/);

    // Item 6: observe_at_end applies default 700 ms settle unless settle_ms is given or last step had expect
    const tDefault = Date.now();
    await s.call('batch', {
      steps: [{ tool: 'tap', args: { x: 1, y: 1 } }],
      observe_at_end: 'ui',
    });
    assert.ok(Date.now() - tDefault >= 650, `expected default ~700 ms settle on observe_at_end, took ${Date.now() - tDefault} ms`);

    const tExpect = Date.now();
    await s.call('batch', {
      steps: [{ tool: 'tap', args: { x: 1, y: 1, expect: { visible: 'Gamma' } } }],
      observe_at_end: 'ui',
    });
    assert.ok(Date.now() - tExpect < 500, `expected observe_at_end to skip default settle after expect, took ${Date.now() - tExpect} ms`);

    const tExplicit = Date.now();
    await s.call('batch', {
      steps: [{ tool: 'tap', args: { x: 1, y: 1 } }],
      observe_at_end: 'ui',
      settle_ms: 120,
    });
    const explicitMs = Date.now() - tExplicit;
    assert.ok(explicitMs >= 100 && explicitMs < 550, `expected explicit ~120 ms settle on observe_at_end, took ${explicitMs} ms`);
  } finally { await s.close(); }
});

test('hidden batch observations never update snapshot/ref binding, suppression hash, or get_ui(diff) baseline', async () => {
  const saveTree: UiTree = {
    source: 'accessibility',
    screen: { width: 1080, height: 2400 },
    capturedAt: '2026-11-23T10:00:00.000Z',
    snapshotId: 'snap-save',
    root: [el('e8', 'Button', 100, 200, 200, 80, { text: 'Save', clickable: true })],
  };
  const deleteTree: UiTree = {
    source: 'accessibility',
    screen: { width: 1080, height: 2400 },
    capturedAt: '2026-11-23T10:00:01.000Z',
    snapshotId: 'snap-delete',
    root: [el('e8', 'Button', 600, 900, 200, 80, { text: 'Delete', clickable: true })],
  };

  let currentTree = saveTree;
  const tapRefCalls: { ref: string; snapshotId?: string }[] = [];
  const fillCalls: { ref?: string; snapshotId?: string }[] = [];

  const makeFake = () => {
    const fake = androidFake({ width: 1080, height: 2400 }, { width: 1080, height: 2400 }, saveTree.root);
    fake.ui = async () => currentTree;
    fake.tap = async (_id: string, _x: number, _y: number, _label?: string, meta?: Record<string, unknown>) => ({
      ok: true,
      delivery: 'sent',
      retrySafe: false,
      ...(meta?.returnUi ? { ui: currentTree } : {}),
    });
    fake.tapRef = async (_id: string, ref: string, opts?: Record<string, unknown>) => {
      tapRefCalls.push({ ref, snapshotId: opts?.snapshotId as string | undefined });
      return { ok: true, delivery: 'sent', retrySafe: false, resolved: { ref, x: 200, y: 240 } };
    };
    fake.fill = async (_id: string, body: Record<string, unknown>) => {
      fillCalls.push({ ref: body.ref as string | undefined, snapshotId: body.snapshotId as string | undefined });
      return { element: null, tapped: { x: 200, y: 240 }, warnings: [], elapsedMs: 1, verified: true };
    };
    return fake;
  };

  // Repro 1a + 2: prior get_ui delivered snap-save ("Save"), then batch hides snap-delete ("Delete") in step 1
  const s1 = await connect(makeFake());
  try {
    const g1 = await s1.call('get_ui');
    assert.match(g1.text, /e8 Button "Save"/);

    currentTree = deleteTree;
    const b1 = await s1.call('batch', {
      steps: [
        { tool: 'tap', args: { x: 1, y: 1, observe: 'ui', settle_ms: 0 } },
        { tool: 'tap', args: { x: 2, y: 2 } },
      ],
    });
    assert.equal(b1.isError, false, b1.text);
    assert.doesNotMatch(b1.text, /Output of the last step:/);

    // 1) A later tap(ref="e8") MUST stay bound to snap-save (last delivered), NEVER snap-delete (hidden step 1)
    await s1.call('tap', { ref: 'e8' });
    assert.equal(tapRefCalls.length, 1);
    assert.equal(tapRefCalls[0].snapshotId, 'snap-save');

    // 2) [tap(observe="ui"), get_ui(diff=true)] MUST diff against Save (last delivered), NEVER "(unchanged)" against hidden step 1
    const b2 = await s1.call('batch', {
      steps: [
        { tool: 'tap', args: { x: 1, y: 1, observe: 'ui', settle_ms: 0 } },
        { tool: 'get_ui', args: { diff: true } },
      ],
    });
    assert.equal(b2.isError, false, b2.text);
    assert.match(b2.text, /- .*Button "Save"/);
    assert.match(b2.text, /\+ .*e8 Button "Delete"/);
    assert.doesNotMatch(b2.text, /\(unchanged\)/);

    // Now Delete WAS delivered in step 2 of b2, so tap(ref="e8") binds to snap-delete
    await s1.call('tap', { ref: 'e8' });
    assert.equal(tapRefCalls[1].snapshotId, 'snap-delete');
  } finally { await s1.close(); }

  // Repro 1b: fresh session (no prior get_ui) + hidden batch observation -> later tap/fill by ref MUST refuse before sending
  tapRefCalls.length = 0;
  fillCalls.length = 0;
  currentTree = deleteTree;
  const s2 = await connect(makeFake());
  try {
    const b = await s2.call('batch', {
      steps: [
        { tool: 'tap', args: { x: 1, y: 1, observe: 'ui', settle_ms: 0 } },
        { tool: 'tap', args: { x: 2, y: 2 } },
      ],
    });
    assert.equal(b.isError, false, b.text);

    const refusedTap = await s2.call('tap', { ref: 'e8' });
    assert.equal(refusedTap.isError, true);
    assert.match(refusedTap.text, /No UI tree has been read/);
    assert.equal(tapRefCalls.length, 0, 'hidden batch step must never allow tap(ref) to reach daemon');

    const refusedFill = await s2.call('fill', { ref: 'e8', value: 'hello' });
    assert.equal(refusedFill.isError, true);
    assert.match(refusedFill.text, /No UI tree has been read/);
    assert.equal(fillCalls.length, 0, 'hidden batch step must never allow fill(ref) to reach daemon');

    // A standalone get_ui(diff=true) after a hidden batch step has no prior delivered baseline, so it returns full lines
    const g = await s2.call('get_ui', { diff: true });
    assert.match(g.text, /e8 Button "Delete"/);
    assert.doesNotMatch(g.text, /\(unchanged\)/);
  } finally { await s2.close(); }
});

test('empty UI reads clear stale refs, and batch rollback never wipes concurrent observations on other devices', async () => {
  const devA = {
    id: 'android-emulator:pdtest-a', nativeId: 'pdtest-a', name: 'pdtest-a', backend: 'android-emulator', platform: 'android',
    kind: 'virtual', state: 'running', managed: true, capabilities: [], screen: { width: 1080, height: 2400, scale: 1 },
  } as unknown as Device;
  const devB = {
    id: 'android-emulator:pdtest-b', nativeId: 'pdtest-b', name: 'pdtest-b', backend: 'android-emulator', platform: 'android',
    kind: 'virtual', state: 'running', managed: true, capabilities: [], screen: { width: 1080, height: 2400, scale: 1 },
  } as unknown as Device;

  const treeA0: UiTree = {
    source: 'accessibility', screen: { width: 1080, height: 2400 }, capturedAt: '2026-11-23T10:00:00.000Z', snapshotId: 'snap-a0',
    root: [el('e8', 'Button', 100, 200, 200, 80, { text: 'Save', clickable: true })],
  };
  const treeA1: UiTree = {
    source: 'accessibility', screen: { width: 1080, height: 2400 }, capturedAt: '2026-11-23T10:00:01.000Z', snapshotId: 'snap-a1',
    root: [el('e8', 'Button', 600, 900, 200, 80, { text: 'Delete', clickable: true })],
  };
  const treeEmpty: UiTree = {
    source: 'accessibility', screen: { width: 1080, height: 2400 }, capturedAt: '2026-11-23T10:00:02.000Z', snapshotId: 'snap-empty',
    root: [],
  };
  const treeB: UiTree = {
    source: 'accessibility', screen: { width: 1080, height: 2400 }, capturedAt: '2026-11-23T10:00:03.000Z', snapshotId: 'snap-b1',
    root: [el('e3', 'Button', 100, 200, 200, 80, { text: 'Confirm', clickable: true })],
  };

  const trees = new Map<string, UiTree>([[devA.id, treeA0], [devB.id, treeB]]);
  const tapRefCalls: { device: string; ref: string; snapshotId?: string }[] = [];
  let pauseNextTapOnA = false;
  let step1Paused!: () => void;
  let resumeStep1!: () => void;
  const step1Gate = new Promise<void>((r) => { step1Paused = r; });
  const resumeGate = new Promise<void>((r) => { resumeStep1 = r; });

  const fake: Fake = {
    calls: [], owner: 'test',
    devices: async () => [devA, devB],
    resolveDevice: async (q: string) => (q === 'pdtest-b' || q === devB.id ? devB : devA),
    screen: async () => ({ width: 1080, height: 2400, scale: 1 }),
    ui: async (id: string) => trees.get(id)!,
    tap: async (id: string, _x: number, _y: number, _label?: string, meta?: Record<string, unknown>) => {
      if (id === devA.id && pauseNextTapOnA) {
        pauseNextTapOnA = false;
        step1Paused();
        await resumeGate;
      }
      return { ok: true, delivery: 'sent', retrySafe: false, ...(meta?.returnUi ? { ui: trees.get(id) } : {}) };
    },
    tapRef: async (id: string, ref: string, opts?: Record<string, unknown>) => {
      tapRefCalls.push({ device: id, ref, snapshotId: opts?.snapshotId as string | undefined });
      return { ok: true, delivery: 'sent', retrySafe: false, resolved: { ref, x: 200, y: 240 } };
    },
  };

  const s = await connect(fake);
  try {
    // Item 1a: get_ui(Save) -> get_ui(empty) -> tap(ref="e8") MUST be rejected (never resolves to old Save snapshot)
    const gSave = await s.call('get_ui', { device: 'pdtest-a' });
    assert.match(gSave.text, /e8 Button "Save"/);
    trees.set(devA.id, treeEmpty);
    const gEmpty = await s.call('get_ui', { device: 'pdtest-a' });
    assert.match(gEmpty.text, /No UI elements found/);
    const afterEmptyGetUi = await s.call('tap', { device: 'pdtest-a', ref: 'e8' });
    assert.equal(afterEmptyGetUi.isError, true);
    assert.equal(tapRefCalls.length, 0, 'empty get_ui must clear prior snapshot binding');

    // Item 1b: get_ui(Save) -> tap(observe="ui") returning empty -> tap(ref="e8") MUST be rejected
    trees.set(devA.id, treeA0);
    await s.call('get_ui', { device: 'pdtest-a' });
    trees.set(devA.id, treeEmpty);
    const obsEmpty = await s.call('tap', { device: 'pdtest-a', x: 10, y: 10, observe: 'ui', settle_ms: 0 });
    assert.equal(obsEmpty.isError, false, obsEmpty.text);
    const afterEmptyObs = await s.call('tap', { device: 'pdtest-a', ref: 'e8' });
    assert.equal(afterEmptyObs.isError, true);
    assert.equal(tapRefCalls.length, 0, 'empty observe="ui" must clear prior snapshot binding');

    // Item 2: two-device interleaving — batch on A rolls back A's hidden step 1 without wiping B's delivered get_ui
    trees.set(devA.id, treeA0);
    await s.call('get_ui', { device: 'pdtest-a' }); // A's delivered baseline is snap-a0

    trees.set(devA.id, treeA1);
    pauseNextTapOnA = true;
    const batchOnA = s.call('batch', {
      device: 'pdtest-a',
      steps: [
        { tool: 'tap', args: { x: 1, y: 1, observe: 'ui', settle_ms: 0 } },
        { tool: 'tap', args: { x: 2, y: 2 } },
      ],
    });
    await step1Gate;
    // While A's batch is paused in step 1 (before step 2's rollback runs), deliver get_ui on device B
    const gB = await s.call('get_ui', { device: 'pdtest-b' });
    assert.match(gB.text, /e3 Button "Confirm"/);
    // Resume A's step 1 -> step 1 observes treeA1 -> step 2 triggers rollback on A
    resumeStep1();
    const resA = await batchOnA;
    assert.equal(resA.isError, false, resA.text);

    // Device B's binding and diff baseline MUST survive A's batch rollback
    const tapB = await s.call('tap', { device: 'pdtest-b', ref: 'e3' });
    assert.equal(tapB.isError, false, tapB.text);
    assert.deepEqual(tapRefCalls.at(-1), { device: devB.id, ref: 'e3', snapshotId: 'snap-b1' });
    const diffB = await s.call('get_ui', { device: 'pdtest-b', diff: true });
    assert.match(diffB.text, /\(unchanged\)/);

    // Device A's hidden step 1 WAS rolled back to snap-a0 (never snap-a1)
    const tapA = await s.call('tap', { device: 'pdtest-a', ref: 'e8' });
    assert.equal(tapA.isError, false, tapA.text);
    assert.deepEqual(tapRefCalls.at(-1), { device: devA.id, ref: 'e8', snapshotId: 'snap-a0' });
  } finally { await s.close(); }
});

test('MCP list_runs and get_run support summary, public-safe md, and json formats', async () => {
  const rec: import('../sdk/client.ts').RunRecord = {
    schemaVersion: 1,
    id: '2026-11-23T12-00-00-000Z-abcd',
    status: 'pass',
    startedAt: '2026-11-23T12:00:00.000Z',
    endedAt: '2026-11-23T12:00:01.500Z',
    durationMs: 1500,
    attempts: 1,
    owner: 'mcp:test',
    flow: { name: 'Checkout', file: '/Users/local/repo/flows/checkout.yaml', fileDisplay: 'flows/checkout.yaml', sha256: 'a'.repeat(64) },
    source: { commit: '1234567890abcdef1234567890abcdef12345678', branch: 'main', dirty: false },
    device: { id: 'android-emulator:pdtest-x', name: 'pdtest-x', platform: 'android', backend: 'android-emulator', kind: 'virtual', osVersion: '14', model: 'Pixel 9' },
    app: { id: 'com.example.shop', name: 'Shop', version: '4.2.0', build: '420' },
    steps: [{ index: 1, description: 'launch com.example.shop', status: 'pass', ms: 900 }],
    artifacts: { dir: '/Users/local/.phonedock/test-runs/r1', report: '/Users/local/.phonedock/test-runs/r1/report.html' },
  };
  const summary: import('../sdk/client.ts').RunSummary = {
    schemaVersion: 1, id: rec.id, status: 'pass', startedAt: rec.startedAt, durationMs: 1500, attempts: 1, owner: rec.owner,
    flowName: 'Checkout', flowFile: 'flows/checkout.yaml', deviceId: rec.device.id, deviceName: rec.device.name,
    platform: 'android', osVersion: '14', appId: 'com.example.shop', appVersion: '4.2.0', appBuild: '420',
    commit: rec.source.commit, dirty: false, stepCount: 1, passedSteps: 1, failedSteps: 0, report: rec.artifacts?.report,
  };
  const fake = androidFake({ width: 1080, height: 2400 }, { width: 1080, height: 2400 }, []);
  fake.listRuns = async () => [summary];
  fake.getRun = async () => rec;
  fake.exportRun = async (_id: string, fmt: string) => (fmt === 'md' ? '### PhoneDock Run: Checkout — PASS\nFlow: `flows/checkout.yaml`\n' : JSON.stringify(rec));

  const s = await connect(fake);
  try {
    const listed = await s.call('list_runs', { status: 'pass', limit: 10 });
    assert.equal(listed.isError, false, listed.text);
    assert.match(listed.text, /2026-11-23T12-00-00-000Z-abcd/);
    assert.match(listed.text, /com\.example\.shop@4\.2\.0\(420\)/);

    const sumRes = await s.call('get_run', { run_id: rec.id });
    assert.equal(sumRes.isError, false, sumRes.text);
    assert.match(sumRes.text, /\/Users\/local\/repo\/flows\/checkout\.yaml/);
    assert.match(sumRes.text, /version=4\.2\.0 build=420/);

    const mdRes = await s.call('get_run', { run_id: rec.id, format: 'md' });
    assert.equal(mdRes.isError, false, mdRes.text);
    assert.match(mdRes.text, /flows\/checkout\.yaml/);
    assert.doesNotMatch(mdRes.text, /\/Users\/local/);

    const jsonRes = await s.call('get_run', { run_id: rec.id, format: 'json' });
    assert.equal(jsonRes.isError, false, jsonRes.text);
    assert.equal(JSON.parse(jsonRes.text).id, rec.id);
  } finally { await s.close(); }
});

test('a wake notice is its own content item, on the call that woke the phone only (#16)', async () => {
  const fake = androidFake({ width: 100, height: 200 }, { width: 100, height: 200 }, []);
  let releaseDoctor!: () => void;
  const gate = new Promise<void>((r) => { releaseDoctor = r; });
  fake.environment = async () => { (fake as { onWake?: (w: unknown) => void }).onWake?.({ ms: 100, name: 'pdtest-x' }); return { platform: 'android', controls: [] }; };
  fake.doctor = async () => { await gate; return { ok: true, checks: [] }; };
  const { client, close } = await connect(fake);
  try {
    const raw = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args }) as Promise<{ content: { type: string; text?: string }[] }>;
    const doctor = raw('doctor', {});
    const env = await raw('device_environment', { device: 'pdtest-x' });
    releaseDoctor();
    const doc = await doctor;
    assert.doesNotThrow(() => JSON.parse(env.content[0].text!), 'the JSON result is untouched');
    assert.ok(env.content.some((x) => x.text === 'Woke pdtest-x (0.1 s).'), JSON.stringify(env.content));
    assert.doesNotThrow(() => JSON.parse(doc.content[0].text!));
    assert.ok(!doc.content.some((x) => /Woke/.test(x.text ?? '')), 'not on a call that never touched the phone');
  } finally { await close(); }
});

test('implicit device: the only running phone, as before idle sleep; a sleeping one only when none runs', async () => {
  const mk = (n: string, state: string, sleep: unknown) => ({ id: `android-emulator:${n}`, nativeId: n, name: n, backend: 'android-emulator', platform: 'android',
    kind: 'virtual', state, managed: true, capabilities: [], sleep, screen: { width: 1080, height: 2400, scale: 1 } }) as unknown as Device;
  for (const [list, want] of [[[mk('pdtest-run', 'running', null), mk('pdtest-zzz', 'stopped', { since: '', reason: 'idle' })], 'android-emulator:pdtest-run'],
    [[mk('pdtest-zzz', 'stopped', { since: '', reason: 'idle' })], 'android-emulator:pdtest-zzz']] as const) {
    const calls: unknown[][] = [];
    const fake: Fake = { calls, owner: 'test', devices: async () => list, resolveDevice: async () => list[0],
      screen: async () => ({ width: 1080, height: 2400, scale: 1 }),
      ui: async (id: string): Promise<UiTree> => { calls.push(['ui', id]); return { source: 'accessibility', screen: { width: 1080, height: 2400, scale: 1 }, root: [], capturedAt: '' }; } };
    const s = await connect(fake);
    try {
      const r = await s.call('get_ui');
      assert.equal(r.isError, false, r.text);
      assert.deepEqual(calls.find((c) => c[0] === 'ui'), ['ui', want]);
    } finally { await s.close(); }
  }
});
