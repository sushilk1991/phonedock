// uiautomator XML → UiElement: text fields' hint becomes `placeholder`, never the value (blind test finding 8).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseShowingHints, parseUiautomatorXml, rawToElements } from './android-common.ts';
import type { UiElement } from '../core/types.ts';

// Trimmed from a real API 36 dump of fixtures/android-sample (the platform dumper writes hint="…" on API 26+).
const field = (text: string, extra = '') =>
  `<node index="1" text="${text}" resource-id="dev.phonedock.sample:id/nameField" class="android.widget.EditText" package="dev.phonedock.sample" content-desc="" checkable="false" checked="false" clickable="true" enabled="true" focusable="true" focused="false" scrollable="false" long-clickable="true" password="false" selected="false" bounds="[63,338][1017,456]" drawing-order="2" hint="Your name" ${extra}/>`;
const page = (inner: string, hints?: string) =>
  `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0"><node index="0" text="" resource-id="dev.phonedock.sample:id/root" class="android.widget.ScrollView" package="dev.phonedock.sample" content-desc="" checkable="false" checked="false" clickable="false" enabled="true" focusable="true" focused="false" scrollable="true" long-clickable="false" password="false" selected="false" bounds="[0,0][1080,2424]">${inner}</node>${hints ?? ''}</hierarchy>`;
const parse = (xml: string): UiElement => {
  const els = rawToElements(parseUiautomatorXml(xml), parseShowingHints(xml));
  const all: UiElement[] = []; const walk = (l: UiElement[]) => { for (const e of l) { all.push(e); walk(e.children ?? []); } };
  walk(els);
  const f = all.find((e) => e.type === 'EditText');
  assert.ok(f, 'EditText parsed');
  return f;
};

test('empty field (helper reports the hint showing): no text, placeholder set', () => {
  const xml = page(field('Your name'), '<pd-hints><pd-hint bounds="[63,338][1017,456]"/></pd-hints>');
  assert.deepEqual(parseShowingHints(xml), [{ x: 63, y: 338, width: 954, height: 118 }]);
  const f = parse(xml);
  assert.equal(f.text, undefined);
  assert.equal(f.placeholder, 'Your name');
});

test('typed text equal to the hint stays text when the helper says no hint is showing', () => {
  const f = parse(page(field('Your name'), '<pd-hints></pd-hints>'));
  assert.equal(f.text, 'Your name');
  assert.equal(f.placeholder, 'Your name');
});

test('typed text: kept as text, hint still reported as placeholder', () => {
  const f = parse(page(field('Margaret Hamilton'), '<pd-hints></pd-hints>'));
  assert.equal(f.text, 'Margaret Hamilton');
  assert.equal(f.placeholder, 'Your name');
});

test('plain `uiautomator dump` (no helper hints): text equal to the hint is the hint', () => {
  const xml = page(field('Your name'));
  assert.equal(parseShowingHints(xml), undefined);
  const f = parse(xml);
  assert.equal(f.text, undefined);
  assert.equal(f.placeholder, 'Your name');
  assert.equal(parse(page(field('Ada'))).text, 'Ada');
});

test('fields without a hint attribute are unchanged (older dumps)', () => {
  const xml = page(field('Your name').replace(' hint="Your name"', ''));
  const f = parse(xml);
  assert.equal(f.text, 'Your name');
  assert.equal(f.placeholder, undefined);
});
