// Shared adb operations for the Android backends (emulator + physical). Every adb call is
// `adb -s <serial> …` – never a bare adb that could hit whatever device happens to be attached.
import { parseAndroidSettingNumber } from '../core/device-settings.ts';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { run, runBuffer, sleep, type RunOptions } from '../core/exec.ts';
import { androidSdkRoot, stateDir, toolEnv, which } from '../core/paths.ts';
import { closeUiHelper, helperEnabled, helperInput, helperInputStarted, helperLabels, helperUiDump, UI_QUIET_MS, UI_QUIET_TIMEOUT_MS } from './android-helper.ts';
import { chooseWindow, parseHelperWindows } from './android-windows.ts';
import { startsWithStartCode } from '../core/video.ts';
import {
  PhoneDockError,
  type AppInfo, type Bounds, type Capability, type CrashReport, type ExecResult, type KeyName,
  type Orientation, type ScreenInfo, type UiElement, type UiTree,
} from '../core/types.ts';

export function sdkRoot(): string {
  const s = androidSdkRoot();
  if (!s) throw new PhoneDockError('Android SDK not found', 'sdk_missing', 501, ['Install the Android SDK.'], 'Install it: brew install --cask android-commandlinetools; or set ANDROID_HOME');
  return s;
}

export function adbPath(): string {
  const s = androidSdkRoot();
  const p = s ? join(s, 'platform-tools', 'adb') : undefined;
  if (p && existsSync(p)) return p;
  const w = which('adb');
  if (w) return w;
  throw new PhoneDockError('Android platform tools not found', 'adb_missing', 501, ['Install the Android platform tools.'], 'Install platform-tools: sdkmanager "platform-tools"');
}

export function ffmpegPath(): string | undefined { return which('ffmpeg'); }

/** adb -s <serial> <args…> */
export function adb(serial: string, args: string[], opts: RunOptions = {}): Promise<ExecResult> {
  if (!serial) throw new PhoneDockError('Device identifier is missing', 'bad_request', 400, undefined, 'adb serial missing');
  return run(adbPath(), ['-s', serial, ...args], { env: toolEnv(), timeoutMs: 30_000, failureMessage: 'Couldn’t reach the Android device', ...opts });
}
export function adbBuf(serial: string, args: string[], opts: RunOptions = {}) {
  if (!serial) throw new PhoneDockError('Device identifier is missing', 'bad_request', 400, undefined, 'adb serial missing');
  return runBuffer(adbPath(), ['-s', serial, ...args], { env: toolEnv(), timeoutMs: 30_000, failureMessage: 'Couldn’t reach the Android device', ...opts });
}
/** Device-independent adb commands (devices, connect, pair). */
export function adbGlobal(args: string[], opts: RunOptions = {}): Promise<ExecResult> {
  return run(adbPath(), args, { env: toolEnv(), timeoutMs: 20_000, ...opts });
}

export interface AdbDeviceLine { serial: string; state: string; props: Record<string, string> }
export async function adbDevices(): Promise<AdbDeviceLine[]> {
  const r = await adbGlobal(['devices', '-l'], { allowFail: true });
  const out: AdbDeviceLine[] = [];
  for (const line of r.stdout.split('\n').slice(1)) {
    const t = line.trim(); if (!t || t.startsWith('*')) continue;
    const parts = t.split(/\s+/);
    const props: Record<string, string> = {};
    for (const p of parts.slice(2)) { const i = p.indexOf(':'); if (i > 0) props[p.slice(0, i)] = p.slice(i + 1); }
    out.push({ serial: parts[0], state: parts[1] ?? 'unknown', props });
  }
  return out;
}

/** Quote one argument for the remote /system/bin/sh. */
export function shQuote(s: string): string { return `'${s.replace(/'/g, `'\\''`)}'`; }

export const ANDROID_CAPS: Capability[] = [
  'screenshot', 'stream', 'uiTree', 'tap', 'longPress', 'swipe', 'type', 'key', 'install', 'apps', 'launch',
  'openUrl', 'shell', 'files', 'logs', 'rotate', 'window', 'doubleTap', 'record', 'crashes', 'appData', 'appearance', 'settings', 'trace', 'video',
];

// Read the same overlay that Android Settings uses, including vendor overrides.
async function fontRange(serial: string): Promise<[number, number] | undefined> {
  const out = await adb(serial, ['shell', 'cmd', 'overlay', 'lookup', 'com.android.settings', 'com.android.settings:array/entryvalues_font_size'], { allowFail: true });
  const values = out.stdout.trim().split(/\s+/).map(parseAndroidSettingNumber).filter((n): n is number => n !== undefined && n > 0);
  if (out.code === 0 && values.length > 1) return [Math.min(...values), Math.max(...values)];
  // Some vendor builds hide the overlay: fall back to AOSP's range (Android 14 added non-linear scaling up to 200%).
  const sdk = Number((await adb(serial, ['shell', 'getprop', 'ro.build.version.sdk'], { allowFail: true })).stdout.trim());
  return Number.isFinite(sdk) && sdk > 0 ? [0.85, sdk >= 34 ? 2 : 1.3] : undefined;
}
const animationKeys = ['window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'] as const;
function animationFile(serial: string): string {
  return join(stateDir(), `settings-animation-${createHash('sha256').update(serial).digest('hex')}.json`);
}
async function setting(serial: string, namespace: string, key: string): Promise<string> {
  return (await adb(serial, ['shell', 'settings', 'get', namespace, key])).stdout.trim();
}
async function putSetting(serial: string, namespace: string, key: string, value: string) {
  const r = await adb(serial, ['shell', 'settings', 'put', namespace, key, value]);
  if (/exception|error|permission denial/i.test(r.stdout + r.stderr)) throw new PhoneDockError('Couldn’t change the Android setting', 'exec_failed', 500, undefined, (r.stdout + r.stderr).trim());
}
export async function getSettings(serial: string): Promise<import('../core/types.ts').SettingsRead> {
  const [range, sdk, night, scale, weight, contrast, ...animation] = await Promise.all([
    fontRange(serial), adb(serial, ['shell', 'getprop', 'ro.build.version.sdk']).then(r => r.stdout.trim()),
    adb(serial, ['shell', 'cmd', 'uimode', 'night']).then(r => r.stdout.trim()),
    setting(serial, 'system', 'font_scale'), setting(serial, 'secure', 'font_weight_adjustment'),
    setting(serial, 'secure', 'high_text_contrast_enabled'),
    ...animationKeys.map(k => setting(serial, 'global', k)),
  ]);
  const settings: import('../core/types.ts').DeviceSettings = {};
  const supported: import('../core/types.ts').SettingKey[] = [];
  const appearance = /night mode:\s*yes/i.test(night) ? 'dark' : /night mode:\s*no/i.test(night) ? 'light' : undefined;
  if (appearance) { settings.appearance = appearance; supported.push('appearance'); }
  const n = scale === 'null' ? 1 : parseAndroidSettingNumber(scale);
  if (range && n !== undefined && n > 0) { settings.textSize = n; settings.textSizeNative = { font_scale: n }; supported.push('textSize'); }
  if (Number(sdk) >= 31) { settings.boldText = Number(weight) > 0; supported.push('boldText'); }
  settings.increaseContrast = contrast === '1'; supported.push('increaseContrast');
  settings.reduceMotion = animation.every(v => v !== 'null' && Number(v) === 0); supported.push('reduceMotion');
  return { settings, supported };
}
export async function setSettings(serial: string, patch: import('../core/types.ts').SettingsInput, identity = serial): Promise<void> {
  let size: number | undefined;
  if (patch.textSize !== undefined) {
    const range = await fontRange(serial);
    if (!range) throw new PhoneDockError('This device does not report its font-size range', 'not_supported', 501);
    const input = patch.textSize;
    if (typeof input === 'string' && !['default', 'smallest', 'largest'].includes(input)) throw new PhoneDockError('iOS text categories are not supported on Android', 'bad_request', 400);
    size = typeof input === 'number' ? Math.max(range[0], Math.min(range[1], input)) : input === 'smallest' ? range[0] : input === 'largest' ? range[1] : 1;
  }
  if (patch.appearance !== undefined) await adb(serial, ['shell', 'cmd', 'uimode', 'night', patch.appearance === 'dark' ? 'yes' : 'no']);
  if (size !== undefined) await putSetting(serial, 'system', 'font_scale', String(size));
  if (patch.boldText !== undefined) await putSetting(serial, 'secure', 'font_weight_adjustment', patch.boldText ? '300' : '0');
  if (patch.increaseContrast !== undefined) await putSetting(serial, 'secure', 'high_text_contrast_enabled', patch.increaseContrast ? '1' : '0');
  if (patch.reduceMotion !== undefined) {
    const file = animationFile(identity);
    if (patch.reduceMotion) {
      if (!existsSync(file)) {
        const previous = await Promise.all(animationKeys.map(k => setting(serial, 'global', k)));
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(previous), { flag: 'wx', mode: 0o600 });
      }
      for (const key of animationKeys) await putSetting(serial, 'global', key, '0');
    } else if (existsSync(file)) {
      const previous: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!Array.isArray(previous) || previous.length !== 3 || previous.some(v => typeof v !== 'string' || (v !== 'null' && !/^\d+(?:\.\d+)?$/.test(v)))) throw new Error('Saved animation scales are invalid');
      for (let i = 0; i < animationKeys.length; i++) {
        if (previous[i] === 'null') await adb(serial, ['shell', 'settings', 'delete', 'global', animationKeys[i]]);
        else await putSetting(serial, 'global', animationKeys[i], previous[i]);
      }
      rmSync(file);
    } else {
      const current = await Promise.all(animationKeys.map(k => setting(serial, 'global', k)));
      if (current.every(v => v !== 'null' && Number(v) === 0)) for (const key of animationKeys) await putSetting(serial, 'global', key, '1');
    }
  }

}
export async function resetSettings(serial: string, identity = serial): Promise<void> {
  const { supported } = await getSettings(serial);
  const defaults = { appearance: 'light', textSize: 'default', boldText: false, increaseContrast: false, reduceMotion: false } as const;
  await setSettings(serial, Object.fromEntries(Object.entries(defaults).filter(([k]) => supported.includes(k as import('../core/types.ts').SettingKey))), identity);
}

const KEYMAP: Record<string, string> = {
  home: 'KEYCODE_HOME', back: 'KEYCODE_BACK', enter: 'KEYCODE_ENTER', delete: 'KEYCODE_DEL', backspace: 'KEYCODE_DEL',
  tab: 'KEYCODE_TAB', escape: 'KEYCODE_ESCAPE', space: 'KEYCODE_SPACE', up: 'KEYCODE_DPAD_UP', down: 'KEYCODE_DPAD_DOWN',
  left: 'KEYCODE_DPAD_LEFT', right: 'KEYCODE_DPAD_RIGHT', volume_up: 'KEYCODE_VOLUME_UP', volume_down: 'KEYCODE_VOLUME_DOWN',
  power: 'KEYCODE_POWER', lock: 'KEYCODE_SLEEP', wake: 'KEYCODE_WAKEUP', app_switch: 'KEYCODE_APP_SWITCH', menu: 'KEYCODE_MENU',
  search: 'KEYCODE_SEARCH', siri: 'KEYCODE_ASSIST', assist: 'KEYCODE_ASSIST', screenshot: 'KEYCODE_SYSRQ',
  forward_delete: 'KEYCODE_FORWARD_DEL', camera: 'KEYCODE_CAMERA',
};
export function androidKeycode(key: KeyName): string {
  const k = String(key);
  if (/^KEYCODE_[A-Z0-9_]+$/.test(k) || /^\d+$/.test(k)) return k;
  const m = KEYMAP[k.toLowerCase()];
  if (m) return m;
  if (/^[a-z0-9]$/i.test(k)) return `KEYCODE_${k.toUpperCase()}`;
  throw new PhoneDockError('The key is not recognized', 'bad_key', 400, ['Choose a supported key.'], `Unknown key ${JSON.stringify(k)}. Use one of: ${Object.keys(KEYMAP).join(', ')} or a raw KEYCODE_* name`);
}

/** Escape text for `input text`: %s for spaces, backslash-escape shell specials. ASCII only. */
export function escapeInputText(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === ' ') out += '%s';
    else if (/[\\'"`$&|;<>()*~!?#\[\]{}^]/.test(ch)) out += '\\' + ch;
    else out += ch;
  }
  return out;
}

// ── UI tree parsing (uiautomator XML) ───────────────────────────────────────────
function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_m, e: string) => {
    if (e === 'amp') return '&'; if (e === 'lt') return '<'; if (e === 'gt') return '>';
    if (e === 'quot') return '"'; if (e === 'apos') return "'";
    const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : '';
  });
}

interface RawNode { attrs: Record<string, string>; children: RawNode[] }

export function parseUiautomatorXml(xml: string): RawNode[] {
  const roots: RawNode[] = []; const stack: RawNode[] = [];
  const re = /<node\b([^>]*?)(\/?)>|<\/node>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[0] === '</node>') { stack.pop(); continue; }
    const attrs: Record<string, string> = {};
    const are = /([\w:-]+)="([^"]*)"/g; let a: RegExpExecArray | null;
    while ((a = are.exec(m[1]))) attrs[a[1]] = decodeEntities(a[2]);
    const node: RawNode = { attrs, children: [] };
    if (stack.length) stack[stack.length - 1].children.push(node); else roots.push(node);
    if (m[2] !== '/') stack.push(node);
  }
  return roots;
}

function parseBounds(b?: string): Bounds {
  const m = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(b ?? '');
  if (!m) return { x: 0, y: 0, width: 0, height: 0 };
  const x1 = +m[1], y1 = +m[2], x2 = +m[3], y2 = +m[4];
  return { x: x1, y: y1, width: Math.max(0, x2 - x1), height: Math.max(0, y2 - y1) };
}

/** The on-device helper appends `<pd-hints><pd-hint bounds="[l,t][r,b]"/>…</pd-hints>` before `</hierarchy>`: the
 *  fields whose AccessibilityNodeInfo.isShowingHintText() is true (empty, so their `text` is the hint). undefined =
 *  not reported (plain `uiautomator dump`). */
export function parseShowingHints(xml: string): Bounds[] | undefined {
  const i = xml.lastIndexOf('<pd-hints');
  if (i < 0) return undefined;
  const out: Bounds[] = [];
  for (const m of xml.slice(i).matchAll(/<pd-hint\b[^>]*\bbounds="([^"]*)"/g)) out.push(parseBounds(m[1]));
  return out;
}

/** Convert raw nodes → UiElement tree; drop empty non-interactive wrappers/leaves; assign refs e1..eN.
 *  Text fields: Android reports an empty field's hint as its text (and, on API 26+ dumps, also as `hint`). The hint
 *  becomes `placeholder`, and `text` is dropped while the hint is showing — per `showingHints` when the helper
 *  reported them, else when text equals the hint. */
export function rawToElements(nodes: RawNode[], showingHints?: Bounds[]): UiElement[] {
  const near = (a: Bounds, b: Bounds) => Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.width - b.width) <= 2 && Math.abs(a.height - b.height) <= 2;
  const conv = (n: RawNode): UiElement[] => {
    const kids = n.children.flatMap(conv);
    const a = n.attrs;
    const cls = a.class ?? 'node';
    const el: UiElement = {
      ref: '', type: cls.includes('.') ? cls.slice(cls.lastIndexOf('.') + 1) : cls,
      bounds: parseBounds(a.bounds),
    };
    if (a.text) el.text = a.text;
    if (a.hint) {
      el.placeholder = a.hint;
      const showing = showingHints ? showingHints.some((b) => near(b, el.bounds)) : a.text === a.hint;
      if (showing && (a.text === a.hint || !a.text)) delete el.text;
    }
    if (a['content-desc']) el.label = a['content-desc'];
    if (a['resource-id']) el.id = a['resource-id'];
    const t = (k: string) => a[k] === 'true';
    if (t('clickable') || t('long-clickable')) el.clickable = true;
    if (a.enabled === 'false') el.enabled = false;
    if (t('focused')) el.focused = true;
    if (t('selected')) el.selected = true;
    if (t('checkable')) el.checked = t('checked');
    if (t('scrollable')) el.scrollable = true;
    if (t('checked')) el.value = 'checked';
    const meaningful = !!(el.text || el.label || el.id || el.placeholder || el.clickable || el.scrollable || el.focused || a.focusable === 'true' && /Edit/.test(cls));
    if (!meaningful) {
      if (kids.length === 0) return [];
      if (kids.length === 1) return kids;
    }
    if (el.bounds.width === 0 && el.bounds.height === 0 && !kids.length) return [];
    if (kids.length) el.children = kids;
    return [el];
  };
  const roots = nodes.flatMap(conv);
  let i = 0;
  const assign = (els: UiElement[]) => { for (const e of els) { e.ref = `e${++i}`; if (e.children) assign(e.children); } };
  assign(roots);
  return roots;
}

// ── PNG helpers ─────────────────────────────────────────────────────────────────
export function pngSize(png: Buffer): { width: number; height: number } | undefined {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return undefined;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

// ── Common ops (both backends) ──────────────────────────────────────────────────
export async function screenshot(serial: string): Promise<Buffer> {
  const r = await adbBuf(serial, ['exec-out', 'screencap', '-p'], { timeoutMs: 20_000 });
  if (!pngSize(r.stdout)) throw new PhoneDockError("Couldn’t take a screenshot", 'screenshot_failed', 500, ["Make sure the device is fully started and unlocked."], [`screencap returned no PNG (${r.stdout.length} bytes): ${r.stderr.trim()}`, ...['Is the device fully booted and unlocked?']].filter(Boolean).join('\n'));
  noteScreenshot(serial, r.stdout);
  return r.stdout;
}

/** How the display is turned, from the window manager: `dumpsys window displays` has "cur=2424x1080" (the logical
 *  size as turned, = screencap, uiautomator and `input` coordinates) and DisplayRotation's "mRotation=1". That is the
 *  one source of truth. `dumpsys input` only follows, and lists one viewport per touch device: an emulator has a dozen
 *  virtio touch devices, only one bound to the display, in no fixed order, so its first "Viewport INTERNAL" line said
 *  orientation=0 on some boots while the screen was landscape (rotate reported "stays in portrait", screenshots came
 *  from the unturned framebuffer, taps went to the wrong place). It stays as the fallback for old releases, reading
 *  only the viewport of display 0 / the active one. */
export const ROTATION_GREP = 'w=$(dumpsys window displays 2>/dev/null | grep -m5 -E "cur=[0-9]+x[0-9]+|mRotation=[0-9]|mFixedRotationLaunchingApp=|mCurrentAppOrientation="); echo "$w"; '
  + 'case "$w" in *mRotation=*) ;; *) dumpsys input 2>/dev/null | grep -E "SurfaceOrientation|Viewport INTERNAL";; esac';
export function parseRotation(out: string): number {
  const wm = /\bmRotation=(\d)\b/.exec(out);
  if (wm) return Number(wm[1]);
  const vps = [...out.matchAll(/Viewport INTERNAL:([^\n]*)/g)].map((m) => m[1]);
  const vp = vps.find((l) => /isActive=\[1\]/.test(l)) ?? vps.find((l) => /displayId=0\b/.test(l)) ?? vps.find((l) => !/deviceSize=\[0, 0\]/.test(l));
  const o = vp ? /orientation=(\d)/.exec(vp) : null;
  if (o) return Number(o[1]);
  const so = [...out.matchAll(/SurfaceOrientation:\s*(\d)/g)].map((m) => Number(m[1]));
  return so.find((n) => n !== 0) ?? so[0] ?? 0;
}
/** An app is being launched with a "fixed rotation" (e.g. the portrait-only launcher after Home while the display
 *  is landscape): the display turns once that transition ends, so its rotation right now is about to change. */
export const rotationPending = (out: string): boolean => /mFixedRotationLaunchingApp=(?!null)\S/.test(out);
/** The orientation the app in front insists on ("mCurrentAppOrientation=SCREEN_ORIENTATION_NOSENSOR" is the
 *  launcher: the panel's natural one), or undefined when it lets the display turn. */
export function appFixedOrientation(out: string, natural: Orientation): Orientation | undefined {
  const m = /mCurrentAppOrientation=SCREEN_ORIENTATION_(\w+)/.exec(out); if (!m) return undefined;
  const v = m[1];
  if (/^(SENSOR_|REVERSE_|USER_)?PORTRAIT$/.test(v)) return 'portrait';
  if (/^(SENSOR_|REVERSE_|USER_)?LANDSCAPE$/.test(v)) return 'landscape';
  if (v === 'NOSENSOR') return natural;
  return undefined;
}
/** The display's current logical size ("cur=WxH" in `dumpsys window displays`), if the dump has it. */
export function parseCurrentSize(out: string): { width: number; height: number } | undefined {
  const m = /\bcur=(\d+)x(\d+)/.exec(out);
  return m ? { width: +m[1], height: +m[2] } : undefined;
}
export const orientationOf = (width: number, height: number): Orientation => (width > height ? 'landscape' : 'portrait');

// ── screen geometry ─────────────────────────────────────────────────────────────
// The screen as it is turned right now (= the size of a screenshot), per serial. Read with `wm size` + the display
// rotation; kept up to date by screenshots and the live stream, so Device.screen follows rotation without an adb
// call per device listing.
export interface ScreenState { info: ScreenInfo; rotation: number; at: number; pending?: boolean; fixed?: Orientation }
const screens = new Map<string, ScreenState>();
const screenReads = new Map<string, Promise<ScreenState | undefined>>();

/** Reads the screen size, density and rotation (and remembers them). */
export async function readScreen(serial: string): Promise<ScreenState> {
  const r = await adb(serial, ['shell', `wm size; wm density; ${ROTATION_GREP}`], { allowFail: true });
  const o = r.stdout;
  const size = /Override size:\s*(\d+)x(\d+)/.exec(o) ?? /Physical size:\s*(\d+)x(\d+)/.exec(o);
  const dens = /Override density:\s*(\d+)/.exec(o) ?? /Physical density:\s*(\d+)/.exec(o);
  const rotation = parseRotation(o);
  const cur = parseCurrentSize(o);
  if (!size && !cur) throw new PhoneDockError("Couldn’t read the screen size", 'device_unavailable', 409, undefined, `Could not read screen size: ${o.trim() || r.stderr.trim()}`);
  let w: number, h: number;
  if (cur) ({ width: w, height: h } = cur);   // already turned (and includes a `wm size` override)
  else { w = +size![1]; h = +size![2]; if (rotation === 1 || rotation === 3) [w, h] = [h, w]; }
  const st: ScreenState = { info: { width: w, height: h, scale: 1, density: dens ? +dens[1] : undefined, orientation: orientationOf(w, h) }, rotation, at: Date.now(), pending: rotationPending(o),
    fixed: appFixedOrientation(o, rotation % 2 ? orientationOf(h, w) : orientationOf(w, h)) };
  screens.set(serial, st);
  return st;
}

export async function screenInfo(serial: string): Promise<ScreenInfo> { return (await readScreen(serial)).info; }

/** The last known screen, without waiting on adb (the daemon reads it with screenInfo() once a device runs). */
export function knownScreen(serial: string): ScreenInfo | undefined { return screens.get(serial)?.info; }
/** The last screen read (size and rotation) and when, without waiting on adb. */
export function knownScreenState(serial: string): ScreenState | undefined { return screens.get(serial); }

/** A screenshot shows the screen as it is now: when its size disagrees with what we know, read the screen again. */
export function noteScreenshot(serial: string, png: Buffer) {
  const sz = pngSize(png); const s = screens.get(serial);
  if (!sz || !s) return;
  if (s.info.width === sz.width && s.info.height === sz.height) { s.at = Date.now(); return; }
  if (!screenReads.has(serial)) screenReads.set(serial, readScreen(serial).catch(() => undefined).finally(() => screenReads.delete(serial)));
}

/** Forget what we know about a serial's screen (it rebooted, or the serial now belongs to another device). */
export function forgetScreen(serial: string) { screens.delete(serial); }

const rnd = (n: number) => String(Math.round(n));

// ── input ───────────────────────────────────────────────────────────────────────
// Through the helper's session when it is up (one write on an open `adb shell`; it injects with the input manager
// like `cmd input`), else `adb shell input` (a new adb shell and process per call). Exactly once: an input the helper says it did not send goes to adb
// instead; one whose reply was lost is reported as delivery 'unknown' and never sent again.

/** adb failures where the command never reached the device. */
const ADB_UNREACHED = /device '?[^']*'? not found|device offline|no devices\/emulators|device unauthorized|device still authorizing|more than one device/i;
/** Run an `adb shell input …` command once; a failure says how far it got. */
async function adbInput(serial: string, args: string[], what: string): Promise<void> {
  try {
    await adb(serial, args, { failureMessage: `Couldn’t send the ${what}` });
  } catch (e) {
    const err = e instanceof PhoneDockError ? e : new PhoneDockError(`Couldn’t send the ${what}`, 'exec_failed', 500, undefined, (e as Error).message);
    err.delivery ??= ADB_UNREACHED.test(err.detail ?? '') ? 'not_sent' : 'unknown';
    if (err.delivery === 'unknown') err.hints = [...(err.hints ?? []), `The ${what} may have reached the device: look at the screen before sending it again.`];
    throw err;
  }
}
/** Helper first; adb when the helper has no session or says nothing was sent. */
async function sendInput(serial: string, helperCmd: string, fallback: () => Promise<void>, what: string, timeoutMs?: number): Promise<'helper' | 'adb'> {
  const r = await helperInput(serial, helperCmd, timeoutMs);
  if (r?.delivery === 'sent') return 'helper';
  if (r?.delivery === 'unknown') {
    throw new PhoneDockError(`The ${what} may or may not have reached the device`, 'delivery_unknown', 502,
      [`Look at the screen before sending the ${what} again: it may already have happened.`], `helper input "${helperCmd.split(' ')[0]}": ${r.detail ?? 'no reply'}`, 'unknown');
  }
  await fallback();
  return 'adb';
}

export async function tap(serial: string, x: number, y: number) {
  finite(x, y);
  await sendInput(serial, `tap ${rnd(x)} ${rnd(y)}`, () => adbInput(serial, ['shell', 'input', 'tap', rnd(x), rnd(y)], 'tap'), 'tap');
}
export async function swipe(serial: string, x1: number, y1: number, x2: number, y2: number, ms: number) {
  finite(x1, y1, x2, y2);
  const d = rnd(ms || 300);
  await sendInput(serial, `swipe ${rnd(x1)} ${rnd(y1)} ${rnd(x2)} ${rnd(y2)} ${d} 0`,
    () => adbInput(serial, ['shell', 'input', 'swipe', rnd(x1), rnd(y1), rnd(x2), rnd(y2), d], 'swipe'), 'swipe', (ms || 300) + 15_000);
}
/** A drag that rests `holdMs` at the end before lifting (no fling). Fallback: `input motionevent` steps in one shell. */
export async function drag(serial: string, x1: number, y1: number, x2: number, y2: number, ms: number, holdMs: number) {
  finite(x1, y1, x2, y2);
  await sendInput(serial, `swipe ${rnd(x1)} ${rnd(y1)} ${rnd(x2)} ${rnd(y2)} ${rnd(ms)} ${rnd(holdMs)}`, async () => {
    const steps = Math.max(4, Math.round(ms / 50));
    const pause = (Math.max(0, ms / steps - 10) / 1000).toFixed(3);
    const at = (i: number) => `${rnd(x1 + ((x2 - x1) * i) / steps)} ${rnd(y1 + ((y2 - y1) * i) / steps)}`;
    const cmd = [`input motionevent DOWN ${rnd(x1)} ${rnd(y1)} || exit 97`,
      ...Array.from({ length: steps }, (_v, i) => `sleep ${pause}; input motionevent MOVE ${at(i + 1)}`),
      `sleep ${(holdMs / 1000).toFixed(3)}; input motionevent MOVE ${rnd(x2)} ${rnd(y2)}; input motionevent UP ${rnd(x2)} ${rnd(y2)}`].join('; ');
    const r = await adb(serial, ['shell', cmd], { allowFail: true, timeoutMs: ms + holdMs + 30_000 });
    if (r.code === 0) return;
    if (r.code === 97) { await adbInput(serial, ['shell', 'input', 'swipe', rnd(x1), rnd(y1), rnd(x2), rnd(y2), rnd(ms)], 'swipe'); return; }   // no `input motionevent`: nothing was sent
    await adb(serial, ['shell', `input motionevent UP ${rnd(x2)} ${rnd(y2)}`], { allowFail: true });   // never leave a finger down
    throw new PhoneDockError('Couldn’t finish the drag', 'exec_failed', 500, ['It may have scrolled part of the way: look at the screen.'], `input motionevent exited ${r.code}: ${(r.stderr || r.stdout).trim().slice(0, 300)}`, 'unknown');
  }, 'drag', ms + holdMs + 15_000);
}
export async function longPress(serial: string, x: number, y: number, ms: number) {
  finite(x, y);
  const d = rnd(ms || 800);
  await sendInput(serial, `press ${rnd(x)} ${rnd(y)} ${d}`, () => adbInput(serial, ['shell', 'input', 'swipe', rnd(x), rnd(y), rnd(x), rnd(y), d], 'long press'), 'long press', (ms || 800) + 15_000);
}
// eslint-disable-next-line no-control-regex
const KEY_TYPEABLE = /^[\x20-\x7e\n]*$/;
export async function typeText(serial: string, text: string) {
  if (!text) return;
  if (!KEY_TYPEABLE.test(text)) {
    // Non-ASCII (emoji, accents, other scripts) has no key events: put it on the clipboard and paste. The helper sets
    // the clipboard itself, as the shell user (as scrcpy does), so this works on builds without `cmd clipboard`
    // (vivo's Android 15 has none); `cmd clipboard` is the fallback when the helper can't run.
    const viaHelper = await helperInputStarted(serial, `clip ${Buffer.from(text, 'utf8').toString('base64')}`, 10_000);
    let onClipboard = viaHelper?.delivery === 'sent';
    let why = viaHelper ? `helper: ${viaHelper.detail ?? viaHelper.delivery}` : 'helper: not running';
    if (!onClipboard) {
      const r = await adb(serial, ['shell', `cmd clipboard set-primary-clip ${shQuote(text)} 2>&1 || echo __NOCLIP__`], { allowFail: true });
      onClipboard = r.code === 0 && !/__NOCLIP__|Unknown|No shell command|Exception|usage/i.test(r.stdout);
      if (!onClipboard) why += `; cmd clipboard: ${(r.stdout + ' ' + r.stderr).trim()}`;
    }
    if (onClipboard) {
      await sendInput(serial, 'key KEYCODE_PASTE', () => adbInput(serial, ['shell', 'input', 'keyevent', 'KEYCODE_PASTE'], 'paste'), 'paste');
      return;
    }
    throw new PhoneDockError('Couldn’t type this text on this device', 'not_supported', 501,
      ['Characters outside plain ASCII go in by pasting, and the clipboard couldn’t be set.', 'Type it without emoji or accents.'],
      `Clipboard input failed. ${why}`, 'not_sent');
  }
  // ASCII: key events from the virtual keyboard map, all in one helper call; it stops at the first key that may not
  // have gone in (then delivery is unknown: never retyped blindly).
  const via = await sendInput(serial, `text ${Buffer.from(text, 'utf8').toString('base64')}`, async () => {}, 'text', 15_000 + text.length * 60);
  if (via === 'helper') return;
  let typed = 0;   // characters sent through adb so far: a failure after some went in is 'sent' (partly), never resent
  try {
    const lines = text.split('\n');
    for (let li = 0; li < lines.length; li++) {
      const line = lines[li];
      // Small chunks: long `input text` bursts drop characters when the IME/UI is busy (seen under load).
      for (let i = 0; i < line.length; i += 12) {
        // Note: `input text` turns a literal "%s" into a space (known adb limitation).
        const chunk = line.slice(i, i + 12);
        if (chunk.trim() === '') { for (let s = 0; s < chunk.length; s++) { await adbInput(serial, ['shell', 'input', 'keyevent', 'KEYCODE_SPACE'], 'text'); typed++; } continue; }
        await adbInput(serial, ['shell', `input text ${escapeInputText(chunk)}`], 'text');
        typed += chunk.length;
      }
      if (li < lines.length - 1) { await adbInput(serial, ['shell', 'input', 'keyevent', 'KEYCODE_ENTER'], 'text'); typed++; }
    }
  } catch (e) {
    if (typed && e instanceof PhoneDockError && e.delivery === 'not_sent') { e.delivery = 'sent'; e.message = `Typed only ${typed} of ${text.length} characters`; }
    throw e;
  }
}
export async function key(serial: string, k: KeyName) {
  const code = androidKeycode(k);
  await sendInput(serial, `key ${code}`, () => adbInput(serial, ['shell', 'input', 'keyevent', code], 'key press'), 'key press');
}

export async function uiTree(serial: string): Promise<UiTree> {
  const screenP = readScreen(serial).catch(() => undefined);
  let xml = '';
  // Fast path: the persistent helper (same XML, no fixed 1 s wait). Any failure → close it (one UiAutomation
  // connection per device) and use `uiautomator dump` as before.
  try {
    const d = await helperUiDump(serial);
    xml = d.xml;
    if (!d.idle) console.error(`[android] ${serial}: screen never went quiet for ${UI_QUIET_MS} ms within ${UI_QUIET_TIMEOUT_MS} ms; read it anyway`);
  } catch { xml = ''; await closeUiHelper(serial).catch(() => undefined); }
  for (let attempt = 0; attempt < 3 && !xml.includes('<hierarchy'); attempt++) {
    const r = await adb(serial, ['exec-out', 'uiautomator dump /sdcard/pd-ui.xml >/dev/null 2>&1; cat /sdcard/pd-ui.xml; rm -f /sdcard/pd-ui.xml'], { allowFail: true, timeoutMs: 30_000 });
    xml = r.stdout;
    if (!xml.includes('<hierarchy')) await sleep(400); // "could not get idle state" – retry
  }
  if (!xml.includes('<hierarchy')) throw new PhoneDockError('Couldn’t read the screen contents', 'ui_unavailable', 500, ['Try again when the screen is ready.'], `uiautomator dump failed (screen may be animating or secure): ${xml}\nUse /ui?ocrFallback=1`);
  const screen = await treeScreen(serial, await screenP, xml);
  return { source: 'accessibility', screen, ...describeDump(xml, screen), capturedAt: new Date().toISOString() };
}

/** The elements of the window the user is using, and the windows over it (android-windows.ts). A dump without the
 *  helper's window list is one root (the active window): all of it. */
export function describeDump(xml: string, screen: { width: number; height: number }): Pick<UiTree, 'root' | 'windows'> {
  const roots = parseUiautomatorXml(xml);
  const wins = parseHelperWindows(xml);
  const choice = wins ? chooseWindow(wins, roots.length, screen) : undefined;
  const root = rawToElements(choice ? roots.slice(choice.root, choice.root + 1) : roots, parseShowingHints(xml));
  return choice ? { root, windows: choice.windows } : { root };
}
/** The screen a dump was laid out on: the dump says its rotation (`<hierarchy rotation="1">`). When the screen read
 *  alongside it disagrees, the display turned meanwhile: read it again, so the tree and its screen always match. */
async function treeScreen(serial: string, st: ScreenState | undefined, xml: string): Promise<ScreenInfo> {
  const m = /<hierarchy[^>]*\brotation="(\d)"/.exec(xml);
  if (m && (!st || st.rotation !== +m[1])) st = await readScreen(serial).catch(() => st);
  return st?.info ?? { width: 0, height: 0, scale: 1 };
}

function aaptPath(): string | undefined {
  try {
    const bt = join(sdkRoot(), 'build-tools');
    const vers = readdirSync(bt).sort().reverse();
    for (const v of vers) { const p = join(bt, v, 'aapt'); if (existsSync(p)) return p; }
  } catch { /* ignore */ }
  return undefined;
}
export async function apkInfo(path: string): Promise<(AppInfo & { versionCode?: string }) | undefined> {
  const aapt = aaptPath(); if (!aapt) return undefined;
  const r = await run(aapt, ['dump', 'badging', path], { allowFail: true, timeoutMs: 30_000 });
  const m = /package: name='([^']+)'(?:.*?versionName='([^']*)')?/.exec(r.stdout);
  if (!m) return undefined;
  const label = /application-label:'([^']*)'/.exec(r.stdout);
  const code = /versionCode='(\d+)'/.exec(r.stdout)?.[1];
  return { id: m[1], version: m[2] || undefined, name: label?.[1], ...(code ? { versionCode: code } : {}) };
}

export async function installApp(serial: string, path: string): Promise<AppInfo | void> {
  if (!existsSync(path)) throw new PhoneDockError('Couldn’t find the file', 'not_found', 404, undefined, `File not found: ${path}`);
  if (!/\.(apk|apks|aab|xapk)$/i.test(path)) throw new PhoneDockError('The app file format is not supported', 'bad_request', 400, undefined, 'Android install accepts .apk, .apks, .aab, or .xapk files.');
  const r = await adb(serial, ['install', '-r', '-g', path], { timeoutMs: 300_000, allowFail: true });
  if (r.code !== 0 || !/Success/.test(r.stdout)) throw new PhoneDockError('Couldn’t install the app', 'install_failed', 500, undefined, `adb install failed: ${(r.stdout + r.stderr).trim().slice(-800)}`);
  const info = await apkInfo(path);
  if (!info) return undefined;
  const { versionCode, ...app } = info;
  // The APK's label is known now: seed the apps-list cache so the next listApps has the name without device work.
  if (app.name && versionCode) labelCache.set(labelKey(serial, app.id, versionCode), app.name);
  return app;
}
export async function uninstallApp(serial: string, id: string) {
  const r = await adb(serial, ['uninstall', id], { allowFail: true });
  if (!/Success/.test(r.stdout)) throw new PhoneDockError("Couldn’t uninstall the app", 'uninstall_failed', 500, undefined, `uninstall failed: ${(r.stdout + r.stderr).trim()}`);
}
// ── app labels for listApps ─────────────────────────────────────────────────
export interface PmPackage { id: string; path?: string; versionCode?: string }
/** `pm list packages -f --show-versioncode` lines: `package:<apk path>=<id> versionCode:<n>` (path and versionCode
 *  optional; the path itself may contain '='). */
export function parsePmPackages(out: string): PmPackage[] {
  const res: PmPackage[] = [];
  for (const raw of out.split('\n')) {
    const m = /^package:(?:(.+)=)?([A-Za-z0-9._]+)(?:\s+versionCode:(\d+))?\s*$/.exec(raw.trim());
    if (m) res.push({ id: m[2], ...(m[1] ? { path: m[1] } : {}), ...(m[3] ? { versionCode: m[3] } : {}) });
  }
  return res;
}
/** serial|package|versionCode → label ('' = the app has none / it could not be read). Updated apps get a new key. */
const labelCache = new Map<string, string>();
const labelKey = (serial: string, id: string, versionCode?: string) => `${serial}|${id}|${versionCode ?? '?'}`;
const labelJobs = new Map<string, Promise<void>>();
const labelsBrokenUntil = new Map<string, number>();
/** How long a list waits for labels it does not have yet; the rest arrive in the background for the next list. */
export const LABEL_WAIT_MS = 250;
export function labelCacheSize() { return labelCache.size; }

/** Resolve the labels of `pkgs` in the background: one job per device at a time, results cached per batch. */
function resolveLabels(serial: string, pkgs: PmPackage[]): Promise<void> {
  const running = labelJobs.get(serial);
  if (running) return running;
  if ((labelsBrokenUntil.get(serial) ?? 0) > Date.now()) return Promise.resolve();
  const todo = pkgs.filter((p) => p.path);
  const byPath = new Map(todo.map((p) => [p.path!, p]));
  const job = helperLabels(serial, [...byPath.keys()], (batch) => {
    for (const [apk, label] of batch) { const p = byPath.get(apk); if (p) labelCache.set(labelKey(serial, p.id, p.versionCode), label); }
  }).then(() => undefined, () => { labelsBrokenUntil.set(serial, Date.now() + 5 * 60_000); })
    .finally(() => { if (labelJobs.get(serial) === job) labelJobs.delete(serial); });
  labelJobs.set(serial, job);
  return job;
}

export async function listApps(serial: string, includeSystem = false): Promise<AppInfo[]> {
  const [third, all] = await Promise.all([
    adb(serial, ['shell', 'pm list packages -3 -f --show-versioncode 2>/dev/null || pm list packages -3']),
    includeSystem ? adb(serial, ['shell', 'pm list packages -f --show-versioncode 2>/dev/null || pm list packages']) : undefined,
  ]);
  const pk3 = parsePmPackages(third.stdout);
  const ids3 = new Set(pk3.map((p) => p.id));
  const pkgs = (all ? parsePmPackages(all.stdout) : pk3).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  // Labels: cached by package + versionCode; missing ones are read on the device in the background and waited for
  // only briefly, so a list is never slower than LABEL_WAIT_MS because of them (and never fails because of them).
  const missing = pkgs.filter((p) => !labelCache.has(labelKey(serial, p.id, p.versionCode)));
  if (missing.length && helperEnabled()) await Promise.race([resolveLabels(serial, missing), sleep(LABEL_WAIT_MS)]);
  return pkgs.map((p) => {
    const name = labelCache.get(labelKey(serial, p.id, p.versionCode));
    return { id: p.id, ...(name ? { name } : {}), system: !ids3.has(p.id) };
  });
}
const PKG_RE = /^[A-Za-z0-9._]+$/;
function checkPkg(id: string) { if (!PKG_RE.test(id)) throw new PhoneDockError('The package name is invalid', 'bad_request', 400, undefined, `Invalid package name ${JSON.stringify(id)}`); }
export async function launchApp(serial: string, id: string) {
  checkPkg(id);
  // monkey frees the rotation lock (`cmd window user-rotation` reads "free" afterwards): put back a lock that rotate()
  // set, or a landscape request made on the portrait-only home screen is lost when the app opens.
  const r = await adb(serial, ['shell', `l=$(cmd window user-rotation 2>/dev/null); monkey -p ${id} -c android.intent.category.LAUNCHER 1; case "$l" in "lock "[0-3]) cmd window user-rotation $l >/dev/null 2>&1;; esac`], { allowFail: true });
  if (/No activities found|monkey aborted|Error/i.test(r.stdout + r.stderr)) throw new PhoneDockError("Couldn’t launch the app", 'launch_failed', 500, ["Check that the app is installed."], [`Could not launch ${id}: ${(r.stdout + r.stderr).trim().slice(-400)}`, ...['Is the app installed? GET /apps']].filter(Boolean).join('\n'));
}
export async function terminateApp(serial: string, id: string) { checkPkg(id); await adb(serial, ['shell', 'am', 'force-stop', id]); }
export async function openUrl(serial: string, url: string) {
  const r = await adb(serial, ['shell', `am start -a android.intent.action.VIEW -d ${shQuote(url)}`], { allowFail: true });
  if (/Error/i.test(r.stdout + r.stderr)) throw new PhoneDockError("Couldn’t open the URL", 'open_url_failed', 500, undefined, `openUrl failed: ${(r.stdout + r.stderr).trim()}`);
}
export async function shell(serial: string, command: string): Promise<ExecResult> {
  return adb(serial, ['shell', command], { allowFail: true, timeoutMs: 120_000 });
}
export async function pushFile(serial: string, local: string, remote: string) {
  if (!existsSync(local)) throw new PhoneDockError("Couldn’t find the file", 'not_found', 404, undefined, `File not found: ${local}`);
  await adb(serial, ['push', local, remote], { timeoutMs: 600_000 });
}
export async function pullFile(serial: string, remote: string, local: string) { await adb(serial, ['pull', remote, local], { timeoutMs: 600_000 }); }
export async function logs(serial: string, opts: { lines?: number; filter?: string } = {}): Promise<string> {
  const n = Math.max(1, Math.min(opts.lines ?? 300, 20_000));
  const want = opts.filter ? n * 20 : n; // fetch more when filtering, then trim
  const r = await adb(serial, ['logcat', '-d', '-t', String(Math.min(want, 100_000))], { timeoutMs: 30_000, allowFail: true });
  let lines = r.stdout.split('\n');
  if (opts.filter) { const f = opts.filter.toLowerCase(); lines = lines.filter((l) => l.toLowerCase().includes(f)); }
  return lines.slice(-n).join('\n');
}
/** Quarter turns from the panel's natural orientation that show `orientation`, keeping the current turn if it already does. */
export function rotationFor(orientation: Orientation, current: { width: number; height: number; rotation: number }): number {
  const odd = current.rotation % 2 === 1;
  const naturalW = odd ? current.height : current.width, naturalH = odd ? current.width : current.height;
  const turned = (orientation === 'landscape') !== (naturalW > naturalH);   // a tablet is landscape unturned
  return turned ? (odd ? current.rotation : 1) : (odd ? 0 : current.rotation);
}
/** Lock the display to `orientation` and wait (≤3 s) for it to turn, then until two reads 200 ms apart agree (the
 *  window manager may still be applying it). Apps that fix their orientation (the phone home screen, many games)
 *  keep it: the lock then applies once such an app is gone. Returns the screen as it really is afterwards. */
export async function rotate(serial: string, orientation: Orientation): Promise<ScreenInfo> {
  const cur = await readScreen(serial);
  const r = rotationFor(orientation, { ...cur.info, rotation: cur.rotation });
  // Android 12+: `cmd window user-rotation`; 10–11: `set-user-rotation`. Older releases read the settings, which
  // newer ones no longer follow.
  const bad = '*nknown*|*rror*|*xception*|*sage:*';
  await adb(serial, ['shell', `o=$(cmd window user-rotation lock ${r} 2>&1); case "$o" in ${bad}) o=$(cmd window set-user-rotation lock ${r} 2>&1); case "$o" in ${bad}) settings put system accelerometer_rotation 0; settings put system user_rotation ${r};; esac;; esac`]);
  // Settled = no app launch is about to turn the display (Home just pressed, an app opening) and two reads agree.
  const deadline = Date.now() + 3000;
  let st = await readScreen(serial);
  // An app that insists on the other orientation (the launcher, a portrait-only app) won't turn: no need to wait.
  const done = (x: ScreenState) => !x.pending && (x.info.orientation === orientation || (x.fixed !== undefined && x.fixed !== orientation));
  while (!done(st) && Date.now() < deadline) { await sleep(150); st = await readScreen(serial); }
  for (let i = 0; i < 6; i++) {
    await sleep(200);
    const again = await readScreen(serial);
    const same = !again.pending && again.rotation === st.rotation && again.info.width === st.info.width && again.info.height === st.info.height;
    st = again;
    if (same) break;
  }
  return st.info;
}
export async function info(serial: string): Promise<Record<string, unknown>> {
  const r = await adb(serial, ['shell', 'getprop'], { allowFail: true });
  const props: Record<string, string> = {};
  for (const m of r.stdout.matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]/gm)) props[m[1]] = m[2];
  const keys = ['ro.product.model', 'ro.product.manufacturer', 'ro.product.brand', 'ro.product.device', 'ro.build.version.release',
    'ro.build.version.sdk', 'ro.build.version.security_patch', 'ro.build.fingerprint', 'ro.build.type', 'ro.product.cpu.abi',
    'ro.serialno', 'ro.boot.qemu.avd_name', 'ro.kernel.qemu', 'sys.boot_completed', 'persist.sys.locale', 'persist.sys.timezone'];
  const picked: Record<string, string> = {};
  for (const k of keys) if (props[k] !== undefined) picked[k] = props[k];
  let screen: ScreenInfo | undefined; try { screen = await screenInfo(serial); } catch { /* ignore */ }
  return { serial, props: picked, screen };
}

export async function getprop(serial: string, prop: string, timeoutMs = 5000): Promise<string> {
  const r = await adb(serial, ['shell', 'getprop', prop], { allowFail: true, timeoutMs });
  return r.code === 0 ? r.stdout.trim() : '';
}

// ── Live stream helpers (the stream itself: android-video.ts) ───────────────────
/** An access unit delimiter: written after each access unit fed to ffmpeg, its raw-h264 parser ends the picture at
 *  once instead of waiting for the next one (a still screen's only frame would otherwise never come out). */
export const H264_AUD = Buffer.from([0, 0, 0, 1, 9, 0xf0]);
export { startsWithStartCode };

/** "display state changed, now has orientation ROTATION_1, size (2424, 1080)" (Android 14+) or "orientation changed,
 *  now 1" (older): screenrecord saw the display turn. It keeps recording at its old size, letterboxed. */
export function parseDisplayChange(line: string): { rotation: number; width?: number; height?: number } | undefined {
  const m = /display state changed[^\n]*?ROTATION_(\d)(?:[^\n]*?size \((\d+), (\d+)\))?/.exec(line) ?? /orientation changed, now (?:ROTATION_)?(\d)/.exec(line);
  if (!m) return undefined;
  return { rotation: +m[1], ...(m[2] && m[3] ? { width: +m[2], height: +m[3] } : {}) };
}

/** PNG → JPEG (optionally downscaled so the longest side ≤ maxSize). Uses ffmpeg, falls back to sips. */
export async function pngToJpeg(png: Buffer, maxSize?: number, quality = 70): Promise<Buffer> {
  const sz = pngSize(png);
  const ff = ffmpegPath();
  const q = String(Math.max(2, Math.min(31, Math.round(31 - (quality / 100) * 29))));
  let vf: string[] = [];
  if (sz && maxSize && Math.max(sz.width, sz.height) > maxSize) {
    const k = Math.max(sz.width, sz.height) / maxSize;
    vf = ['-vf', `scale=${Math.max(2, Math.round(sz.width / k / 2) * 2)}:${Math.max(2, Math.round(sz.height / k / 2) * 2)}`];
  }
  if (ff) {
    const r = await runBuffer(ff, ['-loglevel', 'error', '-f', 'png_pipe', '-i', '-', ...vf, '-f', 'mjpeg', '-q:v', q, '-'], { input: png, timeoutMs: 20_000 });
    return r.stdout;
  }
  throw new PhoneDockError('Couldn’t convert the image to JPEG', 'ffmpeg_missing', 501, ['Install ffmpeg.'], 'ffmpeg not found; install with brew install ffmpeg');
}

/** Wait until a serial reports sys.boot_completed=1. */
export async function waitBootCompleted(serial: string, timeoutMs: number, isAlive?: () => string | undefined): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const dead = isAlive?.();
    if (dead) throw new PhoneDockError('The device failed to start', 'boot_failed', 500, undefined, dead);
    const v = await getprop(serial, 'sys.boot_completed', 4000).catch(() => '');
    if (v === '1') { forgetScreen(serial); return; }
    await sleep(1000);
  }
  throw new PhoneDockError('The device took too long to start', 'timeout', 504, undefined, `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${serial} to boot`);
}

// ═══ v0.2 additions ═════════════════════════════════════════════════════════════

function finite(...v: number[]) {
  if (v.some((n) => typeof n !== 'number' || !Number.isFinite(n))) throw new PhoneDockError('coordinates must be finite numbers', 'bad_request', 400);
}

/** `cmd input …` goes to InputManagerService over binder (~6 ms) instead of spawning app_process like `input` (~60 ms).
 *  Probed once per serial with a no-op key so callers never fall back after a partial success. */
const cmdInputCache = new Map<string, boolean>();
async function hasCmdInput(serial: string): Promise<boolean> {
  const c = cmdInputCache.get(serial); if (c !== undefined) return c;
  const r = await adb(serial, ['shell', 'cmd input keyevent KEYCODE_UNKNOWN 2>&1; echo "__RC=$?"'], { allowFail: true, timeoutMs: 10_000 });
  const ok = /__RC=0/.test(r.stdout) && !/Can't find service|No shell command|Unknown command|usage:/i.test(r.stdout);
  cmdInputCache.set(serial, ok);
  return ok;
}

// ── double tap ──────────────────────────────────────────────────────────────────
/** Two taps ~100 ms apart in one adb round trip (GestureDetector: 40 ms ≤ gap ≤ 300 ms). Verified: zooms Google Maps. */
export async function doubleTap(serial: string, x: number, y: number): Promise<void> {
  finite(x, y);
  const X = rnd(x), Y = rnd(y);
  await sendInput(serial, `dtap ${X} ${Y}`, async () => {
    const t = (await hasCmdInput(serial)) ? 'cmd input tap' : 'input tap';
    // With plain `input` each tap already costs ~60 ms of process start-up, so no extra sleep.
    const gap = t === 'cmd input tap' ? 'sleep 0.08; ' : '';
    await adbInput(serial, ['shell', `${t} ${X} ${Y}; ${gap}${t} ${X} ${Y}`], 'double tap');
  }, 'double tap');
}

// ── keyboard ────────────────────────────────────────────────────────────────────
/** True when the soft keyboard is on screen (`dumpsys input_method`: mInputShown / mImeWindowVis & IME_VISIBLE). */
export function imeShownFrom(dump: string): boolean {
  if (/mInputShown=true/.test(dump)) return true;
  const v = /mImeWindowVis=(\d+)/.exec(dump);
  return !!v && (Number(v[1]) & 2) !== 0;
}
/** One shell command: the IME's shown state and, when shown, its window frame (`frame=[l,t][r,b]`, display px as the
 *  screen is turned now). */
export const IME_PROBE = 'v=$(dumpsys input_method | grep -E "mInputShown=|mImeWindowVis="); echo "$v"; '
  + 'case "$v" in *mInputShown=true*|*mImeWindowVis=[2367]*) dumpsys window InputMethod | grep -m1 -oE "frame=\\[[0-9]+,[0-9]+\\]\\[[0-9]+,[0-9]+\\]";; esac';
/** The IME window frame from IME_PROBE output; undefined when not shown or not reported. */
export function imeFrameFrom(dump: string): { x: number; y: number; width: number; height: number } | undefined {
  if (!imeShownFrom(dump)) return undefined;
  const m = /frame=\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(dump);
  if (!m) return undefined;
  const [l, t, r, b] = m.slice(1).map(Number);
  return r > l && b > t ? { x: l, y: t, width: r - l, height: b - t } : undefined;
}
export async function keyboardShown(serial: string): Promise<boolean> {
  const r = await adb(serial, ['shell', 'dumpsys input_method | grep -E "mInputShown=|mImeWindowVis="'], { allowFail: true });
  return imeShownFrom(r.stdout);
}
/** Press BACK only if the IME reports itself shown (checked on-device in the same command, so a keyboard that
 *  closed in between never turns into a navigation BACK). No-op when no keyboard is up. */
export async function hideKeyboard(serial: string): Promise<void> {
  const r = await adb(serial, ['shell', 'if dumpsys input_method | grep -q "mInputShown=true"; then input keyevent 4; echo __PRESSED__; fi']);
  if (!r.stdout.includes('__PRESSED__')) return;
  for (let i = 0; i < 8; i++) { await sleep(150); if (!(await keyboardShown(serial))) return; }
  throw new PhoneDockError('The keyboard is still visible', 'keyboard_still_shown', 500, ['Tap outside the text field.'], 'The keyboard may ignore BACK.');
}

// ── foreground app ──────────────────────────────────────────────────────────────
const homeCache = new Map<string, { pkg: string; at: number }>();
const ACT_RE = /ActivityRecord\{\S+ u\d+ ([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)/;
const WIN_RE = /Window\{\S+ u\d+ ([A-Za-z0-9_.]+)\/([A-Za-z0-9_.$]+)\}/;

/** Parse dumpsys output → { pkg, activity } of the resumed activity (or focused window as a fallback). */
export function parseForeground(out: string): { pkg: string; activity: string } | undefined {
  const m = ACT_RE.exec(out) ?? WIN_RE.exec(out);
  if (!m) return undefined;
  return { pkg: m[1], activity: m[2].startsWith('.') ? m[1] + m[2] : m[2] };
}

/** Foreground app: topResumedActivity (dumpsys activity), else mCurrentFocus. null for the launcher / unknown. */
export async function foregroundApp(serial: string): Promise<(AppInfo & { activity?: string }) | null> {
  const hc = homeCache.get(serial);
  const needHome = !hc || Date.now() - hc.at > 120_000;
  const script = [
    "A=$(dumpsys activity activities 2>/dev/null | grep -m1 -E 'topResumedActivity=|mResumedActivity:|ResumedActivity:')",
    'echo "$A"',
    "if [ -z \"$A\" ]; then dumpsys window 2>/dev/null | grep -m1 -E 'mCurrentFocus=|mFocusedApp='; fi",
    ...(needHome ? ['echo __HOME__', 'cmd package resolve-activity --brief -c android.intent.category.HOME -a android.intent.action.MAIN 2>/dev/null | tail -1'] : []),
  ].join('\n');
  const r = await adb(serial, ['shell', script], { allowFail: true, timeoutMs: 20_000 });
  const [fgPart, homePart] = r.stdout.split('__HOME__');
  let home = hc?.pkg;
  if (homePart !== undefined) {
    const h = /^([A-Za-z0-9_.]+)\//m.exec(homePart.trim());
    if (h) { home = h[1]; homeCache.set(serial, { pkg: h[1], at: Date.now() }); }
  }
  const fg = parseForeground(fgPart);
  if (!fg) return null;
  if (fg.pkg === home || /\.FallbackHome$/.test(fg.activity)) return null;
  return { id: fg.pkg, activity: fg.activity };
}

// ── crashes: dropbox (data_app_crash, …) + logcat crash buffer ──────────────────
const DROPBOX_TAGS = ['data_app_crash', 'data_app_anr', 'data_app_native_crash', 'system_app_crash', 'system_app_anr', 'system_app_native_crash'];
const ENTRY_MARK = '@@PD_ENTRY';
const DROPBOX_SEP = '========================================';

interface ParsedCrash extends CrashReport { ms: number }

function summarizeCrashText(kind: CrashReport['kind'], lines: string[]): string {
  const text = lines.join('\n');
  if (kind === 'anr') {
    const subj = /^Subject: (.+)$/m.exec(text)?.[1] ?? /^ANR in .+$/m.exec(text)?.[0];
    return `ANR${subj ? `: ${subj}` : ''}`.slice(0, 300);
  }
  const sig = /signal \d+ \(SIG\w+\)[^\n]*/.exec(text)?.[0];
  if (sig) {
    const abort = /Abort message: '([^']*)'/.exec(text)?.[1];
    const f0 = /#00 pc [0-9a-f]+\s+(.+)$/m.exec(text)?.[1];
    return [sig.trim(), abort, f0 ? `@ ${f0.trim()}` : undefined].filter(Boolean).join(' · ').slice(0, 300);
  }
  // Java: first "Exception…" style line after the headers, plus the first "at" frame
  const exc = lines.find((l) => /^[\w$.]+(Exception|Error|Throwable)[\w$]*(:|$)/.test(l.trim()) || /^(Caused by: )?[a-z][\w$]*(\.[\w$]+)+: /.test(l.trim()));
  const frame = lines.find((l) => /^\s*at /.test(l));
  return [exc?.trim(), frame ? `@ ${frame.trim().replace(/^at /, '')}` : undefined].filter(Boolean).join(' ').slice(0, 300) || 'crash';
}

function kindOfTag(tag: string): CrashReport['kind'] { return /anr$/.test(tag) ? 'anr' : 'crash'; }

/** dumpsys dropbox -p -f <tag> output, split into entries (header, path, content lines). */
function splitDropbox(out: string, mark: string): { header: string; path?: string; lines: string[] }[] {
  const entries: { header: string; path?: string; lines: string[] }[] = [];
  for (const chunk of out.split(mark).slice(1)) {
    const lines = chunk.replace(/^\n/, '').split('\n');
    const header = lines.shift() ?? '';
    let path: string | undefined;
    if (lines[0]?.startsWith('/')) path = lines.shift();
    entries.push({ header, path, lines });
  }
  return entries;
}

function dropboxToCrash(e: { header: string; path?: string; lines: string[] }): ParsedCrash | undefined {
  const hm = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (\S+) \(/.exec(e.header);
  if (!hm) return undefined;
  const tag = hm[2];
  const pm = e.path ? /@(\d+)\./.exec(e.path) : null;
  const ms = pm ? Number(pm[1]) : Date.parse(hm[1].replace(' ', 'T'));
  const text = e.lines.join('\n');
  const proc = /^Process: (\S+)/m.exec(text)?.[1];
  const pkg = /^Package: ([A-Za-z0-9_.]+)/m.exec(text)?.[1];
  const kind = kindOfTag(tag);
  return {
    id: `dropbox:${tag}:${ms}`, ms, kind, process: proc, appId: pkg ?? proc?.replace(/:.*$/, ''),
    time: new Date(ms).toISOString(), summary: summarizeCrashText(kind, e.lines),
  };
}

const LOG_RE = /^\s*(\d+)\.(\d{3})\d*\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.+?)\s*: ?(.*)$/;
interface LogBlock { ms: number; pid: string; tag: string; lines: string[]; raw: string[] }

/** FATAL EXCEPTION (AndroidRuntime) and native tombstone (DEBUG "*** *** ***") blocks from `logcat -b crash -v epoch`. */
export function parseCrashLogcat(out: string): LogBlock[] {
  const blocks: LogBlock[] = []; let cur: LogBlock | undefined;
  for (const raw of out.split('\n')) {
    const m = LOG_RE.exec(raw);
    if (!m) continue;
    const [, sec, msec, pid, , , tag, msg] = m;
    const ms = Number(sec) * 1000 + Number(msec);
    const start = (tag === 'AndroidRuntime' && /^FATAL EXCEPTION/.test(msg)) || (tag === 'DEBUG' && /^\*\*\* \*\*\* \*\*\*/.test(msg));
    if (start) { cur = { ms, pid, tag, lines: [msg], raw: [raw] }; blocks.push(cur); continue; }
    if (cur && pid === cur.pid && tag === cur.tag) { cur.lines.push(msg); cur.raw.push(raw); }
  }
  return blocks;
}

function logBlockToCrash(b: LogBlock): ParsedCrash {
  const text = b.lines.join('\n');
  let proc = /^Process: ([^,\s]+)/m.exec(text)?.[1];
  if (!proc) proc = />>> (\S+) <<</.exec(text)?.[1];
  return {
    id: `logcat:${b.ms}:${b.pid}`, ms: b.ms, kind: 'crash', process: proc, appId: proc?.replace(/:.*$/, ''),
    time: new Date(b.ms).toISOString(), summary: summarizeCrashText('crash', b.lines),
  };
}

/** Host clock minus device clock (ms) from `date +%s.%N` sent at `sentAt` and answered at `receivedAt` (host ms).
 *  Emulator clocks drift from the Mac's (seconds behind is common, more after the Mac sleeps). 0 if unreadable. */
export function clockOffsetFrom(stdout: string, sentAt: number, receivedAt: number): number {
  const m = /^(\d{9,})(?:\.(\d+))?/.exec(stdout.trim());
  if (!m) return 0;
  const frac = m[2] ? Number(`0.${m[2]}`) : 0.5; // no %N support: whole seconds, assume mid-second
  return Math.round((sentAt + receivedAt) / 2 - (Number(m[1]) + frac) * 1000);
}
export async function deviceClockOffsetMs(serial: string): Promise<number> {
  const t0 = Date.now();
  const r = await adb(serial, ['shell', 'date +%s.%N'], { allowFail: true, timeoutMs: 5000 });
  return r.code === 0 ? clockOffsetFrom(r.stdout, t0, Date.now()) : 0;
}

/** Newest first. Dropbox entries win over the matching logcat crash-buffer block (same process, ≤5 s apart).
 *  `since` is a Mac (host) time; crash times are the device's clock, so the filter corrects for the clock offset. */
export async function listCrashes(serial: string, opts: { since?: string; appId?: string; limit?: number } = {}): Promise<CrashReport[]> {
  const since = opts.since ? Date.parse(opts.since) : undefined;
  if (opts.since && !Number.isFinite(since)) throw new PhoneDockError('The start time is invalid', 'bad_request', 400, undefined, `since must be an ISO time: ${opts.since}`);
  const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
  // Only the first 60 lines of each entry come back (ANR traces can be megabytes); getCrash returns the full text.
  const awk = `awk 'BEGIN{n=-1} $0=="${DROPBOX_SEP}"{print "${ENTRY_MARK}"; n=0; next} n>=0{n++; if(n<=60) print}'`;
  const script = `L=$(dumpsys dropbox 2>/dev/null); for t in ${DROPBOX_TAGS.join(' ')}; do case "$L" in *" $t ("*) dumpsys dropbox -p -f $t 2>/dev/null | ${awk};; esac; done`;
  const [db, lc, offset] = await Promise.all([
    adb(serial, ['shell', script], { allowFail: true, timeoutMs: 60_000 }),
    adb(serial, ['logcat', '-b', 'crash', '-d', '-v', 'epoch'], { allowFail: true, timeoutMs: 30_000 }),
    since !== undefined ? deviceClockOffsetMs(serial) : Promise.resolve(0),
  ]);
  const fromDropbox = splitDropbox(db.stdout, ENTRY_MARK).map(dropboxToCrash).filter((c): c is ParsedCrash => !!c);
  const fromLog = parseCrashLogcat(lc.stdout).map(logBlockToCrash)
    .filter((l) => !fromDropbox.some((d) => d.appId && d.appId === l.appId && Math.abs(d.ms - l.ms) <= 5000));
  let all = [...fromDropbox, ...fromLog];
  if (since !== undefined) all = all.filter((c) => c.ms + offset >= since);
  if (opts.appId) all = all.filter((c) => c.appId === opts.appId || c.process === opts.appId || c.process?.startsWith(`${opts.appId}:`));
  all.sort((a, b) => b.ms - a.ms);
  return all.slice(0, limit).map(({ ms: _ms, ...c }) => c);
}

export async function getCrash(serial: string, crashId: string): Promise<string> {
  let m = /^dropbox:([A-Za-z0-9_]+):(\d+)$/.exec(crashId);
  if (m) {
    const [, tag, ms] = m;
    const r = await adb(serial, ['shell', `dumpsys dropbox -p -f ${tag}`], { timeoutMs: 60_000, maxBuffer: 256 * 1024 * 1024 });
    const entries = splitDropbox(r.stdout.split(DROPBOX_SEP).join(ENTRY_MARK), ENTRY_MARK);
    const hit = entries.find((e) => e.path?.includes(`@${ms}.`)) ?? entries.find((e) => dropboxToCrash(e)?.id === crashId);
    if (!hit) throw new PhoneDockError('The crash report is no longer available', 'not_found', 404, undefined, `Crash ${crashId} is no longer in the dropbox`);
    return [hit.header, ...(hit.path ? [hit.path] : []), ...hit.lines].join('\n').trimEnd();
  }
  m = /^logcat:(\d+):(\d+)$/.exec(crashId);
  if (m) {
    const r = await adb(serial, ['logcat', '-b', 'crash', '-d', '-v', 'epoch'], { allowFail: true, timeoutMs: 30_000 });
    const b = parseCrashLogcat(r.stdout).find((x) => String(x.ms) === m![1] && x.pid === m![2]);
    if (!b) throw new PhoneDockError('The crash report is no longer available', 'not_found', 404, undefined, `Crash ${crashId} is no longer in the logcat crash buffer; the ring buffer is cleared on reboot`);
    return b.raw.join('\n');
  }
  throw new PhoneDockError('The crash report was not found', 'not_found', 404, ['Choose a crash report from the list.'], `Unknown crash id ${JSON.stringify(crashId)}; use an id from listCrashes`);
}

// ── recording ───────────────────────────────────────────────────────────────────
// Emulator: host-side `adb emu screenrecord start` (VP9 .webm, written by the emulator process) → ffmpeg → H.264 mp4.
// Physical (or emulator without ffmpeg): in-guest `screenrecord` to /sdcard, stopped with SIGINT (finalizes the mp4),
// then pulled. Both cap at 180 s (screenrecord's / the emulator's limit).

interface AndroidRecording {
  mode: 'emu' | 'device'; serial: string; outPath: string; tmp: string; startedAt: number; maxSeconds: number;
  webm?: string; remote?: string; child?: ChildProcess; exited?: Promise<number | null>;
  timer?: NodeJS.Timeout; finishing?: Promise<string>; done?: boolean;
}
const recordings = new Map<string, AndroidRecording>();

export async function startRecording(serial: string, outPath: string, opts: { maxSeconds?: number; emulator?: boolean } = {}): Promise<void> {
  const prev = recordings.get(serial);
  if (prev && !prev.done) throw new PhoneDockError('A recording is already running on this device', 'busy', 409, ['Stop it first']);
  recordings.delete(serial);
  const maxSeconds = Math.max(1, Math.min(Math.round(opts.maxSeconds ?? 180), 180));
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'pd-adbrec-'));
  const base = { serial, outPath, tmp, startedAt: Date.now(), maxSeconds };
  let rec: AndroidRecording | undefined;
  if (opts.emulator && ffmpegPath()) {
    const webm = join(tmp, 'rec.webm');
    const r = await adb(serial, ['emu', 'screenrecord', 'start', '--time-limit', String(maxSeconds), webm], { allowFail: true, timeoutMs: 15_000 });
    if (/^OK/m.test(r.stdout) && !/KO/.test(r.stdout)) rec = { ...base, mode: 'emu', webm };
  }
  if (!rec) {
    const remote = `/sdcard/pd-rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.mp4`;
    const child = spawn(adbPath(), ['-s', serial, 'shell', 'screenrecord', '--time-limit', String(maxSeconds), '--bit-rate', '8000000', remote],
      { env: toolEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; const grab = (d: Buffer) => { if (out.length < 8000) out += d.toString(); };
    child.stdout!.on('data', grab); child.stderr!.on('data', grab);
    const exited = new Promise<number | null>((res) => { child.on('close', (c) => res(c)); child.on('error', () => res(-1)); });
    const early = await Promise.race([exited, sleep(1500).then(() => 'running' as const)]);
    if (early !== 'running') {
      rmSync(tmp, { recursive: true, force: true });
      throw new PhoneDockError("Couldn’t start recording", 'record_failed', 500, ["Make sure the screen is on and unlocked."], [`screenrecord failed to start (exit ${early}): ${out.trim().slice(-500)}`, ...['Is the screen on and unlocked? Secure windows cannot be recorded']].filter(Boolean).join('\n'));
    }
    rec = { ...base, mode: 'device', remote, child, exited };
  }
  // Finalize on our own once the time limit has passed, so the file exists even if nobody calls stop.
  rec.timer = setTimeout(() => { void finalizeRecording(rec!).catch(() => undefined); }, (maxSeconds + 3) * 1000);
  rec.timer.unref?.();
  recordings.set(serial, rec);
}

async function waitStable(file: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs; let last = -1; let same = 0;
  while (Date.now() < deadline) {
    const size = existsSync(file) ? statSync(file).size : -1;
    if (size > 0 && size === last) { if (++same >= 2) return; } else same = 0;
    last = size;
    await sleep(250);
  }
  if (!existsSync(file) || statSync(file).size === 0) throw new PhoneDockError('The emulator wrote no recording', 'record_failed', 502);
}

function finalizeRecording(rec: AndroidRecording): Promise<string> {
  if (rec.finishing) return rec.finishing;
  if (rec.timer) clearTimeout(rec.timer);
  const ranSeconds = Math.min((Date.now() - rec.startedAt) / 1000, rec.maxSeconds);
  rec.finishing = (async () => {
    const { finalizeMp4, probeVideo } = await import('./ios-common.ts');
    try {
      let local: string;
      if (rec.mode === 'emu') {
        await adb(rec.serial, ['emu', 'screenrecord', 'stop'], { allowFail: true, timeoutMs: 15_000 });
        await waitStable(rec.webm!, 20_000);
        local = rec.webm!;
      } else {
        if (rec.child && rec.child.exitCode === null) {
          // SIGINT makes screenrecord write the moov atom; kill only *our* screenrecord (the live stream runs one too)
          await adb(rec.serial, ['shell', `pkill -INT -f ${shQuote(rec.remote!)}`], { allowFail: true, timeoutMs: 10_000 });
          const r = await Promise.race([rec.exited!, sleep(20_000).then(() => 'timeout' as const)]);
          if (r === 'timeout') { rec.child.kill('SIGKILL'); }
        }
        for (let i = 0; i < 20; i++) {
          const g = await adb(rec.serial, ['shell', `pgrep -f ${shQuote(rec.remote!)} || true`], { allowFail: true, timeoutMs: 10_000 });
          if (!g.stdout.trim()) break;
          await sleep(250);
        }
        local = join(rec.tmp, 'rec.mp4');
        await adb(rec.serial, ['pull', rec.remote!, local], { timeoutMs: 300_000 });
        await adb(rec.serial, ['shell', `rm -f ${shQuote(rec.remote!)}`], { allowFail: true });
      }
      // screenrecord writes frames only when the screen changes: hold the last one until recording stopped.
      await finalizeMp4(local, rec.outPath, rec.mode === 'device' ? { minSeconds: ranSeconds } : {});
      const info = await probeVideo(rec.outPath);
      if (info && !(info.duration && info.duration > 0)) throw new PhoneDockError("The recording is not playable", 'record_failed', 500, undefined, `Recording at ${rec.outPath} is not playable (ffprobe: ${JSON.stringify(info)})`);
      return rec.outPath;
    } finally {
      rec.done = true;
      rmSync(rec.tmp, { recursive: true, force: true });
    }
  })();
  return rec.finishing;
}

export async function stopRecording(serial: string): Promise<string> {
  const rec = recordings.get(serial);
  if (!rec) throw new PhoneDockError('No recording is running on this device', 'not_recording', 404);
  try { return await finalizeRecording(rec); } finally { recordings.delete(serial); }
}

// ── app data export / import ────────────────────────────────────────────────────
// Layout of outDir: data/ (= /data/data/<pkg>), external/ (= /sdcard/Android/data/<pkg>, if present),
// phonedock-appdata.json. Privileged access: adbd root, `su 0` (userdebug/eng, emulator google_apis images),
// Magisk-style `su -c`, else `run-as <pkg>` (debuggable apps only).

type PrivMode = 'adbd-root' | 'su0' | 'suc' | 'run-as';

async function privMode(serial: string, pkg: string): Promise<PrivMode> {
  const r = await adb(serial, ['shell', `id -u; echo __; su 0 id -u 2>/dev/null; echo __; run-as ${pkg} id -u 2>&1`], { allowFail: true, timeoutMs: 20_000 });
  const [me, su0, runas] = r.stdout.split('__').map((x) => x.trim());
  if (me === '0') return 'adbd-root';
  if (su0 === '0') return 'su0';
  if (/^\d+$/.test(runas ?? '')) return 'run-as';
  const suc = await adb(serial, ['shell', "su -c 'id -u' 2>/dev/null"], { allowFail: true, timeoutMs: 20_000 });
  if (suc.stdout.trim() === '0') return 'suc';
  throw new PhoneDockError('Couldn’t access the app’s private data', 'forbidden', 403, [
    'Use a debuggable build of the app.',
  ], `Cannot read ${pkg}'s private data: the device is not rooted and the app is not debuggable (${(runas ?? '').slice(0, 200)})\nEmulators with Google APIs images allow it (adb root / su); Google Play images and production phones do not. Debuggable builds of your own app work everywhere (android:debuggable / a debug build variant).`);
}

function privWrap(mode: PrivMode, pkg: string, cmd: string): string {
  switch (mode) {
    case 'adbd-root': return cmd;
    case 'su0': return `su 0 sh -c ${shQuote(cmd)}`;
    case 'suc': return `su -c ${shQuote(cmd)}`;
    case 'run-as': return `run-as ${pkg} sh -c ${shQuote(cmd)}`;
  }
}

/** adb … with stdout streamed into a file (exec-out merges remote stderr into stdout: redirect it remotely). */
function adbToFile(serial: string, args: string[], file: string, timeoutMs = 1_800_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const fd = openSync(file, 'w');
    const child = spawn(adbPath(), ['-s', serial, ...args], { env: toolEnv(), stdio: ['ignore', fd, 'pipe'] });
    closeSync(fd);
    let err = ''; child.stderr!.on('data', (d: Buffer) => { if (err.length < 4000) err += d.toString(); });
    const t = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('error', (e) => { clearTimeout(t); reject(new PhoneDockError('Couldn’t transfer app data', 'exec_failed', 500, undefined, `adb: ${e.message}`)); });
    child.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new PhoneDockError('Couldn’t transfer app data', 'exec_failed', 500, undefined, `adb ${args.join(' ')} exited ${code}: ${err.trim().slice(0, 2048)}`)); });
  });
}
/** Push a host file to a world-readable temp path on the device (readable under run-as too); returns the remote path. */
async function pushTemp(serial: string, file: string, tag: string): Promise<string> {
  const remote = `/data/local/tmp/pd-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tar`;
  const r = await adb(serial, ['push', file, remote], { allowFail: true, timeoutMs: 1_800_000 });
  if (r.code !== 0) throw new PhoneDockError("Couldn’t transfer the app data", 'import_failed', 500, undefined, `adb push failed: ${(r.stderr || r.stdout).trim().slice(-400)}`);
  await adb(serial, ['shell', `chmod 644 ${remote}`], { allowFail: true });
  return remote;
}

/** Linux uid of a package for user 0 (`cmd package list packages -U`, else dumpsys userId=). */
async function appUid(serial: string, pkg: string): Promise<string | undefined> {
  const r = await adb(serial, ['shell', `cmd package list packages -U --user 0 ${pkg} 2>/dev/null; dumpsys package ${pkg} | grep -m1 -E "userId=|appId="`], { allowFail: true });
  const esc = pkg.replace(/\./g, '\\.');
  return new RegExp(`^package:${esc} uid:(\\d+)`, 'm').exec(r.stdout)?.[1] ?? /(?:userId|appId)=(\d+)/.exec(r.stdout)?.[1];
}

async function requireInstalled(serial: string, pkg: string): Promise<void> {
  const r = await adb(serial, ['shell', `pm path ${pkg}`], { allowFail: true });
  if (!/^package:/m.test(r.stdout)) throw new PhoneDockError('The app is not installed', 'not_found', 404, undefined, `${pkg} is not installed`);
}

const hostTarEnv = () => ({ ...toolEnv(), COPYFILE_DISABLE: '1' });   // no AppleDouble ._ files from macOS bsdtar

async function hostExtract(tarFile: string, dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  // -p keeps modes (no umask); --no-same-owner because Android uids mean nothing on the Mac.
  const r = await run('/usr/bin/tar', ['-x', '-p', '--no-same-owner', '-f', tarFile, '-C', dir], { allowFail: true, timeoutMs: 1_800_000, env: hostTarEnv() });
  if (r.code !== 0) throw new PhoneDockError("Couldn’t extract the app data", 'export_failed', 500, undefined, `Extracting the app data failed: ${r.stderr.trim().slice(-500)}`);
}
async function hostCreate(dir: string, tarFile: string): Promise<void> {
  const r = await run('/usr/bin/tar', ['-c', '--no-mac-metadata', '--no-xattrs', '--no-acls', '--no-fflags', '-f', tarFile, '-C', dir, '.'], { allowFail: true, timeoutMs: 1_800_000, env: hostTarEnv() });
  if (r.code !== 0) throw new PhoneDockError("Couldn’t pack the app data", 'import_failed', 500, undefined, `Packing ${dir} failed: ${r.stderr.trim().slice(-500)}`);
}

export async function exportAppData(serial: string, pkg: string, outDir: string): Promise<void> {
  checkPkg(pkg);
  await requireInstalled(serial, pkg);
  const mode = await privMode(serial, pkg);
  await terminateApp(serial, pkg);
  const D = `/data/data/${pkg}`, E = `/sdcard/Android/data/${pkg}`;
  mkdirSync(outDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), 'pd-appdata-'));
  try {
    const tar = join(tmp, 'data.tar');
    await adbToFile(serial, ['exec-out', `${privWrap(mode, pkg, `tar -cf - -C ${D} . 2>/dev/null`)} 2>/dev/null`], tar);
    if (statSync(tar).size < 512) throw new PhoneDockError("Couldn’t read the app data", 'export_failed', 500, undefined, `Reading ${D} produced no archive (mode ${mode})`);
    rmSync(join(outDir, 'data'), { recursive: true, force: true });
    await hostExtract(tar, join(outDir, 'data'));
    rmSync(join(outDir, 'external'), { recursive: true, force: true });
    const ext = await adb(serial, ['shell', `[ -d ${E} ] && echo yes`], { allowFail: true });
    let hasExternal = false;
    if (ext.stdout.trim() === 'yes') {
      const etar = join(tmp, 'external.tar');
      await adbToFile(serial, ['exec-out', `tar -cf - -C ${E} . 2>/dev/null`], etar);
      if (statSync(etar).size >= 512) { await hostExtract(etar, join(outDir, 'external')); hasExternal = true; }
    }
    const v = await adb(serial, ['shell', `dumpsys package ${pkg} | grep -m2 -E "versionCode=|versionName="`], { allowFail: true });
    writeFileSync(join(outDir, 'phonedock-appdata.json'), JSON.stringify({
      format: 1, platform: 'android', appId: pkg, device: serial, exportedAt: new Date().toISOString(), method: mode,
      versionName: /versionName=(\S+)/.exec(v.stdout)?.[1], versionCode: /versionCode=(\d+)/.exec(v.stdout)?.[1],
      layout: { data: D, ...(hasExternal ? { external: E } : {}) },
    }, null, 2));
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

export async function importAppData(serial: string, pkg: string, fromDir: string): Promise<void> {
  checkPkg(pkg);
  const dataDir = join(fromDir, 'data');
  if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) throw new PhoneDockError("Couldn’t find the saved app data", 'not_found', 404, undefined, `${dataDir} not found (expected the layout written by exportAppData)`);
  await requireInstalled(serial, pkg);
  const mode = await privMode(serial, pkg);
  await terminateApp(serial, pkg);
  const D = `/data/data/${pkg}`, E = `/sdcard/Android/data/${pkg}`;
  const tmp = mkdtempSync(join(tmpdir(), 'pd-appdata-'));
  try {
    const tar = join(tmp, 'data.tar');
    await hostCreate(dataDir, tar);
    const remote = await pushTemp(serial, tar, 'appdata');
    // 1) remember the live owner/group + cache gid, wipe the contents (never the directory itself)
    const prep = await adb(serial, ['shell', privWrap(mode, pkg,
      `[ -d ${D} ] || { echo NODIR; exit 3; }; echo "IDS $(stat -c %u ${D}) $(stat -c %g ${D}) $(stat -c %g ${D}/cache 2>/dev/null)"; find ${D} -mindepth 1 -maxdepth 1 -exec rm -rf {} + ; echo WIPED`)], { allowFail: true, timeoutMs: 120_000 });
    const ids = /IDS (\d+) (\d+) ?(\d*)/.exec(prep.stdout);
    if (!ids || !prep.stdout.includes('WIPED')) { await adb(serial, ['shell', `rm -f ${remote}`], { allowFail: true }); throw new PhoneDockError("Couldn’t prepare the app data", 'import_failed', 500, undefined, `Preparing ${D} failed: ${(prep.stdout + prep.stderr).trim().slice(-400)}`); }
    // The package manager's uid wins over the directory's owner (a previous broken restore may have left junk).
    const uid = (await appUid(serial, pkg)) ?? ids[1];
    const gid = uid;
    const app = Number(uid) % 100_000;
    // u0_aNNN_cache = uid + 10000 (AID_CACHE_GID_START - AID_APP_START); system-uid apps keep their own gid
    const cacheGid = app >= 10_000 && app < 20_000 ? String(Number(uid) + 10_000) : (ids[3] || uid);
    // 2) unpack (exec-in returns no output, so push + extract to get tar's status). -o: ignore the Mac's uids.
    const out = await adb(serial, ['shell', `${privWrap(mode, pkg, `tar -xof ${remote} -C ${D} 2>&1; echo "__TAR=$?"`)}; rm -f ${remote}`], { allowFail: true, timeoutMs: 1_800_000 });
    if (!/__TAR=0/.test(out.stdout)) throw new PhoneDockError("Couldn’t extract the app data", 'import_failed', 500, undefined, `Extracting into ${D} failed: ${(out.stdout + out.stderr).trim().slice(-500)}`);
    // 3) ownership + SELinux labels (root only; under run-as the files already belong to the app)
    if (mode !== 'run-as') {
      const fix = await adb(serial, ['shell', privWrap(mode, pkg,
        `chown -R ${uid}:${gid} ${D} && for d in cache code_cache; do [ -d ${D}/$d ] && chown -R ${uid}:${cacheGid} ${D}/$d && chmod g+s ${D}/$d; done; restorecon -RFD ${D} && echo __FIXED`)], { allowFail: true, timeoutMs: 120_000 });
      if (!fix.stdout.includes('__FIXED')) throw new PhoneDockError("Couldn’t restore the app data permissions", 'import_failed', 500, undefined, `Restoring ownership/labels on ${D} failed: ${(fix.stdout + fix.stderr).trim().slice(-400)}`);
    }
    // 4) external app dir
    const extDir = join(fromDir, 'external');
    if (existsSync(extDir) && statSync(extDir).isDirectory()) {
      const etar = join(tmp, 'external.tar');
      await hostCreate(extDir, etar);
      const eremote = await pushTemp(serial, etar, 'appdata-ext');
      const eo = await adb(serial, ['shell', `mkdir -p ${E} && find ${E} -mindepth 1 -maxdepth 1 -exec rm -rf {} + ; tar -xof ${eremote} -C ${E} 2>&1; echo "__TAR=$?"; rm -f ${eremote}`], { allowFail: true, timeoutMs: 1_800_000 });
      if (!/__TAR=0/.test(eo.stdout)) throw new PhoneDockError("Couldn’t extract the app data", 'import_failed', 500, undefined, `Extracting into ${E} failed: ${(eo.stdout + eo.stderr).trim().slice(-500)}`);
    }
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

/** Current display rotation (SurfaceOrientation 0–3) and rotated screenshot size. */
export async function displayRotation(serial: string): Promise<{ width: number; height: number; rotation: number }> {
  const st = await readScreen(serial);
  return { width: st.info.width, height: st.info.height, rotation: st.rotation };
}
