import { test } from 'node:test';
import assert from 'node:assert/strict';
import { snapshotFailure } from './android-emulator.ts';

test('snapshot save after a Vulkan app: a clear error and a fix, not "try again"', () => {
  const e = snapshotFailure('save', 'KO: Snapshot save is skipped. Reason: UNSUPPORTED_VK_APP\n');
  assert.equal(e.code, 'snapshot_vulkan');
  assert.match(e.hints?.join(' ') ?? '', /Vulkan graphics \(Chrome does\)/);
  assert.match(e.hints?.join(' ') ?? '', /Restart the phone, then save before opening that app/);
});
test('snapshot restore with different emulator features is explained', () => {
  const e = snapshotFailure('load', 'KO: Error -1 from the snapshot callback\nKO: Snapshot load failure: different emulator features');
  assert.equal(e.code, 'snapshot_incompatible');
});
test('other snapshot failures keep their detail', () => {
  const e = snapshotFailure('load', 'KO: Snapshot not found');
  assert.equal(e.code, 'not_found');
  assert.match(snapshotFailure('save', 'KO: weird').detail ?? '', /weird/);
});
