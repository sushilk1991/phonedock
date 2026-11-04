// v0.2 daemon routes (find/wait/fill, handoff, crashes, recording, app data, foreground app, keyboard). Registered
// onto the shared router; imported by main.ts after routes.ts. Helpers `dev`/`need`/`num`/`truthy` come from routes.ts.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { sleep } from '../core/exec.ts';
import { stateDir } from '../core/paths.ts';
import { PhoneDockError, type Appearance, type Backend, type ElementMatch, type HandoffState, type PromptButton, type SystemPrompt, type UiElement, type UiTree } from '../core/types.ts';
import { chooseButton, describePrompt, detectPrompt, type AlertAction } from '../core/prompts.ts';
import {
  checkLease, createHandoff, emit, getDevice, getHandoff, listHandoffs, logAction, recordings, resolveHandoff, safeId,
  stopRecordingFor, uiCache, waitHandoff,
} from './core.ts';
import { badRequest, notSupported, type Ctx } from './http.ts';
import {
  center, diffThumbs, findElements, findRef, flatten, focusedElement, grayThumb, isEditable, keyboardInfo,
  nearestEditable, pngSize, screenSummary, toMatch, truncateCrash, unionBounds, type Thumb,
} from './media.ts';
import { router as r, dev, need, num, truthy } from './routes.ts';
import { canScroll, contentItems, contentMoved, contentSignature, lookFromFinger, pickContainer, swipeFor, type ContentItem, type LookDir, type Swipe } from './scroll.ts';
import { imeShownFrom } from '../backends/android-common.ts';
import { observeScrollTo, observeWait } from './observe.ts';
import { axTree, describe, findOnce, ocrTree, parseFind, pollFind, queryText, type Dev } from './find.ts';
import { finishExpect, prepareExpect } from './expect.ts';
import { inputRoute } from './delivery.ts';

// ── shared: trees, find, focus (find.ts) ─────────────────────────────────────
r.post('/v1/devices/:id/find', async (c) => {
  const d = dev(c);
  const body = await c.body();
  const q = parseFind(body);
  const index = Math.max(0, Math.floor(Number(body.index ?? 0)) || 0);
  const limit = Math.max(1, Math.min(Number(body.limit ?? 20) || 20, 200));
  const { tree, matches, ocrTried, ocrError } = await findOnce(d, q);
  // no match: what is on screen, and whether scrolling could reveal more (true / false / null = can't tell)
  const miss = matches.length <= index ? { summary: screenSummary(tree), scrollable: canScroll(tree, (await getDevice(d.id)).platform) } : {};
  return {
    source: tree.source, total: matches.length, index, match: matches[index] ?? null, matches: matches.slice(0, limit),
    screen: tree.screen, capturedAt: tree.capturedAt, ocrTried, ...(ocrError ? { ocrError } : {}), ...miss,
  };
});

interface FocusState { known: boolean; focused: ElementMatch | null; keyboard: boolean; tree?: UiTree; reason?: string }
/** Focus from the tree: the focused element (Android marks it; WDA trees too), else the software keyboard. iOS
 *  simulator trees (AXe) never mark focus, so with no keyboard on screen — a hardware keyboard is connected, or the
 *  keyboard is still sliding in — focus is unknown, not "nothing focused". */
async function focusState(d: Dev, platform?: string): Promise<FocusState> {
  let tree: UiTree | undefined;
  try { tree = await axTree(d); } catch { return { known: false, focused: null, keyboard: false, reason: 'no accessibility tree' }; }
  if (!tree) return { known: false, focused: null, keyboard: false, reason: 'no accessibility tree' };
  const f = focusedElement(tree);
  const keyboard = keyboardInfo(tree).visible;
  const marksFocus = platform !== 'ios' || flatten(tree.root).some((e) => e.focused !== undefined);
  if (!f && !keyboard && !marksFocus) return { known: false, focused: null, keyboard, tree, reason: 'this device does not report focus and no on-screen keyboard is up (hardware keyboard?)' };
  return { known: true, focused: f ? toMatch(f, tree) : null, keyboard, tree };
}
/** Poll until something editable is focused or a software keyboard is up (or waitMs passes). */
async function waitFocus(d: Dev, waitMs: number, interval = 250, platform?: string): Promise<FocusState & { elapsedMs: number; ok: boolean }> {
  const t0 = Date.now(); let s: FocusState;
  for (;;) {
    s = await focusState(d, platform);
    const ok = !!(s.keyboard || (s.focused && (s.focused.editable || s.focused.focused)));
    // unknown because the tree is missing: give up at once; unknown because focus isn't reported: keep polling for a
    // keyboard until waitMs (it may still be animating in)
    if (ok || (!s.known && !s.tree) || Date.now() - t0 >= waitMs) return { ...s, ok, elapsedMs: Date.now() - t0 };
    await sleep(interval);
  }
}
r.get('/v1/devices/:id/focus', async (c) => {
  const d = dev(c);
  const platform = (await getDevice(d.id).catch(() => undefined))?.platform;
  const s = await waitFocus(d, Math.max(0, Math.min(num(c.q('waitMs'), 0)!, 10_000)), 250, platform);
  return { known: s.known, ok: s.ok, focused: s.focused, keyboard: s.keyboard, elapsedMs: s.elapsedMs, ...(s.reason ? { reason: s.reason } : {}) };
});

// ── wait ────────────────────────────────────────────────────────────────────
r.post('/v1/devices/:id/wait', observeWait(async (c) => {
  const d = dev(c);
  const body = await c.body();
  const until = String(body.until ?? '');
  if (!['visible', 'gone', 'idle'].includes(until)) throw badRequest('until must be visible | gone | idle');
  const timeoutMs = Math.max(0, Math.min(Number(body.timeoutMs ?? 10_000) || 0, 300_000));
  const intervalMs = Math.max(50, Math.min(Number(body.intervalMs ?? (until === 'idle' ? 200 : 300)) || 300, 10_000));
  const stableMs = Math.max(0, Math.min(Number(body.stableMs ?? (until === 'idle' ? 1000 : 0)) || 0, 60_000));
  let closed = false; c.res.on('close', () => { closed = true; });
  const t0 = Date.now(); const deadline = t0 + timeoutMs;
  const gone = () => new PhoneDockError('The client disconnected', 'aborted', 499);

  if (until === 'idle') {
    let prev: Thumb | undefined; let lastChange = 0; let region: UiElement['bounds'] | undefined; let frames = 0; let changes = 0; let lastRegion: UiElement['bounds'] | undefined;
    for (;;) {
      if (closed) throw gone();
      const at = Date.now();
      const th = await grayThumb(await d.b.screenshot(d.nid), 64);
      frames++;
      if (!prev) lastChange = at;
      else {
        const df = diffThumbs(prev, th);
        if (df.changed) { lastChange = at; changes++; region = unionBounds(region, df.region); lastRegion = df.region; }
      }
      prev = th;
      const now = Date.now();
      if (frames >= 2 && at - lastChange >= stableMs) {
        return { ok: true, until, elapsedMs: now - t0, frames, changes, stableMs, changedRegion: region ?? null };
      }
      if (now >= deadline) {
        let summary = ''; try { const t = await axTree(d); if (t) summary = screenSummary(t); } catch { /* */ }
        throw new PhoneDockError('The screen did not stay still in time', 'wait_timeout', 408, ['Wait for an element instead, or allow more time.'], [
          `Timed out after ${now - t0} ms: the screen never stayed still for ${stableMs} ms`,
          lastRegion ? `Still changing in region x=${lastRegion.x} y=${lastRegion.y} ${lastRegion.width}x${lastRegion.height} (device px); ${changes} changes in ${frames} frames` : `${changes} changes in ${frames} frames`,
          ...(summary ? [`Screen now: ${summary}`] : []),
          'Animations/videos/spinners never go idle: wait for an element (until="visible"/"gone") instead, or lower stableMs',
        ].join('\n'));
      }
      await sleep(Math.max(0, intervalMs - (Date.now() - at)));
    }
  }

  const q = parseFind(body);
  const p = await pollFind(d, q, until as 'visible' | 'gone', { timeoutMs, intervalMs, stableMs, aborted: () => closed, abortError: gone });
  const last = p.last; const vis = p.visible;
  if (p.ok) return { ok: true, until, elapsedMs: Date.now() - t0, polls: p.polls, source: last.tree.source, ...(until === 'visible' ? { match: vis[0], matches: vis.slice(0, 5) } : {}) };
  const hidden = last.matches.filter((m) => !m.visible);
  const hints = [`Screen now (${last.tree.source}): ${screenSummary(last.tree)}`];
  if (until === 'visible' && hidden.length) hints.unshift(`${hidden.length} match(es) exist but are not visible (off-screen or under the keyboard): ${hidden.slice(0, 3).map(describe).join('; ')}`);
  if (until === 'gone') hints.unshift(`Still visible: ${vis.slice(0, 3).map(describe).join('; ')}`);
  if (last.ocrError) hints.push(`The OCR fallback failed, so only the accessibility tree was searched: ${last.ocrError.split('\n')[0]}`);
  throw new PhoneDockError('The screen did not reach the requested state in time', 'wait_timeout', 408, ['Check the screen and try again.'], [`Timed out after ${Date.now() - t0} ms waiting for ${queryText(q)} to be ${until} (${p.polls} polls)`, ...hints].join('\n'));
}));

// ── fill ────────────────────────────────────────────────────────────────────
const mask = (s: string | undefined, secret: boolean) => (s === undefined ? undefined : secret ? '•'.repeat(Math.min([...s].length, 12)) : s);

/** Re-locate a field in a fresh tree: same id, else the editable element nearest the old centre. */
function relocate(tree: UiTree, el: ElementMatch): UiElement | undefined {
  const all = flatten(tree.root);
  if (el.id) { const byId = all.filter((e) => e.id === el.id); if (byId.length === 1) return byId[0]; }
  let best: { e: UiElement; d: number } | undefined;
  for (const e of all) {
    if (!isEditable(e) && e.type !== el.type) continue;
    const c = center(e); const dd = Math.hypot(c.x - el.center.x, c.y - el.center.y);
    if (dd < Math.max(40, el.bounds.height) && (!best || dd < best.d)) best = { e, d: dd };
  }
  if (best) return best.e;
  // The frame moved (keyboard pushed the page, the field grew): same name, else the only focused text field.
  const name = (e: { label?: string; placeholder?: string }) => e.label || e.placeholder;
  const wanted = name(el);
  if (wanted) { const byName = all.filter((e) => isEditable(e) && name(e) === wanted); if (byName.length === 1) return byName[0]; }
  const focused = all.filter((e) => isEditable(e) && e.focused);
  return focused.length === 1 ? focused[0] : undefined;
}
const fieldValue = (e: UiElement | undefined) => (e ? (e.value ?? (isEditable(e) ? e.text : undefined) ?? '') : undefined);
// iOS reports an empty field's placeholder as its value. Learned per field when a reliable clear leaves it unchanged.
const placeholders = new Map<string, string>();
const fieldKey = (deviceId: string, f: ElementMatch) => `${deviceId}|${f.id ?? `${f.type}@${f.bounds.x},${f.bounds.y},${f.bounds.width}`}`;
// iOS simulators whose software keyboard stays hidden (AXe's HID typing makes the simulator assume a hardware keyboard,
// stickily). Learned when a fill typed and verified with no keyboard up; forgotten when a software keyboard shows.
// For them fill doesn't wait 2 s for a keyboard that never comes, and clears with Cmd+A instead of a delete per char.
const hwKeyboard = new Set<string>();

r.post('/v1/devices/:id/fill', inputRoute(async (c) => {
  const d = dev(c);
  checkLease(d.id, c.owner);
  const body = await c.body();
  if (typeof body.value !== 'string') throw badRequest('value (string) required');
  const exp = await prepareExpect(d, body.expect);
  const value: string = body.value;
  const clear = body.clear !== false; const submit = !!body.submit; const secret = !!body.secret;
  const t0 = Date.now(); const warnings: string[] = [];
  const device = await getDevice(d.id);
  const ios = device.platform === 'ios'; const android = device.platform === 'android';
  const log = (a: unknown, extra?: Record<string, unknown>) => logAction(d.id, c.owner, a, { via: 'fill', ...extra });

  // 1. resolve the field
  let field: ElementMatch | undefined; let label: ElementMatch | undefined; let via: string;
  let tree: UiTree | undefined;
  if (body.ref) {
    via = 'ref';
    tree = uiCache.get(d.id);
    if (!tree) throw new PhoneDockError("The screen information is out of date", 'stale_ref', 409, ["Refresh the screen information and try again."], `No UI tree cached for ${d.id}; call /ui or /find first`);
    const e = findRef(tree, String(body.ref).replace(/^@/, ''));
    if (!e) throw new PhoneDockError("The screen reference is out of date", 'stale_ref', 409, ["Refresh the screen information and try again."], [`Unknown ref ${body.ref}`, ...['Refs are only valid until the next /ui call; fetch /ui again']].filter(Boolean).join('\n'));
    field = toMatch(e, tree);
  } else if (Number.isFinite(body.x) && Number.isFinite(body.y)) {
    via = 'point';
  } else {
    via = body.id ? 'id' : 'text';
    const q = { ...parseFind(body), editable: true };
    const f = await findOnce(d, q);
    tree = f.tree;
    const idx = Math.max(0, Math.floor(Number(body.index ?? 0)) || 0);
    let m = f.matches[idx];
    // get_ui prints ids (`id=nameField`) and agents pass them as the target: an exact id match is that field
    if (!m && q.text && !q.id && /^[\w.:/-]+$/.test(q.text)) {
      const byId = findElements(f.tree, { id: q.text, match: 'exact', type: q.type, editable: true });
      if (byId[idx]) { m = byId[idx]; via = 'id'; }
    }
    if (!m) {
      const fields = flatten(f.tree.root).filter((e) => isEditable(e) && e.bounds.width > 0).slice(0, 5);
      const how = (e: UiElement) => `${describe(e)} → target="${e.ref}"${e.id ? ` or target="id:${e.id.replace(/^.*:id\//, '')}"` : ''}`;
      throw new PhoneDockError('No matching field was found', 'not_found', 404,
        fields.length ? [`Text fields on screen: ${fields.map(how).join('; ')}`, 'target matches a field\'s text, placeholder or label, or an exact id; refs look like "e12" and ids can also be written "id:<id>".'] : ['No text field is on screen: check the screen and try again.'],
        `No field matches ${queryText(q)}${idx ? ` at index ${idx}` : ''}\nScreen now (${f.tree.source}): ${screenSummary(f.tree)}`);
    }
    if (!m.editable && m.source === 'accessibility') {
      const near = nearestEditable(f.tree, m);
      if (near) { label = m; field = near; } else { field = m; warnings.push(`${describe(m)} is not a text field; tapping it anyway`); }
    } else field = m;
  }

  // 2. tap it (iOS: near the right end so the caret lands after the existing text)
  let tx: number, ty: number;
  if (field) {
    tx = field.center.x; ty = field.center.y;
    if (ios && field.editable && tree) {
      // Stay left of any control inside the field's right half (search fields put a "Dictate" mic or a clear button
      // there; their touch area is wider than their frame — run 4b's fill opened "Enable Dictation?" instead).
      const fb = field.bounds;
      const inner = flatten(tree.root).filter((e) => e.ref !== field!.ref && !isEditable(e) && (e.clickable || /Button$/.test(String(e.type))) && e.bounds.width < fb.width * 0.5
        && center(e).x > field!.center.x && center(e).x < fb.x + fb.width && center(e).y >= fb.y && center(e).y < fb.y + fb.height);
      const right = Math.min(fb.x + fb.width, ...inner.map((e) => e.bounds.x - Math.max(24, e.bounds.width * 0.5)));
      const cand = Math.round(right - Math.max(6, Math.min(30, fb.width * 0.06)));
      if (cand > field.center.x) tx = cand;
    }
  } else { tx = Math.round(Number(body.x)); ty = Math.round(Number(body.y)); }
  await d.b.tap(d.nid, tx, ty);
  // `fill`: what was asked for, so `flow save` can write one fill step (src/core/flow.ts). Never the secret itself.
  const asked = { ...(body.text ? { text: String(body.text) } : {}), ...(body.id ? { id: String(body.id) } : {}), ...(body.type ? { type: String(body.type) } : {}),
    ...(body.match && body.match !== 'contains' ? { match: String(body.match) } : {}), ...(Number(body.index) > 0 ? { index: Math.floor(Number(body.index)) } : {}),
    ...(via === 'ref' ? { ref: true } : {}), ...(via === 'point' ? { point: true } : {}),
    ...(secret ? { secret: true, length: [...value].length } : { value }), ...(submit ? { submit: true } : {}), ...(clear ? {} : { clear: false }) };
  log({ action: 'tap', x: tx, y: ty }, { ...(field ? { resolved: { ref: field.ref, element: { type: field.type, text: field.text, label: field.label, id: field.id, placeholder: field.placeholder } } } : {}), fill: asked });

  // 3. wait up to 2 s for focus / keyboard (an iOS simulator known to use a hardware keyboard: one read)
  const hw = ios && hwKeyboard.has(d.id);
  const fs = await waitFocus(d, Math.max(0, Math.min(Number(body.focusTimeoutMs ?? (hw ? 0 : 2000)) || 0, 10_000)), 250, device.platform);
  if (fs.keyboard) hwKeyboard.delete(d.id);
  if (fs.known && !fs.ok) warnings.push('No focused field or keyboard detected after tapping (custom input?); typed anyway');
  tree = fs.tree ?? tree;
  if (!field && fs.focused) field = fs.focused;
  if (!field && tree) { const e = flatten(tree.root).filter((x) => isEditable(x)).find((x) => tx >= x.bounds.x && tx < x.bounds.x + x.bounds.width && ty >= x.bounds.y && ty < x.bounds.y + x.bounds.height); if (e) field = toMatch(e, tree); }
  const current = () => (tree && field ? fieldValue(relocate(tree, field)) : undefined);
  const pkey = field ? fieldKey(d.id, field) : undefined;
  const placeholder = pkey ? placeholders.get(pkey) : undefined;
  const before = current();

  // 4. clear
  let cleared = false; let clearMethod: string | undefined; let afterClear: string | undefined = before; let selectedAll = false;
  let androidSelectAll = false; // Ctrl+A + delete sent, not yet verified (the final re-read checks it)
  const holdDelete = async (n0: number) => {
    // Hold the on-screen delete key: one gesture; auto-repeat starts after ~1–1.4 s (varies with load), then
    // ~10 chars/s, then whole words. Overshoot is harmless; re-read and repeat if text is left.
    let len = n0;
    for (let round = 0; round < 3 && len > 0; round++) {
      const k = tree ? keyboardInfo(tree).deleteKey : undefined; if (!k) break;
      const p = center(k); const ms = Math.min(8000, 1600 + len * 70);
      await need(d.b, 'longPress', 'long press')(d.nid, p.x, p.y, ms);
      log({ action: 'longPress', x: p.x, y: p.y, durationMs: ms });
      const prevVal = afterClear;
      tree = (await axTree(d)) ?? tree; afterClear = current();
      if (!afterClear || afterClear === placeholder) break;
      // Deleting from the end leaves a substring of what was there; anything else (or no change at all from a
      // reliable touch) is the placeholder iOS reports for an empty field.
      if (afterClear === prevVal || !(prevVal ?? '').includes(afterClear)) { if (pkey) placeholders.set(pkey, afterClear); break; }
      len = [...afterClear].length;
    }
  };
  // iOS reports an empty field's placeholder as its value: Settings' empty search field has value "Search", the label
  // of the magnifier icon inside it (blind run 4s: fill "cleared" it one delete at a time, 6.5 s)
  const fb = field?.bounds;
  const showsHint = ios && !!before && !!field && field.editable === true && (before === field.placeholder || before === field.label
    || (!!tree && !!fb && flatten(tree.root).some((e) => /Image|Icon/.test(String(e.type)) && e.label === before
      && e.bounds.x >= fb.x && e.bounds.y >= fb.y && e.bounds.x + e.bounds.width <= fb.x + fb.width && e.bounds.y + e.bounds.height <= fb.y + fb.height)));
  let hwSelectAll = false;   // Cmd+A sent (hardware keyboard): the final re-read checks it
  if (clear && before && (before === placeholder || showsHint)) { cleared = true; clearMethod = 'already empty (placeholder)'; }
  else if (clear && before) {
    const n = [...before].length;
    if (android && d.b.shell) {
      // a) select all (Ctrl+A: KEYCODE_CTRL_LEFT=113 + KEYCODE_A=29, `input keycombination`, Android 13+) and one
      //    KEYCODE_DEL=67: one adb call whatever the length (one delete per character cost ~36 ms each).
      const sa = await d.b.shell(d.nid, 'input keycombination 113 29 && input keyevent 67').catch((e: Error) => ({ code: 1, stdout: '', stderr: e.message }));
      let done = sa.code === 0 && !/error|exception|unknown|usage/i.test(`${sa.stdout}\n${sa.stderr}`);
      if (done) {
        log({ action: 'key', key: 'ctrl+a' }); log({ action: 'key', key: 'delete' });
        if (value) { clearMethod = 'select all + delete'; androidSelectAll = true; afterClear = undefined; } // checked by the final re-read
        else {
          tree = (await axTree(d)) ?? tree; afterClear = current();
          done = !afterClear || afterClear === placeholder;
          if (done) clearMethod = 'select all + delete';
        }
      }
      if (!done) {
        // b) no select-all (older Android, custom fields): caret to end, then a backspace per character (MOVE_END=123)
        const left = afterClear !== undefined && afterClear !== before ? [...afterClear].length : n;
        await d.b.shell(d.nid, `input keyevent 123 ${Array(left + 2).fill('67').join(' ')}`);
        clearMethod = `move-end + ${left + 2}× delete`;
        log({ action: 'key', key: 'KEYCODE_MOVE_END' }); for (let i = 0; i < left + 2; i++) log({ action: 'key', key: 'delete' });
        // keyevent DEL is reliable and the final re-read verifies, so skip a dump unless the value is empty
        // (then the post-clear text tells us the hint/placeholder the field shows when empty).
        if (!value) { tree = (await axTree(d)) ?? tree; afterClear = current(); } else afterClear = undefined;
      }
    } else if (ios && tree && keyboardInfo(tree).deleteKey) {
      // a) Edit menu → "Select All"; typing then replaces the selection (length-independent). Tapping the caret of a
      //    focused field toggles that menu, so the first tap already opened it if the field was focused before.
      const menuItem = (t: UiTree, re: RegExp) => flatten(t.root).find((e) => re.test((e.label ?? e.text ?? '').trim()) && e.bounds.width > 0 && !isEditable(e));
      const selectAll = (t: UiTree) => menuItem(t, /^select all$/i);
      const emptyMenu = (t: UiTree) => !!menuItem(t, /^(paste|autofill)$/i) && !menuItem(t, /^(select|cut|copy)$/i);
      let sa = selectAll(tree); let menuSaysEmpty = !sa && emptyMenu(tree);
      if (!sa && !menuSaysEmpty) {
        await d.b.tap(d.nid, tx, ty); log({ action: 'tap', x: tx, y: ty });
        for (let i = 0; i < 4 && !sa && !menuSaysEmpty; i++) {
          await sleep(200);
          const t = await axTree(d); if (!t) break; tree = t; sa = selectAll(t); menuSaysEmpty = !sa && emptyMenu(t);
        }
      }
      if (sa) { const p = center(sa); await d.b.tap(d.nid, p.x, p.y); log({ action: 'tap', x: p.x, y: p.y }, { resolved: { element: { type: sa.type, text: 'Select All' } } }); selectedAll = true; }
      if (selectedAll) {
        clearMethod = 'select all';
        if (!value) { // nothing will replace the selection: delete it
          await sleep(150); tree = (await axTree(d)) ?? tree;
          const k = tree ? keyboardInfo(tree).deleteKey : undefined;
          if (k) { const p = center(k); await d.b.tap(d.nid, p.x, p.y); log({ action: 'tap', x: p.x, y: p.y }); } else { await d.b.key(d.nid, 'delete'); log({ action: 'key', key: 'delete' }); }
          tree = (await axTree(d)) ?? tree; afterClear = current();
          if (afterClear && afterClear !== before && !before.includes(afterClear) && pkey) placeholders.set(pkey, afterClear);
        }
      } else if (menuSaysEmpty) {
        // The edit menu offers Paste/AutoFill but nothing to select: the field is empty and shows its placeholder.
        if (pkey) placeholders.set(pkey, before);
        clearMethod = 'already empty (placeholder)'; afterClear = before;
      } else {
        // b) no menu (empty field / placeholder, or the tap was read as a double-tap): hold delete
        if (tree && !keyboardInfo(tree).deleteKey) tree = (await axTree(d)) ?? tree;
        await holdDelete(n);
        clearMethod = 'hold keyboard delete';
      }
    } else {
      // hardware keyboard (iOS): Cmd+A selects the text and typing replaces it, one call whatever the length
      if (ios && value && !fs.keyboard) {
        try { await d.b.key(d.nid, 'select_all'); log({ action: 'key', key: 'select_all' }); hwSelectAll = true; } catch { /* per character below */ }
      }
      if (hwSelectAll) { clearMethod = 'select all (Cmd+A)'; afterClear = undefined; }
      else {
        if (ios) { try { await d.b.key(d.nid, 'end'); } catch { /* optional */ } }
        else { try { await d.b.key(d.nid, 'KEYCODE_MOVE_END'); log({ action: 'key', key: 'KEYCODE_MOVE_END' }); } catch { /* optional */ } }
        for (let i = 0; i < n + 1; i++) { await d.b.key(d.nid, 'delete'); log({ action: 'key', key: 'delete' }); }
        clearMethod = `${n + 1}× delete key`;
        tree = (await axTree(d)) ?? tree; afterClear = current();
      }
    }
    cleared = true;
    if (!selectedAll && afterClear && afterClear === before && clearMethod !== 'hold keyboard delete' && !clearMethod?.startsWith('already empty')) warnings.push(`Clearing had no visible effect (field still shows ${JSON.stringify(mask(afterClear, secret))}; that may just be its placeholder)`);
  }
  const emptyShows = (v: string) => v === '' || v === placeholder || (showsHint && v === before) || (pkey !== undefined && v === placeholders.get(pkey)) || (cleared && !selectedAll && v === afterClear && afterClear !== before);
  if (clearMethod === 'already empty (placeholder)') afterClear = before;

  // 5. type
  if (value) { await d.b.type(d.nid, value); log({ action: 'type', text: value, secret }); }

  // 6. re-read + verify (one retry when typing was dropped, which happens under load)
  let finalValue: string | undefined; let verified: boolean | undefined;
  const reread = async (): Promise<string | undefined> => {
    await sleep(150);
    tree = (await axTree(d)) ?? tree;
    let e = tree && field ? relocate(tree, field) : undefined;
    if (!e && tree && !field) { // the field was given by x,y: use the text field under that point, else the focused one
      const eds = flatten(tree.root).filter((x) => isEditable(x));
      e = eds.find((x) => tx >= x.bounds.x && tx < x.bounds.x + x.bounds.width && ty >= x.bounds.y && ty < x.bounds.y + x.bounds.height)
        ?? (eds.filter((x) => x.focused).length === 1 ? eds.find((x) => x.focused) : undefined);
    }
    return e ? fieldValue(e) ?? '' : undefined;
  };
  const check = (shown: string) => secret
    ? shown === value || (!value ? emptyShows(shown) : [...shown].length === [...value].length && !emptyShows(shown))
    : shown === value || (!value && emptyShows(shown));
  try {
    finalValue = await reread();
    if (finalValue !== undefined && hwSelectAll && !check(finalValue) && finalValue !== value && finalValue.endsWith(value) && !emptyShows(finalValue)) {
      const n2 = [...finalValue].length;
      try { await d.b.key(d.nid, 'end'); } catch { /* optional */ }
      for (let i = 0; i < n2 + 1; i++) { await d.b.key(d.nid, 'delete'); log({ action: 'key', key: 'delete' }); }
      await d.b.type(d.nid, value); log({ action: 'type', text: value, secret });
      clearMethod = `${n2 + 1}× delete key (Cmd+A had no effect)`;
      finalValue = await reread();
    }
    if (finalValue !== undefined && androidSelectAll && d.b.shell && !check(finalValue) && finalValue !== value && finalValue.endsWith(value) && !emptyShows(finalValue)) {
      // Ctrl+A was ignored by this field: the old text (minus one char) is still in front. Delete it all, retype.
      const n2 = [...finalValue].length;
      await d.b.shell(d.nid, `input keyevent 123 ${Array(n2 + 2).fill('67').join(' ')}`);
      log({ action: 'key', key: 'KEYCODE_MOVE_END' }); for (let i = 0; i < n2 + 2; i++) log({ action: 'key', key: 'delete' });
      await d.b.type(d.nid, value); log({ action: 'type', text: value, secret });
      clearMethod = `move-end + ${n2 + 2}× delete (select all had no effect)`;
      finalValue = await reread();
    }
    if (finalValue !== undefined) {
      verified = check(finalValue);
      if (!verified && value) {
        const got = emptyShows(finalValue) || (selectedAll && finalValue === before) ? '' : finalValue;
        let rest: string | undefined;
        if (!secret && value.startsWith(got)) rest = value.slice(got.length);
        else if (secret && got === '') rest = value;
        if (rest) {
          await d.b.type(d.nid, rest); log({ action: 'type', text: rest, secret });
          warnings.push(`Typing was ${got ? 'partly ' : ''}dropped; retyped ${secret ? `${[...rest].length} chars` : JSON.stringify(rest)}`);
          finalValue = await reread();
          if (finalValue !== undefined) verified = check(finalValue);
        }
      }
      if (ios && value && verified && !fs.keyboard) hwKeyboard.add(d.id);
      if (finalValue !== undefined && !verified) {
        if (!secret) warnings.push(`Field shows ${JSON.stringify(finalValue)}, expected ${JSON.stringify(value)}${value && finalValue.endsWith(value) ? ' (old text was not fully cleared)' : ''}`);
        else warnings.push(`Field shows ${[...finalValue].length} chars, expected ${[...value].length}`);
      }
    } else warnings.push('Could not verify: the text field could not be found again on screen after typing (the typing itself went through)');
  } catch (e) { warnings.push(`Could not re-read the field: ${(e as Error).message}`); }

  // 7. submit
  if (submit) {
    let done = false;
    if (ios) {
      try { const t = await axTree(d); const rk = t ? keyboardInfo(t).returnKey : undefined; if (rk) { const p = center(rk); await d.b.tap(d.nid, p.x, p.y); log({ action: 'tap', x: p.x, y: p.y }, { resolved: { element: { type: rk.type, text: rk.label, id: rk.id } } }); done = true; } } catch { /* fall back */ }
    }
    if (!done) { await d.b.key(d.nid, 'enter'); log({ action: 'key', key: 'enter' }); }
  }

  const expect = exp ? await finishExpect(d, exp) : undefined;
  return {
    ok: true, via, element: field ?? null, ...(label ? { label } : {}), tapped: { x: tx, y: ty },
    focused: fs.ok, keyboard: fs.keyboard, cleared, ...(clearMethod ? { clearMethod } : {}),
    previousValue: mask(before, secret), finalValue: mask(finalValue, secret), finalLength: finalValue === undefined ? undefined : [...finalValue].length,
    verified: verified ?? null, secret, submitted: submit, warnings, elapsedMs: Date.now() - t0, ...(expect ? { expect } : {}),
  };
}));

// ── human handoff ───────────────────────────────────────────────────────────
r.post('/v1/devices/:id/handoff', async (c) => {
  const d = await getDevice(c.params.id);
  const body = await c.body();
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (!reason) throw badRequest('reason required (what should the human do?)');
  return createHandoff(d.id, reason, c.owner, body.timeoutSec === undefined ? 900 : Number(body.timeoutSec));
});
const HSTATES = new Set(['pending', 'done', 'cancelled', 'timeout']);
r.get('/v1/handoffs', (c) => {
  const st = c.q('state'); if (st && !HSTATES.has(st)) throw badRequest('state must be pending | done | cancelled | timeout');
  let list = listHandoffs(st as HandoffState | undefined);
  const dv = c.q('deviceId'); if (dv) list = list.filter((h) => h.deviceId === dv);
  return list;
});
r.get('/v1/handoffs/:hid', async (c) => {
  const waitSec = Math.max(0, Math.min(num(c.q('waitSec'), 0)!, 60));
  return waitHandoff(c.params.hid, waitSec * 1000, { onClose: (cb) => c.res.on('close', cb) });
});
r.post('/v1/handoffs/:hid/resolve', async (c) => {
  const body = await c.body();
  if (body.state !== 'done' && body.state !== 'cancelled') throw badRequest("state must be 'done' or 'cancelled'");
  return resolveHandoff(c.params.hid, body.state, c.owner, typeof body.note === 'string' ? body.note : undefined);
});

// ── appearance (dark / light) ───────────────────────────────────────────────
/** Android night mode via `cmd uimode night` for backends that don't implement get/setAppearance themselves. */
const parseNight = (out: string): Appearance | 'unknown' => (/night mode:\s*yes/i.test(out) ? 'dark' : /night mode:\s*no/i.test(out) ? 'light' : 'unknown');
async function appearanceOf(d: Dev, platform: string): Promise<Appearance | 'unknown'> {
  if (d.b.getAppearance) return d.b.getAppearance(d.nid);
  if (platform === 'android' && d.b.shell) return parseNight((await d.b.shell(d.nid, 'cmd uimode night')).stdout);
  throw notSupported('appearance (dark/light mode)', d.b.id);
}
r.get('/v1/devices/:id/appearance', async (c) => {
  const d = dev(c);
  return { appearance: await appearanceOf(d, (await getDevice(d.id)).platform) };
});
r.post('/v1/devices/:id/appearance', async (c) => {
  const d = dev(c);
  checkLease(d.id, c.owner);
  const body = await c.body();
  const mode = String(body.appearance ?? body.mode ?? '').toLowerCase();
  if (mode !== 'dark' && mode !== 'light') throw badRequest('appearance must be "dark" or "light"');
  const platform = (await getDevice(d.id)).platform;
  const previous = await appearanceOf(d, platform).catch(() => 'unknown' as const);
  if (d.b.setAppearance) await d.b.setAppearance(d.nid, mode);
  else if (platform === 'android' && d.b.shell) {
    const r = await d.b.shell(d.nid, `cmd uimode night ${mode === 'dark' ? 'yes' : 'no'}`);
    if (r.code !== 0 || /exception|unknown command|error/i.test(r.stdout + r.stderr)) throw new PhoneDockError('Couldn’t change the appearance', 'exec_failed', 500, undefined, `cmd uimode night failed (exit ${r.code}): ${(r.stdout + r.stderr).trim().slice(0, 500)}`);
  } else throw notSupported('appearance (dark/light mode)', d.b.id);
  logAction(d.id, c.owner, { action: 'appearance', appearance: mode });
  uiCache.delete(d.id);
  const now = await appearanceOf(d, platform).catch(() => 'unknown' as const);
  return { ok: true, appearance: now, previous, changed: previous !== now };
});

// ── foreground app / keyboard ───────────────────────────────────────────────
r.get('/v1/devices/:id/foreground', async (c) => {
  const { b, nid } = dev(c);
  return { app: (await need(b, 'foregroundApp', 'foreground app')(nid)) ?? null };
});
r.post('/v1/devices/:id/keyboard/hide', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  await need(b, 'hideKeyboard', 'hide keyboard')(nid);
  return { ok: true };
});

// ── crashes ─────────────────────────────────────────────────────────────────
r.get('/v1/devices/:id/crashes', async (c) => {
  const { b, nid } = dev(c);
  const since = c.q('since');
  if (since && !Number.isFinite(Date.parse(since))) throw badRequest('since must be an ISO time');
  return need(b, 'listCrashes', 'crash reports')(nid, { since, appId: c.q('appId') || undefined, limit: Math.max(1, Math.min(num(c.q('limit'), 20)!, 500)) });
});
r.get('/v1/devices/:id/crashes/:cid', async (c) => {
  const { b, nid } = dev(c);
  const text = await need(b, 'getCrash', 'crash reports')(nid, c.params.cid);
  if (truthy(c.q('full'))) return { id: c.params.cid, text, truncated: false, length: text.length };
  return { id: c.params.cid, ...truncateCrash(text, Math.max(1000, Math.min(num(c.q('maxChars'), 16_000)!, 1_000_000))) };
});

// ── screen recording ────────────────────────────────────────────────────────
const fileSafe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'device';
r.post('/v1/devices/:id/recording/start', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const start = need(b, 'startRecording', 'screen recording');
  const cur = recordings.get(id);
  if (cur) throw new PhoneDockError("The device is already recording", 'recording_active', 409, ["Stop the current recording first."], [`Already recording to ${cur.path} (since ${cur.startedAt})`, ...[`POST /v1/devices/${encodeURIComponent(id)}/recording/stop`]].filter(Boolean).join('\n'));
  const body = await c.body();
  const maxSeconds = Math.max(1, Math.min(Number(body.maxSeconds ?? 300) || 300, 3600));
  const d = await getDevice(id);
  const path = join(stateDir('recordings'), `${fileSafe(d.name)}-${new Date().toISOString().replace(/[:.]/g, '-')}.mp4`);
  const rec = { deviceId: id, path, startedAt: new Date().toISOString(), maxSeconds, owner: c.owner } as import('./core.ts').RecordingState;
  recordings.set(id, rec); // reserve before the (possibly slow) backend call so a racing start gets 409
  try { await start(nid, path, { maxSeconds }); } catch (e) { recordings.delete(id); throw e; }
  rec.startedAt = new Date().toISOString();
  rec.timer = setTimeout(() => { void stopRecordingFor(id, `maxSeconds (${maxSeconds}s) reached`); }, maxSeconds * 1000);
  rec.timer.unref();
  emit('recording', { deviceId: id, active: true, path, startedAt: rec.startedAt, maxSeconds });
  return { ok: true, active: true, path, startedAt: rec.startedAt, maxSeconds };
});
r.post('/v1/devices/:id/recording/stop', async (c) => {
  const { id, b } = dev(c);
  need(b, 'stopRecording', 'screen recording');
  if (!recordings.has(id)) throw new PhoneDockError("No active recording on this device", 'not_recording', 409, ["Start a recording first."], ['No active recording on this device', ...['Start one: POST /v1/devices/:id/recording/start']].filter(Boolean).join('\n'));
  const res = (await stopRecordingFor(id))!;
  return { ok: true, ...res };
});
r.get('/v1/devices/:id/recording', (c) => {
  const rec = recordings.get(c.params.id);
  return rec ? { active: true, path: rec.path, startedAt: rec.startedAt, maxSeconds: rec.maxSeconds, owner: rec.owner } : { active: false };
});

// ── app data save/restore ───────────────────────────────────────────────────
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const APP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/;
function appDataBase(id: string, appId: string): string {
  if (!APP_RE.test(appId)) throw badRequest(`Bad app id "${appId}"`);
  return join(stateDir('appdata'), safeId(id), appId);
}
function dirStats(p: string): { sizeBytes: number; files: number } {
  let sizeBytes = 0, files = 0;
  const walk = (q: string) => {
    for (const e of readdirSync(q, { withFileTypes: true })) {
      const f = join(q, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.isFile()) { files++; try { sizeBytes += statSync(f).size; } catch { /* */ } }
    }
  };
  try { walk(p); } catch { /* */ }
  return { sizeBytes, files };
}
function dataName(body: Record<string, unknown>): string {
  const name = typeof body.name === 'string' ? body.name : '';
  if (!NAME_RE.test(name)) throw badRequest('name required: 1–64 chars of A-Z a-z 0-9 . _ - (starting with a letter or digit)');
  return name;
}
r.get('/v1/devices/:id/apps/:appId/data', (c) => {
  const base = appDataBase(c.params.id, c.params.appId);
  if (!existsSync(base)) return [];
  return readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && NAME_RE.test(e.name))
    .map((e) => { const p = join(base, e.name); return { name: e.name, path: p, savedAt: statSync(p).mtime.toISOString(), ...dirStats(p) }; })
    .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
});
r.post('/v1/devices/:id/apps/:appId/data/export', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const exp = need(b, 'exportAppData', 'app data export');
  const name = dataName(await c.body());
  const base = appDataBase(id, c.params.appId);
  mkdirSync(base, { recursive: true });
  const dir = join(base, name); const tmp = join(base, `.${name}.tmp-${randomBytes(3).toString('hex')}`);
  mkdirSync(tmp, { recursive: true });
  try { await exp(nid, c.params.appId, tmp); } catch (e) { rmSync(tmp, { recursive: true, force: true }); throw e; }
  rmSync(dir, { recursive: true, force: true });
  renameSync(tmp, dir);
  logAction(id, c.owner, { action: 'appData.export', appId: c.params.appId, name });
  return { ok: true, appId: c.params.appId, name, path: dir, ...dirStats(dir) };
});
r.post('/v1/devices/:id/apps/:appId/data/import', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  const imp = need(b, 'importAppData', 'app data import');
  const name = dataName(await c.body());
  const dir = join(appDataBase(id, c.params.appId), name);
  if (!existsSync(dir)) throw new PhoneDockError('The saved app data was not found', 'not_found', 404, ['Choose an existing saved data set.'], `No saved data "${name}" for ${c.params.appId}\nGET /v1/devices/${encodeURIComponent(id)}/apps/${encodeURIComponent(c.params.appId)}/data lists saved names`);
  await imp(nid, c.params.appId, dir);
  uiCache.delete(id);
  logAction(id, c.owner, { action: 'appData.import', appId: c.params.appId, name });
  return { ok: true, appId: c.params.appId, name, path: dir };
});

// ── scroll-to / direction swipes ───────────────────────────────────────────
// Slow, precise swipes (≈600 ms over ≈60 % of the scroll container) until an element matching text/id/type is on
// screen. Swipes never start on the keyboard (Android: it is hidden first; iOS: they stay above it) and stay inside
// the scroll container (src/daemon/scroll.ts). A screen with nothing scrollable answers at once. End of list = the
// container's content (texts and positions) didn't change after a swipe; without a usable tree (OCR, empty
// containers) = the same 64 px greyscale thumbnail as /wait idle, status bar and scroll-indicator strip masked out.
type Dir = LookDir;
const DIRS = new Set<Dir>(['up', 'down', 'left', 'right']);
const clampNum = (v: unknown, d: number, lo: number, hi: number) => { const n = Number(v ?? d); return Math.max(lo, Math.min(Number.isFinite(n) ? n : d, hi)); };

function maskThumb(t: Thumb, vertical: boolean): Thumb {
  const data = Buffer.from(t.data);
  const top = Math.ceil(t.height * 0.06); const right = Math.ceil(t.width * 0.05); const bottom = vertical ? 0 : Math.ceil(t.height * 0.03);
  for (let y = 0; y < t.height; y++) for (let x = 0; x < t.width; x++) {
    if (y < top || x >= t.width - right || y >= t.height - bottom) data[y * t.width + x] = 0;
  }
  return { ...t, data };
}
/** Screenshot once the screen has stopped moving (two equal thumbnails in a row), up to maxMs. */
async function settledShot(d: Dev, vertical: boolean, maxMs = 2500): Promise<{ png: Buffer; thumb: Thumb }> {
  const t0 = Date.now(); let prev: Thumb | undefined;
  for (;;) {
    const png = await d.b.screenshot(d.nid);
    const thumb = maskThumb(await grayThumb(png, 64), vertical);
    if ((prev && !diffThumbs(prev, thumb).changed) || Date.now() - t0 > maxMs) return { png, thumb };
    prev = thumb;
    await sleep(120);
  }
}
async function ocrFromPng(png: Buffer): Promise<UiTree> {
  let ocr: ((png: Buffer) => Promise<UiTree>) | undefined;
  try { const p = '../core/ocr.ts'; ocr = (await import(p) as { ocrUiTree?: (png: Buffer) => Promise<UiTree> }).ocrUiTree; } catch { /* missing */ }
  if (!ocr) throw new PhoneDockError('Text recognition isn’t available', 'not_supported', 501, undefined, 'OCR fallback unavailable (src/core/ocr.ts missing)');
  return ocr(png);
}

/** A drag that stops before lifting, so the list doesn't fling past items. Android: Backend.drag (the helper's
 *  injected drag, else one `input motionevent` sequence: DOWN, MOVE steps, 200 ms hold, UP; a plain swipe on API < 30);
 *  elsewhere the backend's plain swipe (iOS: AXe/HID swipes barely fling, ~+8 % measured). */
async function preciseSwipe(d: Dev, platform: string, s: Swipe): Promise<string> {
  // Android: a drag that rests 200 ms before lifting (helper injection, else `input motionevent` steps)
  if (platform === 'android' && d.b.drag) { await d.b.drag(d.nid, s.x1, s.y1, s.x2, s.y2, s.durationMs, 200); return HOLD_DRAG; }
  await d.b.swipe(d.nid, s.x1, s.y1, s.x2, s.y2, s.durationMs);
  return 'swipe';
}
const HOLD_DRAG = 'drag (hold before lift)';

/** Android: hide the on-screen keyboard if it is up (BACK only while the IME reports itself shown), so no swipe
 *  ever lands on it (Gboard glide-types swipes into the focused field). `stillUp`: it would not go away. */
async function clearAndroidKeyboard(d: Dev): Promise<{ hidden: boolean; stillUp: boolean }> {
  if (!d.b.shell) return { hidden: false, stillUp: false };
  const r = await d.b.shell(d.nid, 'dumpsys input_method | grep -E "mInputShown=|mImeWindowVis="').catch(() => undefined);
  if (!r || !imeShownFrom(r.stdout)) return { hidden: false, stillUp: false };
  if (!d.b.hideKeyboard) return { hidden: false, stillUp: true };
  try { await d.b.hideKeyboard(d.nid); uiCache.delete(d.id); return { hidden: true, stillUp: false }; } catch { return { hidden: false, stillUp: true }; }
}
/** Keyboard top (device px) a swipe must stay above, if a keyboard is (still) up. */
function keyboardTop(tree: UiTree | undefined, H: number, androidStillUp: boolean): number | undefined {
  if (androidStillUp) return H * 0.5;                       // the IME window isn't in Android trees: assume ≤ half
  const kb = tree ? keyboardInfo(tree) : undefined;
  return kb?.visible && kb.frame ? kb.frame.y : undefined;
}
const containerInfo = (e: UiElement | undefined) => (e ? { ref: e.ref, type: e.type, ...(e.id ? { id: e.id } : {}), bounds: e.bounds } : null);

r.post('/v1/devices/:id/scroll-to', inputRoute(observeScrollTo(async (c) => {
  const d = dev(c); checkLease(d.id, c.owner);
  const body = await c.body();
  const q = parseFind(body);
  if (!q.text && !q.id) throw badRequest('text (or id) required: what to scroll to');
  const direction = String(body.direction ?? 'down') as Dir;
  if (!DIRS.has(direction)) throw badRequest('direction must be up | down | left | right (where to look; default down)');
  const maxScrolls = Math.floor(clampNum(body.maxScrolls, 8, 0, 50));
  const durationMs = Math.round(clampNum(body.durationMs, 600, 200, 3000));
  const distance = clampNum(body.distance, 0.6, 0.2, 0.9);
  const vertical = direction === 'up' || direction === 'down';
  let closed = false; c.res.on('close', () => { closed = true; });
  const t0 = Date.now();
  const platform = (await getDevice(d.id)).platform;

  // 0. Android: get the keyboard out of the way first
  const kbd = platform === 'android' ? await clearAndroidKeyboard(d) : { hidden: false, stillUp: false };
  const extra = { ...(kbd.hidden ? { keyboardHidden: true } : {}) };

  // 1. look before scrolling (tree + OCR fallback, exactly like /find)
  const f0 = await findOnce(d, q);
  let tree = f0.tree; let matches = f0.matches;
  const mode = tree.source; // 'ocr' when there is no (usable) tree: every later look OCRs the settled frame
  let W = tree.screen.width, H = tree.screen.height;
  let lastPng: Buffer | undefined;
  if (!W || !H) { lastPng = await d.b.screenshot(d.nid); const s = pngSize(lastPng); W = s?.width ?? 0; H = s?.height ?? 0; }
  if (!W || !H) throw new PhoneDockError('Unknown screen size', 'error', 500);

  // 2. where to swipe: inside the scroll container, above any keyboard
  const point = Number.isFinite(body.x) && Number.isFinite(body.y) ? { x: Number(body.x), y: Number(body.y) } : undefined;
  const container = mode === 'accessibility' ? pickContainer(tree, vertical, point) : undefined;
  const swipe = swipeFor(W, H, direction, { container: container?.bounds, distance, durationMs, point, bottomLimit: keyboardTop(tree, H, kbd.stillUp) });
  const box = container?.bounds ?? { x: 0, y: 0, width: W, height: H };

  // An element in the strip the content is moving in from is only half there: scroll once more.
  const arriving = (m: ElementMatch) => {
    const v = vertical ? (m.center.y - box.y) / box.height : (m.center.x - box.x) / box.width;
    return direction === 'down' || direction === 'right' ? v > 0.9 : v < (vertical ? 0.06 : 0.04);
  };
  let method: string | undefined;
  const found = (m: ElementMatch, scrolls: number, more: Record<string, unknown> = {}) => ({
    ok: true, found: true, element: m, scrolls, direction, endReached: false, source: m.source, elapsedMs: Date.now() - t0, swipe,
    container: containerInfo(container), ...(method ? { method } : {}), ...extra, ...more,
  });
  const notFound = (scrolls: number, reason: string, endReached: boolean, more: Record<string, unknown> = {}) => ({
    ok: true, found: false, element: null, scrolls, direction, endReached, reason, source: tree.source, elapsedMs: Date.now() - t0, swipe,
    container: containerInfo(container), ...(method ? { method } : {}), summary: screenSummary(tree), ...extra, ...more,
  });

  {
    const vis = matches.filter((m) => m.visible);
    const good = vis.find((m) => !arriving(m));
    if (good) return found(good, 0);
  }
  // 3. nothing scrolls here: say so at once instead of swiping blindly
  if (canScroll(tree, platform) === false) {
    const vis = matches.filter((m) => m.visible);
    if (vis.length) return found(vis[0], 0, { note: 'element is at the screen edge' });
    return notFound(0, 'nothing to scroll on this screen', true, { nothingToScroll: true });
  }

  // 4. swipe until it shows up or the content stops moving
  // Android: the container's exact texts and positions. iOS: its rows without the chrome that changes on its own
  // (clock, scroll indicators, floating search field), allowing for the bounce at the end of a list.
  const rows = platform !== 'android' && mode === 'accessibility';
  const sig = (t: UiTree) => (mode !== 'accessibility' ? '' : rows ? JSON.stringify(contentItems(t, container?.bounds)) : contentSignature(t, container?.bounds));
  let before = sig(tree);
  const byPixels = !before || before === '[]';   // no structure to compare (OCR, empty container): compare frames
  const sameContent = (a: string, b: string) => (rows
    ? !contentMoved(JSON.parse(a) as ContentItem[], JSON.parse(b) as ContentItem[], vertical ? box.height : box.width, vertical)
    : a === b);
  let beforeThumb: Thumb | undefined;
  if (byPixels) { lastPng ??= await d.b.screenshot(d.nid); beforeThumb = maskThumb(await grayThumb(lastPng, 64), vertical); }
  let scrolls = 0; let endReached = false; let edge: ElementMatch | undefined;
  for (;;) {
    const vis = matches.filter((m) => m.visible);
    const good = vis.find((m) => !arriving(m));
    if (good) return found(good, scrolls);
    if (vis.length) edge = vis[0];
    if (scrolls >= maxScrolls) break;
    if (closed) throw new PhoneDockError('The client disconnected', 'aborted', 499);
    method = await preciseSwipe(d, platform, swipe);
    scrolls++;
    logAction(d.id, c.owner, { action: 'swipe', ...swipe }, { via: 'scroll-to', method });
    // The hold-before-lift drag stops before lifting: nothing moves any more, so read straight away. A plain swipe may coast.
    if (method !== HOLD_DRAG) await sleep(300);
    if (byPixels) {
      const s = await settledShot(d, vertical);
      lastPng = s.png;
      if (!diffThumbs(beforeThumb!, s.thumb).changed) { endReached = true; break; }
      beforeThumb = s.thumb; edge = undefined;
      if (mode === 'ocr') { tree = await ocrFromPng(s.png); matches = q.text ? findElements(tree, { text: q.text, match: q.match }) : []; }
      else { tree = (await axTree(d)) ?? tree; matches = findElements(tree, q); }
    } else {
      tree = (await axTree(d)) ?? tree; lastPng = undefined;
      matches = findElements(tree, q);
      const now = sig(tree);
      if (sameContent(before, now)) { endReached = true; break; }
      before = now; edge = undefined;
    }
  }
  if (edge) return found(edge, scrolls, { endReached, note: 'element is at the screen edge' });
  // the tree may lack text the screen shows (webviews, canvases): one OCR look at the final frame
  if (mode === 'accessibility' && q.text && q.ocrFallback !== false) {
    try {
      const ot = await ocrFromPng(lastPng ?? await d.b.screenshot(d.nid));
      const om = findElements(ot, { text: q.text, match: q.match }).filter((m) => m.visible);
      if (om.length) return found(om[0], scrolls, { endReached, ocrTried: true });
      tree = ot.root.length && !tree.root.length ? ot : tree;
    } catch { /* OCR unavailable: report not found */ }
  }
  return notFound(scrolls, endReached ? 'end reached, not found' : 'not found within maxScrolls', endReached);
})));

// A direction swipe ("swipe up" = finger moves up = reveal what is below) placed for the screen: inside the scroll
// container and never on the keyboard (Android: hidden first, like scroll-to). Other platforms skip the tree read and
// use the screen's content band. Explicit x1,y1 → x2,y2 swipes stay POST /input.
const FINGER = new Set(['up', 'down', 'left', 'right']);
r.post('/v1/devices/:id/swipe', inputRoute(async (c) => {
  const d = dev(c); checkLease(d.id, c.owner);
  const body = await c.body();
  const finger = String(body.direction ?? '') as Dir;
  if (!FINGER.has(finger)) throw badRequest('direction must be up | down | left | right (the finger movement: "up" reveals what is below)');
  const distance = clampNum(body.distance, 0.5, 0.05, 1);
  const durationMs = Math.round(clampNum(body.durationMs, 300, 50, 5000));
  const point = Number.isFinite(body.x) && Number.isFinite(body.y) ? { x: Number(body.x), y: Number(body.y) } : undefined;
  const look = lookFromFinger(finger);
  const vertical = finger === 'up' || finger === 'down';
  const t0 = Date.now();
  const platform = (await getDevice(d.id)).platform;
  let W = 0, H = 0; let container: UiElement | undefined; let tree: UiTree | undefined;
  const kbd = platform === 'android' ? await clearAndroidKeyboard(d) : { hidden: false, stillUp: false };
  if (platform === 'android' && d.b.uiTree) { try { tree = await axTree(d); } catch { /* geometry only */ } }
  if (tree?.screen.width && tree.screen.height) { W = tree.screen.width; H = tree.screen.height; container = tree ? pickContainer(tree, vertical, point) : undefined; }
  else if (d.b.screenInfo) { const s = await d.b.screenInfo(d.nid).catch(() => undefined); W = s?.width ?? 0; H = s?.height ?? 0; }
  if (!W || !H) { const s = pngSize(await d.b.screenshot(d.nid)); W = s?.width ?? 0; H = s?.height ?? 0; }
  if (!W || !H) throw new PhoneDockError('Unknown screen size', 'error', 500);
  // Without a container: the screen's content band (starting near the edges hits nav/status bars, and on iOS a
  // downward swipe from the top edge opens Notification Center instead of scrolling).
  const s = swipeFor(W, H, look, { container: container?.bounds, distance: container ? distance : Math.min(distance, 0.64), durationMs, point, bottomLimit: keyboardTop(tree, H, kbd.stillUp) });
  // the tree just read is the screen before the swipe: `expect` compares against it
  const exp = await prepareExpect(d, body.expect);
  await d.b.swipe(d.nid, s.x1, s.y1, s.x2, s.y2, s.durationMs);
  uiCache.delete(d.id);
  logAction(d.id, c.owner, { action: 'swipe', ...s }, { via: 'swipe', direction: finger });
  const expect = exp ? await finishExpect(d, exp) : undefined;
  return { ok: true, direction: finger, swipe: s, container: containerInfo(container), ...(kbd.hidden ? { keyboardHidden: true } : {}), elapsedMs: Date.now() - t0, ...(expect ? { expect } : {}) };
}));

// ── back ────────────────────────────────────────────────────────────────────
// Android & co: the Back key. iOS has none: tap the navigation bar's back button when the tree shows one
// (UIKit names it "BackButton"), otherwise fall back to the backend's key('back') left-edge swipe.
r.post('/v1/devices/:id/back', inputRoute(async (c) => {
  const d = dev(c); checkLease(d.id, c.owner);
  const platform = (await getDevice(d.id)).platform;
  const t0 = Date.now(); let method = 'key back'; let tapped: ElementMatch | undefined;
  if (platform === 'ios') {
    const tree = await axTree(d).catch(() => undefined);
    const H = tree?.screen.height ?? 0;
    const navBack = tree ? findElements(tree, { id: 'BackButton', match: 'exact' }).filter((m) => m.visible && (!H || m.center.y < H * 0.2)) : [];
    const backLabel = tree && !navBack.length ? findElements(tree, { text: 'Back', match: 'exact', type: 'Button' }).filter((m) => m.visible && (!H || m.center.y < H * 0.2)) : [];
    tapped = navBack[0] ?? backLabel[0];
    if (tapped) { await d.b.tap(d.nid, tapped.center.x, tapped.center.y); method = 'nav bar back button'; }
    else method = 'left-edge swipe';
  }
  if (!tapped) await d.b.key(d.nid, 'back');
  uiCache.delete(d.id);
  logAction(d.id, c.owner, tapped ? { action: 'tap', x: tapped.center.x, y: tapped.center.y } : { action: 'key', key: 'back' }, { via: 'back', method });
  return { ok: true, method, ...(tapped ? { tapped: { ref: tapped.ref, text: tapped.text ?? tapped.label, center: tapped.center } } : {}), elapsedMs: Date.now() - t0 };
}));

// ── system gestures ─────────────────────────────────────────────────────────
const GESTURES = new Set(['go_home', 'app_switcher', 'control_center', 'notification_center']);
const GESTURE_ALIASES: Record<string, string> = {
  home: 'go_home', app_switch: 'app_switcher', recents: 'app_switcher', switcher: 'app_switcher', overview: 'app_switcher',
  quick_settings: 'control_center', notifications: 'notification_center', notification_shade: 'notification_center',
};
const iosOpened = new Map<string, 'app_switcher' | 'control_center' | 'notification_center'>();
/** Which SpringBoard overlay is up on iOS, from the accessibility tree (undefined: none, or no tree). */
async function iosOverlay(d: Dev, W: number, H: number): Promise<'app_switcher' | 'control_center' | 'notification_center' | undefined> {
  const t = await axTree(d).catch(() => undefined);
  if (!t) return undefined;
  const all = flatten(t.root); const ids = new Set(all.map((e) => e.id ?? ''));
  if (ids.has('cc-root-folder-view')) return 'control_center';
  if (all.some((e) => /^card:/.test(e.id ?? '') && e.bounds.width > 0 && e.bounds.width < W * 0.9 && e.bounds.y + e.bounds.height < H * 0.9)) return 'app_switcher';
  if (ids.has('SBCoverSheetWindow') && ids.has('lockscreen-date-view')) return 'notification_center';
  return undefined;
}
async function screenSize(d: Dev): Promise<{ width: number; height: number }> {
  if (d.b.screenInfo) { const s = await d.b.screenInfo(d.nid); if (s.width && s.height) return s; }
  const s = pngSize(await d.b.screenshot(d.nid));
  if (!s) throw new PhoneDockError('Unknown screen size', 'error', 500);
  return s;
}
/** iOS top-edge swipes in device pixels (Face ID iPhones). */
export function iosGestureSwipe(g: string, W: number, H: number): { x1: number; y1: number; x2: number; y2: number; durationMs: number } {
  const r = Math.round;
  if (g === 'control_center') return { x1: r(W * 0.9), y1: 2, x2: r(W * 0.9), y2: r(H * 0.55), durationMs: 500 };   // top-right corner
  return { x1: r(W * 0.3), y1: 2, x2: r(W * 0.3), y2: r(H * 0.65), durationMs: 500 };                                 // top-left/centre
}
r.post('/v1/devices/:id/gesture', inputRoute(async (c) => {
  const d = dev(c); checkLease(d.id, c.owner);
  const body = await c.body();
  const raw = String(body.gesture ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  const g = GESTURE_ALIASES[raw] ?? raw;
  if (!GESTURES.has(g)) throw badRequest('gesture must be go_home | app_switcher | control_center | notification_center');
  const device = await getDevice(d.id);
  const t0 = Date.now(); let method = '';
  if (device.platform === 'android') {
    if (g === 'go_home') { await d.b.key(d.nid, 'home'); method = 'keyevent KEYCODE_HOME'; }
    else if (g === 'app_switcher') { await d.b.key(d.nid, 'app_switch'); method = 'keyevent KEYCODE_APP_SWITCH'; }
    else {
      const sh = need(d.b, 'shell', `${g} (needs adb shell)`);
      const cmd = g === 'notification_center' ? 'cmd statusbar expand-notifications' : 'cmd statusbar expand-settings';
      const res = await sh(d.nid, cmd);
      if (res.code !== 0) throw new PhoneDockError('Couldn’t perform the gesture', 'gesture_failed', 500, undefined, `${cmd} failed (exit ${res.code}): ${(res.stderr || res.stdout).trim().slice(0, 300)}`);
      method = cmd;
    }
  } else if (device.platform === 'ios') {
    if (g === 'go_home') {
      // The Home button doesn't close SpringBoard overlays (seen on iOS 26 simulators): close them first.
      const { width: W, height: H } = await screenSize(d);
      // the tree shows the switcher, Control Center and the cover sheet over the home screen; Notification Center over an
      // app is invisible to it, so also remember what /gesture opened last
      const flagged = iosOpened.get(d.id); // never tap on a flag alone: only the swipe (ignored by apps) is safe blind
      const overlay = (await iosOverlay(d, W, H)) ?? (flagged === 'app_switcher' ? undefined : flagged);
      iosOpened.delete(d.id);
      if (overlay === 'app_switcher') { await d.b.tap(d.nid, Math.round(W / 2), Math.round(H * 0.95)); method = 'tap below the app switcher cards'; }
      else {
        if (overlay) { // Control Center / Notification Center: a slow swipe up from the bottom edge (fast ones are ignored)
          await d.b.swipe(d.nid, Math.round(W / 2), H - 2, Math.round(W / 2), Math.round(H * 0.55), 1200);
          await sleep(900); // a Home press during the close animation is dropped
        }
        await d.b.key(d.nid, 'home');
        method = overlay ? `closed ${overlay} (slow swipe up from the bottom edge), then home button` : 'home button';
      }
    } else if (g === 'app_switcher') {
      // A swipe up from the home indicator only opens the switcher if the finger pauses before lifting, which
      // Backend.swipe can't do (AXe: ignored; WDA: holds *before* dragging). The backend's app_switch key instead
      // (simulator: double-press Home in one HID session).
      try { await d.b.key(d.nid, 'app_switch'); method = d.b.id === 'ios-simulator' ? 'double-press Home (key app_switch)' : 'key app_switch'; iosOpened.set(d.id, 'app_switcher'); }
      catch (e) {
        if ((e as PhoneDockError).code !== 'not_supported') throw e;
        throw notSupported('system gesture "app_switcher"', d.b.id, [
          'This backend has no reliable app-switcher gesture (a swipe up from the bottom needs a pause before lifting)',
          'Switch apps with launch_app (or go_home, then tap the app); list_apps shows what is installed',
        ]);
      }
    } else {
      const { width, height } = await screenSize(d);
      const s = iosGestureSwipe(g, width, height);
      await d.b.swipe(d.nid, s.x1, s.y1, s.x2, s.y2, s.durationMs);
      iosOpened.set(d.id, g as 'control_center' | 'notification_center');
      method = `edge swipe (${s.x1},${s.y1})→(${s.x2},${s.y2}) ${s.durationMs} ms`;
    }
  } else {
    throw notSupported(`system gesture "${g}"`, d.b.id, ['System gestures exist for Android (key events / cmd statusbar) and iOS (home button / edge swipes)', 'Use press_key or swipe directly']);
  }
  uiCache.delete(d.id);
  logAction(d.id, c.owner, { action: 'gesture', gesture: g }, { method });
  return { ok: true, gesture: g, platform: device.platform, method, elapsedMs: Date.now() - t0 };
}));

// ── system prompts / alerts ─────────────────────────────────────────────────
/** Tree for prompt detection: the accessibility tree (cached for refs), OCR when there is none or it is empty. */
async function promptTree(d: Dev, ocrFallback: boolean): Promise<UiTree | undefined> {
  let tree: UiTree | undefined; let err: unknown;
  try { tree = await axTree(d); } catch (e) { err = e; }
  if ((!tree || !tree.root.length) && ocrFallback) {
    try { tree = await ocrTree(d.b, d.nid); } catch (e) { if (!tree) throw err ?? e; }
  }
  return tree;
}
const ocrOff = (v: unknown) => v === false || v === '0' || v === 'false';

r.get('/v1/devices/:id/prompt', async (c) => {
  const d = dev(c);
  const tree = await promptTree(d, !ocrOff(c.q('ocrFallback')));
  if (!tree) return { prompt: null, source: null, capturedAt: new Date().toISOString() };
  const prompt = detectPrompt(tree);
  return { prompt, source: tree.source, capturedAt: tree.capturedAt, ...(prompt ? { text: describePrompt(prompt) } : { summary: screenSummary(tree) }) };
});

function alertAction(body: Record<string, unknown>): AlertAction {
  const raw = typeof body.action === 'string' ? body.action.trim() : '';
  const btn = typeof body.button === 'string' ? body.button.trim() : '';
  const m = /^button\s*[=:]\s*(.+)$/is.exec(raw);
  if (m && m[1].trim()) return { button: m[1].trim() };
  if ((raw === '' || raw === 'button') && btn) return { button: btn };
  if (raw === 'accept' || raw === 'dismiss') return raw;
  throw badRequest('action must be accept | dismiss | button=<label> (or pass { button: "<label>" })');
}
r.post('/v1/devices/:id/alert', async (c) => {
  const d = dev(c); checkLease(d.id, c.owner);
  const body = await c.body();
  const action = alertAction(body);
  const ocr = !ocrOff(body.ocrFallback);
  const t0 = Date.now();
  const tree = await promptTree(d, ocr);
  if (!tree) throw notSupported('UI tree', d.b.id, ['Pass ocrFallback: true']);
  const prompt = detectPrompt(tree);
  if (!prompt) {
    throw new PhoneDockError('No system prompt or alert on screen', 'no_prompt', 404, ['If a dialog is visible, tap its button by text instead.'], `Screen now (${tree.source}): ${screenSummary(tree)}`);
  }
  if (prompt.needsHuman) {
    throw new PhoneDockError('A person must handle this prompt', 'needs_human', 403, ['Ask a person to handle the prompt.'], [
      `Refusing to answer this ${prompt.kind} prompt (${prompt.reason}): a person must handle it`,
      'Call request_human (MCP) / POST /v1/devices/:id/handoff with what the person should do, and wait for it',
      'PhoneDock never types passcodes or passwords and never approves biometrics, profile installs or paste requests for you',
    ].join('\n'));
  }
  let btn: PromptButton;
  try { btn = chooseButton(prompt, action); } catch (e) {
    const code = (e as { code?: string }).code ?? 'no_button';
    throw new PhoneDockError(code === 'ambiguous_button' ? 'The prompt button could not be identified.' : 'The prompt button was not found.', code, code === 'ambiguous_button' ? 409 : 404, ['Choose a button by its label.'], [(e as Error).message, (e as PhoneDockError).detail, `Buttons: ${prompt.buttons.map((x) => JSON.stringify(x.text)).join(', ') || '(none)'}`, 'Pass button=<label> to pick one'].filter(Boolean).join('\n'));
  }
  const x = Math.round(btn.bounds.x + btn.bounds.width / 2), y = Math.round(btn.bounds.y + btn.bounds.height / 2);
  await d.b.tap(d.nid, x, y);
  uiCache.delete(d.id);
  logAction(d.id, c.owner, { action: 'tap', x, y }, { via: 'alert', prompt: prompt.kind, resolved: { ref: btn.ref, element: { type: 'Button', text: btn.text } } });
  // verify: is the same prompt still there? (one more look if it is: dismiss animations, slow dumps)
  let after: SystemPrompt | null | undefined;
  if (body.verify !== false) {
    const same = (p2: SystemPrompt | null) => !!p2 && p2.kind === prompt.kind && p2.title === prompt.title;
    for (let i = 0; i < 2; i++) {
      await sleep(i ? 800 : Math.round(clampNum(body.settleMs, 500, 0, 5000)));
      try { const t2 = await promptTree(d, ocr); after = t2 ? detectPrompt(t2) : undefined; } catch { after = undefined; break; }
      if (!same(after ?? null)) break;
    }
  }
  const gone = after === undefined ? null : !(after && after.kind === prompt.kind && after.title === prompt.title);
  return {
    ok: true, action: typeof action === 'string' ? action : 'button', prompt,
    tapped: { text: btn.text, ...(btn.ref ? { ref: btn.ref } : {}), ...(btn.role ? { role: btn.role } : {}), bounds: btn.bounds, x, y },
    dismissed: gone, after: after ?? null, elapsedMs: Date.now() - t0,
  };
});
