// Run flows (src/core/flow.ts) against a device through the SDK client: `phonedock test`, the MCP run_flow tool.
// Every element step waits for its element (default 10 s) and every action is followed by a short idle settle, so a
// flow doesn't depend on timing. A failed step fails the flow (unless `optional: true`); the runner then saves a
// screenshot, the UI tree and recent logs into the artifacts folder, and the message names what was expected and
// what was on screen instead ("Screen now: …").
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { PhoneDockClient } from '../sdk/client.ts';
import type { Device, ElementMatch } from './types.ts';
import {
  FlowError, compareVersions, describeSelector, describeStep, interpolateStep, osVersionNumber, parseFlow,
  type Flow, type Point, type Selector, type Step,
} from './flow.ts';

/** The part of PhoneDockClient the runner uses (tests pass a fake). */
export type FlowClient = Pick<PhoneDockClient, 'owner' | 'device' | 'lease' | 'releaseLease' | 'launch' | 'terminate' | 'openUrl' | 'setAppearance'
  | 'rotate' | 'systemGesture' | 'handleAlert' | 'find' | 'waitFor' | 'fill' | 'tap' | 'longPress' | 'doubleTap' | 'swipe' | 'swipeDirection'
  | 'type' | 'key' | 'goBack' | 'hideKeyboard' | 'scrollTo' | 'screenshot' | 'uiText' | 'ui' | 'logs'>
  & Partial<Pick<PhoneDockClient, 'apps'>>;

export type StepStatus = 'pass' | 'fail' | 'warn' | 'skip';
export interface StepResult { index: number; step: Step; description: string; status: StepStatus; ms: number; message?: string }
export interface FlowResult {
  name: string; file?: string; status: 'pass' | 'fail' | 'skip';
  /** Why it failed / was skipped (one paragraph: what was expected, what was on screen). */
  message?: string;
  steps: StepResult[]; ms: number; attempts: number; startedAt: string;
  artifacts?: string; device?: string;
}
export interface RunOptions {
  deviceId: string;
  /** Default wait for elements and assertions (ms; default 10000, iOS 15000). A step's `timeout:` overrides it. */
  timeoutMs?: number;
  /** Run a failed flow again up to this many times (default 0). */
  retries?: number;
  /** Where failure artifacts and screenshots go (created when needed). */
  artifactsDir: string;
  /** Extra / overriding variables for `${VAR}` (on top of the process environment and the flow's `env:`). */
  env?: Record<string, string | undefined>;
  /** Only run flows for this platform (flows without `platform:` run everywhere). */
  platform?: 'android' | 'ios';
  /** Progress lines (PASS/FAIL per step). */
  log?: (line: string) => void;
  /** Compare two PNGs: the fraction (0–1) of the image that differs. Without it, screenshot baselines are only saved. */
  compareImages?: (a: Buffer, b: Buffer) => Promise<number>;
  /** Idle settle after each action step (default true; tests turn it off). */
  settle?: boolean;
  signal?: AbortSignal;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secs = (ms: number) => `${(ms / 1000).toFixed(2)}s`;
/** A timeout for people: "500 ms", "10 s", "2.5 s". */
const dur = (ms: number) => (ms < 1000 ? `${Math.round(ms)} ms` : `${+(ms / 1000).toFixed(1)} s`);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'flow';
/** A path to show: relative to the current folder when it is inside it, absolute otherwise. */
export const displayPath = (p: string) => { const r = relative(process.cwd(), p); return r && !r.startsWith('..') ? r : resolve(p); };
const errInfo = (e: unknown) => e as { message?: string; code?: string; detail?: string; hints?: string[]; status?: number };
const FLOW_FILE = /\.(ya?ml|json)$/i;

/** Expand files and directories (recursively: *.yaml, *.yml, *.json; Maestro exports *.maestro.yaml skipped), sorted. */
export function collectFlowFiles(paths: string[]): string[] {
  const out: string[] = [];
  const walk = (p: string, explicit: boolean) => {
    const st = statSync(p);
    if (st.isDirectory()) {
      for (const n of readdirSync(p).sort()) {
        if (n.startsWith('.') || n === 'node_modules') continue;
        const f = join(p, n);
        if (statSync(f).isDirectory()) walk(f, false);
        else if (FLOW_FILE.test(n) && !/\.maestro\.ya?ml$/i.test(n)) out.push(f);
      }
    } else if (explicit || FLOW_FILE.test(p)) out.push(p);
  };
  for (const p of paths) {
    if (!existsSync(p)) throw new FlowError(`${p}: no such file or directory`);
    walk(p, true);
  }
  return [...new Set(out.map((f) => resolve(f)))];
}

/** `Screen now: …` from a PhoneDock error (wait_timeout detail, not_found hints), if it has one. */
export function screenNow(e: unknown): string | undefined {
  const x = errInfo(e);
  const all = [x.detail, ...(x.hints ?? []), x.message].filter(Boolean).join('\n');
  return /Screen now(?: \([^)]*\))?: (.*)/.exec(all)?.[1]?.trim();
}
function hiddenNote(e: unknown): string | undefined {
  return /(\d+ match\(es\) exist but are not visible[^\n]*)/.exec(errInfo(e).detail ?? '')?.[1];
}

class StepFailure extends Error {
  constructor(message: string) { super(message); this.name = 'StepFailure'; }
}
const findQuery = (s: Selector) => ({ text: s.text, id: s.id, type: s.type, match: s.match });
const tapSel = (s: Selector) => {
  const o: Record<string, unknown> = {};
  for (const k of ['text', 'id', 'type', 'match', 'index'] as const) if (s[k] !== undefined && !(k === 'match' && s[k] === 'contains')) o[k] = s[k];
  return o;
};

/** One flow on one device. */
export async function runFlow(c: FlowClient, flowIn: Flow, o: RunOptions): Promise<FlowResult> {
  const log = o.log ?? (() => {});
  const retries = Math.max(0, Math.floor(o.retries ?? 0));
  let res: FlowResult | undefined;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    res = await attemptFlow(c, flowIn, o, attempt, retries + 1);
    res.attempts = attempt;
    if (res.status !== 'fail' || o.signal?.aborted) break;
    if (attempt <= retries) log(`  retrying (${attempt}/${retries})…`);
  }
  return res!;
}

async function attemptFlow(c: FlowClient, flowIn: Flow, o: RunOptions, attempt: number, attempts: number): Promise<FlowResult> {
  const log = o.log ?? (() => {});
  const t0 = Date.now(); const startedAt = new Date(t0).toISOString();
  const base: FlowResult = { name: flowIn.name, file: flowIn.file, status: 'pass', steps: [], ms: 0, attempts: attempt, startedAt };
  let device: Device;
  try { device = await c.device(o.deviceId); }
  catch (e) { return { ...base, status: 'fail', message: `Device ${o.deviceId}: ${errInfo(e).message}`, ms: Date.now() - t0 }; }
  base.device = `${device.name} (${device.osVersion ?? device.platform})`;
  const name = `${flowIn.name}${flowIn.file ? ` (${displayPath(flowIn.file)})` : ''}`;

  // platform / OS gates
  if (flowIn.platform && device.platform !== flowIn.platform) return { ...base, status: 'skip', message: `for ${flowIn.platform}; ${device.name} is ${device.platform}`, ms: 0 };
  const os = osVersionNumber(device.osVersion);
  if (flowIn.minOS && os && compareVersions(os, flowIn.minOS) < 0) return { ...base, status: 'skip', message: `needs ${device.platform} ${flowIn.minOS} or later; ${device.name} has ${os}`, ms: 0 };
  if (device.state !== 'running') return { ...base, status: 'fail', message: `${device.name} is ${device.state}; boot it first (phonedock boot ${device.id})`, ms: 0 };

  if (attempt === 1) log(`Flow: ${name} on ${device.name} (${device.osVersion ?? device.platform})`);
  const env = { ...flowIn.env, ...process.env, ...(o.env ?? {}) };
  let steps: Step[];
  try { steps = flowIn.steps.map((s) => interpolateStep(s, env)); }
  catch (e) { return { ...base, status: 'fail', message: (e as Error).message, ms: Date.now() - t0 }; }

  // lease for the run (released afterwards if this run took it)
  const held = device.lease?.owner === c.owner;
  try { await c.lease(device.id); }
  catch (e) { return { ...base, status: 'fail', message: `Could not lease ${device.name}: ${errInfo(e).message}${errInfo(e).detail ? ` (${errInfo(e).detail!.split('\n')[0]})` : ''}`, ms: Date.now() - t0 }; }

  const ctx = new Ctx(c, device, flowIn, o);
  const results: StepResult[] = [];
  let failed: StepResult | undefined;
  try {
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]; const desc = describeStep(s); const st = Date.now();
      if (o.signal?.aborted) { results.push({ index: i + 1, step: s, description: desc, status: 'skip', ms: 0, message: 'cancelled' }); continue; }
      if (failed) { results.push({ index: i + 1, step: s, description: desc, status: 'skip', ms: 0 }); continue; }
      let r: StepResult;
      try {
        const note = await ctx.run(s);
        r = { index: i + 1, step: s, description: desc, status: 'pass', ms: Date.now() - st, ...(note ? { message: note } : {}) };
      } catch (e) {
        const msg = e instanceof StepFailure ? e.message : ctx.explain(s, e);
        r = { index: i + 1, step: s, description: desc, status: s.optional ? 'warn' : 'fail', ms: Date.now() - st, message: msg };
        if (!s.optional) failed = r;
      }
      results.push(r);
      log(stepLine(r, steps.length));
    }
  } finally {
    if (!held) await c.releaseLease(device.id).catch(() => {});
  }
  const res: FlowResult = { ...base, steps: results, ms: Date.now() - t0, status: failed ? 'fail' : 'pass', ...(failed ? { message: `step ${failed.index} (${failed.description}): ${failed.message}` } : {}) };
  if (failed) {
    const dir = join(o.artifactsDir, `${slug(flowIn.name)}${attempts > 1 ? `-attempt${attempt}` : ''}`);
    const notRun = results.filter((r) => r.status === 'skip').length;
    if (notRun) log(`${' '.repeat(10 + String(steps.length).length)}(${notRun} later step${notRun === 1 ? '' : 's'} not run)`);
    res.artifacts = await saveArtifacts(c, device, flowIn, res, dir, ctx.shots);
    log(`${' '.repeat(10 + String(steps.length).length)}Artifacts: ${res.artifacts}`);
  }
  if (o.signal?.aborted && res.status === 'pass') { res.status = 'fail'; res.message = 'cancelled'; }
  return res;
}

export function stepLine(r: StepResult, total: number): string {
  const tag = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' }[r.status];
  const n = String(r.index).padStart(String(total).length);
  const head = `  ${tag}  ${n}  ${r.description}`;
  const line = r.status === 'skip' && !r.message ? `${head}` : `${head.padEnd(64)} ${secs(r.ms).padStart(7)}`;
  if (!r.message) return line;
  const pad = ' '.repeat(10 + n.length);   // under the description
  return `${line}\n${r.message.split('\n').map((l) => pad + l).join('\n')}`;
}

/** Executes steps against one device. */
class Ctx {
  c: FlowClient; device: Device; flow: Flow; o: RunOptions;
  timeoutMs: number; idleBroken = false; shots: string[] = [];
  constructor(c: FlowClient, device: Device, flow: Flow, o: RunOptions) {
    this.c = c; this.device = device; this.flow = flow; this.o = o;
    this.timeoutMs = o.timeoutMs ?? (device.platform === 'ios' ? 15_000 : 10_000);   // iOS accessibility reads are slower
  }
  get id() { return this.device.id; }

  async settle(maxMs = 3000, stableMs = 400) {
    if (this.o.settle === false) return;
    if (this.idleBroken) { await sleep(500); return; }
    try { await this.c.waitFor(this.id, { until: 'idle', stableMs, intervalMs: 150, timeoutMs: maxMs }); }
    catch (e) { if (errInfo(e).code === 'not_supported') { this.idleBroken = true; await sleep(500); } /* still moving: carry on */ }
  }

  /** The element a selector names, once it is visible (waits up to the step's timeout). */
  async locate(sel: Selector, timeoutMs: number, what = 'to be visible'): Promise<ElementMatch> {
    const t0 = Date.now();
    const pick = async () => {
      const r = await this.c.find(this.id, { ...findQuery(sel), ...(sel.index ? { index: sel.index } : {}) });
      if (r.match?.visible) return { m: r.match, r };
      const vis = sel.index ? undefined : r.matches.find((m) => m.visible);
      return { m: vis, r };
    };
    let got = await pick();
    if (got.m) return got.m;
    try {
      await this.c.waitFor(this.id, { until: 'visible', ...findQuery(sel), timeoutMs: Math.max(0, timeoutMs - (Date.now() - t0)) });
    } catch (e) {
      if (errInfo(e).code !== 'wait_timeout') throw e;
      const extra = hiddenNote(e);
      throw new StepFailure([`Expected ${describeSelector(sel)} ${what} within ${dur(timeoutMs)}, but it never appeared.`, ...(extra ? [extra] : []), `Screen now: ${screenNow(e) ?? got.r.summary ?? '?'}`].join('\n'));
    }
    got = await pick();
    if (!got.m) throw new StepFailure(`Expected ${describeSelector(sel)} ${what}${sel.index ? ` (match #${sel.index})` : ''}, but it was not there when looked up again.\nScreen now: ${got.r.summary ?? '?'}`);
    // it only just appeared: let the screen finish moving before acting on it
    if (Date.now() - t0 > 600) await this.settle(1500, 300);
    return (await pick()).m ?? got.m;
  }

  px(p: Point): [number, number] {
    if (p.unit === 'px') return [p.x, p.y];
    const w = this.device.screen?.width ?? 0, h = this.device.screen?.height ?? 0;
    if (!w || !h) throw new StepFailure('The screen size is unknown, so percent coordinates cannot be used');
    return [Math.round(p.x / 100 * w), Math.round(p.y / 100 * h)];
  }

  async run(s: Step): Promise<string | undefined> {
    const c = this.c, id = this.id;
    const to = s.timeoutMs ?? this.timeoutMs;
    const appOf = (a?: string) => {
      const x = a ?? this.flow.appId;
      if (!x) throw new StepFailure(`${s.kind} needs an app: write "${s.kind}: <app id>" or set appId: at the top of the flow`);
      return x;
    };
    switch (s.kind) {
      case 'launch': {
        const app = appOf(s.app);
        if (s.stop) await c.terminate(id, app).catch(() => {});
        try { await c.launch(id, app); }
        catch (e) {
          // The usual first failure in CI: the app was never installed on this device. Say so plainly.
          const apps = c.apps ? await c.apps(id, { system: true }).catch(() => undefined) : undefined;
          if (apps && !apps.some((a) => a.id === app)) {
            throw new StepFailure(`${app} isn’t installed on ${this.device.name}. Install it before the run: phonedock install ${this.device.name} <path to .apk or .app>`);
          }
          throw e;
        }
        await this.settle(8000, 600);
        return;
      }
      case 'terminate': await c.terminate(id, appOf(s.app)); await this.settle(); return;
      case 'tap': case 'long_press': case 'double_tap': {
        let x: number, y: number; let m: ElementMatch | undefined;
        if (s.at) [x, y] = this.px(s.at);
        else { m = await this.locate(s.sel!, to); x = m.center.x; y = m.center.y; }
        if (s.kind === 'tap') await c.tap(id, x, y, m ? (m.text || m.label || undefined) : undefined, m ? { selector: tapSel(s.sel!), element: { type: m.type, ...(m.id ? { id: m.id } : {}) } } : undefined);
        else if (s.kind === 'long_press') await c.longPress(id, x, y, s.durationMs);
        else await c.doubleTap(id, x, y);
        await this.settle();
        return;
      }
      case 'fill': {
        let r;
        if (s.at) { const [x, y] = this.px(s.at); r = await c.fill(id, { x, y, value: s.value, submit: s.submit, clear: s.clear, secret: s.secret }); }
        else {
          await this.locate(s.field!, to);
          r = await c.fill(id, { ...findQuery(s.field!), ...(s.field!.index ? { index: s.field!.index } : {}), value: s.value, submit: s.submit, clear: s.clear, secret: s.secret });
        }
        await this.settle();
        if (r.verified === false && !s.secret) throw new StepFailure(`Typed ${JSON.stringify(s.value)} into ${s.at ? 'the field' : describeSelector(s.field)}, but it shows ${JSON.stringify(r.finalValue ?? '')}${r.warnings?.length ? ` (${r.warnings.join('; ')})` : ''}`);
        return r.warnings?.length ? r.warnings.join('; ') : undefined;
      }
      case 'type': await c.type(id, s.text, { secret: s.secret }); if (s.submit) await c.key(id, 'enter'); await this.settle(); return;
      case 'key': await c.key(id, s.key as Parameters<FlowClient['key']>[1]); await this.settle(); return;
      case 'back': await c.goBack(id); await this.settle(); return;
      case 'home': await c.systemGesture(id, 'go_home'); await this.settle(); return;
      case 'hide_keyboard': await c.hideKeyboard(id); await this.settle(1500); return;
      case 'scroll_to': {
        const r = await c.scrollTo(id, s.sel.text ?? '', { ...(s.sel.id ? { id: s.sel.id } : {}), ...(s.sel.type ? { type: s.sel.type } : {}), ...(s.sel.match ? { match: s.sel.match } : {}), ...(s.direction ? { direction: s.direction } : {}), ...(s.max !== undefined ? { maxScrolls: s.max } : {}) });
        if (!r.found) throw new StepFailure(`Scrolled ${r.direction} ${r.scrolls} time${r.scrolls === 1 ? '' : 's'} looking for ${describeSelector(s.sel)}: ${r.reason ?? 'not found'}.\nScreen now: ${r.summary ?? '?'}`);
        await this.settle(1500);
        return;
      }
      case 'swipe': {
        if (s.from && s.to) { const [x1, y1] = this.px(s.from); const [x2, y2] = this.px(s.to); await c.swipe(id, x1, y1, x2, y2, s.durationMs); }
        else await c.swipeDirection(id, s.direction!, { ...(s.distance !== undefined ? { distance: s.distance } : {}), ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}) });
        await this.settle();
        return;
      }
      case 'wait_for': {
        if (s.until === 'idle') {
          try { await c.waitFor(id, { until: 'idle', timeoutMs: s.timeoutMs ?? Math.max(to, 5000), ...(s.stableMs !== undefined ? { stableMs: s.stableMs } : {}) }); }
          catch (e) { if (errInfo(e).code === 'wait_timeout') throw new StepFailure(`The screen kept changing for ${dur(s.timeoutMs ?? Math.max(to, 5000))}.\nScreen now: ${screenNow(e) ?? '?'}`); throw e; }
          return;
        }
        if (s.until === 'visible') { await this.locate(s.sel!, to); return; }
        try { await c.waitFor(id, { until: 'gone', ...findQuery(s.sel!), timeoutMs: to, ...(s.stableMs !== undefined ? { stableMs: s.stableMs } : {}) }); }
        catch (e) { if (errInfo(e).code === 'wait_timeout') throw new StepFailure(`Expected ${describeSelector(s.sel)} to go away within ${dur(to)}, but it is still there.\nScreen now: ${screenNow(e) ?? '?'}`); throw e; }
        return;
      }
      case 'set_appearance': await c.setAppearance(id, s.mode); await this.settle(); return;
      case 'rotate': {
        await c.rotate(id, s.orientation);
        await this.settle(4000);
        try { this.device = await c.device(id); } catch { /* keep the old size */ }
        return;
      }
      case 'open_url': await c.openUrl(id, s.url); await this.settle(6000, 600); return;
      case 'gesture': await c.systemGesture(id, s.gesture as Parameters<FlowClient['systemGesture']>[1]); await this.settle(); return;
      case 'alert': {
        const r = await c.handleAlert(id, s.action === 'button' ? { button: s.button! } : s.action) as { handled?: boolean; ok?: boolean; reason?: string };
        if (r && r.handled === false) throw new StepFailure(`No system prompt to ${s.action === 'button' ? `press "${s.button}" on` : s.action}${r.reason ? ` (${r.reason})` : ''}`);
        await this.settle();
        return;
      }
      case 'sleep': await sleep(s.ms); return;
      case 'assert_visible': await this.locate(s.sel, to); return;
      case 'assert_not_visible': {
        try { await c.waitFor(id, { until: 'gone', ...findQuery(s.sel), timeoutMs: to }); }
        catch (e) { if (errInfo(e).code === 'wait_timeout') throw new StepFailure(`Expected ${describeSelector(s.sel)} not to be on screen, but it is still there after ${dur(to)}.\nScreen now: ${screenNow(e) ?? '?'}`); throw e; }
        return;
      }
      case 'assert_text': {
        const t0 = Date.now(); let last = ''; let summary: string | undefined; let seen = false;
        const want = s.equals !== undefined ? `to be ${JSON.stringify(s.equals)}` : s.contains !== undefined ? `to contain ${JSON.stringify(s.contains)}` : `to match /${s.matches}/`;
        const ok = (v: string) => (s.equals !== undefined ? v.trim() === s.equals.trim() : s.contains !== undefined ? v.toLowerCase().includes(s.contains.toLowerCase()) : new RegExp(s.matches!).test(v));
        for (;;) {
          const r = await c.find(id, { ...findQuery(s.field), ...(s.field.index ? { index: s.field.index } : {}) });
          summary = r.summary;
          const m = r.match;
          if (m) { seen = true; last = m.value ?? m.text ?? m.label ?? ''; if (ok(last)) return; }
          if (Date.now() - t0 >= to) break;
          await sleep(300);
        }
        throw new StepFailure(seen ? `Expected ${describeSelector(s.field)} ${want}, but it is ${JSON.stringify(last)}.` : `Expected ${describeSelector(s.field)} ${want}, but no such element is on screen.\nScreen now: ${summary ?? '?'}`);
      }
      case 'screenshot': {
        const shot = await c.screenshot(id, { format: 'png' });
        const dir = join(this.o.artifactsDir, slug(this.flow.name));
        mkdirSync(dir, { recursive: true });
        const out = join(dir, `${slug(s.name)}.png`);
        writeFileSync(out, shot.data); this.shots.push(out);
        if (!s.baseline) return `saved ${out}`;
        const base = resolve(this.flow.file ? dirname(this.flow.file) : process.cwd(), s.baseline);
        if (!existsSync(base)) { mkdirSync(dirname(base), { recursive: true }); writeFileSync(base, shot.data); return `baseline created: ${base}`; }
        if (!this.o.compareImages) return `saved ${out} (no image comparison available; baseline not checked)`;
        const diff = await this.o.compareImages(readFileSync(base), shot.data);
        const tol = s.tolerance ?? 0.02;
        if (diff > tol) throw new StepFailure(`The screen differs from ${displayPath(base)}: ${(diff * 100).toFixed(1)}% changed (tolerance ${(tol * 100).toFixed(1)}%). Now: ${out}`);
        return `matches the baseline (${(diff * 100).toFixed(1)}% changed)`;
      }
    }
  }

  /** A readable failure message for an error from the client. */
  explain(s: Step, e: unknown): string {
    const x = errInfo(e);
    const scr = screenNow(e);
    const first = (x.detail ?? '').split('\n').find((l) => l && !/^Screen now/.test(l));
    const what = x.message ?? String(e);
    return [`${what}${first && first !== what ? ` (${first})` : ''}`, ...(scr ? [`Screen now: ${scr}`] : [])].join('\n');
  }
}

async function saveArtifacts(c: FlowClient, device: Device, flow: Flow, res: FlowResult, dir: string, shots: string[]): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const tryWrite = async (name: string, get: () => Promise<string | Buffer>) => {
    try { writeFileSync(join(dir, name), await get()); } catch (e) { writeFileSync(join(dir, `${name}.error.txt`), `${errInfo(e).message ?? e}\n`); }
  };
  await tryWrite('failure.png', async () => (await c.screenshot(device.id, { format: 'png' })).data);
  await tryWrite('ui.txt', () => c.uiText(device.id));
  await tryWrite('ui.json', async () => JSON.stringify(await c.ui(device.id), null, 2));
  await tryWrite('logs.txt', () => c.logs(device.id, { lines: 500 }));
  if (flow.appId) await tryWrite('app.log', () => c.logs(device.id, { lines: 300, app: flow.appId }));
  writeFileSync(join(dir, 'steps.txt'), `${flow.name}${flow.file ? ` (${flow.file})` : ''} on ${res.device}\n${res.steps.map((r) => stepLine(r, res.steps.length)).join('\n')}\n\n${res.message ?? ''}\n`);
  writeFileSync(join(dir, 'result.json'), JSON.stringify({ ...res, artifacts: dir, shots }, null, 2));
  return dir;
}

// ── many flows, JUnit ──────────────────────────────────────────────────────
export interface SuiteResult { flows: FlowResult[]; passed: number; failed: number; skipped: number; ms: number; artifactsDir: string }

/** Load and run flow files in order. Files that don't parse fail (a broken flow must not pass CI). */
export async function runFlowFiles(c: FlowClient, files: string[], o: RunOptions): Promise<SuiteResult> {
  const t0 = Date.now(); const flows: FlowResult[] = []; const log = o.log ?? (() => {});
  for (const f of files) {
    if (o.signal?.aborted) break;
    let flow: Flow;
    try { flow = parseFlow(readFileSync(f, 'utf8'), f); }
    catch (e) {
      const r: FlowResult = { name: basename(f).replace(FLOW_FILE, ''), file: f, status: 'fail', message: `invalid flow: ${(e as Error).message}`, steps: [], ms: 0, attempts: 1, startedAt: new Date().toISOString() };
      log(`FAIL  ${displayPath(f)}: ${r.message}`); flows.push(r); continue;
    }
    for (const w of flow.warnings) log(`  note: ${displayPath(f)}: ${w}`);
    if (o.platform && flow.platform && flow.platform !== o.platform) {
      flows.push({ name: flow.name, file: f, status: 'skip', message: `for ${flow.platform} (--platform ${o.platform})`, steps: [], ms: 0, attempts: 0, startedAt: new Date().toISOString() });
      log(`SKIP  ${flow.name}: for ${flow.platform}`); continue;
    }
    const r = await runFlow(c, flow, o);
    flows.push(r);
    const at = r.steps.find((s) => s.status === 'fail');
    const how = r.status === 'pass' ? `${r.steps.length} steps` : at ? `failed at step ${at.index} of ${r.steps.length}` : 'did not run';
    log(r.status === 'skip' ? `SKIP  ${r.name}: ${r.message}` : `${r.status === 'pass' ? 'PASS' : 'FAIL'}  ${r.name} (${how}, ${secs(r.ms)}${r.attempts > 1 ? `, attempt ${r.attempts}` : ''})`);
    if (r.status === 'fail' && !r.steps.length && r.message) log(`      ${r.message}`);
    log('');
  }
  return { flows, passed: flows.filter((f) => f.status === 'pass').length, failed: flows.filter((f) => f.status === 'fail').length, skipped: flows.filter((f) => f.status === 'skip').length, ms: Date.now() - t0, artifactsDir: o.artifactsDir };
}

const xml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

/** JUnit XML: one testsuite, one testcase per flow (steps in system-out). */
export function junitXml(s: SuiteResult, suiteName = 'phonedock flows'): string {
  const t = (ms: number) => (ms / 1000).toFixed(3);
  const cases = s.flows.map((f) => {
    const cls = f.file ? displayPath(f.file) : 'phonedock';
    const out = [f.device ? `device: ${f.device}` : '', ...f.steps.map((r) => stepLine(r, f.steps.length)), f.artifacts ? `artifacts: ${f.artifacts}` : '', f.attempts > 1 ? `attempts: ${f.attempts}` : ''].filter(Boolean).join('\n');
    const body = f.status === 'fail' ? `      <failure message="${xml((f.message ?? 'failed').split('\n')[0])}" type="FlowFailure">${xml(f.message ?? '')}${f.artifacts ? xml(`\nArtifacts: ${f.artifacts}`) : ''}</failure>\n`
      : f.status === 'skip' ? `      <skipped message="${xml(f.message ?? '')}"/>\n` : '';
    return `    <testcase classname="${xml(cls)}" name="${xml(f.name)}" time="${t(f.ms)}"${f.file ? ` file="${xml(cls)}"` : ''}>\n${body}${out ? `      <system-out>${xml(out)}</system-out>\n` : ''}    </testcase>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(suiteName)}" tests="${s.flows.length}" failures="${s.failed}" errors="0" skipped="${s.skipped}" time="${t(s.ms)}">\n`
    + `  <testsuite name="${xml(suiteName)}" tests="${s.flows.length}" failures="${s.failed}" errors="0" skipped="${s.skipped}" time="${t(s.ms)}" timestamp="${new Date(Date.now() - s.ms).toISOString().slice(0, 19)}">\n${cases.join('\n')}\n  </testsuite>\n</testsuites>\n`;
}
