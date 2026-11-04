// MCP tools end to end over an in-memory transport, against a fake daemon client (no devices needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { PhoneDockClient, Device, UiTree, UiElement } from '../sdk/client.ts';
import { createMcpServer } from './server.ts';

type Fake = Record<string, unknown> & { calls: unknown[][] };
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
