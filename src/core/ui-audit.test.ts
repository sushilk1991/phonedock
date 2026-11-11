import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { UiTree, UiElement } from './types.ts';
import { auditUiTree } from './ui-audit.ts';
const el = (ref: string, x: number, y: number, width: number, height: number, extra: Partial<UiElement> = {}): UiElement => ({ ref, type: 'Button', clickable: true, bounds: { x, y, width, height }, ...extra });
const tree = (root: UiElement[], screen = { width: 1200, height: 2400, scale: 3 }): UiTree => ({ source: 'accessibility', capturedAt: '', screen, root });
test('iOS touch targets use points and Android uses density, never screenshot pixel thresholds', () => {
  const t = tree([el('e1', 0, 100, 90, 150, { text: 'Small' }), el('e2', 0, 300, 144, 144, { text: 'Good' })]);
  const result = auditUiTree(t, 'ios');
  assert.deepEqual(result.findings.filter(f=>f.kind === 'small_target').map(f=>f.ref), ['e1']);
  const android = { ...t, screen: { width: 1200, height: 2400, scale: 1, density: 480 } };
  assert.deepEqual(auditUiTree(android, 'android').findings.filter(f=>f.kind === 'small_target').map(f=>f.ref), ['e1']);
  const noDensity = auditUiTree({ ...t, screen: { width: 1200, height: 2400, scale: 1 } }, 'android');
  assert.equal(noDensity.findings.some(f=>f.kind === 'small_target'), false);
  assert.ok(noDensity.limitations.some(l=>/density/i.test(l)));
});
test('missing labels respect descendant text and ignore intentional ellipses and decorative content', () => {
  const t = tree([el('e1', 0, 100, 150, 150), el('e2', 0, 300, 150, 150, { children: [el('e3', 0, 300, 150, 100, { type: 'Text', clickable: false, text: 'Continue…' })] }), el('e4', 0, 500, 150, 150, { type: 'Image', clickable: false })]);
  const result = auditUiTree(t, 'ios');
  assert.deepEqual(result.findings.filter(f=>f.kind === 'missing_label').map(f=>f.ref), ['e1']);
  assert.equal(result.findings.some(f=>String(f.kind) === 'text_truncation'), false);
});

test('floating search fields and tab bars cover rows but never flag their own controls', () => {
  const row = el('e1', 0, 2200, 1100, 150, { text: 'Covered row' });
  const search = el('e2', 100, 2250, 1000, 120, { type: 'TextField', placeholder: 'Search' });
  const t = tree([{ ref: 'app', type: 'Application', bounds: { x: 0, y: 0, width: 1200, height: 2400 }, children: [row, search] }]);
  const result = auditUiTree(t, 'ios');
  assert.ok(result.findings.some(f=>f.ref === 'e1' && f.kind === 'occluded'));
  assert.ok(!result.findings.some(f=>f.ref === 'e2' && f.kind === 'occluded'));
});
test('partial clipping and keyboard occlusion are warnings; offscreen list rows are omitted by default', () => {
  const t = tree([el('e1', -20, 100, 150, 150, { text: 'Clipped' }), el('e2', 0, 2300, 150, 150, { text: 'Keyboard' }), el('e3', 0, 3000, 150, 150, { text: 'Next row' })]);
  t.windows = [{ role: 'keyboard', bounds: { x: 0, y: 2000, width: 1200, height: 400 } }];
  const findings = auditUiTree(t, 'ios').findings;
  assert.ok(findings.some(f=>f.ref === 'e1' && f.kind === 'clipped'));
  assert.ok(findings.some(f=>f.ref === 'e2' && f.kind === 'occluded'));
  assert.ok(!findings.some(f=>f.ref === 'e3'));
  assert.ok(auditUiTree(t, 'ios', { includeOffscreen: true }).findings.some(f=>f.ref === 'e3' && f.kind === 'offscreen'));
});
