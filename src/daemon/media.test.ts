// Partial-tree detection + OCR merge (blind test findings 5 and 13) and placeholder output (finding 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coarseWhere, labelAt, findElements, flatten, floatingBars, mergeOcr, partialRegions, screenSummary, uiText, uncoveredPoint } from './media.ts';
import type { UiElement, UiTree } from '../core/types.ts';

type Box = [x: number, y: number, w: number, h: number];
let n = 0;
function el(type: string, text: string | undefined, b: Box, extra: Partial<UiElement> = {}): UiElement {
  const e: UiElement = { ref: `e${++n}`, type, bounds: { x: b[0], y: b[1], width: b[2], height: b[3] }, ...extra };
  if (text !== undefined) { e.text = text; e.label = text; }
  return e;
}
const tree = (source: UiTree['source'], width: number, height: number, root: UiElement[]): UiTree =>
  ({ source, screen: { width, height }, root, capturedAt: '2026-11-04T00:00:00.000Z' });
const ocr = (width: number, height: number, rows: [string, ...Box][]): UiTree =>
  tree('ocr', width, height, rows.map(([t, ...b]) => el('Text', t, b as Box, { clickable: true, enabled: true })));

/** Settings › Developer on an iPhone 17 Pro simulator, iOS 26.5 (cleaned /ui tree, trimmed): the "Dark Appearance"
 *  and "Enable UI Automation" rows are empty Groups — no text, no switch (blind run 4). */
const iosDeveloper = () => tree('accessibility', 1206, 2622, [
  el('Application', 'Settings', [0, 0, 1206, 2622], { children: [
    el('Group', undefined, [0, 186, 1206, 162], { id: 'Developer', children: [
      el('Button', 'Settings', [48, 186, 132, 132], { id: 'BackButton', clickable: true }),
      el('Heading', 'Developer', [481, 221, 243, 62]),
    ] }),
    el('Group', undefined, [0, 348, 1206, 2172], { children: [
      el('Group', undefined, [0, 0, 1206, 2622], { children: [
        el('ScrollArea', undefined, [60, 348, 1086, 9488], { children: [
          el('Group', undefined, [60, 514, 1086, 159], { id: 'UIAppearanceSettings' }),
          el('Button', 'View, Default', [60, 861, 1086, 159], { id: 'MAGNIFY', clickable: true, children: [
            el('StaticText', 'View', [108, 910, 111, 61]),
            el('StaticText', 'Default', [866, 910, 165, 61]),
          ] }),
          el('Group', undefined, [60, 1171, 1086, 1]),                       // separator
          el('Group', undefined, [60, 1705, 1086, 159], { id: 'UIAGroup.0' }),
        ] }),
        el('Heading', 'Appearance', [60, 348, 1086, 166]),
        el('Heading', 'Display Zoom', [60, 725, 1086, 136]),
        el('Slider', 'Vertical scroll bar, 5 pages', [1107, 348, 90, 2088], { value: '0%', clickable: true }),
      ] }),
    ] }),
  ] }),
]);
const iosDeveloperOcr = () => ocr(1206, 2622, [
  ['Developer', 481, 225, 243, 55],
  ['APPEARANCE', 108, 450, 260, 40],
  ['Dark Appearance', 102, 567, 408, 69],
  ['View', 108, 912, 111, 57],
  ['Default', 866, 912, 165, 57],
  ['Enable UI Automation', 103, 1758, 502, 69],
]);

/** Chrome on a Pixel emulator before its renderer exposed the page (blind run 5): one FrameLayout "Web View". */
const chromeEmpty = () => tree('accessibility', 1080, 2424, [
  el('FrameLayout', undefined, [0, 143, 1080, 2219], { id: 'android:id/content', children: [
    el('FrameLayout', undefined, [0, 143, 1080, 2219], { id: 'org.chromium.chrome:id/compositor_view_holder', children: [
      el('FrameLayout', undefined, [0, 143, 1080, 2219], { label: 'Web View', focused: true }),
    ] }),
    el('FrameLayout', undefined, [0, 143, 1080, 147], { id: 'org.chromium.chrome:id/toolbar', clickable: true, children: [
      el('EditText', 'example.com', [210, 151, 460, 131], { id: 'org.chromium.chrome:id/url_bar', clickable: true }),
      el('ImageButton', undefined, [828, 143, 126, 147], { label: 'See 1 tab', id: 'org.chromium.chrome:id/tab_switcher_button', clickable: true }),
    ] }),
  ] }),
  el('View', undefined, [0, 2361, 1080, 63], { id: 'android:id/navigationBarBackground' }),
]);
const chromeOcr = () => ocr(1080, 2424, [
  ['example.com', 230, 190, 300, 50],
  ['1', 880, 200, 20, 30],
  ['Example Domain', 63, 500, 600, 90],
  ['This domain is for use in documentation examples', 63, 700, 950, 60],
]);

test('partialRegions: empty iOS row Groups are gaps; separators, backgrounds and labelled groups are not', () => {
  const r = partialRegions(iosDeveloper());
  assert.deepEqual(r.map((e) => e.id), ['UIAppearanceSettings', 'UIAGroup.0']);
});

test('partialRegions: a complete tree and OCR trees have none (get_ui stays fast)', () => {
  const t = iosDeveloper();
  // fill the gaps: now nothing is missing
  const groups = flatten(t.root).filter((e) => e.id === 'UIAppearanceSettings' || e.id === 'UIAGroup.0');
  for (const g of groups) g.children = [el('Switch', 'Dark Appearance', [g.bounds.x, g.bounds.y, g.bounds.width, g.bounds.height], { clickable: true, checked: false })];
  assert.deepEqual(partialRegions(t), []);
  assert.deepEqual(partialRegions(iosDeveloperOcr()), []);
});

test('partialRegions: Chrome "Web View" with nothing inside is a gap; the nav bar background is not', () => {
  const r = partialRegions(chromeEmpty());
  assert.equal(r.length, 1);
  assert.equal(r[0].label, 'Web View');
  const full = chromeEmpty();
  flatten(full.root).find((e) => e.label === 'Web View')!.children = [el('TextView', 'Example Domain', [63, 500, 600, 90])];
  assert.deepEqual(partialRegions(full), []);
});

test('mergeOcr: adds only the text inside the gaps, as ocr children with fresh refs', () => {
  const t = iosDeveloper();
  const maxRef = Math.max(...flatten(t.root).map((e) => Number(e.ref.slice(1))));
  const { tree: m, merged } = mergeOcr(t, iosDeveloperOcr(), partialRegions(t));
  assert.equal(merged, 2);
  const added = flatten(m.root).filter((e) => e.ocr);
  assert.deepEqual(added.map((e) => e.text), ['Dark Appearance', 'Enable UI Automation']);
  assert.ok(added.every((e) => Number(e.ref.slice(1)) > maxRef), 'refs continue after the tree');
  assert.equal(new Set(flatten(m.root).map((e) => e.ref)).size, flatten(m.root).length, 'refs unique');
  const g = flatten(m.root).find((e) => e.id === 'UIAppearanceSettings')!;
  assert.equal(g.children?.[0].text, 'Dark Appearance');
  assert.equal(flatten(t.root).some((e) => e.ocr), false, 'input tree untouched');
  // the merged text is findable (tap by text / wait_for) with a ref
  const hit = findElements(m, { text: 'Dark Appearance' });
  assert.equal(hit[0]?.source, 'accessibility');
  assert.ok(hit[0]?.ref);
  // and listed in the text outline with [ocr]
  const txt = uiText({ ...m, ocr: { regions: [], merged, ms: 1 } });
  assert.match(txt, /Text "Dark Appearance" @\(306,602\) 408x69 \[ocr\]/);
  assert.match(txt, /# 2 text line\(s\) marked \[ocr\]/);
});

test('mergeOcr: web view text merged; toolbar text drawn over the web view frame skipped', () => {
  const t = chromeEmpty();
  const { tree: m, merged } = mergeOcr(t, chromeOcr(), partialRegions(t));
  assert.equal(merged, 2);
  assert.deepEqual(flatten(m.root).filter((e) => e.ocr).map((e) => e.text), ['Example Domain', 'This domain is for use in documentation examples']);
});

test('mergeOcr: scales OCR boxes from a smaller screenshot; nothing to merge leaves the tree as is', () => {
  const t = iosDeveloper();
  const half = ocr(603, 1311, [['Dark Appearance', 51, 283, 204, 35]]);
  const { tree: m, merged } = mergeOcr(t, half, partialRegions(t));
  assert.equal(merged, 1);
  const e = flatten(m.root).find((x) => x.ocr)!;
  assert.deepEqual(e.bounds, { x: 102, y: 566, width: 408, height: 70 });
  const none = mergeOcr(t, ocr(1206, 2622, [['Display Zoom', 108, 760, 300, 60]]), partialRegions(t));
  assert.equal(none.merged, 0);
  assert.equal(none.tree, t);
});

test('placeholder: shown separately from the value; empty fields say so; find matches the hint', () => {
  const t = tree('accessibility', 1080, 2424, [
    el('EditText', undefined, [63, 338, 954, 118], { id: 'dev.phonedock.sample:id/nameField', placeholder: 'Your name', clickable: true }),
    el('EditText', 'Ada', [63, 500, 954, 118], { id: 'dev.phonedock.sample:id/other', placeholder: 'Nickname', clickable: true }),
  ]);
  const txt = uiText(t);
  assert.match(txt, /EditText id=nameField placeholder="Your name" \(empty\) @/);
  assert.match(txt, /EditText "Ada" id=other placeholder="Nickname" @/);
  const m = findElements(t, { text: 'Your name', editable: true });
  assert.equal(m[0]?.id, 'dev.phonedock.sample:id/nameField');
  assert.equal(m[0]?.placeholder, 'Your name');
  assert.equal(m[0]?.text, undefined);
});

test('coarseWhere: a point in words', () => {
  assert.equal(coarseWhere(663, 1992, 1080, 2424), 'near the bottom');
  assert.equal(coarseWhere(900, 100, 1080, 2424), 'near the top right');
  assert.equal(coarseWhere(10, 1200, 1080, 2424), 'near the left');
  assert.equal(coarseWhere(540, 1200, 1080, 2424), 'in the middle');
  assert.equal(coarseWhere(540, 50, 1080, 2424), 'near the top');
  assert.equal(coarseWhere(5, 5, 0, 0), undefined);
});
test('labelAt: the smallest labelled element under the point', () => {
  const t = tree('accessibility', 1080, 2424, [el('Window', 'Settings', [0, 0, 1080, 2424], { children: [el('Button', 'Wi-Fi', [0, 300, 1080, 200])] })]);
  assert.equal(labelAt(t, 500, 400), 'Wi-Fi');
  assert.equal(labelAt(t, 500, 1500), 'Settings');
  assert.equal(labelAt(t, 5000, 5000), undefined);
});

// H1 (blind test round 2): agents read `id=nameField` in get_ui and passed it as fill's target; the "Screen now" line
// of the error had no ids. The fill route takes an exact id (findElements id/exact); the summary names them.
test('screenSummary names ids (fields always, short app ids elsewhere); an exact id finds the field', () => {
  const t = tree('accessibility', 1080, 2424, [
    el('EditText', undefined, [63, 338, 954, 118], { id: 'dev.phonedock.sample:id/nameField', placeholder: 'Your name', clickable: true }),
    el('Button', 'Greet', [63, 488, 231, 126], { id: 'dev.phonedock.sample:id/greetButton', clickable: true }),
    el('Button', 'General', [48, 900, 984, 156], { id: 'com.apple.settings.general', clickable: true }),
  ]);
  const s = screenSummary(t);
  assert.match(s, /EditText "Your name" id=nameField/);
  assert.match(s, /Button "Greet" id=greetButton/);
  assert.match(s, /Button "General"(,|$)/);   // a long reverse-DNS id would drown the line
  assert.equal(findElements(t, { text: 'nameField', editable: true }).length, 0);
  assert.equal(findElements(t, { id: 'nameField', match: 'exact', editable: true })[0]?.id, 'dev.phonedock.sample:id/nameField');
});

// M3 (blind test round 2, run 4): in iOS 26 Settings the "Developer" row sat under the floating Search field; the tree
// listed it, the tap at its centre hit the search bar, and nothing happened.
test('floatingBars / uncoveredPoint: a row under the iOS floating search field is tapped above it, or flagged hidden', () => {
  const rows = [['Apps', 2140], ['Wallet', 2300], ['Developer', 2400]] as const;
  const t = tree('accessibility', 1206, 2622, [el('Application', 'Settings', [0, 0, 1206, 2622], { children: [
    ...rows.map(([r, y]) => el('Button', r, [48, y, 1110, 156], { clickable: true })),
    el('TextField', undefined, [100, 2420, 1006, 132], { label: 'Search', clickable: true, children: [el('Button', 'Dictate', [1000, 2450, 66, 72])] }),
  ] })]);
  const bars = floatingBars(t);
  assert.equal(bars.length, 1);
  assert.equal(bars[0]!.name, 'the floating "Search" field');
  const at = (text: string) => findElements(t, { text, match: 'exact' })[0]!;
  assert.deepEqual([at('Apps').center, at('Apps').coveredBy, at('Apps').visible], [{ x: 603, y: 2218 }, undefined, true]);
  assert.deepEqual([at('Wallet').center, at('Wallet').coveredBy, at('Wallet').visible], [{ x: 603, y: 2334 }, 'the floating "Search" field', true]);
  assert.equal(at('Developer').coveredBy, 'the floating "Search" field');
  assert.equal(at('Developer').visible, false);
  // the field itself and its Dictate button are part of the bar: tapped where they are
  assert.deepEqual(uncoveredPoint(at('Dictate') as never, { x: 1033, y: 2486 }, bars), { x: 1033, y: 2486 });
  // Android trees (no Application root) have no floating bars
  assert.equal(floatingBars(tree('accessibility', 1080, 2424, [el('EditText', 'Search', [63, 2200, 954, 118])])).length, 0);
});
