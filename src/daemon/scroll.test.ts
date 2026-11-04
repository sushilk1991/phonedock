import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiElement, UiTree } from '../core/types.ts';
import { canScroll, contentItems, contentMoved, contentSignature, lookFromFinger, pickContainer, swipeFor } from './scroll.ts';

const W = 1080, H = 2424;
let n = 0;
const el = (type: string, x: number, y: number, w: number, h: number, more: Partial<UiElement> = {}): UiElement => ({ ref: `e${++n}`, type, bounds: { x, y, width: w, height: h }, ...more });
const tree = (root: UiElement[], source: UiTree['source'] = 'accessibility'): UiTree => ({ source, screen: { width: W, height: H }, root, capturedAt: '' });

// The sample app's form: a ScrollView whose content fits (Android reports it as not scrollable).
const sample = () => tree([el('FrameLayout', 0, 0, W, H, { id: 'content', children: [el('ScrollView', 0, 0, W, H, { id: 'root', children: [
  el('TextView', 63, 205, 954, 91, { text: 'PhoneDock Sample' }),
  el('EditText', 63, 338, 954, 118, { text: 'Margaret', id: 'nameField', clickable: true, focused: true }),
  el('Button', 63, 488, 231, 126, { text: 'Greet', clickable: true }),
] })] })]);
// A settings-like list below a toolbar, plus a horizontal carousel.
const list = (offset = 0) => tree([el('LinearLayout', 0, 0, W, H, { children: [
  el('Toolbar', 0, 130, W, 160, { text: 'Settings' }),
  el('HorizontalScrollView', 0, 300, W, 300, { scrollable: true, children: [el('TextView', 40, 400, 200, 60, { text: 'Chip A' })] }),
  el('RecyclerView', 0, 620, W, 1700, { scrollable: true, id: 'list', children: [0, 1, 2, 3].map((i) => el('TextView', 40, 700 + i * 300 - offset, 1000, 120, { text: `Row ${i + Math.round(offset / 300)}` })) }),
] })]);

test('canScroll: an Android screen without scrollable nodes has nothing to scroll; unknown elsewhere', () => {
  assert.equal(canScroll(sample(), 'android'), false);
  assert.equal(canScroll(list(), 'android'), true);
  assert.equal(canScroll(sample(), 'ios'), null);                       // iOS marks containers by type only
  assert.equal(canScroll(tree([el('TextView', 0, 0, 10, 10, { text: 'x' })], 'ocr'), 'android'), null);
  assert.equal(canScroll(tree([el('WebView', 0, 0, W, H, { label: 'Web View' })]), 'android'), null);
  assert.equal(canScroll(undefined, 'android'), null);
});

test('pickContainer: the list for vertical scrolls, the carousel for horizontal ones, the one under a point', () => {
  assert.equal(pickContainer(list(), true)?.id, 'list');
  assert.equal(pickContainer(list(), false)?.type, 'HorizontalScrollView');
  assert.equal(pickContainer(list(), true, { x: 500, y: 400 })?.type, 'HorizontalScrollView');
  assert.equal(pickContainer(sample(), true), undefined);
});

test('swipeFor: stays inside the container, in the safe band and above the keyboard', () => {
  const c = { x: 0, y: 620, width: W, height: 1700 };
  const s = swipeFor(W, H, 'down', { container: c, distance: 0.6 });
  assert.ok(s.y1 > s.y2, 'reveal below = finger moves up');
  for (const y of [s.y1, s.y2]) assert.ok(y >= 620 + 170 - 1 && y <= 620 + 1700 * 0.9 + 1 && y <= H * 0.92, `y=${y}`);
  assert.equal(s.x1, W / 2);
  // the blind-test swipe was 540,1939 → 540,485 with the keyboard from y≈1500: now it must end above it
  const k = swipeFor(W, H, 'down', { distance: 0.6, bottomLimit: 1500 });
  assert.ok(Math.max(k.y1, k.y2) < 1500, JSON.stringify(k));
  const up = swipeFor(W, H, 'up', { container: c });
  assert.ok(up.y1 < up.y2, 'reveal above = finger moves down');
  const left = swipeFor(W, H, 'right', { container: { x: 0, y: 300, width: W, height: 300 } });
  assert.ok(left.x1 > left.x2 && left.y1 === 450);
  assert.deepEqual(lookFromFinger('up'), 'down');
  assert.deepEqual(lookFromFinger('left'), 'right');
});

test('swipeFor without a container: the old content band (full-screen scroll-to, MCP direction swipes)', () => {
  const s = swipeFor(W, H, 'down', { distance: 0.6 });
  assert.deepEqual([s.y1, s.y2], [Math.round(H / 2 + H * 0.3), Math.round(H / 2 - H * 0.3)]);
  const m = swipeFor(W, H, 'down', { distance: 0.5, durationMs: 300 });   // MCP swipe direction="up" default
  assert.deepEqual([m.y1, m.y2, m.durationMs], [Math.round(H / 2 + H * 0.25), Math.round(H / 2 - H * 0.25), 300]);
});

test('contentSignature: changes when the list moves, not when a field\'s text changes; empty without text', () => {
  const box = { x: 0, y: 620, width: W, height: 1700 };
  assert.notEqual(contentSignature(list(0), box), contentSignature(list(300), box));
  assert.equal(contentSignature(list(300), box), contentSignature(list(300), box));      // end reached
  const a = sample(), b = sample();
  (b.root[0].children![0].children![1]).text = 'Margaret GT GT GT';                       // glide-typing into the field
  assert.equal(contentSignature(a), contentSignature(b));
  assert.equal(contentSignature(tree([el('View', 0, 0, W, H, { scrollable: true })])), '');
});

// H2 (blind test round 2): iOS Settings never looked "ended": the clock, the scroll indicator's value and the floating
// search field changed between reads, and the end-of-list bounce moved the rows a little. Every miss took 8 scrolls.
const settings = (dy: number, opts: { clock?: string; bar?: string; rows?: string[] } = {}) => {
  const rows = opts.rows ?? ['Privacy & Security', 'Game Center', 'iCloud', 'Apps', 'Developer'];
  return tree([el('Application', 0, 0, W, H, { label: 'Settings', children: [
    el('StaticText', 60, 30, 200, 60, { label: opts.clock ?? '9:41' }),
    ...rows.map((r, i) => el('Button', 48, 900 + i * 156 + dy, 984, 156, { label: r })),
    el('Slider', 1000, 300, 40, 1500, { label: 'Vertical scroll bar, 3 pages', value: opts.bar ?? '100%' }),
    el('TextField', 100, 2200, 880, 114, { label: 'Search', children: [el('Button', 850, 2224, 52, 66, { label: 'Dictate', id: 'Dictate' })] }),
  ] })]);
};
test('contentItems / contentMoved (iOS): the end of a list despite the clock, scroll bar, floating search and bounce', () => {
  const end = contentItems(settings(0, { clock: '9:41', bar: '97%' }));
  assert.deepEqual(end.map((i) => i.t), ['Privacy & Security', 'Game Center', 'iCloud', 'Apps', 'Developer']);
  // the next read: clock ticked, indicator value changed, rows still bouncing back by 60 px → not moved = end reached
  assert.equal(contentMoved(end, contentItems(settings(60, { clock: '9:42', bar: '100%' })), 1700), false);
  // a real scroll: other rows, or the same rows carried a long way (trees that keep off-screen rows)
  assert.equal(contentMoved(end, contentItems(settings(0, { rows: ['iCloud', 'Apps', 'Developer', 'Wallet', 'Maps'] })), 1700), true);
  assert.equal(contentMoved(end, contentItems(settings(-900)), 1700), true);
});
