import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiTree } from './types.ts';
import { uiTreeHash } from './ui-hash.ts';

const baseTree = (): UiTree => ({
  source: 'accessibility',
  screen: { width: 1080, height: 2400 },
  capturedAt: '2026-11-23T10:00:00.000Z',
  snapshotId: 'snap-1',
  actionGeneration: 1,
  root: [
    {
      ref: 'e1',
      type: 'android.widget.Button',
      text: 'Sign in',
      id: 'com.example:id/sign_in',
      clickable: true,
      enabled: true,
      bounds: { x: 100, y: 200, width: 300, height: 80 },
    },
    {
      ref: 'e2',
      type: 'android.widget.Switch',
      text: 'Notifications',
      checked: false,
      clickable: true,
      bounds: { x: 100, y: 320, width: 300, height: 80 },
    },
  ],
});

test('uiTreeHash: deterministic 16-hex-char hash insensitive to capturedAt, snapshotId, actionGeneration', () => {
  const t1 = baseTree();
  const h1 = uiTreeHash(t1);
  assert.match(h1, /^[0-9a-f]{16}$/);

  const t2: UiTree = {
    ...baseTree(),
    capturedAt: '2026-11-23T12:34:56.789Z',
    snapshotId: 'snap-999',
    actionGeneration: 42,
  };
  assert.equal(uiTreeHash(t2), h1);
});

test('uiTreeHash: sensitive to text, ref, bounds, state flags, prompt, and overlay windows', () => {
  const h0 = uiTreeHash(baseTree());

  const diffText = baseTree();
  diffText.root[0].text = 'Log in';
  assert.notEqual(uiTreeHash(diffText), h0);

  const diffRef = baseTree();
  diffRef.root[0].ref = 'e9';
  assert.notEqual(uiTreeHash(diffRef), h0);

  const diffBounds = baseTree();
  diffBounds.root[0].bounds = { x: 100, y: 210, width: 300, height: 80 };
  assert.notEqual(uiTreeHash(diffBounds), h0);

  const diffChecked = baseTree();
  diffChecked.root[1].checked = true;
  assert.notEqual(uiTreeHash(diffChecked), h0);

  const diffPrompt = baseTree();
  diffPrompt.prompt = {
    kind: 'permission',
    reason: 'Allow Notifications?',
    needsHuman: false,
    buttons: [{ text: 'Allow', bounds: { x: 100, y: 500, width: 100, height: 50 }, role: 'accept' }],
  };
  assert.notEqual(uiTreeHash(diffPrompt), h0);

  const diffWindow = baseTree();
  diffWindow.windows = [{ role: 'keyboard', bounds: { x: 0, y: 1600, width: 1080, height: 800 } }];
  assert.notEqual(uiTreeHash(diffWindow), h0);

  // Offscreen element changes do not affect the visible screen hash
  const withOffscreen = baseTree();
  withOffscreen.root.push({
    ref: 'e99',
    type: 'Text',
    text: 'Hidden below',
    bounds: { x: 0, y: 2500, width: 100, height: 40 },
  });
  assert.equal(uiTreeHash(withOffscreen), h0);
});
