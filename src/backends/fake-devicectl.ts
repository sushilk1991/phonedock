// Test support: a fake Xcode developer directory whose `xcrun devicectl` answers from a scenario file, so tests that
// drive the ios-device backend never reach a real phone (DEVELOPER_DIR points here; xcrun runs <dir>/usr/bin/xcrun).
// Run as a script by that xcrun; imported by tests for `fakeDevicectl()`.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FakePhone {
  udid: string; coreDeviceId: string; name?: string; osVersion?: string;
  tunnelIp?: string; transport?: 'wired' | 'localNetwork';
}
export interface FakeScenario {
  phones: FakePhone[];
  /** WebDriverAgent runner pids on each phone (by udid); terminate removes them. */
  runners: Record<string, number[]>;
  /** `list devices` and `info processes` sleep this long (ms). */
  delayMs?: number;
}

const here = fileURLToPath(import.meta.url);

/** Point DEVELOPER_DIR at a fake that serves `scenario`. Returns the scenario (edit and `save()`), the calls seen,
 *  and `restore()`. */
export function fakeDevicectl(scenario: FakeScenario) {
  const dir = mkdtempSync(join(tmpdir(), 'pd-fake-dev-'));
  const bin = join(dir, 'usr', 'bin');
  mkdirSync(bin, { recursive: true });
  const file = join(dir, 'scenario.json'), log = join(dir, 'calls.log');
  writeFileSync(join(bin, 'xcrun'), `#!/bin/sh\nexec "${process.execPath}" "${here}" "${file}" "${log}" "$@"\n`);
  chmodSync(join(bin, 'xcrun'), 0o755);
  const save = () => writeFileSync(file, JSON.stringify(scenario));
  save();
  const before = process.env.DEVELOPER_DIR;
  process.env.DEVELOPER_DIR = dir;
  return {
    scenario, save,
    calls(): string[] { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean); } catch { return []; } },
    runners(udid: string): number[] { return (JSON.parse(readFileSync(file, 'utf8')) as FakeScenario).runners[udid] ?? []; },
    restore() { if (before === undefined) delete process.env.DEVELOPER_DIR; else process.env.DEVELOPER_DIR = before; rmSync(dir, { recursive: true, force: true }); },
  };
}

function device(p: FakePhone) {
  return {
    identifier: p.coreDeviceId,
    hardwareProperties: { udid: p.udid, platform: 'iOS', reality: 'physical', marketingName: 'iPhone XS', productType: 'iPhone11,2' },
    connectionProperties: {
      pairingState: 'paired', tunnelState: p.tunnelIp ? 'connected' : 'disconnected', transportType: p.transport ?? 'localNetwork',
      ...(p.tunnelIp ? { tunnelIPAddress: p.tunnelIp } : {}),
    },
    deviceProperties: { name: p.name ?? 'Test iPhone', osVersionNumber: p.osVersion ?? '18.7', developerModeStatus: 'enabled' },
  };
}

async function main(file: string, log: string, argv: string[]): Promise<number> {
  appendFileSync(log, argv.join(' ') + '\n');
  if (argv[0] !== 'devicectl') return 1;          // xcodebuild, simctl…: no Xcode here
  const out = argv[argv.indexOf('--json-output') + 1];
  const s = JSON.parse(readFileSync(file, 'utf8')) as FakeScenario;
  const dev = argv.includes('--device') ? argv[argv.indexOf('--device') + 1] : undefined;
  const phone = s.phones.find((p) => p.udid === dev || p.coreDeviceId === dev);
  const reply = (result: unknown) => { writeFileSync(out, JSON.stringify({ info: { outcome: 'success' }, result })); return 0; };
  const sleep = () => new Promise((r) => setTimeout(r, s.delayMs ?? 0));
  const [a, b, c] = argv.slice(1);
  if (a === 'list' && b === 'devices') { await sleep(); return reply({ devices: s.phones.map(device) }); }
  if (!phone) { writeFileSync(out, JSON.stringify({ info: { outcome: 'failed' }, error: { description: `no device ${dev}` } })); return 1; }
  if (a === 'device' && b === 'info' && c === 'processes') {
    await sleep();
    const pids = s.runners[phone.udid] ?? [];
    return reply({ runningProcesses: [
      { executable: 'file:///usr/libexec/backboardd', processIdentifier: 40 },
      ...pids.map((pid) => ({ executable: `file:///private/var/containers/Bundle/Application/X/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner`, processIdentifier: pid })),
    ] });
  }
  if (a === 'device' && b === 'process' && c === 'terminate') {
    const pid = Number(argv[argv.indexOf('--pid') + 1]);
    s.runners[phone.udid] = (s.runners[phone.udid] ?? []).filter((p) => p !== pid);
    writeFileSync(file, JSON.stringify(s));
    return reply({});
  }
  if (a === 'device' && b === 'info' && c === 'lockState') return reply({ passcodeRequired: false, unlockedSinceBoot: true });
  if (a === 'device' && b === 'info' && c === 'details') return reply({ deviceProperties: { developerModeStatus: 'enabled' } });
  return reply({});
}

if (process.argv[1] === here) {
  const [file, log, ...rest] = process.argv.slice(2);
  main(file, log, rest).then((code) => process.exit(code), (e) => { process.stderr.write(String(e)); process.exit(1); });
}
