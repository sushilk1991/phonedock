// Performance traces: xctrace argument building and output parsing, perfetto config, gfxinfo parsing.
// Fixtures in testdata/ are real outputs: an iPhone 17 / iOS 26.5 simulator trace of a SwiftUI app with an 846 ms
// main-thread stall (Xcode 27.2), and `dumpsys gfxinfo com.android.settings` from an API 36 emulator after scrolling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compactTriage, extraInstruments, parseDurationMs, parseHangsList, parseInvertedTree, parseLaunchctlPid, pickMainThreadTrack,
  recordArgs, triageDurationSec, xctraceError,
} from './ios-trace.ts';
import { parseGfxinfo, parsePerfettoPid, perfettoConfig } from './android-trace.ts';

const fixture = (f: string) => readFileSync(join(import.meta.dirname, 'testdata', f), 'utf8');

test('recordArgs: attach by pid with template, added instruments, time limit and --no-prompt (argv, no shell)', () => {
  assert.deepEqual(recordArgs({ device: 'UDID-1', template: 'App Launch', instruments: ['Hangs'], attach: '5417', output: '/t/trace.trace', timeLimitSec: 60 }), [
    'record', '--device', 'UDID-1', '--template', 'App Launch', '--instrument', 'Hangs', '--output', '/t/trace.trace', '--time-limit', '60s', '--no-prompt', '--attach', '5417',
  ]);
  // launch: the app path is one argv element (spaces and all); everything after `--` goes to the app; the limit is at least 1 s
  assert.deepEqual(recordArgs({ device: 'U', template: 'Time Profiler', instruments: [], launch: ['/p/My App.app', '--flag'], output: '/o.trace', timeLimitSec: 0.4 }), [
    'record', '--device', 'U', '--template', 'Time Profiler', '--output', '/o.trace', '--time-limit', '1s', '--no-prompt', '--launch', '--', '/p/My App.app', '--flag',
  ]);
  assert.throws(() => recordArgs({ device: 'U', template: 'T', instruments: [], output: '/o', timeLimitSec: 5 }));
});

test('extraInstruments: only what the template lacks; both when the template is unknown', () => {
  assert.deepEqual(extraInstruments({ hangs: true, timeProfiler: true }), []);
  assert.deepEqual(extraInstruments({ hangs: false, timeProfiler: true }), ['Hangs']);              // App Launch
  assert.deepEqual(extraInstruments({ hangs: false, timeProfiler: false }), ['Hangs', 'Time Profiler']); // Allocations
  assert.deepEqual(extraInstruments(undefined), ['Hangs', 'Time Profiler']);
});

test('parseDurationMs: xctrace units', () => {
  assert.equal(parseDurationMs('843.57 ms'), 843.57);
  assert.equal(parseDurationMs('1.15 s'), 1150);
  assert.equal(parseDurationMs('15.00 µs'), 0.015);
  assert.equal(parseDurationMs('0 s'), 0);
  assert.equal(parseDurationMs('2 min'), 120_000);
  assert.equal(parseDurationMs('n/a'), undefined);
});

test('parseHangsList: tiers, total, longest; rows of other processes are ignored', () => {
  const md = [
    '|Start|Duration|Process|Thread|Hang Type|', '|---|---|---|---|---|',
    '|00:04.000.079|843.57 ms|Perf Demo (5417)|Main Thread (0x2b02da5)|Hang|',
    '|00:06.100.000|2.40 s|Perf Demo (5417)|Main Thread (0x2b02da5)|Severe Hang|',
    '|00:07.000.000|120.00 ms|Perf Demo (5417)|Main Thread (0x2b02da5)|Brief Unresponsiveness|',
    '|00:08.000.000|300.00 ms|Other (77)|Main Thread (0x1)|Microhang|',
  ].join('\n');
  const h = parseHangsList(md, 5417);
  assert.deepEqual(h, { count: 3, totalMs: 3363.6, longestMs: 2400, byType: { severe: 1, hang: 1, microhang: 0, brief: 1, delay: 0 } });
  assert.equal(parseHangsList(md).count, 4);
  assert.deepEqual(parseHangsList('No Data\n', 5417), { count: 0, totalMs: 0, longestMs: 0, byType: { severe: 0, hang: 0, microhang: 0, brief: 0, delay: 0 } });
});

test('parseInvertedTree: main-thread total and its heaviest leaf functions (real xctrace show output)', () => {
  const p = parseInvertedTree(fixture('xctrace-inverted-main.md'));
  assert.equal(p.threadMs, 960);
  assert.deepEqual(p.top[0], { symbol: 'countPrimesSlowly(upTo:)', library: 'PerfDemo', ms: 830, pct: 86.5 });
  assert.ok(p.top.every((h) => h.ms <= 830), 'sorted heaviest first');
  assert.ok(!p.top.some((h) => h.symbol === 'ContentView.loadReport()'), 'deeper (caller) rows are not leaf functions');
  assert.equal(parseInvertedTree(fixture('xctrace-inverted-main.md'), 2).top.length, 2);
  // the app-only tree charges idle run-loop time to the entry point: skipped
  const own = ['|tree level|Weight|Self Weight|Symbol Names|Library Name|', '|---|---|---|---|---|',
    '|1|960.00 ms\t100.0%|0 s|Perf Demo (5417)||', '|2|960.00 ms\t100.0%|0 s|Main Thread (0x2b02da5)||',
    '|3|835.00 ms\t87.0%|835.00 ms|countPrimesSlowly(upTo:)|PerfDemo|', '|3|124.00 ms\t12.9%|124.00 ms|static PerfDemoApp.$main()|PerfDemo|'].join('\n');
  assert.deepEqual(parseInvertedTree(own, 5, { skipEntryPoints: true }).top.map((h) => h.symbol), ['countPrimesSlowly(upTo:)']);
  assert.deepEqual(parseInvertedTree('garbage'), { threadMs: null, top: [] });
});

test('pickMainThreadTrack / parseLaunchctlPid', () => {
  const tracks = 'Perf Demo (5417)/Main Thread (0x2b02da5)\nPerf Demo (5417)/Perf Demo (0x2b02e06)\nSettings (88)/Main Thread (0x1)\n';
  assert.equal(pickMainThreadTrack(tracks, 5417), 'Perf Demo (5417)/Main Thread (0x2b02da5)');
  assert.equal(pickMainThreadTrack(tracks, 9), undefined);
  assert.equal(pickMainThreadTrack('A (1)/Main Thread (0x2)\n'), 'A (1)/Main Thread (0x2)');
  const lc = 'PID\tStatus\tLabel\n88976\t0\tUIKitApplication:com.apple.Preferences[0687][rb-legacy]\n-\t0\tUIKitApplication:com.apple.mobilecal[7940][rb-legacy]\n5417\t0\tUIKitApplication:dev.phonedock.perfdemo[335b][rb-legacy]\n';
  assert.equal(parseLaunchctlPid(lc, 'dev.phonedock.perfdemo'), 5417);
  assert.equal(parseLaunchctlPid(lc, 'com.apple.mobilecal'), undefined);   // job exists, not running
  assert.equal(parseLaunchctlPid(lc, 'dev.phonedock'), undefined);          // no prefix matches
});

test('compactTriage: per-hang sections only, <trace> instead of the path, capped on a line', () => {
  const md = fixture('xctrace-triage-hang.md');
  assert.equal(triageDurationSec(md), 15.6);
  const t = compactTriage(md);
  assert.match(t, /^=+Hang #1=+/);
  assert.match(t, /Duration: 843\.57 ms/);
  assert.match(t, /countPrimesSlowly\(upTo:\)/);
  assert.match(t, /--input <trace> --track "Perf Demo \(5417\)\/Main Thread \(0x2b02da5\)" --calltree "Profile"/);
  assert.match(t, /^Main-thread CPU during the hang: avg 99\.2%/m);
  assert.doesNotMatch(t, /Summary of SwiftUI Long Updates: N\/A|\/Users\/me|Std Dev CPU Usage|Summary: CPU Usage/);
  assert.doesNotMatch(t, /^\|[^|]*\|[12]\|/m, 'process and thread rows dropped');
  assert.match(t, /^\|\*\|3\|/m, 'the stack starts below them');
  const c = compactTriage(md, 300);
  assert.ok(c.length < 360, `capped (${c.length})`);
  assert.match(c, /truncated; full report in triage\.md/);
  assert.equal(compactTriage('============== Summary ==============\nRun: 1\nSummary of Hangs (Sorted by Hang Type Ascending)\nNo Data\n\nHangs By Duration (Limit = 10, Sorted by Duration Descending):\n'), 'No hangs in this trace.');
});

test('xctraceError: says what to do', () => {
  const ctx = { device: 'U', appId: 'com.x', physical: true };
  assert.equal(xctraceError('Starting recording...\n[Error] Failed to attach to target process: not permitted', ctx).code, 'app_not_debuggable');
  assert.match(xctraceError('Failed to attach to target process', ctx).hints![0], /development-signed/);
  assert.equal(xctraceError('Failed to attach to target process', { ...ctx, physical: false }).code, 'attach_failed');
  assert.equal(xctraceError('Unable to find template named "Nope"', ctx).code, 'bad_template');
  assert.equal(xctraceError('Cannot find template matching name: No Such Template', ctx).code, 'bad_template');   // Xcode 27.2
  assert.equal(xctraceError('The device has Developer Mode disabled', ctx).code, 'developer_mode_off');
  assert.equal(xctraceError('Cannot find device with name or UDID U', ctx).code, 'device_unavailable');
  assert.equal(xctraceError('something else', ctx).code, 'trace_failed');
});

test('perfettoConfig: sched/freq/frame timeline/atrace for the app; duration = the time limit; bad package rejected', () => {
  const c = perfettoConfig('com.android.settings', 60_000);
  for (const s of ['ftrace_events: "sched/sched_switch"', 'ftrace_events: "power/cpu_frequency"', 'name: "android.surfaceflinger.frametimeline"',
    'atrace_categories: "gfx"', 'atrace_categories: "view"', 'atrace_apps: "com.android.settings"', 'duration_ms: 60000', 'write_into_file: true']) {
    assert.ok(c.includes(s), s);
  }
  assert.throws(() => perfettoConfig('com.x"; rm -rf /', 1000), /invalid/);
  assert.equal(parsePerfettoPid('5201\n'), 5201);
  assert.equal(parsePerfettoPid('[perfetto] something\n5201'), 5201);
  assert.equal(parsePerfettoPid('error: no config'), undefined);
});

test('parseGfxinfo: frame stats from a real API 36 dump', () => {
  assert.deepEqual(parseGfxinfo(fixture('gfxinfo-api36-settings.txt')), {
    total: 94, janky: 2, jankyPct: 2.13, p50Ms: 17, p90Ms: 20, p95Ms: 25, p99Ms: 81,
    missedVsync: 0, slowUiThread: 0, deadlineMissed: 2, jankyLegacyPct: 23.4,
  });
  assert.equal(parseGfxinfo('No process found for: com.x\n'), null);
  // nothing drawn: Android prints its top histogram bucket (4950 ms) as every percentile (seen on API 36)
  const none = parseGfxinfo('Total frames rendered: 0\nJanky frames: 0 (0.00%)\n50th percentile: 4950ms\n90th percentile: 4950ms\n95th percentile: 4950ms\n99th percentile: 4950ms\n');
  assert.deepEqual([none!.total, none!.p50Ms, none!.p90Ms, none!.p99Ms], [0, null, null, null]);
  const old = 'Total frames rendered: 10\nJanky frames: 1 (10.00%)\n90th percentile: 19ms\n';   // older Android: fewer lines
  assert.deepEqual(parseGfxinfo(old), { total: 10, janky: 1, jankyPct: 10, p50Ms: null, p90Ms: 19, p95Ms: null, p99Ms: null, missedVsync: null, slowUiThread: null, deadlineMissed: null, jankyLegacyPct: null });
});
