import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readUiTree, recentTree } from './find.ts';
import { actionCount, lastActionAt } from './core.ts';
import type { Backend, UiTree } from '../core/types.ts';
const tree = (): UiTree => ({ source: 'accessibility', screen: { width: 100, height: 200 }, root: [], capturedAt: new Date().toISOString() });
test('equivalent concurrent UI reads share work, but a newer action starts a new read', async () => {
  const waiting: ((t: UiTree) => void)[] = []; let calls = 0;
  const d = { id: 'fake:pdtest-read-sharing', nid: 'pdtest-read-sharing', b: { uiTree() { calls++; return new Promise<UiTree>((r) => waiting.push(r)); } } as unknown as Backend };
  const a = readUiTree(d); const b = readUiTree(d);
  assert.equal(calls, 1);
  lastActionAt.set(d.id, Date.now() + 1);
  const c = readUiTree(d); assert.equal(calls, 2);
  waiting[0](tree()); waiting[1](tree());
  assert.equal(await a, await b); await c;
});

test('a read begun before input is not trusted merely because its completion timestamp is newer', async () => {
  let finish!: (t: UiTree) => void; let calls = 0;
  const d = { id: 'fake:pdtest-old-generation', nid: 'pdtest-old-generation', b: { uiTree() { return ++calls === 1 ? new Promise<UiTree>((r) => { finish = r; }) : Promise.resolve(tree()); } } as unknown as Backend };
  const old = readUiTree(d);
  actionCount.set(d.id, 1); lastActionAt.set(d.id, Date.now());
  finish(tree()); await old;
  const result = await recentTree(d, lastActionAt.get(d.id)!, 1000);
  assert.equal(result?.via, 'read'); assert.equal(calls, 2); assert.equal(result?.tree.actionGeneration, 1);
});
