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

test('formatUiObservation: hashes exact printed outline (inner toggle movement, UiWindow.texts, coordinate space)', () => {
  const scale = standardSpace(1200, 2400);

  // Item 3: moving an unlabeled inner switch changes the printed tap point @(x,y) -> must NOT suppress
  const ctxToggle = makeCtx();
  const toggleTree = (innerX: number) => makeTree([{
    ref: 'e1',
    type: 'CheckBox',
    text: 'Airplane Mode',
    clickable: true,
    bounds: { x: 40, y: 200, width: 1000, height: 80 },
    children: [{ ref: 'e2', type: 'Switch', bounds: { x: innerX, y: 210, width: 100, height: 60 } }],
  }], { screenHash: 'same-daemon-hash' });
  const t1 = formatUiObservation({ ctx: ctxToggle, device: dev, tree: toggleTree(700), scale, mode: 'action' });
  const t2 = formatUiObservation({ ctx: ctxToggle, device: dev, tree: toggleTree(950), scale, mode: 'action' });
  assert.equal(t2.unchanged, false, 'moved inner switch tap point must not be suppressed');
  assert.notEqual(t2.hash, t1.hash);
  assert.match(t2.text, /e1 CheckBox "Airplane Mode"/);

  // Item 4: changing UiWindow.texts changes the printed overlay window line -> must NOT suppress
  const ctxWin = makeCtx();
  const winTree = (texts: string[]) => makeTree(
    [{ ref: 'e1', type: 'Button', text: 'OK', clickable: true, bounds: { x: 40, y: 200, width: 200, height: 60 } }],
    {
      screenHash: 'same-daemon-hash',
      windows: [{ role: 'heads_up', bounds: { x: 0, y: 100, width: 1200, height: 400 }, texts }],
    },
  );
  const w1 = formatUiObservation({ ctx: ctxWin, device: dev, tree: winTree(['Allow location?']), scale, mode: 'action' });
  const w2 = formatUiObservation({ ctx: ctxWin, device: dev, tree: winTree(['Allow camera?']), scale, mode: 'action' });
  assert.equal(w2.unchanged, false, 'changed UiWindow.texts must not be suppressed');
  assert.notEqual(w2.hash, w1.hash);
  assert.match(w2.text, /Allow camera\?/);
});

test('formatUiObservation: enforces 8000-char cap with notice on unchanged-screen and empty-tree prompt warnings', () => {
  const ctx = makeCtx();
  const scale = standardSpace(1200, 2400);
  const hugeLabel = 'Allow ' + 'X'.repeat(10_500);
  const treeWithHugePrompt = makeTree(
    [{ ref: 'e1', type: 'Button', text: 'Settings', clickable: true, bounds: { x: 20, y: 100, width: 200, height: 60 } }],
    {
      snapshotId: 'snap-huge-1',
      prompt: {
        kind: 'permission',
        reason: 'Permission dialog',
        needsHuman: false,
        buttons: [{ text: hugeLabel, bounds: { x: 10, y: 10, width: 100, height: 40 }, role: 'accept' }],
      },
    },
  );

  const first = formatUiObservation({ ctx, device: dev, tree: treeWithHugePrompt, scale, mode: 'action' });
  assert.equal(first.unchanged, false);
  assert.equal(first.truncated, true);
  assert.ok(first.text.length <= OBSERVE_MAX_CHARS, `first len ${first.text.length} exceeded ${OBSERVE_MAX_CHARS}`);
  assert.match(first.text, /8000 char limit.*call get_ui for the full tree\./);

  // Item 8: unchanged screen with huge alert button text MUST also obey the 8000-char cap + notice
  const second = formatUiObservation({ ctx, device: dev, tree: { ...treeWithHugePrompt, snapshotId: 'snap-huge-2' }, scale, mode: 'action' });
  assert.equal(second.unchanged, true);
  assert.equal(second.truncated, true);
  assert.ok(second.text.length <= OBSERVE_MAX_CHARS, `unchanged len ${second.text.length} exceeded ${OBSERVE_MAX_CHARS}`);
  assert.match(second.text, /^Screen unchanged \(obs=#2,/);
  assert.match(second.text, /8000 char limit.*call get_ui for the full tree\./);

  // Empty-element tree with huge prompt also obeys the cap
  const emptyHuge = formatUiObservation({
    ctx: makeCtx(),
    device: dev,
    tree: makeTree([], { prompt: treeWithHugePrompt.prompt }),
    scale,
    mode: 'action',
  });
  assert.equal(emptyHuge.truncated, true);
  assert.ok(emptyHuge.text.length <= OBSERVE_MAX_CHARS);
  assert.match(emptyHuge.text, /8000 char limit.*call get_ui for the full tree\./);
});
