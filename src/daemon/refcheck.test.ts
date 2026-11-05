// Tap by ref checked against a fresh read (refcheck.ts, runAction in routes.ts), on a fake backend: unchanged → the
// old point; moved → the new point, reported; gone or ambiguous → stale_ref and no tap; the keyboard-closed Instagram
// case (a Like heart now under the old "Post" point); look-alikes told apart by their row; reads reused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend, InputAction, UiElement, UiTree } from '../core/types.ts';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-refcheck-'));   // observe.ts notes screens under it
const { lastActionAt, uiCache } = await import('./core.ts');
const { runAction } = await import('./routes.ts');
const { readUiTree } = await import('./find.ts');
const { identity, relocateRef, tolerance } = await import('./refcheck.ts');

// ── trees ────────────────────────────────────────────────────────────────────
type Box = [x: number, y: number, w: number, h: number];
let n = 0;   // refs count up across trees, so a new read numbers its elements differently, as backends do
function el(type: string, text: string | undefined, b: Box, extra: Partial<UiElement> = {}): UiElement {
  return { ref: `e${++n}`, type, bounds: { x: b[0], y: b[1], width: b[2], height: b[3] }, ...(text !== undefined ? { text } : {}), ...extra };
}
const W = 1080, H = 2400;
const tree = (kids: UiElement[], agoMs = 5000): UiTree => ({
  source: 'accessibility', screen: { width: W, height: H },
  root: [el('android.widget.FrameLayout', undefined, [0, 0, W, H], { children: kids })], capturedAt: new Date(Date.now() - agoMs).toISOString(),
});
const all = (t: UiTree) => { const out: UiElement[] = []; const walk = (es: UiElement[]) => { for (const e of es) { out.push(e); if (e.children) walk(e.children); } }; walk(t.root); return out; };
const refOf = (t: UiTree, pred: (e: UiElement) => boolean) => { const e = all(t).find(pred); assert.ok(e, 'element in tree'); return e.ref; };

/** An Instagram comment row (200 px): author, comment, and a Like heart whose centre is (970, y + 90). */
const row = (y: number, author: string, comment: string) => el('android.view.ViewGroup', undefined, [0, y, W, 200], { children: [
  el('android.widget.TextView', author, [40, y + 20, 400, 50]),
  el('android.widget.TextView', comment, [40, y + 80, 800, 80]),
  el('android.widget.ImageView', undefined, [940, y + 60, 60, 60], { label: 'Like', clickable: true }),
] });
/** The comment box: the field and its "Post" button, whose centre is (970, y + 70). */
const composer = (y: number, typed = 'Nice shot!') => el('android.widget.LinearLayout', undefined, [0, y, W, 140], { children: [
  el('android.widget.EditText', typed, [40, y + 20, 820, 100], { id: 'com.instagram.android:id/comment_edittext', placeholder: 'Add a comment…' }),
  el('android.widget.TextView', 'Post', [900, y + 40, 140, 60], { id: 'com.instagram.android:id/post_button', clickable: true }),
] });
const PEOPLE = ['amy', 'bob', 'cat', 'dan', 'eve', 'fay', 'gus', 'hal', 'ivy', 'jon'];
const rows = (first: number, count: number, from = 0) => Array.from({ length: count }, (_v, i) => row(first + 200 * i, PEOPLE[from + i], `comment by ${PEOPLE[from + i]}`));
/** Keyboard up: six rows (y 80…1080) and the comment box right above the keyboard: Post at (970, 1370). */
const keyboardUp = (agoMs?: number) => tree([...rows(80, 6), composer(1300)], agoMs);
/** Keyboard closed: ten rows (y 80…1880), the comment box at the bottom (Post at (970, 2270)); the heart of row 7
 *  ("gus", y 1280) is at (970, 1370), where Post was. */
const keyboardClosed = (withPost = true) => tree([...rows(80, 10), withPost ? composer(2200) : el('android.widget.TextView', 'Add a comment…', [40, 2220, 820, 100])], 0);

// ── fake backend ───────────────────────────────────────────────────────────
interface Fake { b: Backend; taps: [number, number][]; reads: number; next: () => UiTree | Promise<UiTree>; hidden: number }
function fake(platform: 'ios' | 'android', next: () => UiTree | Promise<UiTree>, extra: Record<string, unknown> = {}): Fake {
  const f: Fake = { taps: [], reads: 0, next, hidden: 0, b: undefined as unknown as Backend };
  f.b = {
    id: 'fake-ref', displayName: 'Fake', platform, kind: 'virtual', capabilities: ['uiTree', 'tap'],
    available: async () => ({ ok: true }), listDevices: async () => [], screenshot: async () => Buffer.alloc(0),
    async uiTree() { f.reads++; return structuredClone(await f.next()); },
    async tap(_nid: string, x: number, y: number) { f.taps.push([x, y]); },
    swipe: async () => {}, type: async () => {}, key: async () => {},
    ...extra,
  } as unknown as Backend;
  return f;
}
let devN = 0;
/** A device with `cached` as the tree its client read (GET /ui), and a ref tap on it. */
function setup(cached: UiTree) { const id = `fake-ref:pdtest-${++devN}`; uiCache.set(id, cached); return id; }
const tap = (f: Fake, id: string, ref: string) => runAction(id, f.b, id.split(':')[1], { action: 'tap', ref } as InputAction) as Promise<Record<string, any>>;
const refused = async (p: Promise<unknown>) => {
  const e = await p.then(() => undefined, (x: unknown) => x) as { code?: string; status?: number; message?: string; detail?: string } | undefined;
  assert.ok(e, 'expected stale_ref, but the tap went through');
  assert.equal(e.code, 'stale_ref'); assert.equal(e.status, 409);
  return e;
};

// ── the five cases ──────────────────────────────────────────────────────────
test('ref tap, screen unchanged: a fresh read finds it where it was and taps the old point', async () => {
  const cached = keyboardUp();
  const id = setup(cached);
  const f = fake('ios', () => keyboardUp(0));
  const r = await tap(f, id, refOf(cached, (e) => e.text === 'Post'));
  assert.equal(f.reads, 1);                       // checked against a new read…
  assert.deepEqual(f.taps, [[970, 1370]]);        // …and tapped where it was
  assert.equal(r.moved, undefined);
  assert.equal(r.element.text, 'Post');
  assert.equal(r.refCheck.via, 'read');
});

test('ref tap, element moved and only one like it: taps its new point and reports moved', async () => {
  const before = tree([el('Button', 'Wi-Fi', [0, 500, W, 120], { clickable: true }), el('Button', 'Bluetooth', [0, 620, W, 120], { clickable: true })]);
  const after = () => tree([el('Other', 'Update available', [0, 400, W, 300]), el('Button', 'Wi-Fi', [0, 800, W, 120], { clickable: true }), el('Button', 'Bluetooth', [0, 920, W, 120], { clickable: true })], 0);
  const id = setup(before);
  const f = fake('ios', after);
  const r = await tap(f, id, refOf(before, (e) => e.text === 'Wi-Fi'));
  assert.deepEqual(f.taps, [[540, 860]]);
  assert.deepEqual(r.moved, { from: { x: 540, y: 560 }, to: { x: 540, y: 860 } });
  assert.equal(r.x, 540); assert.equal(r.y, 860);
});

test('ref tap, element gone: stale_ref with what changed, and no tap', async () => {
  const before = tree([el('Button', 'Delete account', [0, 1000, W, 120], { clickable: true })]);
  const id = setup(before);
  const f = fake('ios', () => tree([el('Button', 'Sign out', [0, 1000, W, 120], { clickable: true })], 0));
  const e = await refused(tap(f, id, refOf(before, (x) => x.text === 'Delete account')));
  assert.deepEqual(f.taps, []);
  assert.match(e.message!, /screen changed since it was read, so PhoneDock didn't tap: read the screen again/);
  assert.match(e.detail!, /Button "Delete account" was @\(540,1060\).*not on screen now/);
  assert.match(e.detail!, /would now hit Button "Sign out"/);
});

test('ref tap, ambiguous (several like it, none at the old point): stale_ref and no tap', async () => {
  const before = tree([el('Button', 'Allow', [100, 1200, 880, 120], { clickable: true })]);
  const after = () => tree([el('Button', 'Allow', [100, 600, 880, 120], { clickable: true }), el('Button', 'Allow', [100, 1800, 880, 120], { clickable: true })], 0);
  const id = setup(before);
  const f = fake('ios', after);
  const e = await refused(tap(f, id, refOf(before, (x) => x.text === 'Allow')));
  assert.deepEqual(f.taps, []);
  assert.match(e.detail!, /2 elements like it are on screen now, none there: @\(540,660\), @\(540,1860\)/);
});

test('the Instagram bug: keyboard closed, a Like heart is now where Post was: Post is tapped where it is, never the heart', async () => {
  const cached = keyboardUp();
  const post = refOf(cached, (e) => e.text === 'Post');
  // the old point now holds gus's Like heart
  const heart = all(keyboardClosed()).find((e) => e.label === 'Like' && e.bounds.y === 1280 + 60)!;
  assert.deepEqual([heart.bounds.x + heart.bounds.width / 2, heart.bounds.y + heart.bounds.height / 2], [970, 1370]);

  const f = fake('android', () => keyboardClosed());
  const r = await tap(f, setup(cached), post);
  assert.deepEqual(f.taps, [[970, 2270]]);
  assert.deepEqual(r.moved, { from: { x: 970, y: 1370 }, to: { x: 970, y: 2270 } });

  // and when the comment box no longer shows Post at all: refused, nothing tapped (least of all the heart)
  const cached2 = keyboardUp();
  const g = fake('android', () => keyboardClosed(false));
  const e = await refused(tap(g, setup(cached2), refOf(cached2, (x) => x.text === 'Post')));
  assert.deepEqual(g.taps, []);
  assert.match(e.detail!, /TextView "Post".*not on screen now.*would now hit ImageView "Like"/s);
});

// ── look-alikes, keyboard, reuse, no tree ─────────────────────────────────────
test('look-alikes (a Like heart per comment): the heart at the old point belongs to another row, so it is not tapped', async () => {
  const before = tree(rows(80, 6));                                 // bob's heart: (970, 370)
  const bobHeart = refOf(before, (e) => e.label === 'Like' && e.bounds.y === 280 + 60);
  // a new comment pushed every row down by exactly one row: amy's heart is now at (970, 370), bob's at (970, 570)
  const shifted = () => tree([row(80, 'zed', 'first!'), ...rows(280, 6)], 0);
  const f = fake('ios', shifted);
  const r = await tap(f, setup(before), bobHeart);
  assert.deepEqual(f.taps, [[970, 570]]);
  assert.deepEqual(r.moved, { from: { x: 970, y: 370 }, to: { x: 970, y: 570 } });

  // bob's comment deleted: cat's heart now sits where bob's was, and it is just like bob's, but not bob's: refused
  const g = fake('ios', () => tree([row(80, 'amy', 'comment by amy'), ...rows(280, 4, 2)], 0));
  const before2 = tree(rows(80, 6));
  const e = await refused(tap(g, setup(before2), refOf(before2, (x) => x.label === 'Like' && x.bounds.y === 280 + 60)));
  assert.deepEqual(g.taps, []);
  assert.match(e.detail!, /next to .*"bob"/);
});

test('Android: hiding a keyboard that covers the element reads the screen again before the tap', async () => {
  const cached = keyboardUp();
  let hidden = false;
  const f = fake('android', () => (hidden ? keyboardClosed() : keyboardUp(0)), {
    shell: async () => ({ code: 0, stdout: hidden ? 'mInputShown=false' : 'mInputShown=true\nframe=[0,1300][1080,2400]', stderr: '' }),
    hideKeyboard: async () => { hidden = true; },
  });
  const r = await tap(f, setup(cached), refOf(cached, (e) => e.text === 'Post'));
  assert.equal(r.keyboardHidden, true);
  assert.equal(f.reads, 2);                         // once before hiding the keyboard, once after
  assert.deepEqual(f.taps, [[970, 2270]]);          // where Post went once the keyboard was down
  assert.deepEqual(r.moved, { from: { x: 970, y: 1370 }, to: { x: 970, y: 2270 } });
});

test('reads are reused: a tree under 300 ms old with no input since is trusted; a read in flight is joined', async () => {
  const young = keyboardUp(50);
  const f = fake('ios', () => keyboardUp(0));
  const r = await tap(f, setup(young), refOf(young, (e) => e.text === 'Post'));
  assert.equal(f.reads, 0); assert.equal(r.refCheck.via, 'recent'); assert.deepEqual(f.taps, [[970, 1370]]);

  // the same young tree, but an input came after it: read again
  const young2 = keyboardUp(50); const id2 = setup(young2); lastActionAt.set(id2, Date.now());
  const g = fake('ios', () => keyboardUp(0));
  assert.equal((await tap(g, id2, refOf(young2, (e) => e.text === 'Post'))).refCheck.via, 'read');
  assert.equal(g.reads, 1);

  // a read already running (another client's GET /ui): the check waits for it instead of starting its own
  const old = keyboardUp(); const id3 = setup(old);
  let release!: () => void; const gate = new Promise<void>((res) => { release = res; });
  const h = fake('ios', async () => { await gate; return keyboardUp(0); });
  const inflight = readUiTree({ id: id3, b: h.b, nid: id3.split(':')[1] });
  const pending = tap(h, id3, refOf(old, (e) => e.text === 'Post'));
  release();
  const r3 = await pending; await inflight;
  assert.equal(h.reads, 1); assert.equal(r3.refCheck.via, 'joined'); assert.deepEqual(h.taps, [[970, 1370]]);
});

test('no new read possible: a tree under 1.5 s old is tapped unchecked, an older one is refused', async () => {
  const failing = () => fake('ios', () => { throw new Error('WDA went away'); });
  const young = keyboardUp(800);
  const f = failing();
  const r = await tap(f, setup(young), refOf(young, (e) => e.text === 'Post'));
  assert.equal(r.refCheck.via, 'unchecked'); assert.deepEqual(f.taps, [[970, 1370]]);

  const old = keyboardUp(3000);
  const g = failing();
  const e = await refused(tap(g, setup(old), refOf(old, (x) => x.text === 'Post')));
  assert.deepEqual(g.taps, []);
  assert.match(e.detail!, /couldn't be read again.*WDA went away/);

  // the existing errors stay: no tree read, unknown ref
  await refused(tap(failing(), 'fake-ref:pdtest-never-read', 'e1'));
  await refused(tap(failing(), setup(keyboardUp(0)), 'e999999'));
});

// ── identity and tolerance (pure) ───────────────────────────────────────────
test('identity: a text field is the same field whatever was typed; a switch that flipped is not the same', () => {
  const a = el('android.widget.EditText', 'Nice', [0, 0, 100, 50], { id: 'x:id/f', placeholder: 'Add a comment…' });
  assert.equal(identity(a), identity({ ...a, text: 'Nice shot!' }));
  assert.notEqual(identity(a), identity({ ...a, placeholder: 'Search' }));
  const s = el('Switch', 'Wi-Fi', [0, 0, 100, 50], { checked: false });
  assert.notEqual(identity(s), identity({ ...s, checked: true }));
  assert.equal(identity(el('Text', 'Post ', [0, 0, 1, 1]), true), identity(el('Text', 'post', [0, 0, 1, 1]), true));   // OCR: text, case aside

  const before = tree([el('Switch', 'Wi-Fi', [0, 500, W, 120], { checked: false })]);
  const r = relocateRef(before, all(before)[1], tree([el('Switch', 'Wi-Fi', [0, 500, W, 120], { checked: true })], 0));
  assert.equal(r.ok, false);
});

test('tolerance: 2% of the shorter side, at least 8 px; a small shift is not a move', () => {
  assert.equal(tolerance({ width: 1080, height: 2400 }), 22);
  assert.equal(tolerance({ width: 300, height: 300 }), 8);
  assert.equal(tolerance(undefined), 8);
  const before = tree([el('Button', 'OK', [400, 1000, 280, 100])]);
  const small = relocateRef(before, all(before)[1], tree([el('Button', 'OK', [400, 1015, 280, 100])], 0));
  assert.ok(small.ok && !small.moved && small.y === 1065);   // within 22 px: tapped where it is now, not "moved"
  const far = relocateRef(before, all(before)[1], tree([el('Button', 'OK', [400, 1040, 280, 100])], 0));
  assert.ok(far.ok && far.moved);
});

test('OCR refs (no accessibility tree): matched by text in a new OCR read, in the old read\'s pixels', () => {
  const ocrTree = (w: number, h: number, lines: [string, ...Box][]): UiTree => ({ source: 'ocr', screen: { width: w, height: h },
    root: lines.map(([t, ...b]) => el('Text', t, b as Box, { label: t, clickable: true })), capturedAt: new Date(Date.now() - 4000).toISOString() });
  const before = ocrTree(1080, 2400, [['Settings', 40, 100, 300, 60], ['Post', 900, 1340, 140, 60]]);
  const post = before.root[1];
  // a half-size screenshot, Post moved down to (970, 2270) in full-size pixels
  const r = relocateRef(before, post, { ...ocrTree(540, 1200, [['Settings', 20, 50, 150, 30], ['post', 450, 1120, 70, 30]]), capturedAt: new Date().toISOString() });
  assert.ok(r.ok);
  assert.deepEqual(r.moved, { from: { x: 970, y: 1370 }, to: { x: 970, y: 2270 } });
  // two "Post" lines now, neither where it was: refused
  const two = relocateRef(before, post, ocrTree(1080, 2400, [['Post', 900, 400, 140, 60], ['Post', 900, 2240, 140, 60]]));
  assert.equal(two.ok, false);
});

test('look-alikes in a flat tree (an iPhone without WDA lists elements without rows): told apart by the words on their line', () => {
  const flat = (rowsAt: [number, string][], agoMs = 5000): UiTree => ({ source: 'accessibility', screen: { width: 1206, height: 2622, scale: 3 }, capturedAt: new Date(Date.now() - agoMs).toISOString(),
    root: [el('Application', 'Instagram', [0, 0, 1206, 2622], { children: rowsAt.flatMap(([y, who]) => [
      el('StaticText', who, [40, y, 300, 50]), el('StaticText', `comment by ${who}`, [40, y + 60, 900, 60]), el('Button', 'Like', [1100, y + 30, 66, 66], { clickable: true }),
    ]) })] });
  const before = flat([[300, 'amy'], [500, 'bob'], [700, 'cat']]);
  const bobLike = all(before).find((e) => e.text === 'Like' && e.bounds.y === 530)!;
  // a new comment on top: amy's Like is now where bob's was, bob's one row lower
  const r = relocateRef(before, bobLike, flat([[300, 'zed'], [500, 'amy'], [700, 'bob'], [900, 'cat']], 0));
  assert.ok(r.ok);
  assert.deepEqual(r.moved, { from: { x: 1133, y: 563 }, to: { x: 1133, y: 763 } });
  // bob's comment gone: refused, though a Like button (cat's) sits where his was
  assert.equal(relocateRef(before, bobLike, flat([[300, 'amy'], [500, 'cat']], 0)).ok, false);
});

test('expect on a ref tap reads the screen without replacing the tree the ref came from, and the check reuses that read', async () => {
  const { prepareExpect } = await import('./expect.ts');
  const numbered = (t: UiTree) => { let k = 0; const walk = (es: UiElement[]) => { for (const e of es) { e.ref = `e${++k}`; if (e.children) walk(e.children); } }; walk(t.root); return t; };
  const old = numbered(tree([el('Button', 'Cancel', [0, 2000, 500, 120]), el('Button', 'Delete', [540, 2000, 500, 120])], 20_000));
  // a "Saved" banner is now at the top: every element is numbered one later, so old "Delete"'s ref names "Cancel" now
  const now = () => numbered(tree([el('Other', 'Saved', [0, 100, W, 100]), el('Button', 'Cancel', [0, 2000, 500, 120]), el('Button', 'Delete', [540, 2000, 500, 120])], 0));
  const deleteRef = refOf(old, (e) => e.text === 'Delete');
  assert.equal(all(now()).find((e) => e.ref === deleteRef)?.text, 'Cancel');
  const id = setup(old);
  const f = fake('ios', now);
  await prepareExpect({ id, b: f.b, nid: id.split(':')[1] }, { changed: true });   // the tree is 20 s old: read again
  assert.equal(uiCache.get(id), old);
  const r = await tap(f, id, deleteRef);
  assert.equal(r.element.text, 'Delete'); assert.deepEqual(f.taps, [[790, 2060]]);
  assert.equal(f.reads, 1); assert.equal(r.refCheck.via, 'recent');
});
