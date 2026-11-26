// Read-only CDP diagnostics for an app which explicitly exposes WebView debugging. This is not a universal
// inspection path for arbitrary apps. Every ADB command is bound to the caller's existing device transport.
import { adb } from './android-common.ts';
import { PhoneDockError, type Bounds, type ExecResult } from '../core/types.ts';

export interface SocketLike {
  readyState: number; send(data: string): void; close(): void;
  addEventListener(type: string, listener: (event: any) => void, options?: { once?: boolean }): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}
export interface AndroidWebViewDeps {
  adb(serial: string, args: string[]): Promise<ExecResult>;
  fetchJson(url: string): Promise<unknown>;
  socket(url: string): SocketLike;
  wait(ms: number): Promise<void>;
}
export interface WebViewOptions {
  appId?: string; targetId?: string; action: 'snapshot' | 'network' | 'measure'; selector?: string; bounds?: Bounds;
  captureMs?: number; maxElements?: number;
}
export interface WebViewTarget { id: string; title: string; url: string; appId?: string }
export interface WebViewElement { ref: string; tag: string; role?: string; label: string; cssBounds: Bounds; bounds?: Bounds }
export interface WebViewMeasuredElement {
  ref: string; tag: string; id?: string; classes?: string[]; text: string; visible: boolean;
  cssBounds: Bounds; bounds?: Bounds;
  styles: Record<string, string>;
}
export interface WebViewSnapshot {
  action: 'snapshot'; source: 'webview-dom'; target: WebViewTarget; coordinateSpace: 'css' | 'device';
  viewport: { width: number; height: number; offsetLeft: number; offsetTop: number; scale: number };
  elements: WebViewElement[]; text: string; truncated: boolean; warnings: string[];
}
export interface WebViewMeasure {
  action: 'measure'; source: 'webview-dom'; target: WebViewTarget; selector: string; matchCount: number;
  coordinateSpace: 'css' | 'device';
  viewport: { width: number; height: number; offsetLeft: number; offsetTop: number; scale: number };
  elements: WebViewMeasuredElement[]; truncated: boolean; warnings: string[];
}
export interface WebViewNetwork {
  action: 'network'; source: 'webview-cdp'; target: WebViewTarget; captureMs: number;
  requests: { method: string; url: string; status?: number; durationMs?: number; failed?: boolean }[];
  truncated: boolean; warnings: string[];
}
export type WebViewResult = WebViewSnapshot | WebViewMeasure | WebViewNetwork;
const debugError = (message = 'The WebView debugger returned an invalid response', code = 'webview_debug_failed', status = 502) => new PhoneDockError(message, code, status);
const notDebuggable = () => new PhoneDockError('No debug-enabled WebView was found for this running app', 'not_supported', 501,
  ['Enable WebView debugging in your own app build, open its WebView, and try again.', 'Use native accessibility or OCR when a WebView does not expose debugging.']);

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'error' });
  if (!response.ok || !response.body) throw debugError();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let n = 0;
  try {
    for (;;) { const r = await reader.read(); if (r.done) break; n += r.value.length; if (n > 1024 * 1024) throw debugError(); chunks.push(r.value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}
const defaults: AndroidWebViewDeps = { adb: (serial, args) => adb(serial, args, { timeoutMs: 10_000 }), fetchJson,
  socket: (url) => new WebSocket(url) as unknown as SocketLike, wait: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Query, fragments, URL credentials, and non-network payload URLs are never included in diagnostics. */
export function diagnosticUrl(raw: unknown): string {
  try {
    const u = new URL(String(raw));
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(u.protocol)) return `${u.protocol}[redacted]`;
    u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString().slice(0, 4096);
  } catch { return '[unavailable URL]'; }
}
function debuggerUrl(raw: unknown, port: number): string {
  if (typeof raw !== 'string') throw debugError();
  let u: URL; try { u = new URL(raw); } catch { throw debugError(); }
  if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname) || Number(u.port) !== port || u.username || u.password || u.search || u.hash || !/^\/devtools\/page\/[^/]+$/.test(u.pathname)) throw debugError('The WebView debugger URL does not match the local device forward');
  // Avoid DNS resolution even for the accepted localhost spelling.
  u.hostname = '127.0.0.1'; return u.toString();
}

class CdpSession {
  socket: SocketLike; nextId = 1;
  pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  events = new Set<(method: string, params: any) => void>();
  ended = false;
  constructor(socket: SocketLike) { this.socket = socket; }
  readonly onMessage = (event: any) => {
    const raw = event.data;
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 2 * 1024 * 1024) { this.fail(debugError()); return; }
    let message: any; try { message = JSON.parse(raw); } catch { this.fail(debugError()); return; }
    if (!message || typeof message !== 'object' || Array.isArray(message)) { this.fail(debugError()); return; }
    if (typeof message.id === 'number') {
      const p = this.pending.get(message.id); if (!p) return;
      this.pending.delete(message.id); clearTimeout(p.timer);
      if (message.error || !message.result || typeof message.result !== 'object') p.reject(debugError('The WebView debugger rejected a diagnostic command'));
      else p.resolve(message.result);
    } else if (typeof message.method === 'string') {
      const params = message.params && typeof message.params === 'object' && !Array.isArray(message.params) ? message.params : {};
      for (const listener of this.events) { try { listener(message.method, params); } catch { this.fail(debugError()); } }
    }
  };
  readonly onClosed = () => this.fail(debugError('The WebView debugger disconnected'));
  fail(error: Error) {
    this.ended = true;
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear();
  }
  async connect(): Promise<void> {
    this.socket.addEventListener('message', this.onMessage);
    this.socket.addEventListener('close', this.onClosed); this.socket.addEventListener('error', this.onClosed);
    if (this.socket.readyState === 1) return;
    if (this.socket.readyState > 1) throw debugError('The WebView debugger disconnected');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.socket.removeEventListener('open', opened); this.socket.removeEventListener('close', failed); this.socket.removeEventListener('error', failed); };
      const opened = () => { cleanup(); resolve(); }; const failed = () => { cleanup(); reject(debugError('Could not open the WebView debugger')); };
      const timer = setTimeout(() => { cleanup(); reject(debugError('The WebView debugger timed out', 'webview_timeout', 504)); }, 3000);
      this.socket.addEventListener('open', opened); this.socket.addEventListener('close', failed); this.socket.addEventListener('error', failed);
    });
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (this.ended || this.socket.readyState !== 1) return Promise.reject(debugError('The WebView debugger disconnected'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(debugError('The WebView debugger timed out', 'webview_timeout', 504)); }, 3000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { clearTimeout(timer); this.pending.delete(id); reject(debugError('The WebView debugger disconnected')); }
    });
  }
  close(): void {
    this.fail(debugError('The WebView debugger session ended'));
    this.socket.removeEventListener('message', this.onMessage); this.socket.removeEventListener('close', this.onClosed); this.socket.removeEventListener('error', this.onClosed);
    this.events.clear(); try { this.socket.close(); } catch { /* already disconnected */ }
  }
}

// This expression only reads the DOM. Password/text-field values and executable caller code are never read/run.
export function snapshotExpression(maxElements: number): string {
  return `(() => { const vv=window.visualViewport; const viewport={width:vv?.width||innerWidth,height:vv?.height||innerHeight,offsetLeft:vv?.offsetLeft||0,offsetTop:vv?.offsetTop||0,scale:vv?.scale||1}; const elements=[]; const nodes=document.querySelectorAll('button,a[href],input,textarea,select,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[tabindex]'); for(const node of Array.from(nodes).slice(0,2000)){ const r=node.getBoundingClientRect(),s=getComputedStyle(node); if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0'||r.width<=0||r.height<=0||r.right<=viewport.offsetLeft||r.bottom<=viewport.offsetTop||r.left>=viewport.offsetLeft+viewport.width||r.top>=viewport.offsetTop+viewport.height)continue; elements.push({tag:node.tagName.toLowerCase(),role:node.getAttribute('role')||undefined,label:(node.getAttribute('aria-label')||node.getAttribute('placeholder')||node.innerText||node.getAttribute('title')||'').slice(0,240),bounds:{x:r.left,y:r.top,width:r.width,height:r.height}}); if(elements.length>=${maxElements})break;} return {viewport,elements,text:(document.body?.innerText||'').slice(0,12000),truncated:nodes.length>2000||elements.length>=${maxElements}}; })()`;
}

// Read-only CSS selector measurement: bounding boxes, visibility, and key computed layout/typography styles.
export function measureExpression(selector: string, maxElements: number): string {
  const selLit = JSON.stringify(selector);
  return `(() => { const vv=window.visualViewport; const viewport={width:vv?.width||innerWidth,height:vv?.height||innerHeight,offsetLeft:vv?.offsetLeft||0,offsetTop:vv?.offsetTop||0,scale:vv?.scale||1}; let list; try { list=document.querySelectorAll(${selLit}); } catch (e) { return { invalidSelector: String(e && e.message || e) }; } const elements=[]; for(const node of Array.from(list).slice(0,${maxElements})){ const r=node.getBoundingClientRect(),s=getComputedStyle(node); const vis=s.display!=='none'&&s.visibility!=='hidden'&&s.opacity!=='0'&&r.width>0&&r.height>0; const cls=typeof node.className==='string'?node.className.trim().split(/\\s+/).filter(Boolean).slice(0,12):[]; elements.push({tag:node.tagName.toLowerCase(),id:node.id?String(node.id).slice(0,120):undefined,classes:cls.length?cls:undefined,text:(node.getAttribute('aria-label')||node.innerText||'').trim().slice(0,240),visible:vis,bounds:{x:r.left,y:r.top,width:r.width,height:r.height},styles:{display:s.display,position:s.position,visibility:s.visibility,opacity:s.opacity,zIndex:s.zIndex,fontSize:s.fontSize,fontFamily:s.fontFamily.slice(0,120),fontWeight:s.fontWeight,color:s.color,backgroundColor:s.backgroundColor,padding:s.padding,margin:s.margin,borderRadius:s.borderRadius}}); } return {viewport,matchCount:list.length,elements,truncated:list.length>${maxElements}}; })()`;
}

const finiteRect = (r: any): r is Bounds => r && [r.x, r.y, r.width, r.height].every((v) => typeof v === 'number' && Number.isFinite(v)) && r.width >= 0 && r.height >= 0;
export function parseSnapshotResult(value: any, target: WebViewTarget, bounds?: Bounds): WebViewSnapshot {
  const v = value?.viewport;
  if (!v || ![v.width, v.height, v.offsetLeft, v.offsetTop, v.scale].every((x) => typeof x === 'number' && Number.isFinite(x)) || v.width < 1 || v.width > 100_000 || v.height < 1 || v.height > 100_000 || v.scale <= 0 || v.scale > 100 || !Array.isArray(value.elements)) throw debugError();
  const warnings: string[] = [];
  const mapped = !!bounds && Math.abs((bounds.width / bounds.height) / (v.width / v.height) - 1) <= 0.03;
  if (!bounds) warnings.push('Native WebView bounds were not supplied; coordinates are CSS pixels, not device input coordinates.');
  else if (!mapped) warnings.push('WebView bounds and CSS viewport aspect ratios differ; device coordinates were omitted.');
  else warnings.push('Device coordinates use caller-supplied native WebView bounds. Refresh those bounds after layout, zoom or orientation changes.');
  const elements: WebViewElement[] = [];
  for (const e of value.elements.slice(0, 500)) {
    if (!finiteRect(e?.bounds) || typeof e.tag !== 'string' || typeof e.label !== 'string') continue;
    const r = e.bounds;
    const left = Math.max(v.offsetLeft, r.x), top = Math.max(v.offsetTop, r.y), right = Math.min(v.offsetLeft + v.width, r.x + r.width), bottom = Math.min(v.offsetTop + v.height, r.y + r.height);
    if (right <= left || bottom <= top) continue;
    const cssBounds = { x: left, y: top, width: right - left, height: bottom - top };
    const entry: WebViewElement = { ref: `w${elements.length + 1}`, tag: e.tag.slice(0, 32), ...(typeof e.role === 'string' ? { role: e.role.slice(0, 64) } : {}), label: e.label.slice(0, 240), cssBounds };
    if (mapped && bounds) entry.bounds = { x: bounds.x + (left - v.offsetLeft) * bounds.width / v.width, y: bounds.y + (top - v.offsetTop) * bounds.height / v.height, width: cssBounds.width * bounds.width / v.width, height: cssBounds.height * bounds.height / v.height };
    elements.push(entry);
  }
  return { action: 'snapshot', source: 'webview-dom', target, coordinateSpace: mapped ? 'device' : 'css', viewport: v,
    elements, text: typeof value.text === 'string' ? value.text.slice(0, 12000) : '', truncated: !!value.truncated || value.elements.length > 500, warnings };
}

export function parseMeasureResult(value: any, target: WebViewTarget, selector: string, bounds?: Bounds): WebViewMeasure {
  if (value && typeof value.invalidSelector === 'string') {
    throw new PhoneDockError(`Invalid CSS selector: ${value.invalidSelector.slice(0, 200)}`, 'bad_request', 400);
  }
  const v = value?.viewport;
  if (!v || ![v.width, v.height, v.offsetLeft, v.offsetTop, v.scale].every((x) => typeof x === 'number' && Number.isFinite(x)) || v.width < 1 || v.width > 100_000 || v.height < 1 || v.height > 100_000 || v.scale <= 0 || v.scale > 100 || !Array.isArray(value.elements)) throw debugError();
  const warnings: string[] = [];
  const mapped = !!bounds && Math.abs((bounds.width / bounds.height) / (v.width / v.height) - 1) <= 0.03;
  if (!bounds) warnings.push('Native WebView bounds were not supplied; coordinates are CSS pixels, not device input coordinates.');
  else if (!mapped) warnings.push('WebView bounds and CSS viewport aspect ratios differ; device coordinates were omitted.');
  const elements: WebViewMeasuredElement[] = [];
  for (const e of value.elements.slice(0, 500)) {
    if (!finiteRect(e?.bounds) || typeof e.tag !== 'string') continue;
    const cssBounds = { x: e.bounds.x, y: e.bounds.y, width: e.bounds.width, height: e.bounds.height };
    const styles: Record<string, string> = {};
    if (e.styles && typeof e.styles === 'object') {
      for (const [k, val] of Object.entries(e.styles)) {
        if (typeof val === 'string') styles[k] = val.slice(0, 160);
      }
    }
    const entry: WebViewMeasuredElement = {
      ref: `m${elements.length + 1}`,
      tag: e.tag.slice(0, 32),
      ...(typeof e.id === 'string' && e.id ? { id: e.id.slice(0, 120) } : {}),
      ...(Array.isArray(e.classes) ? { classes: e.classes.filter((c: unknown) => typeof c === 'string').slice(0, 12) } : {}),
      text: typeof e.text === 'string' ? e.text.slice(0, 240) : '',
      visible: !!e.visible,
      cssBounds,
      styles,
    };
    if (mapped && bounds) {
      entry.bounds = {
        x: bounds.x + (cssBounds.x - v.offsetLeft) * bounds.width / v.width,
        y: bounds.y + (cssBounds.y - v.offsetTop) * bounds.height / v.height,
        width: cssBounds.width * bounds.width / v.width,
        height: cssBounds.height * bounds.height / v.height,
      };
    }
    elements.push(entry);
  }
  const matchCount = typeof value.matchCount === 'number' && Number.isFinite(value.matchCount) ? value.matchCount : elements.length;
  return {
    action: 'measure', source: 'webview-dom', target, selector, matchCount,
    coordinateSpace: mapped ? 'device' : 'css', viewport: v,
    elements, truncated: !!value.truncated || value.elements.length > 500, warnings,
  };
}
async function network(session: CdpSession, target: WebViewTarget, ms: number, deps: AndroidWebViewDeps): Promise<WebViewNetwork> {
  const requests = new Map<string, { method: string; url: string; status?: number; durationMs?: number; failed?: boolean; start?: number }>();
  let truncated = false;
  const listener = (method: string, p: any) => {
    if (typeof p.requestId !== 'string' || p.requestId.length > 200) return;
    if (method === 'Network.requestWillBeSent') {
      if (requests.size >= 500 && !requests.has(p.requestId)) { truncated = true; return; }
      requests.set(p.requestId, { method: typeof p.request?.method === 'string' ? p.request.method.slice(0, 16) : '?', url: diagnosticUrl(p.request?.url), ...(Number.isFinite(p.timestamp) ? { start: p.timestamp } : {}) });
    } else {
      const r = requests.get(p.requestId); if (!r) return;
      if (method === 'Network.responseReceived' && Number.isFinite(p.response?.status)) r.status = p.response.status;
      if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
        if (typeof r.start === 'number' && Number.isFinite(p.timestamp)) r.durationMs = Math.max(0, Math.round((p.timestamp - r.start) * 1000));
        if (method === 'Network.loadingFailed') r.failed = true;
      }
    }
  };
  session.events.add(listener);
  try {
    await session.send('Network.enable', { maxTotalBufferSize: 0, maxResourceBufferSize: 0, maxPostDataSize: 0 });
    await deps.wait(ms);
    if (session.ended) throw debugError('The WebView debugger disconnected during network capture');
    return { action: 'network', source: 'webview-cdp', target, captureMs: ms,
      requests: [...requests.values()].map(({ start: _start, ...r }) => r), truncated,
      warnings: ['Only requests observed during this debug session are included. URL paths may still contain sensitive information; review before sharing.'] };
  } finally { session.events.delete(listener); }
}

export function validateWebViewOptions(input: unknown, opts: { requireAppId?: boolean } = {}): asserts input is WebViewOptions {
  const options = input as WebViewOptions;
  const requireAppId = opts.requireAppId ?? true;
  if (!options || typeof options !== 'object' || Array.isArray(options) || !['snapshot', 'network', 'measure'].includes(options.action)) {
    throw new PhoneDockError('Pass a valid WebView action (snapshot, measure, or network)', 'bad_request', 400);
  }
  if (requireAppId || options.appId !== undefined) {
    if (typeof options.appId !== 'string' || !/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+$/.test(options.appId) || options.appId.length > 200) {
      throw new PhoneDockError('Pass a valid app package / bundle ID', 'bad_request', 400);
    }
  }
  if (options.action === 'measure') {
    if (typeof options.selector !== 'string' || !options.selector.trim() || options.selector.length > 500 || /[\0\r\n]/.test(options.selector)) {
      throw new PhoneDockError('measure requires a non-empty CSS selector (max 500 chars)', 'bad_request', 400);
    }
  }
  if (options.targetId !== undefined && (typeof options.targetId !== 'string' || !/^[\w.:-]{1,200}$/.test(options.targetId))) throw new PhoneDockError('Invalid WebView target ID', 'bad_request', 400);
  if (options.bounds !== undefined && (!finiteRect(options.bounds) || options.bounds.x < 0 || options.bounds.y < 0 || options.bounds.width <= 0 || options.bounds.height <= 0 || [options.bounds.x, options.bounds.y, options.bounds.width, options.bounds.height].some((x) => x > 100_000))) throw new PhoneDockError('WebView bounds must be finite device-pixel bounds', 'bad_request', 400);
  const ms = options.captureMs ?? 2000; const max = options.maxElements ?? 200;
  if (!Number.isInteger(ms) || ms < 1 || ms > 5000 || !Number.isInteger(max) || max < 1 || max > 500) throw new PhoneDockError('captureMs must be 1–5000 and maxElements 1–500', 'bad_request', 400);
}
export async function inspectAndroidWebView(serial: string, options: WebViewOptions, overrides: Partial<AndroidWebViewDeps> = {}): Promise<WebViewResult> {
  const deps: AndroidWebViewDeps = { ...defaults, ...overrides };
  validateWebViewOptions(options, { requireAppId: true });
  if (typeof serial !== 'string' || !serial || serial.length > 300 || /[\r\n\0]/.test(serial)) throw new PhoneDockError('An explicit Android device transport is required', 'bad_request', 400);
  const ms = options.captureMs ?? 2000; const max = options.maxElements ?? 200;
  const p = await deps.adb(serial, ['shell', 'pidof', options.appId!]);
  const pids = p.code === 0 ? p.stdout.trim().split(/\s+/).filter((pid) => /^\d+$/.test(pid) && Number.isSafeInteger(Number(pid)) && Number(pid) > 0).slice(0, 32) : [];
  if (!pids.length) throw notDebuggable();
  const unix = await deps.adb(serial, ['shell', 'cat', '/proc/net/unix']);
  const sockets = [...new Set(unix.stdout.split(/\s+/).filter((s) => /^@?webview_devtools_remote_\d+$/.test(s)).map((s) => s.replace(/^@/, '')))].filter((s) => pids.includes(s.slice('webview_devtools_remote_'.length)));
  if (sockets.length !== 1) throw sockets.length ? new PhoneDockError('Several WebView debugger processes match this app', 'ambiguous_target', 409, ['Inspect one application process at a time.']) : notDebuggable();
  let port: number | undefined; let session: CdpSession | undefined; let result: WebViewResult | undefined;
  try {
    const forwarded = await deps.adb(serial, ['forward', 'tcp:0', `localabstract:${sockets[0]}`]);
    if (!/^\d+$/.test(forwarded.stdout.trim())) throw debugError('ADB did not return a local WebView port');
    port = Number(forwarded.stdout.trim()); if (!Number.isInteger(port) || port < 1 || port > 65535) { port = undefined; throw debugError(); }
    const rawTargets = await deps.fetchJson(`http://127.0.0.1:${port}/json/list`);
    if (!Array.isArray(rawTargets) || rawTargets.length > 1000) throw debugError();
    const targets = rawTargets.filter((t: any) => t && t.type === 'page' && typeof t.id === 'string');
    const selected = options.targetId ? targets.find((t: any) => t.id === options.targetId) : targets.length === 1 ? targets[0] : undefined;
    if (!selected) throw targets.length ? new PhoneDockError('Choose one debug-enabled WebView target', 'ambiguous_target', 409,
      ['Pass targetId from the availableTargets error detail.'], JSON.stringify({ availableTargets: targets.slice(0, 20).map((t: any) => ({ id: t.id.slice(0, 200), title: String(t.title ?? '').slice(0, 200), url: diagnosticUrl(t.url) })) })) : notDebuggable();
    const url = debuggerUrl(selected.webSocketDebuggerUrl, port);
    const target: WebViewTarget = { id: selected.id.slice(0, 200), title: String(selected.title ?? '').slice(0, 200), url: diagnosticUrl(selected.url) };
    session = new CdpSession(deps.socket(url)); await session.connect();
    if (options.action === 'snapshot') {
      const reply = await session.send('Runtime.evaluate', { expression: snapshotExpression(max), returnByValue: true, silent: true, timeout: 2000 });
      if (reply.exceptionDetails) throw debugError('The WebView could not produce a DOM snapshot');
      result = parseSnapshotResult(reply.result?.value, target, options.bounds);
    } else if (options.action === 'measure') {
      const reply = await session.send('Runtime.evaluate', { expression: measureExpression(options.selector!, max), returnByValue: true, silent: true, timeout: 2000 });
      if (reply.exceptionDetails) throw debugError('The WebView could not measure that CSS selector');
      result = parseMeasureResult(reply.result?.value, target, options.selector!, options.bounds);
    } else result = await network(session, target, ms, deps);
    return result;
  } catch (e) {
    if (e instanceof PhoneDockError) throw e;
    throw debugError('The WebView diagnostic connection failed');
  } finally {
    session?.close();
    if (port) {
      try { await deps.adb(serial, ['forward', '--remove', `tcp:${port}`]); }
      catch { if (result) result.warnings.push(`Could not remove PhoneDock's temporary WebView forward tcp:${port}; remove this forward for the selected device.`); }
    }
  }
}
