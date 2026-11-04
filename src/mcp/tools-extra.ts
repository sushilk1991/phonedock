// v0.2 MCP tools (fill, wait_for, batch, request_human, crashes, recording, app data, foreground app, gestures,
// file/rotate/push exposure). Registered from createMcpServer() via registerExtraTools(); use the ToolKit helpers so
// behaviour (device targeting, coordinate spaces, observe screenshots, error formatting) matches the built-in tools.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { PhoneDockApiError, type AlertActionInput, type Handoff, type SystemGesture, type SystemPrompt } from '../sdk/client.ts';
import { describePrompt } from '../core/prompts.ts';
import type { Content, ToolKit, ToolResult } from './server.ts';
import { toExpect } from './args.ts';

/** The one-line warning get_ui / screenshot add when a system prompt is on screen. */
export function promptWarning(p: SystemPrompt): string {
  if (p.needsHuman) return `SYSTEM PROMPT (needs a human): ${p.reason}. Don't answer it or type credentials yourself: call request_human(reason="…"), wait, then get_ui again.`;
  return `SYSTEM PROMPT: ${describePrompt(p)}. Answer it with handle_alert(action="accept" | "dismiss" | "button=<label>").`;
}

const expandHome = (p: string) => (p === '~' ? homedir() : p.startsWith('~/') ? homedir() + p.slice(1) : p);
const fmtBytes = (n: number) => (n >= 1 << 20 ? `${(n / (1 << 20)).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
/** ISO → "2026-11-04 19:20:13 +0530" in the Mac's time zone (crash reports print local times too). */
export function localTime(iso: string | undefined): string {
  const t = iso ? new Date(iso) : undefined;
  if (!t || Number.isNaN(t.getTime())) return iso ?? '?';
  const p = (n: number) => String(Math.abs(n)).padStart(2, '0'); const off = -t.getTimezoneOffset();
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}:${p(t.getSeconds())} ${off < 0 ? '-' : '+'}${p(Math.trunc(off / 60))}${p(off % 60)}`;
}
const oneLine = (r: ToolResult, max = 240) => {
  const t = r.content.filter((c): c is Extract<Content, { type: 'text' }> => c.type === 'text').map((c) => c.text).join(' | ').replace(/\s*\n\s*/g, ' | ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t || '(no text)';
};
/** "10m", "2h", "30s", "1d" → ISO; ISO passes through. */
function sinceIso(v?: string): string | undefined {
  if (!v) return undefined;
  const m = v.trim().match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d)$/i);
  if (m) return new Date(Date.now() - Number(m[1]) * { s: 1e3, m: 6e4, h: 36e5, d: 864e5 }[m[2].toLowerCase() as 's']).toISOString();
  if (!Number.isFinite(Date.parse(v))) throw new Error(`since must be an ISO time or a duration like "15m" / "2h" (got "${v}")`);
  return new Date(v).toISOString();
}

export function registerExtraTools(k: ToolKit): void {
  const { tool, c, target, scaleFor, toDevice, act, text, shot, errorResult, handlers, describeMatch, sleep,
    deviceParam, spaceParam, observeParam, settleParam, matchParam, expectParam } = k;
  const imgScale = async (d: Parameters<typeof scaleFor>[0], space?: 'image' | 'device') => (space === 'device' ? 1 : (await scaleFor(d)).scale || 1);

  // ── fill ──────────────────────────────────────────────────────────────
  tool('fill', 'Fill a text field in one call: tap it, wait (≤2 s) for focus/keyboard, clear the old text, type `value`, then re-read the field and report its final value (so you don\'t need a get_ui to check). Pick the field with target — its placeholder/label/current text ("Email"), a ref from get_ui ("e12"), or its id as get_ui prints it ("nameField" or "id:nameField") — or with ref/text/element_id, or x,y (image space unless coordinate_space="device"). If the text matches a label next to a field, the nearest field below/right of it is used. Use secret=true for passwords/OTPs. When later steps depend on this one (fill, then tap "Submit"), send them in one batch, which stops at the first failure.', {
    device: deviceParam,
    value: z.string().describe('Text to put in the field ("" just clears it)'),
    target: z.string().optional().describe('Field to fill: "e12" (ref), "id:email_input" (or the bare id), or text such as "Email" / "Your name"'),
    text: z.string().optional().describe('Alternative to target: match by text/label/placeholder'),
    ref: z.string().optional().describe('Alternative to target: ref from the latest get_ui'),
    element_id: z.string().optional().describe('Alternative to target: accessibility identifier / resource-id'),
    element_type: z.string().optional().describe('Only fields of this type, e.g. "SecureTextField", "EditText"'),
    match: matchParam,
    index: z.number().int().min(0).optional().describe('Which candidate when several fields match (0 = best)'),
    x: z.number().optional().describe('Alternative to target: x of the field (image space unless coordinate_space="device")'), y: z.number().optional().describe('y of the field'), coordinate_space: spaceParam,
    clear: z.boolean().optional().describe('Remove existing text first (default true)'),
    submit: z.boolean().optional().describe('Press Enter / the keyboard return key afterwards (default false)'),
    secret: z.boolean().optional().describe('Password/OTP: never echoed, logged as "•••", skipped by replay'),
    return_screenshot: observeParam, settle_ms: settleParam, expect: expectParam,
  }, async (a) => {
    const d = await target(a.device);
    let ref = a.ref; let txt = a.text; let id = a.element_id;
    const expect = toExpect(a.expect);
    if (a.target) {
      const t = a.target.trim();
      if (/^@?e\d+$/i.test(t)) ref = t.replace(/^@/, '');
      else if (/^id:/i.test(t)) id = t.slice(3).trim();
      else txt = t;
    }
    const body: Record<string, unknown> = { value: a.value, clear: a.clear, submit: a.submit, secret: a.secret, match: a.match, index: a.index, type: a.element_type, ...(expect ? { expect } : {}) };
    if (ref) body.ref = ref;
    else if (txt || id || a.element_type) { body.text = txt; body.id = id; }
    else if (a.x !== undefined && a.y !== undefined) { const [x, y] = await toDevice(d, a.x, a.y, a.coordinate_space); body.x = x; body.y = y; }
    else throw new Error('Pass target (or text / ref / element_id), or x and y');
    const r = await c.fill(d.id, body as never);
    const sc = await imgScale(d, a.coordinate_space);
    const show = (v: string | undefined) => (v === undefined ? '?' : a.secret ? `${[...v].length} hidden chars` : JSON.stringify(v));
    const el = r.element && a.secret ? { ...r.element, text: undefined, value: undefined, label: r.element.label && r.element.label !== r.element.text ? r.element.label : undefined } : r.element;
    const field = el ? describeMatch(el, sc) : `(${Math.round(r.tapped.x / sc)},${Math.round(r.tapped.y / sc)})`;
    const parts = [`Filled ${field}${r.label ? ` (label ${JSON.stringify(r.label.text ?? r.label.label ?? '')} → nearest field)` : ''}`];
    if (r.cleared && r.previousValue && r.clearMethod !== 'already empty (placeholder)') parts.push(`cleared ${show(r.previousValue)}`);
    parts.push(a.value ? `typed ${a.secret ? `${[...a.value].length} secret chars` : JSON.stringify(a.value)}` : 'left it empty');
    if (r.submitted) parts.push('submitted');
    let line = parts.join(', ') + '.';
    if (r.finalValue !== undefined) line += ` Field now shows ${show(r.finalValue)}${r.verified ? ' (verified)' : r.verified === false ? ' — DOES NOT MATCH' : ''}.`;
    else if (!r.submitted) line += ' Could not re-read the field.';
    if (!r.focused && r.keyboard === false && !r.verified) line += ' (no focus/keyboard was detected)';
    line += ` ${secs(r.elapsedMs)}.`;
    if (r.warnings.length) line += `\nWarnings:\n- ${r.warnings.join('\n- ')}`;
    const res = await act(d, line, a.return_screenshot, a.settle_ms, undefined, { report: r.expect, what: 'text' });
    if (r.verified === false && !(r.expect && !r.expect.ok)) res.isError = false; // reported in text; the agent decides
    return res;
  });

  // ── wait_for ──────────────────────────────────────────────────────────
  tool('wait_for', 'Wait for the screen instead of sleeping: until="visible" returns as soon as an element matching text/element_id/element_type is on screen (and not under the keyboard); until="gone" when none is visible any more (e.g. a spinner or "Loading…"); until="idle" when the screen stops changing for stable_ms (animations/transitions finished; tiny blinks like the text caret are ignored). Polls the accessibility tree (OCR fallback). On timeout you get an error with a short summary of what is on screen now.', {
    device: deviceParam,
    until: z.enum(['visible', 'gone', 'idle']),
    text: z.string().optional().describe('Text/label/value to look for (visible/gone)'),
    element_id: z.string().optional().describe('Accessibility identifier / resource-id (visible/gone)'),
    element_type: z.string().optional().describe('Element type, e.g. "Button" (visible/gone)'),
    match: matchParam,
    timeout_ms: z.number().int().min(0).max(60000).optional().describe('Give up after this long (default 10000, max 60000 — call again to keep waiting)'),
    interval_ms: z.number().int().min(50).max(5000).optional().describe('Poll interval (default 300; idle 200)'),
    stable_ms: z.number().int().min(0).max(30000).optional().describe('idle: how long the screen must stay unchanged (default 1000). visible/gone: how long the condition must hold (default 0)'),
    return_screenshot: observeParam,
  }, async (a) => {
    const d = await target(a.device);
    if (a.until !== 'idle' && !a.text && !a.element_id && !a.element_type) throw new Error(`until="${a.until}" needs text, element_id or element_type`);
    const r = await c.waitFor(d.id, { until: a.until, text: a.text, id: a.element_id, type: a.element_type, match: a.match, timeoutMs: a.timeout_ms ?? 10_000, intervalMs: a.interval_ms, stableMs: a.stable_ms });
    const sc = await imgScale(d);
    let msg: string;
    if (a.until === 'visible') msg = `Visible after ${secs(r.elapsedMs)}: ${r.match ? describeMatch(r.match, sc) : '?'}${(r.matches?.length ?? 0) > 1 ? ` (+${r.matches!.length - 1} more)` : ''}.`;
    else if (a.until === 'gone') msg = `Gone after ${secs(r.elapsedMs)} (${r.polls} polls).`;
    else {
      const g = r.changedRegion;
      msg = `Screen idle after ${secs(r.elapsedMs)} (unchanged for ${r.stableMs} ms; ${r.changes} change${r.changes === 1 ? '' : 's'} seen${g ? `, changed region x=${Math.round(g.x / sc)} y=${Math.round(g.y / sc)} ${Math.round(g.width / sc)}x${Math.round(g.height / sc)} in image space` : ''}).`;
    }
    return act(d, msg, a.return_screenshot, 0);
  });

  // ── batch ─────────────────────────────────────────────────────────────
  const NOT_IN_BATCH = new Set(['batch', 'request_human']);
  tool('batch', 'Run several tool calls in one round trip, in order, e.g. [{tool:"tap",args:{text:"Login"}}, {tool:"fill",args:{target:"Email",value:"a@b.c"}}, {tool:"wait_for",args:{until:"idle"}}, {tool:"get_ui"}]. Each step\'s args are exactly that tool\'s arguments (`device` defaults to the batch\'s `device`). Returns one line per step; images from steps are dropped except the last step\'s. The last step\'s full text output is included too, so end with get_ui to see the result. batch and request_human cannot be steps.', {
    device: deviceParam,
    steps: z.array(z.object({ tool: z.string().describe('Tool name, e.g. "tap"'), args: z.record(z.string(), z.unknown()).optional().describe('That tool\'s arguments') })).min(1).max(50),
    stop_on_error: z.boolean().optional().describe('Stop at the first failing step (default true)'),
    screenshot_at_end: z.boolean().optional().describe('Append a fresh screenshot after the last step (default false)'),
  }, async (a, extra) => {
    const stop = a.stop_on_error !== false;
    const lines: string[] = []; let failed = 0; let ran = 0; let last: ToolResult | undefined; const t0 = Date.now();
    for (const [i, s] of a.steps.entries()) {
      const n = i + 1;
      let r: ToolResult;
      const h = handlers.get(s.tool);
      const ts = Date.now();
      if (NOT_IN_BATCH.has(s.tool)) r = { isError: true, content: [text(`${s.tool} is not allowed inside batch; call it on its own`)] };
      else if (!h) r = { isError: true, content: [text(`Unknown tool "${s.tool}"`)] };
      else {
        const args: Record<string, unknown> = { ...(s.args ?? {}) };
        if (a.device && args.device === undefined) args.device = a.device;
        try { r = await h(args, extra); } catch (e) { r = errorResult(e); }
        ran++;
      }
      last = r;
      lines.push(`${n}. ${s.tool} ${r.isError ? 'FAILED' : 'ok'} (${Date.now() - ts} ms): ${oneLine(r)}`);
      if (r.isError) {
        failed++;
        if (stop) { if (n < a.steps.length) lines.push(`Stopped at step ${n} (stop_on_error); ${a.steps.length - n} step(s) not run.`); break; }
      }
      if (extra?.signal?.aborted) { lines.push('Cancelled.'); break; }
    }
    const content: Content[] = [text(`Batch: ${ran}/${a.steps.length} step(s) run, ${failed} failed, ${secs(Date.now() - t0)}.\n${lines.join('\n')}`)];
    if (last) {
      const full = last.content.filter((x) => x.type === 'text').map((x) => (x as { text: string }).text).join('\n');
      if (full.includes('\n') || full.length > 240) content.push(text(`Output of the last step:\n${full}`));
      content.push(...last.content.filter((x) => x.type === 'image'));
    }
    if (a.screenshot_at_end) { try { content.push(...(await shot(await target(a.device)))); } catch (e) { content.push(...errorResult(e).content); } }
    return { content, isError: failed > 0 };
  });

  // ── human handoff ─────────────────────────────────────────────────────
  tool('request_human', 'Ask the person at the Mac to do something on the device that you cannot or must not do: approve Face ID / Touch ID, enter a passcode, sign in to an Apple Account / Google account (passwords, 2FA codes), solve a CAPTCHA, answer an "Allow Paste" or other system prompt, confirm a payment, press a hardware button. Shows a request in the PhoneDock app and BLOCKS until they mark it done or cancelled, or timeout_sec passes (progress notifications are sent while waiting). The device stays yours meanwhile: the person can use it without taking your lease, and if they take it over in the app, the lease comes back to you when they press Done or Can\'t Do It. The result says who holds the device afterwards. Afterwards the screen has changed: call get_ui before acting. Never type credentials you were not given.', {
    device: deviceParam,
    reason: z.string().min(3).describe('Exactly what the human should do, e.g. "Approve the Face ID prompt for Wallet" or "Sign in to the Apple Account on screen, then tap Done"'),
    timeout_sec: z.number().int().min(10).max(3600).optional().describe('Give up after this long (default 900 = 15 min)'),
  }, async (a, extra) => {
    const d = await target(a.device);
    const timeoutSec = a.timeout_sec ?? 900;
    let h: Handoff;
    try { h = await c.requestHandoff(d.id, a.reason, { timeoutSec }); }
    catch (e) {
      // Re-attach to our own pending request (e.g. the client timed out and the agent asked again).
      if (!(e instanceof PhoneDockApiError) || e.code !== 'handoff_pending') throw e;
      const mine = (await c.handoffs({ state: 'pending', deviceId: d.id })).find((x) => x.requestedBy === c.owner);
      if (!mine) throw e;
      h = mine;
    }
    const token = extra?._meta?.progressToken;
    const t0 = Date.now();
    const progress = async (msg: string) => {
      if (token === undefined || !extra?.sendNotification) return;
      await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: Math.round((Date.now() - t0) / 1000), total: timeoutSec, message: msg } }).catch(() => {});
    };
    const held = h.leaseHolder === c.owner || h.returnLease;
    await progress(`Waiting for a human on ${d.name}: ${a.reason}${held ? ' (the device stays yours; if they take it over, it comes back to you when they finish)' : ''}`);
    while (h.state === 'pending') {
      if (extra?.signal?.aborted) {
        try { h = await c.resolveHandoff(h.id, 'cancelled', 'agent cancelled the request'); } catch { /* already resolved */ }
        break;
      }
      try { h = await c.handoff(h.id, { waitSec: 15 }); }
      catch (e) { if (e instanceof PhoneDockApiError && e.code === 'not_found') throw new PhoneDockApiError(`Handoff ${h.id} disappeared (daemon restarted?)`, 'handoff_lost', 410, ['Call request_human again'], e.detail ?? e.message); throw e; }
      if (h.state === 'pending') await progress(`Still waiting for a human (${Math.round((Date.now() - t0) / 1000)} s): ${a.reason}`);
    }
    const took = secs(Date.parse(h.resolvedAt ?? new Date().toISOString()) - Date.parse(h.createdAt));
    const note = h.note ? ` Their note: ${JSON.stringify(h.note)}.` : '';
    // Who holds the device now, read back from the daemon (never claim the lease is back unless it is).
    const holder = await c.device(d.id).then((x) => x.lease?.owner ?? null, () => undefined);
    const lease = holder === undefined ? ''
      : holder === c.owner ? ` You hold ${d.name} again${h.leaseReturned ? ' (the person handed it back to you)' : ''}.`
      : holder === null ? ` Nobody holds ${d.name} now: call acquire_device(device="${d.name}") first if others may use it.`
      : holder === 'app:human' ? ` The person at the Mac still holds ${d.name}: wait, or ask them to hand it back (you can't take it over).`
      : ` ${holder} holds ${d.name} now: wait for it, or use another device.`;
    if (holder === c.owner) (k.ctx.leased ??= new Set()).add(d.id);
    if (h.state === 'done') return { content: [text(`Human marked it DONE after ${took} (handoff ${h.id}${h.resolvedBy ? ` by ${h.resolvedBy}` : ''}).${note}${lease} The screen has probably changed: call get_ui (or screenshot) before your next action.`)] };
    if (h.state === 'cancelled') return { content: [text(`Human CANCELLED the request after ${took} (handoff ${h.id}).${note}${lease} Don't retry the same step blindly: adapt, or ask the user what to do.`)] };
    return { isError: true, content: [text(`Nobody responded within ${timeoutSec} s (handoff ${h.id} timed out).${lease} Tell the user you need them for: ${a.reason}`)] };
  });

  // ── app state / diagnostics ───────────────────────────────────────────
  tool('get_foreground_app', 'Which app is in the foreground right now (package name / bundle id), or the home screen. Cheap; use it to check where you are after a launch, deep link or crash.', { device: deviceParam }, async (a) => {
    const d = await target(a.device);
    const app = await c.foregroundApp(d.id);
    return { content: [text(app ? `Foreground on ${d.name}: ${app.id}${app.name ? ` (${app.name})` : ''}${app.version ? ` v${app.version}` : ''}` : `${d.name}: no app in front (home screen / launcher).`)] };
  });

  tool('list_crashes', 'List recent crash / ANR / jetsam reports on the device, newest first: id, time, app, kind and a one-line summary. Then get_crash(crash_id) for the details.', {
    device: deviceParam,
    app_id: z.string().optional().describe('Only this package name / bundle id'),
    since: z.string().optional().describe('ISO time or a duration like "15m", "2h", "1d" (default: everything the device keeps)'),
    limit: z.number().int().min(1).max(200).optional().describe('default 20'),
  }, async (a) => {
    const d = await target(a.device);
    const list = await c.crashes(d.id, { appId: a.app_id, since: sinceIso(a.since), limit: a.limit ?? 20 });
    return { content: [text(list.length ? list.map((x) => `${x.id} | ${localTime(x.time)} | ${x.appId ?? x.process ?? '?'} | ${x.kind ?? 'crash'}${x.summary ? ` | ${x.summary}` : ''}`).join('\n') : `No crash reports on ${d.name}${a.app_id ? ` for ${a.app_id}` : ''}${a.since ? ` since ${a.since}` : ''}.`)] };
  });

  tool('get_crash', 'Read one crash report (id from list_crashes). Long reports are cut down to the header (exception, signal, termination reason) plus the crashed thread\'s stack; full=true returns everything.', {
    device: deviceParam, crash_id: z.string(), full: z.boolean().optional().describe('Return the whole report (can be very long)'),
  }, async (a) => {
    const d = await target(a.device);
    const r = await c.crash(d.id, a.crash_id, { full: a.full });
    return { content: [text(`${r.truncated ? `[report ${r.length} chars, showing header + crashed thread; full=true for all]\n` : ''}${r.text}`)] };
  });

  tool('record_screen', 'Record the device screen to an .mp4 on the Mac. action="start" begins (auto-stops after max_seconds, default 300), "stop" finishes and returns the file path and size, "status" says whether a recording is running. Recording also stops when the device shuts down.', {
    device: deviceParam,
    action: z.enum(['start', 'stop', 'status']),
    max_seconds: z.number().int().min(1).max(3600).optional().describe('start: auto-stop after this long (default 300)'),
  }, async (a) => {
    const d = await target(a.device);
    if (a.action === 'start') {
      const r = await c.startRecording(d.id, { maxSeconds: a.max_seconds });
      return { content: [text(`Recording ${d.name} → ${r.path} (auto-stops after ${r.maxSeconds} s). Call record_screen action="stop" when done.`)] };
    }
    if (a.action === 'stop') {
      const r = await c.stopRecording(d.id);
      return { content: [text(`Saved ${r.path} (${fmtBytes(r.sizeBytes)}, ${r.durationSec} s).${r.warning ? ` Warning: ${r.warning}` : ''}`)], isError: !r.sizeBytes };
    }
    const r = await c.recording(d.id);
    return { content: [text(r.active ? `Recording ${d.name} since ${r.startedAt} → ${r.path} (auto-stop after ${r.maxSeconds} s).` : `${d.name} is not recording.`)] };
  });

  tool('app_data', 'Save / restore one app\'s data container (documents, databases, preferences, login state) so you can reset to a known state fast: action="save" copies it to the Mac under `name`, "restore" puts a saved copy back (the app is stopped first), "list" shows saved names. Cheaper than a full device snapshot.', {
    device: deviceParam,
    action: z.enum(['save', 'restore', 'list']),
    app_id: z.string().describe('Package name / bundle id (see list_apps)'),
    name: z.string().optional().describe('Snapshot name for save/restore, e.g. "logged-in" (letters, digits, . _ -)'),
  }, async (a) => {
    const d = await target(a.device);
    if (a.action === 'list') {
      const list = await c.appData(d.id, a.app_id);
      return { content: [text(list.length ? list.map((x) => `${x.name} | saved ${x.savedAt} | ${fmtBytes(x.sizeBytes)}, ${x.files} files`).join('\n') : `No saved data for ${a.app_id} on ${d.name}.`)] };
    }
    if (!a.name) throw new Error(`name is required for ${a.action}`);
    if (a.action === 'save') {
      const r = await c.exportAppData(d.id, a.app_id, a.name);
      return { content: [text(`Saved ${a.app_id} data as "${a.name}" (${fmtBytes(r.sizeBytes)}, ${r.files} files) → ${r.path}`)] };
    }
    await c.importAppData(d.id, a.app_id, a.name);
    return { content: [text(`Restored ${a.app_id} data "${a.name}" on ${d.name}. Launch the app (launch_app) to use it.`)] };
  });

  // ── gestures / keyboard ───────────────────────────────────────────────
  tool('hide_keyboard', 'Dismiss the on-screen keyboard (e.g. when it covers a button you need). Doesn\'t submit the form.', { device: deviceParam, return_screenshot: observeParam, settle_ms: settleParam }, async (a) => {
    const d = await target(a.device); await c.hideKeyboard(d.id);
    return act(d, 'Keyboard hidden.', a.return_screenshot, a.settle_ms);
  });

  tool('double_tap', 'Double-tap at x,y (standard image space: get_ui @(x,y) / a default-size screenshot, unless coordinate_space="device"), e.g. to zoom a map/photo or select a word.', {
    device: deviceParam, x: z.number().describe('x in the standard image space (get_ui @(x,y) / a default-size screenshot), unless coordinate_space="device"'), y: z.number().describe('y, same space as x'), coordinate_space: spaceParam, return_screenshot: observeParam, settle_ms: settleParam, expect: expectParam,
  }, async (a) => {
    const d = await target(a.device);
    const [x, y] = await toDevice(d, a.x, a.y, a.coordinate_space);
    const r = await c.doubleTap(d.id, x, y, { expect: toExpect(a.expect) });
    return act(d, `Double-tapped (${a.x},${a.y})${a.coordinate_space === 'device' ? '' : ` → device (${x},${y})`}.`, a.return_screenshot, a.settle_ms, undefined, { report: r.expect, what: 'double tap' });
  });

  tool('pinch', 'Two-finger pinch centred on x,y (image space unless coordinate_space="device"). scale is the final finger distance relative to the start: <1 pinches in (zoom out), >1 spreads (zoom in); e.g. 0.5 or 2.', {
    device: deviceParam, x: z.number().describe('x in the standard image space (get_ui @(x,y) / a default-size screenshot), unless coordinate_space="device"'), y: z.number().describe('y, same space as x'), scale: z.number().min(0.1).max(10).describe('Final finger distance ÷ start distance: <1 zooms out, >1 zooms in'),
    duration_ms: z.number().int().min(100).max(5000).optional().describe('default 400'),
    coordinate_space: spaceParam, return_screenshot: observeParam, settle_ms: settleParam,
  }, async (a) => {
    const d = await target(a.device);
    const [x, y] = await toDevice(d, a.x, a.y, a.coordinate_space);
    await c.pinch(d.id, x, y, a.scale, a.duration_ms);
    return act(d, `Pinched ×${a.scale} at (${a.x},${a.y}).`, a.return_screenshot, a.settle_ms);
  });

  // ── system routes that had no tool ────────────────────────────────────
  tool('rotate', 'Rotate the device to portrait or landscape. Screen size changes: take a new screenshot/get_ui before using coordinates.', {
    device: deviceParam, orientation: z.enum(['portrait', 'landscape']), return_screenshot: observeParam, settle_ms: settleParam,
  }, async (a) => {
    const d = await target(a.device);
    const r = await c.rotate(d.id, a.orientation);
    // the screen as it really ended up (the daemon reads it after the turn settles) is the new image space
    k.ctx.scales.delete(d.id); k.ctx.deviceCache = undefined;
    const sp = r.screen?.width && r.screen.height ? await scaleFor({ ...d, screen: r.screen }) : undefined;
    const size = r.screen ? ` (${r.screen.width}x${r.screen.height}${sp ? `; x,y are now in the ${sp.imageWidth}x${sp.imageHeight} image space` : ''})` : '';
    const msg = r.orientation && r.orientation !== a.orientation
      ? `${d.name} stays in ${r.orientation}${size}: ${r.note ?? 'the app on screen does not rotate.'}`
      : `Rotated ${d.name} to ${a.orientation}${size}. Coordinates from earlier screenshots are now invalid.`;
    return act(d, msg, a.return_screenshot, a.settle_ms, 500);
  });

  const remoteHelp = 'Android: an absolute device path, e.g. /sdcard/Download/x.png. iOS simulator: app://<bundleId>/<path> (the app\'s data container, e.g. app://com.me.app/Documents/a.json), group://<appGroupId>/<path>, or data://<path> (simulator data dir)';
  tool('push_file', `Copy a file or folder from the Mac onto the device. ${remoteHelp}; on iOS "photos:" adds an image/video to the Photos library.`, {
    device: deviceParam, local_path: z.string().describe('Path on the Mac'), remote_path: z.string().describe('Destination on the device (a trailing "/" keeps the file name)'),
  }, async (a) => {
    const d = await target(a.device);
    const local = resolve(expandHome(a.local_path));
    if (!existsSync(local)) throw new Error(`No such file on the Mac: ${local}`);
    await c.pushFile(d.id, local, a.remote_path);
    return { content: [text(`Pushed ${local} → ${d.name}:${a.remote_path}`)] };
  });

  tool('pull_file', `Copy a file or folder from the device to the Mac. ${remoteHelp}.`, {
    device: deviceParam, remote_path: z.string().describe('Path on the device'), local_path: z.string().describe('Destination path on the Mac'),
  }, async (a) => {
    const d = await target(a.device);
    const local = resolve(expandHome(a.local_path));
    await c.pullFile(d.id, a.remote_path, local);
    return { content: [text(`Pulled ${d.name}:${a.remote_path} → ${local}`)] };
  });

  tool('push_notification', 'Deliver a push notification to an app (iOS simulator: simulated APNs). Give title/body, or a full payload (APNs JSON; {"aps":…} is added if missing). Android emulators don\'t support this; use shell with `cmd notification post` there.', {
    device: deviceParam, app_id: z.string().describe('Bundle id / package name'),
    title: z.string().optional(), body: z.string().optional(),
    payload: z.record(z.string(), z.unknown()).optional().describe('Full payload, e.g. {"aps":{"alert":{"title":"Hi","body":"…"},"badge":1},"custom":1}'),
  }, async (a) => {
    const d = await target(a.device);
    const payload = a.payload ?? { aps: { alert: { ...(a.title ? { title: a.title } : {}), body: a.body ?? '' }, sound: 'default' } };
    await c.pushNotification(d.id, a.app_id, payload);
    return { content: [text(`Sent a push notification to ${a.app_id} on ${d.name}.`)] };
  });

  // ── scroll / navigation / system UI ───────────────────────────────────
  tool('scroll_to', 'Scroll until an element with this text is on screen, using slow, precise swipes (about 600 ms over about 60 % of the screen; on Android the finger stops before lifting so the list never flings past items). direction is where to look: "down" (default) reveals what is below, "up" what is above, "left"/"right" for carousels and pagers. Swipes run inside the scroll container and never on the keyboard (on Android an open keyboard is hidden first). Answers at once with "nothing to scroll on this screen" when nothing on screen scrolls, and stops as soon as a swipe no longer moves the content ("end reached, not found"). Returns the element (its ref works with tap(ref=…), centre in image space) and the number of scrolls. Uses the accessibility tree, with OCR when there is none. Pass x,y (image space unless coordinate_space="device") to swipe inside a list that doesn\'t fill the screen.', {
    device: deviceParam,
    text: z.string().min(1).describe('Text / label / value of the element to bring on screen, e.g. "About phone"'),
    match: matchParam,
    element_type: z.string().optional().describe('Only elements of this type, e.g. "Button", "Cell", "TextView"'),
    direction: z.enum(['down', 'up', 'left', 'right']).optional().describe('Where to look (default "down" = scroll down to reveal what is below)'),
    max_scrolls: z.number().int().min(0).max(30).optional().describe('Give up after this many swipes (default 8)'),
    x: z.number().optional().describe('Point inside the scrollable area to swipe around (default: screen centre)'), y: z.number().optional().describe('y of that point'),
    coordinate_space: spaceParam, return_screenshot: observeParam, settle_ms: settleParam,
  }, async (a) => {
    const d = await target(a.device);
    let x: number | undefined, y: number | undefined;
    if (a.x !== undefined && a.y !== undefined) [x, y] = await toDevice(d, a.x, a.y, a.coordinate_space);
    const r = await c.scrollTo(d.id, a.text, { match: a.match, type: a.element_type, direction: a.direction, maxScrolls: a.max_scrolls, x, y });
    const n = (k: number) => `${k} scroll${k === 1 ? '' : 's'}`;
    const kb = r.keyboardHidden ? ' (The keyboard was up: it was hidden first so no swipe could type on it.)' : '';
    if (!r.found || !r.element) {
      if (r.nothingToScroll) {
        return { isError: true, content: [text(`Not found: ${JSON.stringify(a.text)}: nothing to scroll on this screen, so it is not further down (no swipes, ${secs(r.elapsedMs)}).${kb}${r.summary ? ` Screen now: ${r.summary}` : ''} It is not on this screen: check get_ui / screenshot, or navigate to where it is.`)] };
      }
      const why = r.endReached ? `the end of the list was reached after ${n(r.scrolls)} ${r.direction}`
        : `still not on screen after ${n(r.scrolls)} ${r.direction} (max_scrolls; the list may go on: raise max_scrolls to keep looking)`;
      return { isError: true, content: [text(`Not found: ${JSON.stringify(a.text)}: ${why} (${secs(r.elapsedMs)}).${kb}${r.summary ? ` Screen now: ${r.summary}` : ''}${r.endReached ? ' Try direction="up" (or the other axis) if it may be above, or check the spelling.' : ''}`)] };
    }
    const sc = await imgScale(d, a.coordinate_space);
    const how = r.element.ref ? ` Tap it with tap(ref="${r.element.ref}").` : ` (via OCR, no ref: tap its coordinates.)`;
    return act(d, `Found ${describeMatch(r.element, sc)} after ${n(r.scrolls)} ${r.direction} (${secs(r.elapsedMs)}).${how}${r.note ? ` Note: ${r.note}.` : ''}${kb}`, a.return_screenshot, a.settle_ms, 0);
  });

  tool('go_back', 'Go back one screen. Android: the system Back key (also closes dialogs, the keyboard and the notification shade). iOS has no Back key: this taps the navigation bar\'s back button when there is one, otherwise it swipes in from the left edge, which only works where the app supports it; if nothing changed, tap the app\'s own close / back control.', {
    device: deviceParam, return_screenshot: observeParam, settle_ms: settleParam,
  }, async (a) => {
    const d = await target(a.device);
    const r = await c.goBack(d.id);
    const how = r.tapped ? `tapped the back button "${r.tapped.text ?? 'Back'}"` : r.method === 'left-edge swipe' ? 'swiped in from the left edge' : 'pressed Back';
    return act(d, `Went back on ${d.name}: ${how}.`, a.return_screenshot, a.settle_ms);
  });

  tool('system_gesture', 'Open system UI: gesture="go_home" (home screen), "app_switcher" (recent apps), "control_center" (iOS Control Center; Android quick settings), "notification_center" (the notification list / shade). Android uses key events and `cmd statusbar`; iOS uses the home button and edge swipes built from the screen size. Close the shade / switcher / Control Center again with go_home (Android: go_back also works). Not available on Linux/QEMU devices.', {
    device: deviceParam,
    gesture: z.enum(['go_home', 'app_switcher', 'control_center', 'notification_center']),
    return_screenshot: observeParam, settle_ms: settleParam,
  }, async (a) => {
    const d = await target(a.device);
    const r = await c.systemGesture(d.id, a.gesture as SystemGesture);
    return act(d, `${a.gesture} on ${d.name} (${r.method}).`, a.return_screenshot, a.settle_ms, 900);
  });

  tool('handle_alert', 'Answer the system prompt or alert that is on screen by tapping one of its buttons by text (it never types anything). action="accept" grants or confirms ("Allow While Using App", "While using the app", "Allow", "OK"), "dismiss" declines ("Don\'t Allow", "Not Now", "Cancel"), "button=<label>" taps a specific one, e.g. "button=Allow Once". Works on iOS and Android permission dialogs and on alerts with 1–3 buttons (accessibility tree, or OCR without one); get_ui and screenshot show a "SYSTEM PROMPT" line when one is up. It REFUSES prompts a person must answer: passcode, Face ID / Touch ID, Apple Account / Google password sheets, profile / certificate installs and "Allow Paste". Use request_human for those.', {
    device: deviceParam,
    action: z.string().regex(/^(accept|dismiss|button\s*=\s*.+)$/is, 'accept | dismiss | button=<label>').describe('"accept", "dismiss" or "button=<label>"'),
    return_screenshot: observeParam, settle_ms: settleParam,
  }, async (a) => {
    const d = await target(a.device);
    const m = /^button\s*=\s*(.+)$/is.exec(a.action.trim());
    const action: AlertActionInput = m ? { button: m[1].trim() } : (a.action.trim().toLowerCase() as 'accept' | 'dismiss');
    let r;
    try { r = await c.handleAlert(d.id, action); } catch (e) {
      if (e instanceof PhoneDockApiError && e.code === 'needs_human') {
        return { isError: true, content: [text(`Refused: ${e.message}. Call request_human(reason="…") describing what the person should do on ${d.name}, wait for it, then get_ui.`)] };
      }
      throw e;
    }
    const state = r.dismissed === true ? ' The prompt is gone.' : r.dismissed === false ? ' The prompt is still on screen (take a screenshot).' : '';
    const next = r.after ? `\n${promptWarning(r.after)}` : '';
    return act(d, `Tapped [${r.tapped.text}] on the ${r.prompt.kind} prompt (${r.prompt.reason}).${state} ${secs(r.elapsedMs)}.${next}`, a.return_screenshot, a.settle_ms);
  });

  void sleep;
}
