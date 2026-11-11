import { randomUUID } from 'node:crypto';
import { PhoneDockError, type UiTree } from '../core/types.ts';
import { ownershipEpoch } from './execution.ts';
const snapshots = new Map<string, { device: string; tree: UiTree; epoch: number; at: number }>();
const TTL_MS = 120_000;
const LIMIT = 512;
export function rememberSnapshot(device: string, tree: UiTree): UiTree {
  const now = Date.now();
  for (const [id, s] of snapshots) if (now - s.at > TTL_MS) snapshots.delete(id);
  tree.snapshotId ??= randomUUID();
  snapshots.set(tree.snapshotId, { device, tree, epoch: ownershipEpoch(device), at: now });
  while (snapshots.size > LIMIT) snapshots.delete(snapshots.keys().next().value!);
  return tree;
}
export function getSnapshot(device: string, id: string): UiTree {
  const s = snapshots.get(id);
  if (!s || s.device !== device || s.epoch !== ownershipEpoch(device) || Date.now() - s.at > TTL_MS) {
    throw new PhoneDockError('The requested screen snapshot expired or ownership changed', 'stale_ref', 409,
      ['Read the screen again before using a ref.'], undefined, 'not_sent');
  }
  return s.tree;
}
