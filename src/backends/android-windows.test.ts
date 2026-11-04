// Which window an Android UI read describes (android-windows.ts), from real helper dumps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describeDump } from './android-common.ts';
import { chooseWindow, parseHelperWindows, windowRole, windowsLine, type HelperWindow } from './android-windows.ts';
import { pickContainer } from '../daemon/scroll.ts';
import { flatten, keyboardInfo } from '../daemon/media.ts';
import type { UiTree } from '../core/types.ts';

const SCREEN = { width: 1080, height: 2424 };
// API 36 emulator, Settings in front, a heads-up notification ("pdtest" / "hello") from the sample app, every window
// dumped: root 0 = SystemUI's NotificationShade window (its tree holds the collapsed quick settings), root 1 = Settings.
const HEADS_UP = readFileSync(new URL('../../fixtures/android-windows/headsup-over-settings.xml', import.meta.url), 'utf8');
// What the vivo showed: the shade window active (it took the active flag from a heads-up), its quick settings
// ScrollView scrollable. The old read (getRootInActiveWindow) described that window.
const SHADE_ACTIVE = HEADS_UP
  .replace('<pd-window id="88" type="system" layer="1"', '<pd-window id="88" type="system" layer="1" active="1"')
  .replace('focused="1" active="1" bounds="[0,0][1080,2424]" pkg="com.android.settings"', 'focused="1" bounds="[0,0][1080,2424]" pkg="com.android.settings"')
  .replace(/(resource-id="com\.android\.systemui:id\/expanded_qs_scroll_view"[^>]*?)scrollable="false"/, '$1scrollable="true"');
const tree = (xml: string): UiTree => ({ source: 'accessibility', screen: { ...SCREEN, scale: 1 }, ...describeDump(xml, SCREEN), capturedAt: '' });
const ids = (t: UiTree) => flatten(t.root).map((e) => e.id).filter(Boolean);

const win = (o: Partial<HelperWindow>): HelperWindow => ({ id: 1, type: 'app', layer: 0, focused: false, active: false, pip: false, shade: false, bounds: { x: 0, y: 0, width: 1080, height: 2424 }, texts: [], ...o });

test('parses the window list: shade flag, root index, texts without separators', () => {
  const w = parseHelperWindows(HEADS_UP)!;
  assert.equal(w.length, 2);
  assert.deepEqual({ type: w[0].type, shade: w[0].shade, root: w[0].root, texts: w[0].texts, bounds: w[0].bounds },
    { type: 'system', shade: true, root: 0, texts: ['pdtest', 'now', 'hello'], bounds: { x: 42, y: 163, width: 996, height: 218 } });
  assert.deepEqual({ type: w[1].type, focused: w[1].focused, title: w[1].title, root: w[1].root }, { type: 'app', focused: true, title: 'Settings', root: 1 });
  assert.equal(parseHelperWindows('<hierarchy rotation="0"><node/></hierarchy>'), undefined);
});

test('heads-up over Settings: Settings is described, the heads-up is an overlay with its text', () => {
  const t = tree(HEADS_UP);
  assert.ok(ids(t).includes('com.android.settings:id/recycler_view'));
  assert.ok(!ids(t).some((id) => id!.startsWith('com.android.systemui:')), 'no SystemUI node in the tree');
  assert.deepEqual(t.windows, [
    { role: 'heads_up', bounds: { x: 42, y: 163, width: 996, height: 218 }, package: 'com.android.systemui', texts: ['pdtest', 'now', 'hello'] },
    { role: 'app', bounds: { x: 0, y: 0, width: 1080, height: 2424 }, package: 'com.android.settings', title: 'Settings', focused: true, described: true },
  ]);
  assert.equal(windowsLine(t.windows), 'Over the screen: heads-up notification: "pdtest · now · hello"');
});

test('the shade window is active (vivo): still Settings, and swipe never picks the quick settings ScrollView', () => {
  const w = parseHelperWindows(SHADE_ACTIVE)!;
  assert.equal(w[0].active, true); assert.equal(w[1].active, false);
  const t = tree(SHADE_ACTIVE);
  assert.match(pickContainer(t, true)?.id ?? '', /^com\.android\.settings:id\//);
  // the bug: describing the active window (or every root) put expanded_qs_scroll_view in the tree
  const old: UiTree = { ...t, root: describeDump(SHADE_ACTIVE.replace(/<pd-windows>[\s\S]*<\/pd-windows>/, ''), SCREEN).root };
  assert.ok(ids(old).includes('com.android.systemui:id/expanded_qs_scroll_view'));
  // and the guard: given both, a swipe takes the app's container over SystemUI's
  assert.match(pickContainer(old, true)?.id ?? '', /^com\.android\.settings:id\//);
});

test('roles: bars, keyboard, focused system dialog, pulled-down shade, pip', () => {
  assert.equal(windowRole(win({ type: 'system', title: 'Navigation bar', bounds: { x: 0, y: 2296, width: 1080, height: 104 } }), SCREEN), 'bar');
  assert.equal(windowRole(win({ type: 'system', bounds: { x: 0, y: 0, width: 1080, height: 87 } }), SCREEN), 'bar');   // vivo status bar: no title
  assert.equal(windowRole(win({ type: 'ime', bounds: { x: 0, y: 1500, width: 1080, height: 924 } }), SCREEN), 'keyboard');
  assert.equal(windowRole(win({ type: 'system', focused: true, bounds: { x: 100, y: 900, width: 880, height: 600 } }), SCREEN), 'dialog');
  assert.equal(windowRole(win({ type: 'system', bounds: { x: 100, y: 900, width: 880, height: 600 } }), SCREEN), 'system');
  assert.equal(windowRole(win({ type: 'system', shade: true, focused: true }), SCREEN), 'notifications');
  assert.equal(windowRole(win({ type: 'system', title: 'NotificationShade', bounds: { x: 42, y: 163, width: 996, height: 218 } }), SCREEN), 'heads_up');
  assert.equal(windowRole(win({ pip: true, bounds: { x: 600, y: 1700, width: 400, height: 225 } }), SCREEN), 'pip');
  assert.equal(windowRole(win({ type: 'a11y' }), SCREEN), undefined);
});

test('describe: the focused window (system dialog, pulled-down shade), else active, else the top app', () => {
  const app = win({ id: 2, root: 1, title: 'Play Store', pkg: 'com.android.vending' });
  const dialog = win({ id: 3, type: 'system', focused: true, root: 0, bounds: { x: 100, y: 900, width: 880, height: 600 }, texts: ['Allow?'] });
  let c = chooseWindow([dialog, { ...app, active: true }], 2, SCREEN)!;
  assert.equal(c.root, 0);
  assert.deepEqual(c.windows.map((w) => [w.role, !!w.described]), [['dialog', true], ['app', false]]);
  // the keyboard has focus and no root: the app below it is described; the keyboard is an overlay with its top
  const ime = win({ id: 4, type: 'ime', focused: true, layer: 5, bounds: { x: 0, y: 1500, width: 1080, height: 924 } });
  c = chooseWindow([ime, { ...app, root: 0, active: true }], 1, SCREEN)!;
  assert.equal(c.root, 0);
  assert.deepEqual(c.windows[0], { role: 'keyboard', bounds: { x: 0, y: 1500, width: 1080, height: 924 }, focused: true });
  const kb = keyboardInfo({ source: 'accessibility', screen: { ...SCREEN, scale: 1 }, root: [], capturedAt: '', windows: c.windows });
  assert.deepEqual(kb.frame, { x: 0, y: 1500, width: 1080, height: 924 });
  assert.equal(windowsLine(c.windows), 'Over the screen: keyboard from y=1500');
  // a small system window hanging off the screen edge (vivo's com.vivo.card): its on-screen part, with where it is
  const edge = chooseWindow([
    { id: 9, type: 'system', layer: 30, focused: false, active: false, pip: false, shade: false, bounds: { x: 1008, y: 192, width: 204, height: 306 }, pkg: 'com.vivo.card', texts: [] },
    { id: 1, type: 'app', layer: 2, focused: true, active: true, pip: false, shade: false, bounds: { x: 0, y: 0, width: 1080, height: 2400 }, pkg: 'com.android.launcher3', title: 'System Home Screen', root: 0, texts: [] },
  ], 1, { width: 1080, height: 2400 })!;
  assert.deepEqual(edge.windows[0].bounds, { x: 1008, y: 192, width: 72, height: 306 });
  assert.equal(windowsLine(edge.windows), 'Over the screen: system window (com.vivo.card) @(1044,345) 72x306');
  // nothing focused and the active window is a heads-up: the top app
  const hu = win({ id: 5, type: 'system', shade: true, active: true, root: 0, bounds: { x: 42, y: 163, width: 996, height: 218 } });
  c = chooseWindow([hu, { ...app, root: 1 }], 2, SCREEN)!;
  assert.equal(c.root, 1);
  // pulled-down shade (focused, full screen) is the screen
  const shade = win({ id: 6, type: 'system', shade: true, focused: true, root: 0 });
  c = chooseWindow([shade, { ...app, root: 1 }], 2, SCREEN)!;
  assert.equal(c.root, 0);
  assert.equal(c.windows[0].role, 'notifications');
});
