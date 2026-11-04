// PhoneDock TypeScript SDK: a typed client for the daemon HTTP API (docs/API.md).
// Discovery: $PHONEDOCK_HOME/daemon.json ({ port, token }); PHONEDOCK_PORT / PHONEDOCK_URL / PHONEDOCK_TOKEN override.
// With autoStart (default true) the client spawns the daemon detached when it isn't reachable.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AppInfo, BootOptions, Device, DeviceSpec, ExecResult, HardwareProfile, InputAction, KeyName, Lease,
  OsImage, Platform, ScreenInfo, Snapshot, UiTree, UiElement, Bounds, Availability, Capability, DeviceKind, DeviceState,
  CrashReport, ElementMatch, Handoff, HandoffState, PromptButton, PromptKind, SystemPrompt, Appearance, TapSelector,
  Delivery, Expect, ExpectReport, UiWindow, UiWindowRole,
  TraceSummary, TraceMetrics, TraceHangs, TraceHotspot, TraceFrames, TraceComparison,
} from '../core/types.ts';

export type {
  AppInfo, BootOptions, Device, DeviceSpec, ExecResult, HardwareProfile, InputAction, KeyName, Lease,
  OsImage, Platform, ScreenInfo, Snapshot, UiTree, UiElement, Bounds, Availability, Capability, DeviceKind, DeviceState,
  CrashReport, ElementMatch, Handoff, HandoffState, PromptButton, PromptKind, SystemPrompt, Appearance, TapSelector,
  Delivery, Expect, ExpectReport, UiWindow, UiWindowRole,
  TraceSummary, TraceMetrics, TraceHangs, TraceHotspot, TraceFrames, TraceComparison,
};

/** Every input result: how far it got (`delivery`: sent / not_sent), whether sending it again is safe (`retrySafe`:
 *  only when nothing was sent), and with `expect` the check of what the screen showed afterwards. */
export interface InputDelivery { delivery?: Delivery; retrySafe?: boolean; expect?: ExpectReport }
export interface InputResult extends InputDelivery { ok: boolean; resolved?: unknown }
/** Options of every input call: `expect` waits (after the input) for what the screen should show. */
export interface InputOptions { expect?: Expect | string }

/** Element query for find / waitFor / fill / tapText. `match` applies to text and id (default contains, case-insensitive). */
export interface FindOptions { text?: string; id?: string; type?: string; match?: 'contains' | 'exact' | 'regex'; index?: number; ocrFallback?: boolean; limit?: number }
export interface FindResult {
  source: 'accessibility' | 'ocr'; total: number; index: number; match: ElementMatch | null; matches: ElementMatch[];
  screen: ScreenInfo; capturedAt: string; ocrTried: boolean; summary?: string;
  /** No match only: can scrolling reveal more? true: something on screen scrolls; false: nothing does; null: can't tell. */
  scrollable?: boolean | null;
  /** Set when the OCR fallback was needed but failed (the result then reflects the accessibility tree only). */
  ocrError?: string;
}
export interface WaitForOptions extends Omit<FindOptions, 'index' | 'limit'> {
  until: 'visible' | 'gone' | 'idle'; timeoutMs?: number; intervalMs?: number; stableMs?: number;
}
export interface WaitForResult {
  ok: true; until: 'visible' | 'gone' | 'idle'; elapsedMs: number; polls?: number; frames?: number; changes?: number;
  source?: 'accessibility' | 'ocr'; match?: ElementMatch; matches?: ElementMatch[]; changedRegion?: Bounds | null; stableMs?: number;
}
/** Target the field by `ref` (from the last ui()/find()), by `text`/`id`/`type` (+ match/index), or by device-pixel `x`,`y`. */
export interface FillOptions extends Omit<FindOptions, 'limit'> {
  value: string; ref?: string; x?: number; y?: number; clear?: boolean; submit?: boolean; secret?: boolean; focusTimeoutMs?: number;
  expect?: Expect | string;
}
export interface FillResult extends InputDelivery {
  ok: true; via: 'ref' | 'text' | 'id' | 'point'; element: ElementMatch | null; label?: ElementMatch; tapped: { x: number; y: number };
  focused: boolean; keyboard: boolean; cleared: boolean; clearMethod?: string; previousValue?: string; finalValue?: string; finalLength?: number;
  verified: boolean | null; secret: boolean; submitted: boolean; warnings: string[]; elapsedMs: number;
}
/** POST /v1/devices/:id/flow (`flow save`): which part of the action log to turn into a flow. */
export interface SaveFlowOptions {
  /** ISO time or a duration back from now ("10m", "2h"). Default: the latest session (the owner's last lease, else
   *  everything after the last 15-minute pause). */
  since?: string; until?: string;
  /** Only this owner's actions (e.g. this client's `owner`; "mcp:*" for any MCP client). Default: everyone's. */
  owner?: string;
  name?: string; appId?: string;
  /** Checks to end the flow with: texts that must be visible ("!text": must not be), or steps such as
   *  `{ assert_text: { field: 'id:status', equals: 'On' } }`. Replaces the automatic final assertion. */
  assertions?: (string | Record<string, unknown>)[];
  /** Add assertions automatically after launches and at the end (default true). */
  autoAssert?: boolean;
  /** Keep taps that were undone (tap, then back to the same screen). Default false. */
  keepNoise?: boolean;
  format?: 'yaml' | 'json';
}
export interface SaveFlowResult {
  /** The flow (steps in PhoneDock's internal form) and its file text. */
  flow: { name: string; appId?: string; platform?: 'android' | 'ios'; minOS?: string; steps: Record<string, unknown>[]; recordedOn?: Record<string, string> };
  text: string; format: 'yaml' | 'json';
  warnings: string[]; dropped: string[];
  stats: { entries: number; observations: number; steps: number; assertions: number };
  range: { since: string | null; until: string; owner: string | null };
}
export interface FocusResult { known: boolean; ok: boolean; focused: ElementMatch | null; keyboard: boolean; elapsedMs: number; reason?: string }
export interface CrashText { id: string; text: string; truncated: boolean; length: number }
export interface RecordingStatus { active: boolean; path?: string; startedAt?: string; maxSeconds?: number; owner?: string }
export interface RecordingResult { ok: true; path: string; sizeBytes: number; durationSec: number; autoStopped?: boolean; warning?: string }
/** startTrace: `appId` = bundle id / package; `template` = Instruments template (iOS, default "Time Profiler");
 *  `timeLimitSec` default 60, max 600 (the recorder stops itself there); `launch` starts the app if it isn't running. */
export interface TraceStartOptions { appId: string; template?: string; timeLimitSec?: number; launch?: boolean }
export interface TraceStartResult {
  ok: true; active: true; traceId: string; appId: string; tool: 'xctrace' | 'perfetto'; template: string; instruments: string[];
  process: { pid?: number; name?: string } | null; launched: boolean; startedAt: string; timeLimitSec: number; dir: string;
}
/** stopTrace: `top` hot spots kept (default 5, max 25), `triageChars` of triage markdown (default 1200),
 *  `compareTo` an earlier traceId ("none" = no comparison; default: the previous trace of the same app + template). */
export interface TraceStopOptions { top?: number; triageChars?: number; compareTo?: string }
/** `summary` has the same keys every run (diff `summary.metrics`); `text` is a compact rendering for people/agents. */
export interface TraceStopResult { ok: true; traceId: string; text: string; summary: TraceSummary }
export interface TraceStatus {
  active: boolean; traceId?: string; appId?: string; template?: string | null; startedAt?: string; timeLimitSec?: number; owner?: string; ready?: boolean; dir?: string;
  finished?: { traceId: string; appId: string; endedAt: string; reason: string | null };
}
export type TraceListEntry = Pick<TraceSummary, 'traceId' | 'appId' | 'template' | 'startedAt' | 'metrics' | 'files'>;
export interface AppDataEntry { name: string; path: string; savedAt: string; sizeBytes: number; files: number }
/** scrollTo: `direction` is where to look (default 'down' = reveal what is below); x,y = device-pixel point to swipe around. */
export interface ScrollToOptions extends Omit<FindOptions, 'index' | 'limit'> {
  direction?: 'up' | 'down' | 'left' | 'right'; maxScrolls?: number; x?: number; y?: number; durationMs?: number; distance?: number;
}
export interface ScrollToResult extends InputDelivery {
  ok: true; found: boolean; element: ElementMatch | null; scrolls: number; direction: 'up' | 'down' | 'left' | 'right'; endReached: boolean;
  reason?: string; note?: string; source: 'accessibility' | 'ocr'; elapsedMs: number; summary?: string;
  swipe: { x1: number; y1: number; x2: number; y2: number; durationMs: number };
  /** The screen has nothing to scroll (answered without swiping; reason "nothing to scroll on this screen"). */
  nothingToScroll?: boolean;
  /** The Android keyboard was up and was hidden first, so no swipe landed on it. */
  keyboardHidden?: boolean;
  /** The scroll container the swipes ran in (null: the whole screen). */
  container?: { ref: string; type: string; id?: string; bounds: Bounds } | null;
}
/** swipeDirection: `direction` is the finger movement ('up' reveals what is below); placed inside the scroll container,
 *  never on the keyboard. */
export interface SwipeDirectionResult extends InputDelivery {
  ok: true; direction: 'up' | 'down' | 'left' | 'right'; swipe: { x1: number; y1: number; x2: number; y2: number; durationMs: number };
  container: { ref: string; type: string; id?: string; bounds: Bounds } | null; keyboardHidden?: boolean; elapsedMs: number;
}
/** Releasing a lease you don't hold is not an error: `released` is false and `note` / `heldBy` say why. */
export interface ReleaseResult { ok: true; released: boolean; heldBy?: string; note?: string }
export type SystemGesture = 'go_home' | 'app_switcher' | 'control_center' | 'notification_center';
export interface GestureResult extends InputDelivery { ok: true; gesture: SystemGesture; platform: Platform; method: string; elapsedMs: number }
/** method: 'key back' (Android), 'nav bar back button' (iOS, tapped) or 'left-edge swipe' (iOS without one). */
export interface BackResult extends InputDelivery { ok: true; method: string; tapped?: { ref?: string; text?: string; center: { x: number; y: number } }; elapsedMs: number }
export interface PromptResult { prompt: SystemPrompt | null; source: 'accessibility' | 'ocr' | null; capturedAt: string; text?: string; summary?: string }
/** handleAlert action: 'accept' | 'dismiss' | 'button=<label>' | { button: '<label>' }. */
export type AlertActionInput = 'accept' | 'dismiss' | `button=${string}` | { button: string };
export interface AlertResult {
  ok: true; action: 'accept' | 'dismiss' | 'button'; prompt: SystemPrompt;
  tapped: { text: string; ref?: string; role?: 'accept' | 'dismiss'; bounds: Bounds; x: number; y: number };
  dismissed: boolean | null; after: SystemPrompt | null; elapsedMs: number;
}

export const DEFAULT_PORT = 47420;

export interface Job {
  id: string;
  kind: string;
  state: 'running' | 'done' | 'failed';
  progress: string[];
  result?: unknown;
  /** Set when state is 'failed'. Older daemons sent a plain string. */
  error?: JobError | string;
  startedAt: string;
  endedAt?: string;
}
export interface JobError { code: string; message: string; hints?: string[]; detail?: string }

/** A failed job's error as one readable line: the message, then its hints. */
export function jobErrorText(error: Job['error']): string {
  if (!error) return '';
  if (typeof error === 'string') return error;
  // "… on this Mac" + "Download …": end each part with a full stop so they read as two sentences
  return [error.message, ...(error.hints ?? [])].map((s) => s.trim()).filter(Boolean).map((s) => (/[.!?…:]$/.test(s) ? s : `${s}.`)).join(' ');
}

export interface BackendInfo {
  id: string;
  displayName: string;
  /** Maturity: show a badge unless `stable`. Absent from older services (treat as `stable`). */
  stage?: 'stable' | 'beta' | 'experimental';
  platform: Platform;
  kind: DeviceKind;
  capabilities: Capability[];
  availability: Availability;
}

export interface HealthInfo { ok: boolean; version: string; pid: number; uptimeSec: number }

export interface DaemonInfo { port: number; token: string; pid?: number; version?: string; startedAt?: string }

export interface ScreenshotResult {
  data: Buffer;
  mime: string;
  deviceWidth: number;   // full-res device screenshot pixels
  deviceHeight: number;
  imageWidth: number;    // pixels of `data`
  imageHeight: number;
  scale: number;         // device px / image px (multiply image coords by this to get device coords)
}

export interface ActionRecord { at: string; owner?: string; action: InputAction | Record<string, unknown> }

export interface PhoneDockEvent { event: string; data: any; id?: string }

export interface WaitOptions { wait?: boolean; timeoutMs?: number; onProgress?: (line: string) => void }

export interface ClientOptions {
  baseUrl?: string;
  token?: string;
  owner?: string;
  autoStart?: boolean;
  /** Override the state dir (default $PHONEDOCK_HOME or ~/Library/Application Support/PhoneDock). */
  home?: string;
}

/** A matched element's visible name (text, else accessibility label), for activity-log labels. */
export function matchName(m: ElementMatch): string | undefined {
  const n = (m.text || m.label || '').trim();
  return n ? n.slice(0, 80) : undefined;
}

/** What to log with a tap aimed by a find query, so `flow save` can write `tap: <text>` instead of coordinates. */
export function tapMeta(q: { text?: string; id?: string; type?: string; match?: string; index?: number }, m: ElementMatch): { selector: TapSelector; element: { type?: string; id?: string; editable?: boolean } } {
  const selector: TapSelector = {};
  if (q.text) selector.text = q.text;
  if (q.id) selector.id = q.id;
  if (q.type) selector.type = q.type;
  if (q.match === 'exact' || q.match === 'regex') selector.match = q.match;
  if (q.index) selector.index = q.index;
  return { selector, element: { type: m.type, ...(m.id ? { id: m.id } : {}), ...(m.editable ? { editable: true } : {}) } };
}

export class PhoneDockApiError extends Error {
  code: string;
  status: number;
  hints: string[];
  detail?: string;
  /** Input calls: how far the input got; `retrySafe` is true only when nothing reached the device. */
  delivery?: Delivery;
  retrySafe?: boolean;
  constructor(message: string, code = 'error', status = 0, hints: string[] = [], detail?: string, delivery?: Delivery) {
    super(message);
    this.name = 'PhoneDockApiError';
    this.code = code;
    this.status = status;
    this.hints = hints;
    this.detail = detail;
    if (delivery) { this.delivery = delivery; this.retrySafe = delivery === 'not_sent'; }
  }
}

export function phonedockHome(): string {
  return process.env.PHONEDOCK_HOME ?? join(homedir(), 'Library', 'Application Support', 'PhoneDock');
}

export function readDaemonInfo(home = phonedockHome()): DaemonInfo | undefined {
  try {
    const port = Number(process.env.PHONEDOCK_PORT ?? 47420);
    const name = port === 47420 ? 'daemon.json' : `daemon-${port}.json`;
    const j = JSON.parse(readFileSync(join(home, name), 'utf8'));
    if (j && typeof j.port === 'number') return j as DaemonInfo;
  } catch { /* missing or partial */ }
  return undefined;
}

/** Where the daemon entry point lives (env, bundled next to the CLI, or the repo source). */
export function resolveDaemonEntry(): string | undefined {
  const cands: string[] = [];
  if (process.env.PHONEDOCK_DAEMON_ENTRY) cands.push(process.env.PHONEDOCK_DAEMON_ENTRY);
  const here = dirname(fileURLToPath(import.meta.url));
  cands.push(join(here, '..', 'daemon', 'phonedockd.mjs'));             // bundle: dist/{cli,daemon}/
  cands.push(join(here, 'phonedockd.mjs'));                             // bundle: same dir
  if (process.argv[1]) {
    const cliDir = dirname(process.argv[1]);
    cands.push(join(cliDir, '..', 'daemon', 'phonedockd.mjs'), join(cliDir, 'phonedockd.mjs'));
  }
  cands.push(join(here, '..', 'daemon', 'main.ts'));                    // repo: src/sdk → src/daemon
  return cands.find((c) => existsSync(c));
}

/** Log file the SDK redirects a spawned daemon's stdout/stderr to. */
export function daemonLogFile(home = phonedockHome()): string { return join(home, 'logs', 'daemon.log'); }

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const enc = encodeURIComponent;

function isConnError(e: unknown): boolean {
  const err = e as { cause?: { code?: string }; code?: string; name?: string };
  const code = err?.cause?.code ?? err?.code;
  return ['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH', 'UND_ERR_SOCKET'].includes(code ?? '') ||
    (err?.name === 'TypeError' && /fetch failed/i.test(String((e as Error).message)));
}

/** The connection was never opened (nothing was sent): the only failure after which an input may be sent again. */
function neverConnected(e: unknown): boolean {
  const code = (e as { cause?: { code?: string }; code?: string })?.cause?.code ?? (e as { code?: string })?.code;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(code ?? '');
}

type Query = Record<string, string | number | boolean | undefined | null>;
/** input: an input request. It is sent again (after starting the daemon) only when the connection was refused; a
 *  connection that broke after the request went out is a 'delivery unknown' error, never a resend. */
interface ReqOpts { query?: Query; body?: unknown; raw?: boolean; signal?: AbortSignal; noRetry?: boolean; input?: boolean }

export class PhoneDockClient {
  owner: string;
  autoStart: boolean;
  home: string;
  private explicitBaseUrl?: string;
  private explicitToken?: string;
  private daemonInfo?: DaemonInfo;
  private starting?: Promise<void>;

  constructor(opts: ClientOptions = {}) {
    this.home = opts.home ?? phonedockHome();
    this.explicitBaseUrl = (opts.baseUrl ?? process.env.PHONEDOCK_URL)?.replace(/\/+$/, '');
    this.explicitToken = opts.token ?? process.env.PHONEDOCK_TOKEN;
    this.owner = opts.owner ?? process.env.PHONEDOCK_OWNER ?? `sdk:${process.pid}`;
    this.autoStart = opts.autoStart ?? process.env.PHONEDOCK_NO_AUTOSTART !== '1';
  }

  // ── connection ─────────────────────────────────────────────────────────
  get port(): number {
    if (process.env.PHONEDOCK_PORT) return Number(process.env.PHONEDOCK_PORT);
    return this.loadInfo()?.port ?? DEFAULT_PORT;
  }

  get baseUrl(): string { return this.explicitBaseUrl ?? `http://127.0.0.1:${this.port}`; }

  get token(): string | undefined { return this.explicitToken ?? this.loadInfo()?.token; }

  private loadInfo(refresh = false): DaemonInfo | undefined {
    if (refresh || !this.daemonInfo) this.daemonInfo = readDaemonInfo(this.home);
    return this.daemonInfo;
  }

  /** URL with ?token= for <img>/MJPEG consumers. */
  url(path: string, query: Query = {}): string {
    const u = new URL(this.baseUrl + path);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== false) u.searchParams.set(k, String(v));
    return u.toString();
  }

  async health(): Promise<HealthInfo> { return this.request('GET', '/v1/health', { noRetry: true }); }

  async isRunning(): Promise<boolean> {
    try { const h = await this.health(); return !!h?.ok; } catch { return false; }
  }

  /** Make sure a daemon answers /v1/health, spawning one (detached) if needed. Waits up to 10s. */
  async ensureDaemon(timeoutMs = 10_000): Promise<void> {
    if (await this.isRunning()) { this.loadInfo(true); return; }
    if (this.explicitBaseUrl && !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(this.explicitBaseUrl)) {
      throw new PhoneDockApiError(`PhoneDock daemon at ${this.explicitBaseUrl} is not reachable`, 'daemon_unreachable', 0);
    }
    if (!this.starting) {
      this.starting = (async () => {
        const entry = resolveDaemonEntry();
        if (!entry) throw new PhoneDockApiError('Cannot find the PhoneDock daemon entry point', 'daemon_not_found', 0,
          ['Set PHONEDOCK_DAEMON_ENTRY to src/daemon/main.ts (repo) or phonedockd.mjs (bundle)']);
        const logFile = daemonLogFile(this.home);
        mkdirSync(dirname(logFile), { recursive: true });
        const fd = openSync(logFile, 'a');
        const env: NodeJS.ProcessEnv = { ...process.env, PHONEDOCK_HOME: this.home };
        if (!process.env.PHONEDOCK_PORT && this.explicitBaseUrl) {
          const p = new URL(this.explicitBaseUrl).port; if (p) env.PHONEDOCK_PORT = p;
        }
        const child = spawn(process.execPath, [entry], { detached: true, stdio: ['ignore', fd, fd], env, cwd: this.home });
        child.unref();
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
          await sleep(200);
          if (await this.isRunning()) { this.loadInfo(true); return; }
        }
        throw new PhoneDockApiError(`PhoneDock daemon did not become healthy within ${Math.round(timeoutMs / 1000)}s`, 'daemon_start_timeout', 0,
          [`See ${logFile}`, `Start it manually: node ${entry}`]);
      })().finally(() => { this.starting = undefined; });
    }
    return this.starting;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { 'X-PhoneDock-Owner': this.owner };
    const t = this.token; if (t) h.Authorization = `Bearer ${t}`;
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  /** Low-level request. Returns parsed JSON, text (text/*), or the Response when `raw`. */
  async request<T = any>(method: string, path: string, opts: ReqOpts = {}): Promise<T> {
    const doFetch = () => {
      const u = new URL(this.baseUrl + path);
      for (const [k, v] of Object.entries(opts.query ?? {})) {
        if (v === undefined || v === null) continue;
        u.searchParams.set(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v));
      }
      const hasBody = opts.body !== undefined;
      return fetch(u, { method, headers: this.headers(hasBody), body: hasBody ? JSON.stringify(opts.body) : undefined, signal: opts.signal });
    };
    let res: Response;
    try {
      res = await doFetch();
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
      const fresh = neverConnected(e);
      if (opts.input && !fresh) throw this.unreachable(e, 'unknown');
      if (!isConnError(e) || opts.noRetry) throw this.unreachable(e, opts.input ? 'not_sent' : undefined);
      if (!this.autoStart) throw this.unreachable(e, opts.input ? 'not_sent' : undefined);
      await this.ensureDaemon();
      try { res = await doFetch(); } catch (e2) { throw this.unreachable(e2, opts.input ? (neverConnected(e2) ? 'not_sent' : 'unknown') : undefined); }
    }
    if (res.status === 401 && !this.explicitToken && !opts.noRetry) {
      // Daemon restarted with a new token – re-read daemon.json once.
      const before = this.daemonInfo?.token;
      if (this.loadInfo(true)?.token !== before) res = await doFetch();
    }
    if (!res.ok) throw await this.toError(res);
    if (opts.raw) return res as unknown as T;
    const ct = res.headers.get('content-type') ?? '';
    if (res.status === 204) return undefined as T;
    if (ct.includes('application/json')) return (await res.json()) as T;
    const text = await res.text();
    if (!ct && text) { try { return JSON.parse(text) as T; } catch { /* plain text */ } }
    return text as unknown as T;
  }

  private unreachable(e: unknown, delivery?: Delivery): PhoneDockApiError {
    if (e instanceof PhoneDockApiError) return e;
    if (delivery === 'unknown') {
      return new PhoneDockApiError(`The connection to PhoneDock broke after the input was sent: ${(e as Error).message}`, 'daemon_unreachable', 0,
        ['The input may have reached the device: look at the screen before sending it again.'], undefined, 'unknown');
    }
    return new PhoneDockApiError(`PhoneDock daemon not reachable at ${this.baseUrl}: ${(e as Error).message}`, 'daemon_unreachable', 0,
      ['Start it with `phonedock daemon start`', 'Or set PHONEDOCK_PORT / PHONEDOCK_HOME to point at a running daemon'], undefined, delivery);
  }

  private async toError(res: Response): Promise<PhoneDockApiError> {
    const text = await res.text().catch(() => '');
    try {
      const j = JSON.parse(text);
      const e = j?.error ?? j;
      const dl = e?.delivery === 'sent' || e?.delivery === 'not_sent' || e?.delivery === 'unknown' ? e.delivery as Delivery : undefined;
      return new PhoneDockApiError(e?.message ?? `HTTP ${res.status}`, e?.code ?? `http_${res.status}`, res.status, Array.isArray(e?.hints) ? e.hints : [], typeof e?.detail === 'string' ? e.detail : undefined, dl);
    } catch {
      return new PhoneDockApiError(text.trim() || `HTTP ${res.status} ${res.statusText}`, `http_${res.status}`, res.status);
    }
  }

  private dev(id: string, sub = ''): string { return `/v1/devices/${enc(id)}${sub}`; }

  // ── service ────────────────────────────────────────────────────────────
  backends(): Promise<BackendInfo[]> { return this.request('GET', '/v1/backends'); }
  backendsDebug(): Promise<{ backends: BackendInfo[]; failures: { module: string; error: string }[] }> {
    return this.request('GET', '/v1/backends', { query: { debug: 1 } });
  }
  images(backend: string): Promise<OsImage[]> { return this.request('GET', `/v1/backends/${enc(backend)}/images`); }
  async installImage(backend: string, image: string, opts: WaitOptions = {}): Promise<Job> {
    const job = await this.request<Job>('POST', `/v1/backends/${enc(backend)}/images/install`, { body: { image } });
    return opts.wait === false ? job : this.waitJob(job.id, { timeoutMs: opts.timeoutMs ?? 60 * 60_000, onProgress: opts.onProgress });
  }
  profiles(backend: string): Promise<HardwareProfile[]> { return this.request('GET', `/v1/backends/${enc(backend)}/profiles`); }

  jobs(): Promise<Job[]> { return this.request('GET', '/v1/jobs'); }
  job(id: string): Promise<Job> { return this.request('GET', `/v1/jobs/${enc(id)}`); }

  /** Poll a job until done/failed. Throws PhoneDockApiError('job_failed') on failure. */
  async waitJob(id: string, opts: { timeoutMs?: number; intervalMs?: number; onProgress?: (line: string) => void } = {}): Promise<Job> {
    const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
    let lastTail: string | undefined;
    for (;;) {
      const job = await this.job(id);
      if (opts.onProgress && Array.isArray(job.progress) && job.progress.length) {
        // progress is a rolling window of the last 50 lines; emit lines after the last one we printed.
        const idx = lastTail === undefined ? -1 : job.progress.lastIndexOf(lastTail);
        for (const l of job.progress.slice(idx + 1)) opts.onProgress(l);
        lastTail = job.progress[job.progress.length - 1];
      }
      if (job.state === 'done') return job;
      if (job.state === 'failed') {
        const e = job.error;
        if (e && typeof e === 'object') throw new PhoneDockApiError(e.message, e.code || 'job_failed', 0, e.hints ?? [], e.detail ?? job.progress?.slice(-5).join('\n'));
        throw new PhoneDockApiError(e || `Job ${id} failed`, 'job_failed', 0, job.progress?.slice(-5) ?? []);
      }
      if (Date.now() > deadline) throw new PhoneDockApiError(`Timed out waiting for job ${id} (${job.kind})`, 'job_timeout', 0, [`Check later: phonedock jobs ${id}`]);
      await sleep(opts.intervalMs ?? 1000);
    }
  }

  /** Server-sent events: `for await (const ev of client.events()) …`. Abort via `signal`. */
  async *events(opts: { signal?: AbortSignal } = {}): AsyncGenerator<PhoneDockEvent> {
    const res = await this.request<Response>('GET', '/v1/events', { raw: true, signal: opts.signal });
    if (!res.body) return;
    const decoder = new TextDecoder();
    let buf = ''; let ev = 'message'; let data: string[] = []; let evId: string | undefined;
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, ''); buf = buf.slice(nl + 1);
        if (line === '') {
          if (data.length) {
            const raw = data.join('\n'); let parsed: unknown = raw;
            try { parsed = JSON.parse(raw); } catch { /* keep string */ }
            yield { event: ev, data: parsed, id: evId };
          }
          ev = 'message'; data = []; evId = undefined;
        } else if (line.startsWith(':')) { /* comment / keepalive */ }
        else {
          const i = line.indexOf(':'); const field = i < 0 ? line : line.slice(0, i);
          const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
          if (field === 'event') ev = value; else if (field === 'data') data.push(value); else if (field === 'id') evId = value;
        }
      }
    }
  }

  // ── devices ────────────────────────────────────────────────────────────
  devices(filter: { backend?: string; platform?: string; state?: string } = {}): Promise<Device[]> {
    return this.request('GET', '/v1/devices', { query: filter });
  }
  device(id: string): Promise<Device> { return this.request('GET', this.dev(id)); }

  /** Resolve a full id, nativeId, exact name, or unique id/name prefix to a Device. */
  async resolveDevice(query: string): Promise<Device> {
    const list = await this.devices();
    const q = query.trim(); const ql = q.toLowerCase();
    const exact = list.filter((d) => d.id === q) ;
    if (exact.length) return exact[0];
    // A phone on several connections is one device; its other transports (e.g. ip:port) still find it.
    const viaTransport = (d: Device) => {
      const t = (d.meta as { transports?: unknown } | undefined)?.transports;
      return Array.isArray(t) && t.includes(q.startsWith(`${d.backend}:`) ? q.slice(d.backend.length + 1) : q);
    };
    for (const pick of [
      (d: Device) => d.nativeId === q,
      viaTransport,
      (d: Device) => d.name === q,
      (d: Device) => d.name?.toLowerCase() === ql || d.nativeId.toLowerCase() === ql,
      (d: Device) => d.id.startsWith(q) || d.nativeId.startsWith(q) || (d.name ?? '').toLowerCase().startsWith(ql),
    ]) {
      const m = list.filter(pick);
      if (m.length === 1) return m[0];
      if (m.length > 1) throw new PhoneDockApiError(`"${query}" matches ${m.length} devices`, 'ambiguous_device', 400,
        m.slice(0, 10).map((d) => `${d.id}  (${d.name}, ${d.state})`));
    }
    throw new PhoneDockApiError(`No device matches "${query}"`, 'not_found', 404,
      list.length ? ['Known devices: ' + list.slice(0, 15).map((d) => `${d.name} [${d.id}]`).join(', ')] : ['No devices found. Create one with `phonedock create` or create_device.']);
  }

  /** Create a device. Waits for the creation job (returns the Device) unless `wait: false`. */
  async createDevice(spec: DeviceSpec & { boot?: boolean }, opts: WaitOptions = {}): Promise<Device> {
    const r = await this.request<{ job: Job; device?: Device }>('POST', '/v1/devices', { body: spec });
    if (opts.wait === false) return (r.device ?? { id: '', state: 'creating', job: r.job }) as Device & { job?: Job };
    const job = await this.waitJob(r.job.id, { timeoutMs: opts.timeoutMs ?? 30 * 60_000, onProgress: opts.onProgress });
    return (job.result as Device) ?? r.device!;
  }
  /** Raw create returning `{ job, device? }`. */
  createDeviceAsync(spec: DeviceSpec & { boot?: boolean }): Promise<{ job: Job; device?: Device }> {
    return this.request('POST', '/v1/devices', { body: spec });
  }
  createDevices(spec: DeviceSpec, count: number, boot?: boolean): Promise<{ jobs: Job[] }> {
    return this.request('POST', '/v1/devices/batch', { body: { spec, count, boot } });
  }
  updateDevice(id: string, patch: { name?: string; autoStart?: boolean }): Promise<Device> {
    return this.request('PATCH', this.dev(id), { body: patch });
  }
  deleteDevice(id: string, opts: { force?: boolean } = {}): Promise<{ ok: boolean }> {
    return this.request('DELETE', this.dev(id), { query: { force: opts.force ? 1 : undefined } });
  }
  /** Boot; waits until usable unless `wait: false`. */
  async boot(id: string, opts: BootOptions & WaitOptions = {}): Promise<Job> {
    const { wait, timeoutMs, onProgress, ...bootOpts } = opts;
    const r = await this.request<{ job: Job }>('POST', this.dev(id, '/boot'), { body: bootOpts });
    if (wait === false || !r?.job) return r?.job;
    return this.waitJob(r.job.id, { timeoutMs: timeoutMs ?? 10 * 60_000, onProgress });
  }
  shutdown(id: string): Promise<{ ok: boolean }> { return this.request('POST', this.dev(id, '/shutdown'), { body: {} }); }
  async clone(id: string, name: string, opts: WaitOptions = {}): Promise<Device> {
    const r = await this.request<{ job: Job }>('POST', this.dev(id, '/clone'), { body: { name } });
    if (opts.wait === false) return { id: '', name, state: 'creating', job: r.job } as unknown as Device;
    const job = await this.waitJob(r.job.id, { timeoutMs: opts.timeoutMs ?? 30 * 60_000, onProgress: opts.onProgress });
    return job.result as Device;
  }
  openWindow(id: string): Promise<{ ok: boolean }> { return this.request('POST', this.dev(id, '/window'), { body: {} }); }
  snapshots(id: string): Promise<Snapshot[]> { return this.request('GET', this.dev(id, '/snapshots')); }
  saveSnapshot(id: string, name: string): Promise<{ ok: boolean }> { return this.request('POST', this.dev(id, '/snapshots'), { body: { name } }); }
  restoreSnapshot(id: string, name: string): Promise<{ ok: boolean }> { return this.request('POST', this.dev(id, `/snapshots/${enc(name)}/restore`), { body: {} }); }
  deleteSnapshot(id: string, name: string): Promise<{ ok: boolean }> { return this.request('DELETE', this.dev(id, `/snapshots/${enc(name)}`)); }
  info(id: string): Promise<Record<string, unknown>> { return this.request('GET', this.dev(id, '/info')); }
  screen(id: string): Promise<ScreenInfo> { return this.request('GET', this.dev(id, '/screen')); }

  // ── observation ────────────────────────────────────────────────────────
  async screenshot(id: string, opts: { format?: 'png' | 'jpeg'; maxSize?: number; quality?: number } = {}): Promise<ScreenshotResult> {
    const res = await this.request<Response>('GET', this.dev(id, '/screenshot'), { raw: true, query: { format: opts.format, maxSize: opts.maxSize, quality: opts.quality } });
    const data = Buffer.from(await res.arrayBuffer());
    const num = (h: string) => { const v = Number(res.headers.get(h)); return Number.isFinite(v) && v > 0 ? v : 0; };
    const mime = (res.headers.get('content-type') ?? (opts.format === 'jpeg' ? 'image/jpeg' : 'image/png')).split(';')[0].trim();
    let imageWidth = num('x-image-width'); let imageHeight = num('x-image-height');
    if (!imageWidth || !imageHeight) { const d = imageSize(data); imageWidth ||= d.width; imageHeight ||= d.height; }
    const deviceWidth = num('x-device-width') || imageWidth; const deviceHeight = num('x-device-height') || imageHeight;
    const scale = num('x-scale') || (imageWidth ? deviceWidth / imageWidth : 1);
    return { data, mime, deviceWidth, deviceHeight, imageWidth, imageHeight, scale };
  }
  streamUrl(id: string, opts: { maxSize?: number; fps?: number } = {}): string { return this.url(this.dev(id, '/stream'), { ...opts, token: this.token }); }
  frameUrl(id: string, opts: { maxSize?: number } = {}): string { return this.url(this.dev(id, '/frame'), { ...opts, token: this.token }); }
  async frame(id: string, opts: { maxSize?: number } = {}): Promise<Buffer> {
    const res = await this.request<Response>('GET', this.dev(id, '/frame'), { raw: true, query: opts });
    return Buffer.from(await res.arrayBuffer());
  }
  ui(id: string, opts: { ocrFallback?: boolean } = {}): Promise<UiTree> {
    return this.request('GET', this.dev(id, '/ui'), { query: { format: 'json', ocrFallback: opts.ocrFallback } });
  }
  async uiText(id: string, opts: { ocrFallback?: boolean } = {}): Promise<string> {
    const r = await this.request<unknown>('GET', this.dev(id, '/ui'), { query: { format: 'text', ocrFallback: opts.ocrFallback } });
    return typeof r === 'string' ? r : JSON.stringify(r);
  }

  // ── input ──────────────────────────────────────────────────────────────
  /** One action or several in a row; `expect` is checked once, after the last. */
  input(id: string, action: InputAction | InputAction[], opts: InputOptions = {}): Promise<InputResult> {
    const ex = opts.expect !== undefined ? { expect: opts.expect } : {};
    return this.request('POST', this.dev(id, '/input'), { body: Array.isArray(action) ? { actions: action, ...ex } : { ...action, ...ex }, input: true });
  }
  /** `label` names what the tap is aimed at (e.g. a matched element's text); it only shows in the activity log. */
  tap(id: string, x: number, y: number, label?: string, meta?: { selector?: TapSelector; element?: { type?: string; id?: string; editable?: boolean }; expect?: Expect | string }) {
    return this.input(id, { action: 'tap', x: Math.round(x), y: Math.round(y), ...(label ? { label } : {}), ...(meta?.selector ? { selector: meta.selector } : {}), ...(meta?.element ? { element: meta.element } : {}) }, { expect: meta?.expect });
  }
  tapRef(id: string, ref: string, opts: InputOptions = {}) { return this.input(id, { action: 'tap', ref: ref.replace(/^@/, '') }, opts); }
  longPress(id: string, x: number, y: number, durationMs?: number, opts: InputOptions = {}) { return this.input(id, { action: 'longPress', x: Math.round(x), y: Math.round(y), durationMs }, opts); }
  swipe(id: string, x1: number, y1: number, x2: number, y2: number, durationMs?: number, opts: InputOptions = {}) {
    return this.input(id, { action: 'swipe', x1: Math.round(x1), y1: Math.round(y1), x2: Math.round(x2), y2: Math.round(y2), durationMs }, opts);
  }
  /** `secret: true` keeps the text out of the action log (stored as '•••'; replay skips it). */
  type(id: string, text: string, opts: { secret?: boolean } & InputOptions = {}) { return this.input(id, opts.secret ? { action: 'type', text, secret: true } : { action: 'type', text }, { expect: opts.expect }); }
  doubleTap(id: string, x: number, y: number, opts: InputOptions = {}) { return this.input(id, { action: 'doubleTap', x: Math.round(x), y: Math.round(y) }, opts); }
  /** scale < 1 pinches in (zoom out), > 1 spreads (zoom in). */
  pinch(id: string, x: number, y: number, scale: number, durationMs?: number) { return this.input(id, { action: 'pinch', x: Math.round(x), y: Math.round(y), scale, durationMs }); }
  hideKeyboard(id: string): Promise<{ ok: boolean }> { return this.request('POST', this.dev(id, '/keyboard/hide'), { body: {} }); }
  key(id: string, key: KeyName, opts: InputOptions = {}) { return this.input(id, { action: 'key', key }, opts); }
  actions(id: string, opts: { limit?: number } = {}): Promise<ActionRecord[]> { return this.request('GET', this.dev(id, '/actions'), { query: opts }); }
  async replay(id: string, actions: (InputAction & { delayMs?: number })[], opts: WaitOptions = {}): Promise<Job> {
    const r = await this.request<{ job: Job }>('POST', this.dev(id, '/replay'), { body: { actions } });
    return opts.wait === false ? r.job : this.waitJob(r.job.id, { timeoutMs: opts.timeoutMs, onProgress: opts.onProgress });
  }

  // ── find / wait / fill ─────────────────────────────────────────────────
  /** Ranked element search over the accessibility tree (OCR fallback). Refs in matches are valid for tapRef(). */
  find(id: string, q: FindOptions): Promise<FindResult> { return this.request('POST', this.dev(id, '/find'), { body: q }); }
  /** find() then tap the chosen match's centre. Throws not_found (with a screen summary hint) when nothing matches. */
  async tapText(id: string, text: string, opts: Omit<FindOptions, 'text'> = {}): Promise<{ match: ElementMatch; others: ElementMatch[] }> {
    const r = await this.find(id, { ...opts, text });
    if (!r.match) throw new PhoneDockApiError(`Nothing on screen matches ${JSON.stringify(text)}`, 'not_found', 404, r.summary ? [`Screen now: ${r.summary}`] : []);
    await this.tap(id, r.match.center.x, r.match.center.y, matchName(r.match), tapMeta({ ...opts, text }, r.match));
    return { match: r.match, others: r.matches.filter((m) => m !== r.matches[r.index]) };
  }
  /** Block until an element is visible / gone, or the screen is idle. Throws `wait_timeout` (408) with a screen summary. */
  waitFor(id: string, opts: WaitForOptions): Promise<WaitForResult> { return this.request('POST', this.dev(id, '/wait'), { body: opts }); }
  /** Tap a field, wait for focus, clear it, type `value`, re-read and verify. */
  fill(id: string, opts: FillOptions): Promise<FillResult> { return this.request('POST', this.dev(id, '/fill'), { body: opts, input: true }); }
  /** Focused text field / keyboard state, optionally waiting up to waitMs for one to appear. */
  focus(id: string, opts: { waitMs?: number } = {}): Promise<FocusResult> { return this.request('GET', this.dev(id, '/focus'), { query: opts }); }
  /** Slow swipes (≈600 ms, ≈60 % of the screen) until an element matching `text` is on screen; stops when a swipe
   *  no longer moves the content (found: false, reason 'end reached, not found'). */
  /** Turn this device's recent actions into a flow file's text (`phonedock flow save`); the caller writes the file. */
  saveFlow(id: string, opts: SaveFlowOptions = {}): Promise<SaveFlowResult> { return this.request('POST', this.dev(id, '/flow'), { body: opts }); }
  scrollTo(id: string, text: string, opts: Omit<ScrollToOptions, 'text'> = {}): Promise<ScrollToResult> {
    return this.request('POST', this.dev(id, '/scroll-to'), { body: { ...opts, text }, input: true });
  }
  /** Swipe in a direction (finger movement), inside the scroll container and never on the keyboard. */
  swipeDirection(id: string, direction: 'up' | 'down' | 'left' | 'right', opts: { distance?: number; durationMs?: number; x?: number; y?: number } & InputOptions = {}): Promise<SwipeDirectionResult> {
    return this.request('POST', this.dev(id, '/swipe'), { body: { ...opts, direction }, input: true });
  }

  // ── navigation / system UI ─────────────────────────────────────────────
  /** Android: the Back key. iOS: a left-edge swipe (interactive pop; only where the app supports it). */
  /** Back one screen: Android Back key; iOS taps the nav bar back button, else swipes from the left edge. */
  goBack(id: string): Promise<BackResult> { return this.request('POST', this.dev(id, '/back'), { body: {}, input: true }); }
  /** go_home | app_switcher | control_center (Android: quick settings) | notification_center. */
  systemGesture(id: string, gesture: SystemGesture): Promise<GestureResult> { return this.request('POST', this.dev(id, '/gesture'), { body: { gesture }, input: true }); }
  /** The system prompt / alert on screen now (null if none). ocrFallback (default true) OCRs devices without a tree. */
  prompt(id: string, opts: { ocrFallback?: boolean; signal?: AbortSignal } = {}): Promise<PromptResult> {
    return this.request('GET', this.dev(id, '/prompt'), { query: { ocrFallback: opts.ocrFallback }, signal: opts.signal });
  }
  /** Tap a system prompt's button by its text: accept (e.g. "Allow While Using App"), dismiss ("Don't Allow") or a label.
   *  Refuses (403 needs_human) passcode, biometric, credential, profile and "Allow Paste" prompts. Never types. */
  handleAlert(id: string, action: AlertActionInput = 'accept', opts: { verify?: boolean; ocrFallback?: boolean } = {}): Promise<AlertResult> {
    const body = typeof action === 'object' ? { action: 'button', button: action.button } : { action };
    return this.request('POST', this.dev(id, '/alert'), { body: { ...body, ...opts } });
  }

  // ── human handoff ──────────────────────────────────────────────────────
  /** Ask a human to do something on the device (Face ID, passcode, sign-in, …). 409 handoff_pending if one is open. */
  requestHandoff(id: string, reason: string, opts: { timeoutSec?: number } = {}): Promise<Handoff> {
    return this.request('POST', this.dev(id, '/handoff'), { body: { reason, timeoutSec: opts.timeoutSec } });
  }
  handoffs(opts: { state?: HandoffState; deviceId?: string } = {}): Promise<Handoff[]> { return this.request('GET', '/v1/handoffs', { query: opts }); }
  /** Get a handoff; with waitSec (≤60) long-polls until it is no longer pending. */
  handoff(hid: string, opts: { waitSec?: number } = {}): Promise<Handoff> { return this.request('GET', `/v1/handoffs/${enc(hid)}`, { query: opts }); }
  resolveHandoff(hid: string, state: 'done' | 'cancelled', note?: string): Promise<Handoff> {
    return this.request('POST', `/v1/handoffs/${enc(hid)}/resolve`, { body: { state, note } });
  }
  /** Long-poll until the handoff resolves (done / cancelled / timeout). `onWait` is called between polls. */
  async waitHandoff(hid: string, opts: { onWait?: (h: Handoff, elapsedMs: number) => void; signal?: AbortSignal } = {}): Promise<Handoff> {
    const t0 = Date.now();
    for (;;) {
      const h = await this.request<Handoff>('GET', `/v1/handoffs/${enc(hid)}`, { query: { waitSec: 25 }, signal: opts.signal });
      if (h.state !== 'pending') return h;
      opts.onWait?.(h, Date.now() - t0);
    }
  }
  /** requestHandoff() + waitHandoff(). */
  async requestHuman(id: string, reason: string, opts: { timeoutSec?: number; onWait?: (h: Handoff, elapsedMs: number) => void } = {}): Promise<Handoff> {
    const h = await this.requestHandoff(id, reason, opts);
    return this.waitHandoff(h.id, opts);
  }

  // ── app state / diagnostics ────────────────────────────────────────────
  async foregroundApp(id: string): Promise<AppInfo | null> { return (await this.request<{ app: AppInfo | null }>('GET', this.dev(id, '/foreground'))).app; }
  crashes(id: string, opts: { since?: string; appId?: string; limit?: number } = {}): Promise<CrashReport[]> { return this.request('GET', this.dev(id, '/crashes'), { query: opts }); }
  /** Crash report text; long reports are cut to the header + crashed thread unless `full`. */
  crash(id: string, crashId: string, opts: { full?: boolean; maxChars?: number } = {}): Promise<CrashText> {
    return this.request('GET', this.dev(id, `/crashes/${enc(crashId)}`), { query: { full: opts.full ? 1 : undefined, maxChars: opts.maxChars } });
  }
  /** Start an .mp4 screen recording (auto-stops after maxSeconds, default 300). */
  startRecording(id: string, opts: { maxSeconds?: number } = {}): Promise<RecordingStatus & { ok: true }> { return this.request('POST', this.dev(id, '/recording/start'), { body: opts }); }
  stopRecording(id: string): Promise<RecordingResult> { return this.request('POST', this.dev(id, '/recording/stop'), { body: {} }); }
  recording(id: string): Promise<RecordingStatus> { return this.request('GET', this.dev(id, '/recording')); }
  /** Start a performance trace of one app (xctrace on iOS, perfetto + gfxinfo on Android). Resolves once recording. */
  startTrace(id: string, opts: TraceStartOptions): Promise<TraceStartResult> { return this.request('POST', this.dev(id, '/trace/start'), { body: opts }); }
  /** Stop the trace, check the file opens, and summarize it (also returns a trace the time limit already ended). */
  stopTrace(id: string, opts: TraceStopOptions = {}): Promise<TraceStopResult> { return this.request('POST', this.dev(id, '/trace/stop'), { body: opts }); }
  trace(id: string): Promise<TraceStatus> { return this.request('GET', this.dev(id, '/trace')); }
  /** Earlier traces of this device (newest first): ids, metrics and file paths. */
  traces(id: string, opts: { limit?: number } = {}): Promise<TraceListEntry[]> { return this.request('GET', this.dev(id, '/traces'), { query: { limit: opts.limit } }); }
  /** Saved app-data snapshots for one app (newest first). */
  appData(id: string, appId: string): Promise<AppDataEntry[]> { return this.request('GET', this.dev(id, `/apps/${enc(appId)}/data`)); }
  exportAppData(id: string, appId: string, name: string): Promise<{ ok: true; appId: string; name: string; path: string; sizeBytes: number; files: number }> {
    return this.request('POST', this.dev(id, `/apps/${enc(appId)}/data/export`), { body: { name } });
  }
  importAppData(id: string, appId: string, name: string): Promise<{ ok: true; appId: string; name: string; path: string }> {
    return this.request('POST', this.dev(id, `/apps/${enc(appId)}/data/import`), { body: { name } });
  }

  // ── leases / pool ──────────────────────────────────────────────────────
  lease(id: string, opts: { ttlSec?: number; force?: boolean; owner?: string } = {}): Promise<Lease> {
    return this.request('POST', this.dev(id, '/lease'), { body: { owner: opts.owner ?? this.owner, ttlSec: opts.ttlSec, force: opts.force } });
  }
  releaseLease(id: string): Promise<ReleaseResult> { return this.request('DELETE', this.dev(id, '/lease')); }
  acquire(opts: { deviceId?: string; includePhysical?: boolean; force?: boolean; platform?: Platform; backend?: string; createIfNone?: DeviceSpec; ttlSec?: number; owner?: string } = {}): Promise<{ device: Device; lease: Lease }> {
    return this.request('POST', '/v1/pool/acquire', { body: { ...opts, owner: opts.owner ?? this.owner } });
  }
  release(deviceId: string, owner?: string): Promise<ReleaseResult> {
    return this.request('POST', '/v1/pool/release', { body: { owner: owner ?? this.owner, deviceId } });
  }

  // ── apps / system ──────────────────────────────────────────────────────
  apps(id: string, opts: { system?: boolean } = {}): Promise<AppInfo[]> {
    return this.request('GET', this.dev(id, '/apps'), { query: { system: opts.system ? 1 : undefined } });
  }
  /** Install from a local path on the Mac or an http(s) URL (daemon downloads it). */
  install(id: string, pathOrUrl: string): Promise<{ ok: boolean; app?: AppInfo }> {
    const body = /^https?:\/\//i.test(pathOrUrl) ? { url: pathOrUrl } : { path: pathOrUrl };
    return this.request('POST', this.dev(id, '/apps'), { body });
  }
  uninstall(id: string, appId: string): Promise<{ ok: boolean }> { return this.request('DELETE', this.dev(id, `/apps/${enc(appId)}`)); }
  /** `inFront`: the app is in the foreground afterwards (absent when the backend can't tell); `foreground`: what is. */
  launch(id: string, appId: string, opts: InputOptions = {}): Promise<{ ok: boolean; inFront?: boolean; foreground?: string | null; relaunched?: boolean } & InputDelivery> {
    return this.request('POST', this.dev(id, `/apps/${enc(appId)}/launch`), { body: opts.expect !== undefined ? { expect: opts.expect } : {}, input: true });
  }
  terminate(id: string, appId: string): Promise<{ ok: boolean }> { return this.request('POST', this.dev(id, `/apps/${enc(appId)}/terminate`), { body: {} }); }
  openUrl(id: string, url: string): Promise<{ ok: boolean }> { return this.request('POST', this.dev(id, '/open-url'), { body: { url } }); }
  shell(id: string, command: string): Promise<ExecResult> { return this.request('POST', this.dev(id, '/shell'), { body: { command } }); }
  /** System-wide appearance: iOS simulator `simctl ui appearance`, Android `cmd uimode night`. */
  appearance(id: string): Promise<{ appearance: Appearance | 'unknown' }> { return this.request('GET', this.dev(id, '/appearance')); }
  /** Switch dark/light; resolves with what the device reports afterwards (`previous` = before). */
  setAppearance(id: string, mode: Appearance): Promise<{ ok: boolean; appearance: Appearance | 'unknown'; previous: Appearance | 'unknown'; changed: boolean }> {
    return this.request('POST', this.dev(id, '/appearance'), { body: { appearance: mode } });
  }
  pushFile(id: string, local: string, remote: string): Promise<{ ok: boolean }> { return this.request('POST', this.dev(id, '/files/push'), { body: { local, remote } }); }
  pullFile(id: string, remote: string, local: string): Promise<{ ok: boolean }> { return this.request('POST', this.dev(id, '/files/pull'), { body: { remote, local } }); }
  async logs(id: string, opts: { lines?: number; filter?: string; app?: string } = {}): Promise<string> {
    const r = await this.request<unknown>('GET', this.dev(id, '/logs'), { query: opts });
    return typeof r === 'string' ? r : JSON.stringify(r, null, 2);
  }
  setLocation(id: string, lat: number, lon: number): Promise<{ ok: boolean }> { return this.request('POST', this.dev(id, '/location'), { body: { lat, lon } }); }
  pushNotification(id: string, appId: string, payload: Record<string, unknown>): Promise<{ ok: boolean }> {
    return this.request('POST', this.dev(id, '/push'), { body: { appId, payload } });
  }
  /** Rotate the screen. `orientation` is what the screen shows afterwards: it stays put when the app on screen
   *  can't turn (the Android launcher, iOS home screen), and then `note` says so. `screen` is the new size. */
  rotate(id: string, orientation: 'portrait' | 'landscape'): Promise<{ ok: boolean; orientation?: 'portrait' | 'landscape'; screen?: ScreenInfo; note?: string }> {
    return this.request('POST', this.dev(id, '/rotate'), { body: { orientation } });
  }

  // ── physical devices ───────────────────────────────────────────────────
  /** Android: connect over Wi-Fi. Without `address`, connects to `opts.serial`, or to the only phone advertising Wireless debugging.
   *  `restartAdb`: after a Local Network "No route to host", restart the adb server (briefly disconnects other adb users) and retry. */
  connect(address?: string, opts: { serial?: string; restartAdb?: boolean } = {}): Promise<{ ok: boolean; device?: Device; message?: string }> {
    return this.request('POST', '/v1/connect', { body: { ...(address ? { address } : {}), ...opts } });
  }
  /** Connect an iPhone over Wi-Fi via WebDriverAgent: `target` = IP/host (→ http://<ip>:8100) or a full WDA URL. */
  connectIos(target: string, opts: { name?: string; udid?: string } = {}): Promise<{ ok: boolean; device?: Device; wdaUrl: string }> {
    const body: Record<string, unknown> = { platform: 'ios', ...opts };
    if (/^https?:\/\//i.test(target)) body.wdaUrl = target; else body.address = target;
    return this.request('POST', '/v1/connect', { body });
  }
  /** Forget a saved Wi-Fi connection (iOS WDA entry / Android adb connect). */
  disconnect(id: string): Promise<{ ok: boolean }> { return this.request('DELETE', `/v1/connect/${encodeURIComponent(id)}`); }
  /** Scan for iPhones on the network (Bonjour + devicectl). */
  discoverIos(): Promise<{ name: string; host?: string; udid?: string; source: string; service?: string; deviceId?: string }[]> { return this.request('GET', '/v1/ios/discover'); }
  /** Build + run WebDriverAgent on a device (Job; resolves when WDA prints its URL, which is saved for the device). */
  async wdaSetup(udid: string, opts: { team?: string; destination?: string; name?: string } & WaitOptions = {}): Promise<Job> {
    const { wait, timeoutMs, onProgress, ...body } = opts;
    const r = await this.request<{ job: Job }>('POST', '/v1/ios/wda-setup', { body: { udid, ...body } });
    return wait === false ? r.job : this.waitJob(r.job.id, { timeoutMs: timeoutMs ?? 30 * 60_000, onProgress });
  }
  pair(address: string, code: string, opts: { restartAdb?: boolean } = {}): Promise<{ ok: boolean }> { return this.request('POST', '/v1/pair', { body: { address, code, ...opts } }); }
  /** Scan the Wi-Fi for Android phones with Wireless debugging (about 3 s). A phone offers `pairingPort` only while its pairing screen is open. */
  discoverAndroid(): Promise<AndroidPhone[]> { return this.request('GET', '/v1/android/discover'); }
  /** Pair with just the code shown on the phone, then connect and wait until it is online. `serial` picks the phone when several show a pairing screen. */
  pairWithCode(code: string, opts: { serial?: string; restartAdb?: boolean } = {}): Promise<{ ok: boolean; device?: Device; message?: string; serial?: string }> {
    return this.request('POST', '/v1/pair', { body: { code, ...opts } });
  }
}

/** An Android phone found on the Wi-Fi by `discoverAndroid()`. */
export interface AndroidPhone {
  serial: string; model?: string; host?: string; ip?: string;
  connectPort?: number; pairingPort?: number; connected: boolean;
  connectInstance?: string; pairingInstance?: string;
}

/** Width/height from PNG or JPEG bytes (fallback when the daemon omits X-Image-* headers). */
export function imageSize(buf: Buffer): { width: number; height: number } {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1]; const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return { width: 0, height: 0 };
}
