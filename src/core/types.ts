// PhoneDock shared contract. Every backend implements `Backend`; the daemon exposes it over HTTP
// (see docs/API.md); the SDK, CLI, MCP server and macOS app only ever talk to the daemon.
//
// COORDINATES: every x/y/bounds in this contract is in *device screenshot pixels*, i.e. the pixel
// grid of the PNG returned by `screenshot()` at full size. Backends convert to their native space
// (e.g. iOS points = pixels / scale). Clients that downscale screenshots must scale back.

export type Platform = 'android' | 'ios' | 'linux' | 'other';
export type DeviceKind = 'virtual' | 'physical' | 'cloud';
export type DeviceState =
  | 'creating' | 'stopped' | 'booting' | 'running' | 'stopping'
  | 'offline' | 'unauthorized' | 'error' | 'unknown';

export type Capability =
  | 'boot' | 'shutdown' | 'delete' | 'clone' | 'snapshot'
  | 'screenshot' | 'stream' | 'uiTree' | 'ocr'
  | 'tap' | 'longPress' | 'swipe' | 'type' | 'key'
  | 'install' | 'apps' | 'launch' | 'openUrl'
  | 'shell' | 'files' | 'logs' | 'location' | 'push' | 'rotate' | 'clipboard' | 'root' | 'window'
  | 'record' | 'crashes' | 'appData' | 'doubleTap' | 'pinch' | 'appearance' | 'settings'
  | 'trace'    // performance trace of one app (startTrace/stopTrace)
  | 'video';   // live H.264 video (Backend.video, GET /v1/devices/:id/video)

/** System-wide light/dark appearance (iOS "Dark Appearance", Android night mode). */
export type Appearance = 'dark' | 'light';

export type { TextSizeInput, SettingsInput } from './device-settings.ts';
import type { SettingsInput } from './device-settings.ts';
export type SettingKey = keyof SettingsInput;
export interface DeviceSettings {
  appearance?: Appearance | 'unknown'; textSize?: number;
  textSizeNative?: { category?: string; font_scale?: number };
  boldText?: boolean; increaseContrast?: boolean; reduceMotion?: boolean;
  reduceTransparency?: boolean; colorFilter?: 'none' | 'grayscale' | 'invert';
}
export interface SettingsRead { settings: DeviceSettings; supported: SettingKey[] }
export interface SettingsResult extends SettingsRead { ok: boolean; previous: DeviceSettings; changed: SettingKey[] }


export interface Bounds { x: number; y: number; width: number; height: number }

export type Orientation = 'portrait' | 'landscape';

export interface ScreenInfo {
  width: number;        // screenshot pixels, as the screen is turned right now (a landscape screen is wider than tall)
  height: number;
  scale?: number;       // pixels per native unit (iOS points). 1 for Android.
  density?: number;     // Android dpi
  orientation?: Orientation; // width > height: 'landscape'
}

export interface DeviceSpec {
  backend: string;               // backend id, e.g. 'android-emulator'
  name: string;                  // human name, unique per backend
  image?: string;                // OsImage.id from listImages()
  profile?: string;              // HardwareProfile.id from listProfiles()
  cpus?: number;
  ramMB?: number;
  storageMB?: number;
  width?: number;
  height?: number;
  dpi?: number;
  network?: 'nat' | 'none';
  headless?: boolean;            // boot without a host window (default true)
  autoStart?: boolean;           // boot when the daemon starts (persistent devices)
  options?: Record<string, unknown>; // backend-specific (e.g. { gpu: 'host' }, { isoPath })
}

export interface Device {
  id: string;                    // stable PhoneDock id: `${backend}:${nativeId}`
  backend: string;
  nativeId: string;              // AVD name, simulator UDID, adb serial, VM name, cloud instance id
  name: string;
  platform: Platform;
  kind: DeviceKind;
  state: DeviceState;
  managed: boolean;              // created by PhoneDock (false = discovered/pre-existing)
  osVersion?: string;
  model?: string;
  connection?: 'local' | 'usb' | 'wifi' | 'remote';
  screen?: ScreenInfo;           // the size a screenshot has right now (follows rotation while the device runs)
  orientation?: Orientation;     // how the screen is turned now (from `screen`); filled in by the daemon
  spec?: Partial<DeviceSpec>;
  capabilities: Capability[];
  lease?: Lease | null;          // filled in by the daemon, not backends
  handoff?: Handoff | null;      // pending human handoff (request_human); filled in by the daemon, not backends
  error?: string;
  meta?: Record<string, unknown>; // backend extras (adb serial, console port, pid, …)
}

export interface OsImage {
  id: string;                    // opaque id passed back in DeviceSpec.image
  backend: string;
  platform: Platform;
  name: string;                  // "Android 16 (API 36) · Google APIs · arm64"
  version?: string;
  installed: boolean;
  usable?: boolean;              // false: installed but can't create devices here (`notes` says why). Absent = no known problem.
  profiles?: string[];           // HardwareProfile.ids this image can run (absent = all)
  sizeMB?: number;
  notes?: string;
}

export interface HardwareProfile {
  id: string;
  name: string;
  width?: number;
  height?: number;
  dpi?: number;
  ramMB?: number;
}

export interface UiElement {
  ref: string;                   // short handle valid until the next uiTree() for this device: "e1", "e2", …
  type: string;                  // Button, TextField, android.widget.TextView, …
  text?: string;
  label?: string;                // accessibility label / content-desc
  id?: string;                   // resource-id / accessibility identifier
  value?: string;
  /** Text fields: the hint/placeholder the field shows while it is empty. When set, `text`/`value` hold only
   *  what was typed (absent for an empty field), never the hint. */
  placeholder?: string;
  bounds: Bounds;                // screenshot pixels
  /** true: read from the screenshot by OCR and merged into an accessibility tree that was missing this text. */
  ocr?: boolean;
  clickable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  checked?: boolean;              // switches/checkboxes/toggles: on (true) / off (false); absent if not checkable
  scrollable?: boolean;
  children?: UiElement[];
}

export interface UiTree {
  source: 'accessibility' | 'ocr';
  screen: ScreenInfo;
  root: UiElement[];             // tree
  capturedAt: string;            // ISO time
  /** Filled in by the daemon's GET /ui (not by backends): the system prompt on screen, or null. */
  prompt?: SystemPrompt | null;
  /** Filled in by the daemon's GET /ui: OCR text merged into a partial tree (empty containers, empty web views).
   *  `regions`: the containers that had no content; `merged`: OCR elements added (marked `ocr: true`). */
  ocr?: { regions: Bounds[]; merged: number; ms: number; error?: string };
  /** Android (on-device helper): the windows on screen, top first, status and navigation bars left out. `root` is
   *  the one marked `described` (the window with input focus: the app, a system dialog, the pulled-down shade);
   *  the others are overlays it does not contain (keyboard, heads-up notification, unfocused system windows).
   *  Absent: not known (iOS, `uiautomator dump` fallback). */
  windows?: UiWindow[];
}

/** What a window is: 'app' (an app's window), 'dialog' (a system window with input focus), 'keyboard' (the input
 *  method; its top edge is bounds.y), 'notifications' (the pulled-down notification shade), 'heads_up' (a notification
 *  shown over the screen), 'pip' (picture-in-picture), 'system' (any other system window). */
export type UiWindowRole = 'app' | 'dialog' | 'keyboard' | 'notifications' | 'heads_up' | 'pip' | 'system';
export interface UiWindow {
  role: UiWindowRole;
  bounds: Bounds;                // screenshot pixels (for a heads-up: the card)
  package?: string;
  title?: string;
  focused?: boolean;             // has input focus
  described?: boolean;           // its contents are UiTree.root
  texts?: string[];              // overlays: what it says (up to 6 visible texts)
}

/** A system prompt / dialog recognised on screen by src/core/prompts.ts (detectPrompt). */
export type PromptKind =
  | 'passcode' | 'biometric' | 'allow_paste' | 'install_profile' | 'credentials' // needsHuman: true
  | 'permission' | 'alert';
export interface PromptButton {
  text: string;
  ref?: string;                  // accessibility ref (valid like /ui refs); absent for OCR
  bounds: Bounds;                // screenshot pixels
  role?: 'accept' | 'dismiss';   // what handle_alert's accept / dismiss would pick from
}
export interface SystemPrompt {
  kind: PromptKind;
  reason: string;                // one line: why it was classified this way
  buttons: PromptButton[];       // top-to-bottom, left-to-right
  needsHuman: boolean;           // true: an agent must not answer it (call request_human)
  title?: string;
  message?: string;
  source?: 'accessibility' | 'ocr';
}

export interface AppInfo {
  id: string;                    // package name / bundle id
  name?: string;
  version?: string;
  system?: boolean;
}

export interface Snapshot { name: string; createdAt?: string; sizeMB?: number }

/** A crash / ANR / jetsam report. `id` is opaque and passed back to getCrash(). */
export interface CrashReport {
  id: string;
  appId?: string;                // bundle id / package, when known
  process?: string;
  time?: string;                 // ISO
  kind?: 'crash' | 'anr' | 'jetsam' | 'other';
  summary?: string;              // one line: exception type / signal / first frame
}

export type KeyName =
  | 'home' | 'back' | 'enter' | 'delete' | 'tab' | 'escape' | 'space'
  | 'up' | 'down' | 'left' | 'right'
  | 'volume_up' | 'volume_down' | 'power' | 'lock' | 'app_switch' | 'menu' | 'search'
  | 'siri' | 'screenshot' | string; // backends may accept raw keycodes like "KEYCODE_CAMERA"

/** How a tap's target was found (find / tap text=…): logged with the tap so `flow save` can write `tap: <text>`. */
export interface TapSelector { text?: string; id?: string; type?: string; match?: 'contains' | 'exact' | 'regex'; index?: number }
export type InputAction =
  // label: what was aimed at; selector / element: how it was found and what it was. All three: activity log only.
  | { action: 'tap'; x: number; y: number; label?: string; selector?: TapSelector; element?: { type?: string; id?: string; editable?: boolean } }
  | { action: 'tap'; ref: string }                       // resolved by the daemon from the last uiTree
  | { action: 'longPress'; x: number; y: number; durationMs?: number }
  | { action: 'doubleTap'; x: number; y: number }
  | { action: 'pinch'; x: number; y: number; scale: number; durationMs?: number } // scale <1 pinch in, >1 zoom out→in
  | { action: 'swipe'; x1: number; y1: number; x2: number; y2: number; durationMs?: number }
  | { action: 'type'; text: string; secret?: boolean }   // secret: the action log stores '•••' + length; replay skips it
  | { action: 'key'; key: KeyName };

export interface ExecResult { stdout: string; stderr: string; code: number }

export interface Lease {
  owner: string;
  acquiredAt: string;
  expiresAt: string | null;      // null: held until released / handed back (app:human)
  ttlSec?: number;               // sliding lifetime: every call the owner makes on the device renews expiresAt (agents: default 600)
  stale?: boolean;               // the owner's process has exited; the next other owner that uses the device reclaims it
  preempted?: { owner: string; ttlSec?: number; at: string };   // app:human leases only: the agent the person took the device from; Hand Back returns it there if that session is still alive
  reclaimedFrom?: string;        // acquire responses only: this lease replaced a stale one held by that (exited) owner
}

/** An agent asking a human to do something on a device (Face ID, passcode, sign-in, CAPTCHA, …).
 *  Created by POST /v1/devices/:id/handoff; resolved by a human (app/CLI) via POST /v1/handoffs/:hid/resolve;
 *  pending ones become 'timeout' at expiresAt. Every change is emitted as SSE `event: handoff`. */
export type HandoffState = 'pending' | 'done' | 'cancelled' | 'timeout';
export interface Handoff {
  id: string;
  deviceId: string;
  reason: string;                // what the agent needs the human to do
  requestedBy: string;           // owner (X-PhoneDock-Owner) of the requester
  createdAt: string;             // ISO
  expiresAt: string;             // ISO
  state: HandoffState;
  note?: string;                 // human's note on resolve
  resolvedAt?: string;
  resolvedBy?: string;           // owner of the resolver ('app:human', 'cli:…'), or 'daemon' for timeouts
  leaseHolder?: string | null;   // who holds the device's lease: when requested, then (once resolved) right after
  returnLease?: boolean;         // the requester held the lease when it asked: if the person holds it when they finish
                                 // (done / cancelled), the lease goes back to the requester
  leaseReturned?: boolean;       // set on resolve when the daemon gave the lease back to the requester
}

/** One element found by POST /v1/devices/:id/find (coordinates = device screenshot pixels). */
export interface ElementMatch {
  ref?: string;                  // accessibility ref (valid like /ui refs); absent for OCR matches
  type: string;
  text?: string;
  label?: string;
  id?: string;
  value?: string;
  placeholder?: string;          // text fields: hint shown while empty (see UiElement.placeholder)
  bounds: Bounds;
  center: { x: number; y: number };   // tap point (centre; for a toggle row with an inner switch: the switch)
  clickable?: boolean;
  enabled?: boolean;
  focused?: boolean;
  checked?: boolean;
  editable?: boolean;            // text input (TextField, EditText, …)
  visible: boolean;              // centre on screen and not covered by the keyboard (or wholly by a floating bar)
  /** iOS: a bar floating over the content (the search field of iOS 26 Settings, a tab bar) covers the element's
   *  centre: `center` is then the middle of its part above the bar, or `visible` is false when nothing usable is. */
  coveredBy?: string;
  exact: boolean;                // text/id matched exactly (case-insensitive)
  score: number;                 // ranking: exact 4 + clickable 2 + visible 1 (+8 editable when filling)
  source: 'accessibility' | 'ocr';
}

/** `expect` on an input (POST /input, /fill, /swipe, /apps/:id/launch): what the screen should show afterwards.
 *  Exactly one of visible / gone / id / changed; `match` applies to text and id (default contains); timeoutMs
 *  defaults to 5000 (max 60000). A string is short for { visible: string }. */
export interface Expect {
  visible?: string;              // text that should appear (visible on screen)
  gone?: string;                 // text that should no longer be visible
  id?: string;                   // element id (Android resource-id / accessibility identifier) that should be visible
  changed?: boolean;             // true: the screen should change at all
  match?: 'contains' | 'exact' | 'regex';
  timeoutMs?: number;
}
/** How an `expect` went. outcome: 'verified' (met), 'screen_unchanged' (not met, and the screen never changed after the
 *  input), 'changed_not_found' (not met, but the screen changed). The input was sent either way. */
export interface ExpectReport {
  ok: boolean;
  outcome: 'verified' | 'screen_unchanged' | 'changed_not_found';
  expected: string;              // in words: '"Welcome" visible', '"Loading" gone', 'id submit visible', 'the screen to change'
  message: string;               // one sentence, e.g. 'Not verified: the screen changed, but "Welcome" never appeared (5.0 s).'
  elapsedMs: number;
  polls: number;
  changed: boolean | null;       // the screen changed after the input (null: it could not be read before the input)
  wasThere?: boolean;            // the target was already visible (visible / id) or present (gone) before the input
  match?: ElementMatch;          // visible / id: what was found
  summary?: string;              // not ok: what is on screen now
}

export interface Availability { ok: boolean; reason?: string; hints?: string[]; version?: string }

// ── performance traces (Backend.startTrace / stopTrace; daemon routes /trace/start|stop) ─────────────────────────
/** What to trace: one app on one device, for a bounded time. */
export interface TraceOptions {
  appId: string;                 // bundle id / package name
  template?: string;             // iOS: Instruments template name or .tracetemplate path (default "Time Profiler"); Android: ignored
  timeLimitSec: number;          // the recorder itself stops here (xctrace --time-limit, perfetto duration_ms), even if the daemon dies
  launch?: boolean;              // start the app first when it isn't running (default: fail with app_not_running)
}
/** Backend.startTrace resolves with this once recording has really begun. */
export interface TraceStarted {
  tool: 'xctrace' | 'perfetto';
  template: string;              // the template / config actually used
  instruments?: string[];        // iOS: instruments added to the template so the summary can be built (e.g. ["Hangs"])
  process?: { pid?: number; name?: string };
  launched?: boolean;            // the app was started for this trace
  hostPid?: number;              // the recorder process on this Mac (xctrace), so a later daemon can stop an orphan
}
/** Hangs on the main thread, by Apple's tiers (xctrace triage --style hangs). */
export interface TraceHangs {
  count: number; totalMs: number; longestMs: number;
  byType: { severe: number; hang: number; microhang: number; brief: number; delay: number }; // >2 s, >500, >250, >100, >33 ms
}
/** One heavy function on the main thread (Time Profiler weight). */
export interface TraceHotspot { symbol: string; library?: string; ms: number; pct: number }
/** Frame stats for the trace window (Android: dumpsys gfxinfo, reset at start, read at stop). */
export interface TraceFrames {
  total: number; janky: number; jankyPct: number;
  p50Ms: number | null; p90Ms: number | null; p95Ms: number | null; p99Ms: number | null;
  missedVsync: number | null; slowUiThread: number | null; deadlineMissed: number | null; jankyLegacyPct: number | null;
}
/** Backend.stopTrace result: the files it wrote and the platform part of the summary (the daemon adds the rest). */
export interface TraceCapture {
  files: Record<string, string>; // at least { trace }; e.g. triage, toc, gfxinfo, log
  durationSec?: number;          // as the recorder measured it
  hangs?: TraceHangs | null;
  mainThreadMs?: number | null;  // iOS: main-thread CPU time sampled by Time Profiler
  hotspots?: TraceHotspot[];     // iOS: heaviest main-thread functions by self time (any library)
  appHotspots?: TraceHotspot[];  // iOS: heaviest main-thread functions in the app's own code (system callees charged to them)
  frames?: TraceFrames | null;
  triage?: string | null;        // iOS: `xctrace triage --style hangs --format markdown`, capped
  notes?: string[];              // what could not be measured, and why
}
/** The numbers to compare run to run. Every key is always present (null = not measured on this platform/trace). */
export interface TraceMetrics {
  durationSec: number;
  hangs: number | null; hangsTotalMs: number | null; hangsLongestMs: number | null;   // iOS
  mainThreadMs: number | null; topHotspotMs: number | null; topAppHotspotMs: number | null;  // iOS
  frames: number | null; jankyFrames: number | null; jankyPct: number | null;          // Android
  frameP50Ms: number | null; frameP90Ms: number | null; frameP95Ms: number | null; frameP99Ms: number | null;
}
/** This trace's metrics next to an earlier trace's (same device, app and template unless chosen). */
export interface TraceComparison {
  traceId: string;
  startedAt: string;
  changes: Record<string, { before: number | null; after: number | null; delta: number | null }>;  // keys: TraceMetrics
}
/** POST /v1/devices/:id/trace/stop → `summary` (also saved as summary.json next to the trace). Same keys every time. */
export interface TraceSummary {
  v: 1;
  traceId: string;
  deviceId: string; device: string; platform: Platform;
  appId: string;
  tool: 'xctrace' | 'perfetto';
  template: string;
  startedAt: string; endedAt: string;
  timeLimitSec: number;
  stopReason: string | null;     // null: stopped by the caller; else why it ended ("time limit (60 s) reached", "device shutdown", …)
  metrics: TraceMetrics;
  hangs: TraceHangs | null;
  hotspots: TraceHotspot[];      // [] on Android
  appHotspots: TraceHotspot[];
  frames: TraceFrames | null;    // null on iOS
  triage: string | null;
  compare: TraceComparison | null;
  files: Record<string, string>; // trace (the .trace / .perfetto-trace), summary (summary.json), + per-platform extras
  notes: string[];
}

/** How mature a backend is. Clients show a "Beta" / "Experimental" badge for anything but `stable` (the default when absent). */
export type BackendStage = 'stable' | 'beta' | 'experimental';

export interface BootOptions { headless?: boolean; coldBoot?: boolean; window?: boolean }

/** Live frame source. The daemon starts at most one per device and fans frames out. */
export interface FrameStream {
  /** Called with each encoded JPEG frame, and the device screen (screenshot pixels) it shows when the stream knows it. */
  onFrame(cb: (jpeg: Buffer, screen?: ScreenInfo) => void): void;
  onEnd(cb: (err?: Error) => void): void;
  stop(): void;
  /** Start capturing again at the screen's current size (after a rotation). Without it the daemon stops the stream. */
  restart?(): void;
}

/** Codec of a live video stream. */
export type VideoCodec = 'h264' | 'hevc';
/** What a live video source sends, in order (served as-is by `GET /v1/devices/:id/video`, docs/API.md "Live video").
 *  A new VideoStream, and the packets after every `reset`, start with what a decoder needs: `screen`, `config`, then a
 *  key frame and the frames after it (all but the newest marked `replay`: decode them, don't show them). */
export type VideoPacket =
  /** The device screen (screenshot pixels: what taps use) and the size of the encoded picture. Sent first and whenever
   *  either changes (rotation, a new encoder size). */
  | { type: 'screen'; screen: ScreenInfo; video: { width: number; height: number }; rotation?: number;
      /** The decoded picture, when it is larger than `video`: show only its top-left `video` part (an iPhone pads its
       *  picture without saying so in the SPS, e.g. 1328x2896 for a 1320x2868 screen). */
      coded?: { width: number; height: number } }
  /** Parameter sets (H.264: SPS + PPS; HEVC: VPS + SPS + PPS), Annex B (each NAL unit after 00 00 00 01). */
  | { type: 'config'; codec: VideoCodec; data: Buffer }
  /** One access unit (a picture), Annex B, without parameter sets. `at`: ms since the epoch when the daemon got it. */
  | { type: 'frame'; data: Buffer; key: boolean; at: number; replay?: boolean }
  /** `asleep`: the display is off, no frames until it wakes. `live`: frames flow again. */
  | { type: 'state'; state: 'live' | 'asleep' }
  /** Throw away the decoder's state: a fresh `screen`/`config`/key frame sequence follows. */
  | { type: 'reset' };

/** Live H.264/HEVC source. The daemon starts at most one per device and fans its packets out. */
export interface VideoStream {
  onPacket(cb: (p: VideoPacket) => void): void;
  onEnd(cb: (err?: Error) => void): void;
  stop(): void;
  /** The screen may have turned: start again at its current size if it did. */
  restart?(): void;
  /** A viewer needs a key frame soon (it joined while the frames since the last one were too many to replay). */
  requestKeyFrame?(): void;
}

export interface Backend {
  readonly id: string;           // 'android-emulator' | 'android-device' | 'ios-simulator' | 'ios-device' | 'qemu' | 'corellium'
  readonly displayName: string;
  /** Maturity; absent means `stable`. Served by `GET /v1/backends` (additive field). */
  readonly stage?: BackendStage;
  readonly platform: Platform;
  readonly kind: DeviceKind;
  /** Capabilities this backend generally supports (devices may narrow it). */
  readonly capabilities: Capability[];

  available(): Promise<Availability>;

  // ── inventory / lifecycle ──────────────────────────────────────────────
  listDevices(): Promise<Device[]>;
  listImages?(): Promise<OsImage[]>;
  installImage?(imageId: string, onProgress?: (line: string) => void): Promise<void>;
  listProfiles?(): Promise<HardwareProfile[]>;
  create?(spec: DeviceSpec, onProgress?: (line: string) => void): Promise<Device>;
  boot?(nativeId: string, opts?: BootOptions): Promise<void>;      // resolves when usable
  shutdown?(nativeId: string): Promise<void>;
  delete?(nativeId: string): Promise<void>;
  clone?(nativeId: string, newName: string): Promise<Device>;
  listSnapshots?(nativeId: string): Promise<Snapshot[]>;
  saveSnapshot?(nativeId: string, name: string): Promise<void>;
  restoreSnapshot?(nativeId: string, name: string): Promise<void>;
  deleteSnapshot?(nativeId: string, name: string): Promise<void>;
  openWindow?(nativeId: string): Promise<void>;                     // native low-latency viewer (Simulator.app / scrcpy / emulator window)

  // ── observation ────────────────────────────────────────────────────────
  screenshot(nativeId: string): Promise<Buffer>;                    // PNG, full resolution
  screenInfo?(nativeId: string): Promise<ScreenInfo>;
  stream?(nativeId: string, opts?: { maxSize?: number; fps?: number }): FrameStream;
  /** Live video straight from the device's encoder (additive; `GET /v1/devices/:id/video`). `maxSize` bounds the
   *  longer side of the encoded picture. Backends that have it share one capture between it and `stream()`. */
  video?(nativeId: string, opts?: { maxSize?: number }): VideoStream;
  uiTree?(nativeId: string): Promise<UiTree>;

  // ── input ──────────────────────────────────────────────────────────────
  tap(nativeId: string, x: number, y: number): Promise<void>;
  longPress?(nativeId: string, x: number, y: number, durationMs: number): Promise<void>;
  swipe(nativeId: string, x1: number, y1: number, x2: number, y2: number, durationMs: number): Promise<void>;
  type(nativeId: string, text: string): Promise<void>;
  key(nativeId: string, key: KeyName): Promise<void>;

  // ── apps / system ──────────────────────────────────────────────────────
  installApp?(nativeId: string, path: string): Promise<AppInfo | void>;
  uninstallApp?(nativeId: string, appId: string): Promise<void>;
  listApps?(nativeId: string): Promise<AppInfo[]>;
  launchApp?(nativeId: string, appId: string): Promise<void>;
  terminateApp?(nativeId: string, appId: string): Promise<void>;
  openUrl?(nativeId: string, url: string): Promise<void>;
  shell?(nativeId: string, command: string): Promise<ExecResult>;
  pushFile?(nativeId: string, localPath: string, remotePath: string): Promise<void>;
  pullFile?(nativeId: string, remotePath: string, localPath: string): Promise<void>;
  logs?(nativeId: string, opts?: { lines?: number; filter?: string }): Promise<string>;
  setLocation?(nativeId: string, lat: number, lon: number): Promise<void>;
  pushNotification?(nativeId: string, appId: string, payload: Record<string, unknown>): Promise<void>;
  /** Resolves once the screen has turned, or once it is clear the app on screen keeps its orientation. */
  rotate?(nativeId: string, orientation: Orientation): Promise<void>;
  info?(nativeId: string): Promise<Record<string, unknown>>;

  // ── v0.2 additions (all optional; the daemon returns 501 not_supported when absent) ──
  doubleTap?(nativeId: string, x: number, y: number): Promise<void>;          // daemon falls back to 2 taps
  /** A drag that rests `holdMs` at the end before lifting, so a list stops where the finger stopped (no fling):
   *  scroll_to's precise scrolls. Absent: the daemon uses swipe(). */
  drag?(nativeId: string, x1: number, y1: number, x2: number, y2: number, durationMs: number, holdMs: number): Promise<void>;
  pinch?(nativeId: string, x: number, y: number, scale: number, durationMs: number): Promise<void>;
  hideKeyboard?(nativeId: string): Promise<void>;
  /** The app in the foreground (null = home screen / launcher / unknown). */
  foregroundApp?(nativeId: string): Promise<AppInfo | null>;
  /** Newest first. `since` = ISO time filter. */
  listCrashes?(nativeId: string, opts?: { since?: string; appId?: string; limit?: number }): Promise<CrashReport[]>;
  getCrash?(nativeId: string, crashId: string): Promise<string>;               // full report text
  /** Start recording the screen to `outPath` (.mp4). One recording per device. */
  startRecording?(nativeId: string, outPath: string, opts?: { maxSeconds?: number }): Promise<void>;
  /** Stop and finalize; resolves with the file path once the mp4 is complete and playable. */
  stopRecording?(nativeId: string): Promise<string>;
  /** Copy one app's data container to `outDir` (a directory) / restore it from there. App is stopped first. */
  exportAppData?(nativeId: string, appId: string, outDir: string): Promise<void>;
  importAppData?(nativeId: string, appId: string, fromDir: string): Promise<void>;
  /** System-wide dark/light appearance. Android backends without these get `cmd uimode night` via shell(). */
  getAppearance?(nativeId: string): Promise<Appearance | 'unknown'>;
  setAppearance?(nativeId: string, mode: Appearance): Promise<void>;
  getSettings?(nativeId: string): Promise<SettingsRead>;
  setSettings?(nativeId: string, settings: SettingsInput): Promise<void>;
  resetSettings?(nativeId: string): Promise<void>;
  /** The device clipboard's (pasteboard's) plain text; null when it is empty or holds no text. Backends with these
   *  list the 'clipboard' capability. The text can be secret: never log it or put it in an error. */
  clipboardGet?(nativeId: string): Promise<string | null>;
  /** Replace the clipboard with `text` (plain text, may be ""). */
  clipboardSet?(nativeId: string, text: string): Promise<void>;

  // ── performance traces (optional; the daemon returns 501 not_supported when absent) ──
  /** Start tracing one app; files go into `dir` (an empty directory). One trace per device. Resolves once recording
   *  has begun. The recorder must stop by itself at `opts.timeLimitSec` so nothing outlives a crashed daemon. */
  startTrace?(nativeId: string, dir: string, opts: TraceOptions): Promise<TraceStarted>;
  /** Stop (or collect, if the time limit already ended it), finalize, check the file opens, and summarize. */
  stopTrace?(nativeId: string): Promise<TraceCapture>;
  /** Stop the recorder right away without summarizing (daemon exit). Never throws. */
  abortTrace?(nativeId: string): Promise<void>;
}

/** How far an input got. 'sent': it reached the device; 'not_sent': nothing reached it (sending it again is safe);
 *  'unknown': it may have reached it (the reply was lost): look at the screen before sending it again. */
export type Delivery = 'sent' | 'not_sent' | 'unknown';

/** Thrown by backends for expected failures; the daemon maps `status` to the HTTP status. */
export class PhoneDockError extends Error {
  status: number;
  code: string;
  hints?: string[];
  detail?: string;
  /** Input errors: how far the input got (the daemon fills it in for input routes when a backend leaves it out). */
  delivery?: Delivery;
  constructor(message: string, code = 'error', status = 400, hints?: string[], detail?: string, delivery?: Delivery) {
    super(message);
    this.code = code;
    this.status = status;
    this.hints = hints;
    this.detail = detail;
    if (delivery) this.delivery = delivery;
  }
}
