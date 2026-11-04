// Trace lifecycle in the daemon (trace.ts) against a fake backend: time-limit clamp, one trace per device, failed
// starts, auto-stopped traces handed to the next stop, summary shape (same keys every run, small), comparison.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend, TraceCapture, TraceOptions } from '../core/types.ts';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-trace-'));   // traces + actions.jsonl go under it
const core = await import('./core.ts');
const T = await import('./trace.ts');

const starts: { nid: string; dir: string; opts: TraceOptions }[] = [];
let nextCapture: TraceCapture | undefined;
let failStart: Error | undefined;
const fake = {
  id: 'fake-trace', displayName: 'Fake', platform: 'ios', kind: 'virtual', capabilities: ['trace'],
  available: async () => ({ ok: true }), listDevices: async () => [], screenshot: async () => Buffer.alloc(0),
  tap: async () => {}, swipe: async () => {}, type: async () => {}, key: async () => {},
  async startTrace(nid: string, dir: string, opts: TraceOptions) {
    if (failStart) { const e = failStart; failStart = undefined; throw e; }
    starts.push({ nid, dir, opts });
    return { tool: 'xctrace' as const, template: opts.template ?? 'Time Profiler', instruments: [], process: { pid: 42 } };
  },
  async stopTrace() { const c = nextCapture ?? iosCapture(0); nextCapture = undefined; return c; },
  async abortTrace() {},
} as unknown as Backend;
core.backends.push(fake);

function iosCapture(hangs: number, big = false): TraceCapture {
  const sym = (i: number) => (big ? `specialized generic function number ${i} with a very long templated C++ name<swift::InProcess>::operator()`.slice(0, 100) : `fn${i}()`);
  return {
    files: { trace: '/x/trace.trace', triage: '/x/triage.md', toc: '/x/toc.txt', log: '/x/xctrace.log' }, durationSec: 12.3,
    hangs: { count: hangs, totalMs: hangs * 600, longestMs: hangs ? 800 : 0, byType: { severe: 0, hang: hangs, microhang: 0, brief: 0, delay: 0 } },
    mainThreadMs: 1000 + hangs * 600,
    hotspots: Array.from({ length: 25 }, (_, i) => ({ symbol: sym(i), library: 'libsystem_kernel.dylib', ms: 500 - i, pct: 10 })),
    appHotspots: Array.from({ length: 25 }, (_, i) => ({ symbol: sym(i), library: 'MyApp', ms: 400 - i, pct: 8 })),
    frames: null, triage: big ? `==============Hang #1==============\n${'|*|9|829.00 ms\t99.5%|824.00 ms|countPrimesSlowly(upTo:)|\n'.repeat(400)}` : 'No hangs in this trace.', notes: [],
  };
}
const androidCapture = (): TraceCapture => ({
  files: { trace: '/x/trace.perfetto-trace', gfxinfo: '/x/gfxinfo.txt', config: '/x/perfetto-config.pbtxt' }, durationSec: 9.7,
  hangs: null, mainThreadMs: null, hotspots: [], appHotspots: [],
  frames: { total: 151, janky: 3, jankyPct: 1.99, p50Ms: 5, p90Ms: 7, p95Ms: 9, p99Ms: 31, missedVsync: 0, slowUiThread: 1, deadlineMissed: 3, jankyLegacyPct: 4 },
  triage: null, notes: ['Open trace.perfetto-trace in https://ui.perfetto.dev'],
});
const dev = (n: string, platform: 'ios' | 'android' = 'ios') => ({ id: `fake-trace:${n}`, name: n, platform });
const req = (o: Partial<{ appId: string; template: string; timeLimitSec: number }> = {}) => ({ appId: 'com.example.app', timeLimitSec: 60, ...o });

test('clampTimeLimit: default 60 s, at least 2 s, at most 600 s', () => {
  assert.equal(T.clampTimeLimit(undefined), 60);
  assert.equal(T.clampTimeLimit(''), 60);
  assert.equal(T.clampTimeLimit('abc'), 60);
  assert.equal(T.clampTimeLimit(-5), 60);
  assert.equal(T.clampTimeLimit(0), 60);
  assert.equal(T.clampTimeLimit(1), 2);
  assert.equal(T.clampTimeLimit(30.4), 30);
  assert.equal(T.clampTimeLimit('45'), 45);
  assert.equal(T.clampTimeLimit(3600), 600);
});

test('one trace per device: a second start gets 409 trace_active; other devices are independent; stop frees it', async () => {
  const a = dev('pdtest-one'), b = dev('pdtest-two');
  const r = await T.beginTrace(a, fake, 'pdtest-one', req({ timeLimitSec: 5000 }), 'mcp:test:1');
  assert.equal(r.timeLimitSec, 600, 'clamped');
  assert.equal(starts.at(-1)!.opts.timeLimitSec, 600, 'the recorder gets the clamped limit');
  await assert.rejects(T.beginTrace(a, fake, 'pdtest-one', req(), 'mcp:test:2'), (e: Error & { code?: string; status?: number }) => e.code === 'trace_active' && e.status === 409);
  await T.beginTrace(b, fake, 'pdtest-two', req(), 'mcp:test:1');
  assert.equal(T.traceStatus(a.id).active, true);
  const s1 = await T.stopTraceFor(a.id);
  assert.ok(s1);
  assert.equal(T.traceStatus(a.id).active, false);
  assert.equal(await T.stopTraceFor(a.id), undefined, 'nothing left to stop');
  await T.beginTrace(a, fake, 'pdtest-one', req(), 'mcp:test:2');
  await T.stopTraceFor(a.id); await T.stopTraceFor(b.id);
});

test('a failed start frees the device and is logged in Activity', async () => {
  const a = dev('pdtest-fail');
  failStart = Object.assign(new Error('The app is not running'), { code: 'app_not_running', status: 409, hints: ['Open it first'] });
  await assert.rejects(T.beginTrace(a, fake, 'pdtest-fail', req(), 'cli:me'), /not running/);
  assert.equal(T.traceStatus(a.id).active, false);
  const log = core.readActions(a.id, 10) as { action: { action: string; error?: string } }[];
  assert.equal(log.at(-1)!.action.action, 'trace.start_failed');
  assert.match(log.at(-1)!.action.error!, /not running Open it first/);
  await T.beginTrace(a, fake, 'pdtest-fail', req(), 'cli:me');
  await T.stopTraceFor(a.id);
});

test('a trace the time limit ended is handed to the next stop, with the reason', async () => {
  const a = dev('pdtest-auto');
  await T.beginTrace(a, fake, 'pdtest-auto', req(), 'cli:me');
  assert.equal(await T.stopTraceFor(a.id, 'time limit (60 s) reached'), undefined);
  assert.equal((T.traceStatus(a.id).finished as { reason: string }).reason, 'time limit (60 s) reached');
  const r = await T.stopTraceFor(a.id);
  assert.equal(r!.summary.stopReason, 'time limit (60 s) reached');
  assert.equal(await T.stopTraceFor(a.id), undefined, 'claimed once');
  const acts = (core.readActions(a.id, 10) as { action: { action: string } }[]).map((x) => x.action.action);
  assert.deepEqual(acts, ['trace.start', 'trace.stop'], 'one trace.stop in Activity');
});

test('summary: the same keys every run and across platforms, small by default, compared with the previous run', async () => {
  const a = dev('pdtest-cmp');
  await T.beginTrace(a, fake, 'pdtest-cmp', req(), 'cli:me');
  nextCapture = iosCapture(2, true);
  const before = (await T.stopTraceFor(a.id))!;
  await T.beginTrace(a, fake, 'pdtest-cmp', req(), 'cli:me');
  nextCapture = iosCapture(0, true);
  const after = (await T.stopTraceFor(a.id))!;
  const shape = (o: object): string[] => Object.keys(o).sort();
  assert.deepEqual(shape(after.summary), shape(before.summary));
  assert.deepEqual(shape(after.summary.metrics), shape(before.summary.metrics));
  assert.equal(before.summary.compare, null, 'nothing to compare the first run with');
  assert.equal(after.summary.compare!.traceId, before.traceId);
  assert.deepEqual(after.summary.compare!.changes.hangs, { before: 2, after: 0, delta: -2 });
  assert.deepEqual(after.summary.compare!.changes.mainThreadMs, { before: 2200, after: 1000, delta: -1200 });
  assert.equal(after.summary.compare!.changes.jankyPct, undefined, 'metrics neither run measured are left out');
  assert.match(after.text, /vs .*: hangs 2 → 0 \(-2\)/);
  // defaults keep it small even with 25 long hot spots and a 20 KB triage report
  assert.ok(after.summary.hotspots.length >= 3 && after.summary.hotspots.length <= 5, `top ${after.summary.hotspots.length}`);
  assert.match(after.summary.triage!, /^=+Hang #1=+\n[^]*truncated; full report in triage\.md\)$/);
  assert.ok(JSON.stringify(after.summary).length < 4096, `summary JSON ${JSON.stringify(after.summary).length} B`);
  assert.ok(after.text.length < 4096, `text ${after.text.length} B`);
  assert.match(after.text, /^Metrics: \{"durationSec":12\.3,"hangs":0,/m);
  assert.deepEqual(shape(after.summary.files), ['dir', 'summary', 'trace', 'triage']);
  const saved = JSON.parse(readFileSync(after.summary.files.summary, 'utf8'));
  assert.equal(saved.traceId, after.traceId);
  // top / triageChars widen it on request; compareTo: "none" turns the comparison off
  await T.beginTrace(a, fake, 'pdtest-cmp', req(), 'cli:me');
  nextCapture = iosCapture(1, true);
  const wide = (await T.stopTraceFor(a.id, undefined, { top: 25, triageChars: 0, compareTo: 'none' }))!;
  assert.equal(wide.summary.hotspots.length, 25);
  assert.equal(wide.summary.triage, null);
  assert.equal(wide.summary.compare, null);
  // a different template is a different series: not compared
  await T.beginTrace(a, fake, 'pdtest-cmp', req({ template: 'Animation Hitches' }), 'cli:me');
  const other = (await T.stopTraceFor(a.id))!;
  assert.equal(other.summary.compare, null);
  // Android: same summary keys, frame metrics filled, iOS ones null
  const d = dev('pdtest-android', 'android');
  await T.beginTrace(d, fake, 'pdtest-android', req(), 'cli:me');
  nextCapture = androidCapture();
  const an = (await T.stopTraceFor(d.id))!;
  assert.deepEqual(shape(an.summary), shape(after.summary));
  assert.deepEqual(shape(an.summary.metrics), shape(after.summary.metrics));
  assert.equal(an.summary.metrics.hangs, null);
  assert.equal(an.summary.metrics.jankyPct, 1.99);
  assert.equal(an.summary.metrics.frameP99Ms, 31);
  assert.match(an.text, /Frames: 151 rendered, 3 janky \(1\.99%\) · p50 5 ms · p90 7 ms · p95 9 ms · p99 31 ms/);
  assert.deepEqual(T.listTraces(a.id, 2).map((t) => t.traceId), [other.traceId, wide.traceId]);
});

test('compareTo names a trace that does not exist: 404', () => {
  assert.throws(() => T.findPrevious('fake-trace:pdtest-cmp', '', '', '', 'nope'), (e: Error & { code?: string }) => e.code === 'not_found');
});

test('only the newest traces keep their (big) trace file; summaries stay', () => {
  const id = 'fake-trace:pdtest-prune';
  const root = join(process.env.PHONEDOCK_HOME!, 'traces', core.safeId(id));
  const ids = Array.from({ length: 12 }, (_, i) => `2026-01-01T00-00-${String(i).padStart(2, '0')}-000-abcd`);
  for (const t of ids) {
    mkdirSync(join(root, t, 'trace.trace'), { recursive: true });   // a .trace is a bundle (directory)
    writeFileSync(join(root, t, 'trace.trace', 'data'), 'x'); writeFileSync(join(root, t, 'summary.json'), '{}');
  }
  writeFileSync(join(root, ids[0], 'active.json'), '{}');   // still recording: never touched
  const removed = T.pruneTraceFiles(id, 10);
  assert.deepEqual(removed, [join(root, ids[1], 'trace.trace')]);
  assert.ok(existsSync(join(root, ids[0], 'trace.trace')) && existsSync(join(root, ids[2], 'trace.trace')));
  assert.ok(existsSync(join(root, ids[1], 'summary.json')));
});
