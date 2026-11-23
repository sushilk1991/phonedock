import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Device, UiElement, UiTree } from '../core/types.ts';
import type { McpContext } from './server.ts';
import { standardSpace } from './server.ts';
import { formatUiObservation, OBSERVE_MAX_CHARS, OBSERVE_MAX_ELEMENTS, resolveObserve } from './ui-format.ts';

const dev: Device = {
  id: 'ios-simulator:sim-1',
  backend: 'ios-simulator',
  nativeId: 'sim-1',
  name: 'pdtest-sim',
  platform: 'ios',
  kind: 'virtual',
  state: 'running',
  managed: true,
  capabilities: ['uiTree', 'screenshot'],
  screen: { width: 1200, height: 2400 },
};

const makeTree = (root: UiElement[], extra: Partial<UiTree> = {}): UiTree => ({
  source: 'accessibility',
  screen: { width: 1200, height: 2400 },
  capturedAt: new Date().toISOString(),
  snapshotId: 'snap-1',
  root,
  ...extra,
});

const makeCtx = (): McpContext => ({ client: {} as never, scales: new Map() });

test('resolveObserve: supports all modes, return_screenshot compatibility, and rejects conflicts', () => {
  assert.equal(resolveObserve(undefined, undefined), 'none');
  assert.equal(resolveObserve(undefined, false), 'none');
  assert.equal(resolveObserve(undefined, true), 'image');
  assert.equal(resolveObserve('none', false), 'none');
  assert.equal(resolveObserve('image', true), 'image');
  assert.equal(resolveObserve('both', true), 'both');
  assert.equal(resolveObserve('ui', undefined), 'ui');
  assert.throws(() => resolveObserve('none', true), /Conflicting options/);
  assert.throws(() => resolveObserve('ui', true), /Conflicting options/);
});

test('formatUiObservation: increments obs counter, suppresses unchanged screen in action mode, preserves prompt warnings', () => {
  const ctx = makeCtx();
  const scale = standardSpace(1200, 2400);
  const el: UiElement = { ref: 'e1', type: 'Button', text: 'General', clickable: true, bounds: { x: 20, y: 100, width: 300, height: 60 } };

  const r1 = formatUiObservation({ ctx, device: dev, tree: makeTree([el], { snapshotId: 'snap-1' }), scale, mode: 'action' });
  assert.equal(r1.obsCount, 1);
  assert.equal(r1.unchanged, false);
  assert.match(r1.text, /obs=#1 hash=[0-9a-f]{16} snapshot=snap-1/);
  assert.match(r1.text, /e1 Button "General"/);
  assert.equal(ctx.snapshots?.get(dev.id), 'snap-1');

  // Same visible screen with newer snapshotId -> suppressed in action mode, snapshot still updated
  const r2 = formatUiObservation({ ctx, device: dev, tree: makeTree([el], { snapshotId: 'snap-2' }), scale, mode: 'action' });
  assert.equal(r2.obsCount, 2);
  assert.equal(r2.unchanged, true);
  assert.equal(r2.hash, r1.hash);
  assert.equal(r2.text, `Screen unchanged (obs=#2, hash=${r1.hash}, snapshot=snap-2).`);
  assert.equal(ctx.snapshots?.get(dev.id), 'snap-2');

  // Unchanged screen with a prompt still emits SYSTEM PROMPT warning
  const withPrompt = makeTree([el], {
    snapshotId: 'snap-3',
    prompt: { kind: 'permission', reason: 'Allow Camera?', needsHuman: false, buttons: [{ text: 'Allow', bounds: { x: 10, y: 10, width: 50, height: 30 }, role: 'accept' }] },
  });
  const r3 = formatUiObservation({ ctx, device: dev, tree: withPrompt, scale, mode: 'action' });
  assert.equal(r3.unchanged, false);
  const r4 = formatUiObservation({ ctx, device: dev, tree: { ...withPrompt, snapshotId: 'snap-4' }, scale, mode: 'action' });
  assert.equal(r4.unchanged, true);
  assert.match(r4.text, /^Screen unchanged \(obs=#4,/);
  assert.match(r4.text, /SYSTEM PROMPT:/);

  // Explicit get_ui (`mode: 'full'`) is never suppressed and still increments obs=#N
  const r5 = formatUiObservation({ ctx, device: dev, tree: { ...withPrompt, snapshotId: 'snap-5' }, scale, mode: 'full' });
  assert.equal(r5.obsCount, 5);
  assert.equal(r5.unchanged, false);
  assert.match(r5.text, /obs=#5 hash=[0-9a-f]{16}/);
  assert.match(r5.text, /e1 Button "General"/);
});

test('formatUiObservation: enforces 120-element cap and 8000-char cap in action mode with explicit truncation notice', () => {
  const scale = standardSpace(1200, 2400);

  // 150 short elements -> hits 120 element limit
  const manyEls: UiElement[] = Array.from({ length: 150 }, (_, i) => ({
    ref: `e${i + 1}`,
    type: 'Text',
    text: `Row ${i + 1}`,
    bounds: { x: 10, y: 10 + i * 10, width: 200, height: 10 },
  }));
  const rElem = formatUiObservation({ ctx: makeCtx(), device: dev, tree: makeTree(manyEls), scale, mode: 'action' });
  assert.equal(rElem.truncated, true);
  assert.equal(rElem.totalElements, 150);
  assert.equal(rElem.shownElements, OBSERVE_MAX_ELEMENTS);
  assert.match(rElem.text, /… truncated: showing 120 of 150 elements \(120 element limit\); call get_ui for the full tree\./);
  assert.ok(rElem.text.length <= OBSERVE_MAX_CHARS);

  // 110 wide elements (each ~130 chars) -> hits 8000 char limit before 120 elements
  const wideEls: UiElement[] = Array.from({ length: 110 }, (_, i) => ({
    ref: `e${i + 1}`,
    type: 'StaticText',
    text: `Item ${i + 1} ${'abcdefghij'.repeat(7)}`,
    id: `com.example:id/very_long_identifier_row_${i + 1}`,
    clickable: true,
    bounds: { x: 10, y: 10 + i * 10, width: 500, height: 10 },
  }));
  const rChar = formatUiObservation({ ctx: makeCtx(), device: dev, tree: makeTree(wideEls), scale, mode: 'action' });
  assert.equal(rChar.truncated, true);
  assert.ok(rChar.shownElements < 110, `expected char cap < 110, got ${rChar.shownElements}`);
  assert.ok(rChar.text.length <= OBSERVE_MAX_CHARS, `len ${rChar.text.length} exceeded ${OBSERVE_MAX_CHARS}`);
  assert.match(rChar.text, /8000 char limit.*call get_ui for the full tree\./);
});
