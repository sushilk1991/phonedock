import { test } from 'node:test';
import assert from 'node:assert/strict';
import { screenDigest } from './observe.ts';
import type { UiElement, UiTree } from '../core/types.ts';

let n = 0;
const el = (type: string, y: number, o: Partial<UiElement> = {}): UiElement => ({ ref: `e${++n}`, type, bounds: { x: 0, y, width: 1080, height: 100 }, ...o });
const tree = (root: UiElement[]): UiTree => ({ source: 'accessibility', screen: { width: 1080, height: 2400 }, root, capturedAt: '' });

test('screenDigest: visible label texts in order; no status bar, typed field contents or clocks', () => {
  const t = tree([
    el('TextView', 10, { text: '12:45', id: 'com.android.systemui:id/clock', bounds: { x: 0, y: 10, width: 100, height: 60 } }),
    el('TextView', 200, { text: 'PhoneDock Sample' }),
    el('EditText', 300, { text: 'Ada', value: 'Ada', placeholder: 'Your name' }),
    el('Button', 500, { text: 'Greet' }),
    el('TextView', 700, { text: 'Hello, Ada!' }),
    el('TextView', 800, { text: '42%' }),
    el('Switch', 900, { text: 'Notifications', checked: true }),
    el('TextView', 5000, { text: 'Below the screen' }),
    el('Image', 550, { label: 'chevron.forward' }),
  ]);
  const d = screenDigest(t);
  assert.deepEqual(d.texts, ['PhoneDock Sample', 'Greet', 'Hello, Ada!', 'Notifications']);
  // a toggle flip or a typed value changes the signature; the clock doesn't
  const flipped = structuredClone(t); (flipped.root[6] as UiElement).checked = false;
  assert.notEqual(screenDigest(flipped).sig, d.sig);
  const later = structuredClone(t); (later.root[0] as UiElement).text = '12:46';
  assert.equal(screenDigest(later).sig, d.sig);
  // iOS: a TextView with a value is a field
  assert.deepEqual(screenDigest(tree([el('TextView', 300, { value: 'notes typed', text: 'notes typed' }), el('StaticText', 400, { label: 'Notes' })])).texts, ['Notes']);
});
