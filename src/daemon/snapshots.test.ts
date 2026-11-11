import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiTree } from '../core/types.ts';
import { getSnapshot, rememberSnapshot } from './snapshots.ts';
import { ownershipChanged } from './execution.ts';
test('snapshot identities survive another client reading; device and takeover boundaries are enforced', () => {
  const id = 'fake:pdtest-snapshots';
  const tree = (text: string): UiTree => ({ source: 'accessibility', screen: { width: 100, height: 100 }, capturedAt: new Date().toISOString(), root: [{ ref: 'e1', type: 'Button', text, bounds: { x: 0, y: 0, width: 10, height: 10 } }] });
  const first = rememberSnapshot(id, tree('First'));
  const second = rememberSnapshot(id, tree('Second'));
  assert.notEqual(first.snapshotId, second.snapshotId);
  assert.equal(getSnapshot(id, first.snapshotId!).root[0].text, 'First');
  assert.throws(() => getSnapshot('fake:other', first.snapshotId!), (e: any) => e.code === 'stale_ref');
  ownershipChanged(id);
  assert.throws(() => getSnapshot(id, first.snapshotId!), (e: any) => e.code === 'stale_ref');
});
