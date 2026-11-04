// AXe describe-ui gaps on the iOS simulator (blind test findings 5 and 13): rows the full tree leaves as empty Groups are
// filled from a point query, so "Dark Appearance" is a real switch with a state and a tap point on the switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyRows, mapTree, rowHit } from './ios-simulator.ts';
import type { AxNode } from './ios-simulator.ts';
import { flatten, tapPoint } from '../daemon/media.ts';

type F = { x: number; y: number; width: number; height: number };
const n = (type: string, label: string | null, frame: F, extra: Partial<AxNode> = {}): AxNode => ({ type, AXLabel: label, frame, children: [], ...extra });

/** Settings › Developer, iPhone 17 Pro, iOS 26.5 — frames (points) from a real `axe describe-ui`, trimmed. */
const developer = (): AxNode[] => [
  n('Application', 'Settings', { x: 0, y: 0, width: 402, height: 874 }, { children: [
    n('Group', null, { x: 0, y: 62, width: 402, height: 54 }, { AXUniqueId: 'Developer', children: [
      n('Button', 'Settings', { x: 16, y: 62, width: 44, height: 44 }, { AXUniqueId: 'BackButton' }),
      n('Heading', 'Developer', { x: 160.3, y: 73.7, width: 81, height: 20.7 }),
    ] }),
    n('Group', null, { x: 0, y: 0, width: 402, height: 874 }),                                  // full-screen backdrop
    n('Heading', 'Appearance', { x: 20, y: 116, width: 362, height: 55.3 }),
    n('Group', null, { x: 20, y: 171.33, width: 362, height: 53 }, { AXUniqueId: 'UIAppearanceSettings' }),
    n('Button', 'View, Default', { x: 20, y: 287, width: 362, height: 53 }, { AXUniqueId: 'MAGNIFY', children: [
      n('Button', 'View, Default', { x: 36, y: 303.3, width: 307.7, height: 20.3 }, { AXUniqueId: 'MAGNIFY' }),
      n('Group', null, { x: 20, y: 287, width: 362, height: 53 }),                              // the cell's background
      n('Group', null, { x: 20, y: 339, width: 362, height: 1 }),                               // separator
    ] }),
    n('Group', null, { x: 20, y: 568.33, width: 362, height: 53 }, { AXUniqueId: 'UIAGroup.0' }),
  ] }),
];

/** `axe describe-ui --point 201,198` on that screen (real output, trimmed): the row's switch with its label and value. */
const darkAppearanceHit = (): AxNode => ({
  type: 'CheckBox', role: 'AXCheckBox', subrole: 'AXSwitch', AXLabel: 'Dark Appearance', AXValue: '0', AXUniqueId: 'UIAppearanceSettings',
  AXFrame: '{{36, 184}, {330, 28}}', enabled: true, children: [
    n('Button', 'Dark Appearance', { x: 36, y: 187.67, width: 132.33, height: 20.33 }, { AXUniqueId: 'UIAppearanceSettings', role: 'AXButton' }),
    { type: 'CheckBox', role: 'AXCheckBox', subrole: 'AXSwitch', AXLabel: null, AXValue: '0', AXFrame: '{{305, 184}, {63, 28}}', children: [] },
  ],
});

test('emptyRows: the two bare switch rows, not backdrops, separators or cell backgrounds', () => {
  const rows = emptyRows(developer());
  assert.deepEqual(rows.map((r) => r.node.AXUniqueId), ['UIAppearanceSettings', 'UIAGroup.0']);
  assert.deepEqual(rows[0].point, { x: 201, y: 198 });
});

test('rowHit: takes the element inside the row; a container around it or an unlabelled node is not a hit', () => {
  const row = emptyRows(developer())[0];
  assert.equal(rowHit([darkAppearanceHit()], row.f)?.AXLabel, 'Dark Appearance');
  assert.equal(rowHit([n('Application', 'Settings', { x: 0, y: 0, width: 402, height: 874 })], row.f), undefined);
  assert.equal(rowHit([n('Group', null, { x: 20, y: 171.33, width: 362, height: 53 })], row.f), undefined);
});

test('grafted row maps to a switch with its state, tapped on the switch itself', () => {
  const roots = developer();
  const row = emptyRows(roots)[0];
  row.node.children = [darkAppearanceHit()];
  const els = flatten(mapTree(roots, 3));
  const sw = els.find((e) => e.label === 'Dark Appearance' && e.type === 'Switch');   // AXCheckBox/AXSwitch → Switch
  assert.ok(sw, 'Dark Appearance is in the tree');
  assert.equal(sw.checked, false);
  assert.equal(sw.text, 'Dark Appearance');
  assert.deepEqual(tapPoint(sw), { x: 1010, y: 594 }, 'the inner switch, not the label');
  const inner = els.find((e) => e.type === 'Switch' && !e.label);
  assert.ok(!els.some((e) => e.type === 'CheckBox'), 'no iOS switch is reported as a CheckBox');
  assert.equal(inner?.text, undefined, 'a toggle\'s 0/1 value is not its text');
});
