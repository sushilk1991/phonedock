// Test support: a fake Xcode developer directory whose `xcrun devicectl` answers from a scenario file, so tests that
// drive the ios-device backend never reach a real phone (DEVELOPER_DIR points here; xcrun runs <dir>/usr/bin/xcrun).
// Run as a script by that xcrun; imported by tests for `fakeDevicectl()`.
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface FakePhone {
  udid: string; coreDeviceId: string; name?: string; osVersion?: string;
  tunnelIp?: string; transport?: 'wired' | 'localNetwork';
  /** An idle phone: its tunnel is down until `device info details` brings it up at this address. That answer carries
   *  the address unless `detailsOmitsTunnel`; `list devices` shows it only `listLag` lists later (as on a real Mac). */
  wakesTo?: string; listLag?: number; detailsOmitsTunnel?: boolean;
  /** Only the deprecated `connectionProperties` (devicectl before Xcode 27), without `properties.connection`. */
  legacyOnly?: boolean;
}
export interface FakeApp {
  bundleIdentifier: string;
  url: string;
  executable?: string;
  pids: number[];
  ignoresSigterm?: boolean;
  ignoresSigkill?: boolean;
}
export interface FakeScenario {
  phones: FakePhone[];
  /** WebDriverAgent runner pids on each phone (by udid); terminate removes them. */
  runners: Record<string, number[]>;
  /** Installed apps and their running processes (by udid), for terminateApp tests. */
  apps?: Record<string, FakeApp[]>;
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

/** A real `devicectl list devices` entry from Xcode 27 (keys only, values scrubbed): the fake fills it in, so code
 *  that reads a key devicectl doesn't send fails here too. */
const SHAPE = JSON.parse(readFileSync(join(dirname(here), 'fixtures', 'devicectl-list-entry.json'), 'utf8'));

function device(p: FakePhone) {
  const d = JSON.parse(JSON.stringify(SHAPE));
  const up = !!p.tunnelIp, transport = p.transport ?? 'localNetwork';
  d.identifier = p.coreDeviceId;
  Object.assign(d.hardwareProperties, { udid: p.udid, platform: 'iOS', reality: 'physical', marketingName: 'iPhone XS', productType: 'iPhone11,2' });
  const legacy = d.connectionProperties;
  Object.assign(legacy, { pairingState: 'paired', tunnelState: up ? 'connected' : 'disconnected', transportType: transport, tunnelTransportProtocol: 'tcp',
    authenticationType: 'manualPairing', lastConnectionDate: '2026-11-24T00:00:00Z', localHostnames: [], potentialHostnames: [] });
  const current = d.properties.connection;
  Object.assign(current, { pairingState: 'paired', state: up ? 'connected' : 'disconnected', transportType: transport, tunnelTransportProtocol: 'tcp',
    authenticationType: 'manualPairing' });
  // devicectl leaves the address out while the tunnel is down.
  if (up) { legacy.tunnelIPAddress = p.tunnelIp; current.tunnelIPAddressString = p.tunnelIp; } else { delete legacy.tunnelIPAddress; delete current.tunnelIPAddressString; }
  if (p.legacyOnly) delete d.properties;
  d.deviceProperties = { name: p.name ?? 'Test iPhone', osVersionNumber: p.osVersion ?? '18.7', developerModeStatus: 'enabled' };
  return d;
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
  if (a === 'list' && b === 'devices') {
    await sleep();
    const shown = s.phones.map((p) => {
      if (!p.wakesTo || p.tunnelIp) return device(p);
      if (p.listLag !== undefined && p.listLag <= 0) { p.tunnelIp = p.wakesTo; return device(p); }   // caught up
      if (p.listLag !== undefined) p.listLag--;                                                     // woken, list lags
      return device(p);
    });
    writeFileSync(file, JSON.stringify(s));
    return reply({ devices: shown });
  }
  if (!phone) { writeFileSync(out, JSON.stringify({ info: { outcome: 'failed' }, error: { description: `no device ${dev}` } })); return 1; }
  if (a === 'device' && b === 'info' && c === 'apps') {
    const bundleId = argv.includes('--bundle-id') ? argv[argv.indexOf('--bundle-id') + 1] : undefined;
    const all = s.apps?.[phone.udid] ?? [];
    const list = bundleId ? all.filter((x) => x.bundleIdentifier === bundleId) : all;
    return reply({ apps: list.map((x) => ({ bundleIdentifier: x.bundleIdentifier, url: x.url })) });
  }
  if (a === 'device' && b === 'info' && c === 'processes') {
    await sleep();
    const pids = s.runners[phone.udid] ?? [];
    const appProcs = (s.apps?.[phone.udid] ?? []).flatMap((app) =>
      app.pids.map((pid) => ({
        executable: app.executable ?? `${app.url.replace(/\/$/, '')}/AppBinary`,
        processIdentifier: pid,
      })),
    );
    return reply({ runningProcesses: [
      { executable: 'file:///usr/libexec/backboardd', processIdentifier: 40 },
      ...pids.map((pid) => ({ executable: `file:///private/var/containers/Bundle/Application/X/WebDriverAgentRunner-Runner.app/WebDriverAgentRunner-Runner`, processIdentifier: pid })),
      ...appProcs,
    ] });
  }
  if (a === 'device' && b === 'process' && c === 'terminate') {
    const pid = Number(argv[argv.indexOf('--pid') + 1]);
    const kill = argv.includes('--kill');
    s.runners[phone.udid] = (s.runners[phone.udid] ?? []).filter((p) => p !== pid);
    for (const app of s.apps?.[phone.udid] ?? []) {
      if (!app.pids.includes(pid)) continue;
      if (kill ? !app.ignoresSigkill : !app.ignoresSigterm) {
        app.pids = app.pids.filter((p) => p !== pid);
      }
    }
    writeFileSync(file, JSON.stringify(s));
    return reply({});
  }
  if (a === 'device' && b === 'info' && c === 'lockState') return reply({ passcodeRequired: false, unlockedSinceBoot: true });
  if (a === 'device' && b === 'info' && c === 'details') {
    if (phone.wakesTo && !phone.tunnelIp) {
      phone.listLag ??= 2;
      writeFileSync(file, JSON.stringify(s));
      return reply(device({ ...phone, tunnelIp: phone.detailsOmitsTunnel ? undefined : phone.wakesTo }));
    }
    return reply(device(phone));
  }
  return reply({});
}

if (process.argv[1] === here) {
  const [file, log, ...rest] = process.argv.slice(2);
  main(file, log, rest).then((code) => process.exit(code), (e) => { process.stderr.write(String(e)); process.exit(1); });
}
