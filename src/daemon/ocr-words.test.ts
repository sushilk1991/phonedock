// Word-level OCR targets: a text query that matches part of an OCR line taps the matched words, not the line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ocrTreeFromItems, ocrWords, type OcrItem } from '../core/ocr.ts';
import { cleanTree, findElements, matchSpan, wordSpanBounds } from './media.ts';

/** tools/pd-ocr.swift (accurate) on a 1200x400 test image: three lines, system font 44 pt. */
const ITEMS: OcrItem[] = [
  { text: 'I agree to the Terms and Privacy Policy', confidence: 1, x: 36, y: 50, width: 718, height: 40, words: [
    { text: 'I', x: 36, y: 50, width: 15, height: 40 }, { text: 'agree', x: 56, y: 50, width: 105, height: 40 },
    { text: 'to', x: 166, y: 50, width: 45, height: 40 }, { text: 'the', x: 216, y: 50, width: 65, height: 40 },
    { text: 'Terms', x: 286, y: 50, width: 115, height: 40 }, { text: 'and', x: 406, y: 50, width: 80, height: 40 },
    { text: 'Privacy', x: 491, y: 50, width: 140, height: 40 }, { text: 'Policy', x: 636, y: 50, width: 118, height: 40 },
  ] },
  { text: 'Code: X7QK-2B9Z @sushil_k1991', confidence: 1, x: 40, y: 151, width: 661, height: 57, words: [
    { text: 'Code:', x: 40, y: 151, width: 112, height: 49 }, { text: 'X7QK-2B9Z', x: 157, y: 152, width: 247, height: 50 },
    { text: '@sushil_k1991', x: 410, y: 156, width: 291, height: 52 },
  ] },
  { text: 'Interest in Terms', confidence: 1, x: 40, y: 270, width: 400, height: 40, words: [
    { text: 'Interest', x: 40, y: 270, width: 170, height: 40 }, { text: 'in', x: 215, y: 270, width: 40, height: 40 },
    { text: 'Terms', x: 260, y: 270, width: 180, height: 40 },
  ] },
  // a helper built before word boxes: lines only
  { text: 'Forgot your password?', confidence: 1, x: 40, y: 340, width: 420, height: 40 },
  { text: 'Continue', confidence: 1, x: 500, y: 340, width: 160, height: 40 },
  { text: 'faint ghost text', confidence: 0.1, x: 700, y: 340, width: 300, height: 40, words: [
    { text: 'faint', x: 700, y: 340, width: 90, height: 40 }, { text: 'ghost', x: 795, y: 340, width: 100, height: 40 },
  ] },
];
const tree = () => ocrTreeFromItems(ITEMS, { width: 1200, height: 400 });
const first = (text: string, match?: 'contains' | 'exact' | 'regex') => findElements(tree(), { text, match })[0];

test('a word inside a longer line: the word\'s centre, the line\'s bounds', () => {
  const m = first('Terms');
  assert.equal(m.text, 'I agree to the Terms and Privacy Policy');
  assert.deepEqual(m.center, { x: 344, y: 70 }, 'centre of "Terms" (286..401), not of the line (395)');
  assert.deepEqual(m.bounds, { x: 36, y: 50, width: 718, height: 40 }, 'bounds stay the line');
  assert.equal(m.exact, false);
  assert.equal(m.source, 'ocr');
  assert.equal(m.ref, undefined);
});

test('several words: the centre of all of them', () => {
  assert.deepEqual(first('Privacy Policy').center, { x: 623, y: 70 });   // 491..754
  assert.deepEqual(first('privacy   POLICY').center, { x: 623, y: 70 }, 'case and spacing as for matching');
});

test('part of a word: that word', () => {
  assert.deepEqual(first('Term').center, { x: 344, y: 70 });
  assert.deepEqual(first('ivac').center, { x: 561, y: 70 });
});

test('the whole line keeps the line centre', () => {
  const line = 'I agree to the Terms and Privacy Policy';
  assert.deepEqual(first(line).center, { x: 395, y: 70 });
  assert.equal(first(line).exact, true);
  assert.deepEqual(first(line.toUpperCase()).center, { x: 395, y: 70 });
  assert.deepEqual(first(line, 'exact').center, { x: 395, y: 70 });
});

test('codes and handles are words too', () => {
  assert.deepEqual(first('X7QK-2B9Z').center, { x: 281, y: 177 });
  assert.deepEqual(first('@sushil_k1991').center, { x: 556, y: 182 });
  assert.deepEqual(first('sushil').center, { x: 556, y: 182 });
});

test('a whole-word hit beats an earlier hit inside a word', () => {
  const m = findElements(tree(), { text: 'in' }).find((x) => x.text === 'Interest in Terms')!;
  assert.deepEqual(m.center, { x: 235, y: 290 }, '"in", not the start of "Interest"');
  assert.deepEqual(first('inter').center, { x: 125, y: 290 }, 'no whole-word hit: the first one');
});

test('regex: the words its first match covers', () => {
  assert.deepEqual(first('priv\\w+', 'regex').center, { x: 561, y: 70 });
  assert.deepEqual(first('^I agree.*Policy$', 'regex').center, { x: 395, y: 70 });
});

test('no word boxes (older helper): the line centre, as before', () => {
  assert.deepEqual(first('password').center, { x: 250, y: 360 });
});

test('low-confidence lines are dropped; words ride along only on the tree\'s own elements', () => {
  const t = tree();
  assert.equal(t.root.some((e) => e.text === 'faint ghost text'), false);
  assert.equal(ocrWords(t.root[0])?.length, 8);
  assert.equal(ocrWords(t.root[3]), undefined);
  assert.equal(JSON.stringify(t).includes('"words"'), false, '/ui JSON is unchanged');
  assert.deepEqual(findElements(cleanTree(t), { text: 'Terms' })[0].center, { x: 395, y: 70 }, 'a copy has no words: line centre');
});

test('matchSpan / wordSpanBounds edge cases', () => {
  assert.deepEqual(matchSpan('Read the  Terms.', 'terms'), [9, 14], 'spaces collapsed, punctuation is a boundary');
  assert.equal(matchSpan('Terms', 'Privacy'), undefined);
  assert.equal(matchSpan('Terms', '(', 'regex'), undefined, 'bad regex: no span');
  assert.equal(matchSpan('Terms', 'x*', 'regex'), undefined, 'empty matches only: no span');
  const words = [{ text: 'Hello', x: 0, y: 0, width: 50, height: 20 }, { text: '??', x: 55, y: 0, width: 10, height: 20 }, { text: 'World', x: 70, y: 0, width: 50, height: 20 }];
  assert.deepEqual(wordSpanBounds('Hello World', words, [6, 11]), { x: 70, y: 0, width: 50, height: 20 }, 'a word OCR did not keep in the line is skipped');
  assert.equal(wordSpanBounds('Hello World', [], [0, 5]), undefined);
});

test('word boxes outside the line are not trusted', () => {
  const t = ocrTreeFromItems([{ text: 'Sign in now', confidence: 1, x: 100, y: 100, width: 300, height: 40, words: [
    { text: 'Sign', x: 100, y: 100, width: 80, height: 40 }, { text: 'in', x: 900, y: 600, width: 40, height: 40 }, { text: 'now', x: 300, y: 100, width: 100, height: 40 },
  ] }], { width: 1200, height: 800 });
  assert.deepEqual(findElements(t, { text: 'in' })[0].center, { x: 250, y: 120 });
});
