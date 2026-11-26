import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_SIMSLIM_EXCEPT,
  cachedSimslimStatus,
  clearSimslimStatus,
  parseSimslimReport,
  prepareSimslimBoot,
  resolveSlimBootPlan,
  setSimslimSetting,
  simslimDeviceAction,
  simslimSetting,
  simslimStatus,
  type SimslimDeps,
} from './ios-simslim.ts';

function fakeDeps(dir: string, overrides: Partial<SimslimDeps> = {}): SimslimDeps {
  return {
    resolveBinary: () => '/opt/homebrew/bin/simslim',
    runCmd: async () => ({ code: 0, stdout: '', stderr: '' }),
    exists: () => true,
    settingPath: () => join(dir, 'simslim.json'),
    env: {},
    ...overrides,
  };
}

const UDID = '11111111-2222-3333-4444-555555555555';

test('simslim settings default off, persist to disk, and respect env override', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-simslim-'));
  try {
    const deps = fakeDeps(dir);
    const d0 = simslimSetting(deps);
    assert.equal(d0.enabled, false);
    assert.equal(d0.source, 'default');
    assert.deepEqual(d0.except, [...DEFAULT_SIMSLIM_EXCEPT]);

    const saved = setSimslimSetting({ enabled: true, except: ['web', 'store'] }, deps);
    assert.equal(saved.enabled, true);
    assert.equal(saved.source, 'setting');
    assert.deepEqual(saved.except, ['web', 'store']);

    const envDeps = fakeDeps(dir, { env: { PHONEDOCK_SIMSLIM_ENABLED: 'off' } });
    const overridden = simslimSetting(envDeps);
    assert.equal(overridden.enabled, false);
    assert.equal(overridden.source, 'env');
    assert.equal(overridden.savedEnabled, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveSlimBootPlan honors boot > spec > managed global setting and leaves unmanaged simulators stock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-simslim-plan-'));
  try {
    const deps = fakeDeps(dir);
    setSimslimSetting({ enabled: true }, deps);

    // Unmanaged simulator is never slimmed unless explicitly requested
    assert.equal(resolveSlimBootPlan({ managed: false }, deps).want, false);
    assert.equal(resolveSlimBootPlan({ managed: true }, deps).want, true);
    // Explicit false overrides global on
    assert.equal(resolveSlimBootPlan({ managed: true, bootSlim: false }, deps).want, false);
    // Explicit profile path overrides default except
    const p = resolveSlimBootPlan({ managed: false, bootSlim: '/tmp/custom.json' }, deps);
    assert.equal(p.want, true);
    assert.equal(p.profilePath, '/tmp/custom.json');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareSimslimBoot runs simslim on and caches parsed status', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-simslim-boot-'));
  const calls: string[][] = [];
  try {
    clearSimslimStatus(UDID);
    const deps = fakeDeps(dir, {
      runCmd: async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (args[0] === 'status') {
          return { code: 0, stdout: JSON.stringify({ slim: true, disabled: 82, managedTotal: 173 }), stderr: '' };
        }
        return { code: 0, stdout: 'ok', stderr: '' };
      },
    });
    const out = await prepareSimslimBoot(UDID, { bootSlim: true, managed: true, alreadyBooted: false }, deps);
    assert.equal(out.applied, true);
    assert.equal(out.info?.slimmed, true);
    assert.equal(out.info?.disabledCount, 82);
    assert.equal(out.info?.managedTotal, 173);
    assert.equal(calls[0][0], '/opt/homebrew/bin/simslim');
    assert.ok(calls[0].includes('on'));
    assert.ok(calls[0].includes(UDID));
    assert.ok(calls[0].includes('--except'));
    assert.equal(cachedSimslimStatus(UDID)?.disabledCount, 82);
  } finally {
    clearSimslimStatus(UDID);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareSimslimBoot falls back to stock boot and restores on simslim failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-simslim-fail-'));
  const calls: string[][] = [];
  try {
    clearSimslimStatus(UDID);
    const deps = fakeDeps(dir, {
      runCmd: async (_cmd, args) => {
        calls.push(args);
        if (args.includes('on')) return { code: 1, stdout: '', stderr: 'runtime unsupported' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const notes: string[] = [];
    const out = await prepareSimslimBoot(UDID, { bootSlim: true, managed: true, alreadyBooted: false, onProgress: (l) => notes.push(l) }, deps);
    assert.equal(out.applied, false);
    assert.match(out.fallbackReason ?? '', /runtime unsupported/);
    assert.ok(calls.some((a) => a[0] === 'off' && a.includes('--preserve-boot-state')));
    assert.equal(cachedSimslimStatus(UDID)?.slimmed, false);
    assert.ok(notes.some((n) => /falling back/i.test(n)));
  } finally {
    clearSimslimStatus(UDID);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('simslimStatus & simslimDeviceAction measure and validate cleanly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-simslim-act-'));
  try {
    const profileFile = join(dir, 'ui.json');
    writeFileSync(profileFile, JSON.stringify({ name: 'ui', except: ['web'] }));
    const deps = fakeDeps(dir, {
      runCmd: async (_cmd, args) => {
        if (args[0] === '--version') return { code: 0, stdout: 'simslim 0.15.0\n', stderr: '' };
        if (args[0] === 'status') return { code: 0, stdout: JSON.stringify({ slim: true, disabled: 80, managedTotal: 173 }), stderr: '' };
        if (args[0] === 'measure') return { code: 0, stdout: JSON.stringify({ physFootprintBytes: 512 * 1024 * 1024, processes: 54 }), stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    const st = await simslimStatus(deps);
    assert.equal(st.available, true);
    assert.equal(st.version, 'simslim 0.15.0');

    const m = await simslimDeviceAction(UDID, 'measure', { profilePath: profileFile }, deps);
    assert.equal(m.slimmed, true);
    assert.equal(m.disabledCount, 80);
    assert.equal(m.footprintMB, 512);
    assert.equal(m.processCount, 54);

    const parsed = parseSimslimReport({ slimmed: true, disabledCount: 12, memoryMB: 410.5, processCount: 48 });
    assert.equal(parsed.footprintMB, 410.5);
    assert.equal(parsed.processCount, 48);

    await assert.rejects(simslimDeviceAction('not-a-udid', 'status', {}, deps), (e: any) => e.code === 'bad_request');
  } finally {
    clearSimslimStatus(UDID);
    rmSync(dir, { recursive: true, force: true });
  }
});
