// CLI output for leases and handoffs: the devices table and lease_conflict hints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhoneDockApiError } from '../sdk/client.ts';
import type { Device } from '../sdk/client.ts';
import { cliDetail, cliHints, devicesTable, humanCell, leaseCell, parseLaunchFlags, parseSpec } from './main.ts';
import { parseArgs } from './args.ts';

const base = { id: 'android-emulator:pdtest-a', name: 'pdtest-a', backend: 'android-emulator', platform: 'android', kind: 'emulator', state: 'running', managed: true } as unknown as Device;
const ID = 'android-emulator:pdtest-a';
const conflict = (owner: string, hints: string[]) => new PhoneDockApiError(`The device is in use by ${owner}`, 'lease_conflict', 409, hints,
  `Device ${ID} is leased by ${owner} since 2026-11-04T10:00:00.000Z\nThe lease ends at …\nPOST /v1/devices/${encodeURIComponent(ID)}/lease (force:true to take over)`);

test('devices: the lease column says who holds it, until when, and when its owner is gone', () => {
  assert.equal(leaseCell(null), '');
  assert.match(leaseCell({ owner: 'mcp:claude-code:42', acquiredAt: '', expiresAt: '2026-11-04T10:10:00.000Z', ttlSec: 600 }), /^mcp:claude-code:42 \(until \d\d:\d\d unless used\)$/);
  assert.equal(leaseCell({ owner: 'app:human', acquiredAt: '', expiresAt: null }), 'app:human (until handed back)');
  assert.equal(leaseCell({ owner: 'mcp:codex:7', acquiredAt: '', expiresAt: null, stale: true }), 'mcp:codex:7 (stale: process exited)');
});

test('devices: a pending handoff shows as WAITING with the request, and the footer says how to finish it', () => {
  const waiting = { ...base, lease: { owner: 'mcp:claude-code:42', acquiredAt: '', expiresAt: null }, handoff: { id: 'abc123', deviceId: ID, reason: 'Type your name and tap Greet', requestedBy: 'mcp:claude-code:42', createdAt: '', expiresAt: '', state: 'pending' } } as unknown as Device;
  assert.equal(humanCell(waiting), 'WAITING (mcp:claude-code:42): "Type your name and tap Greet"');
  const out = devicesTable([waiting]);
  assert.match(out, /HUMAN/);
  assert.match(out, /pdtest-a is waiting for a person: Type your name and tap Greet/);
  assert.match(out, /--owner app:human/);
  assert.match(out, /phonedock handoff done abc123/);
  assert.doesNotMatch(devicesTable([base]), /HUMAN|waiting/);   // no column without a handoff
});

test('lease_conflict hints: never raw routes; a person → handoff request; an agent → lease --force; rm → rm --force', () => {
  const human = cliHints(conflict('app:human', ['A person is using this device…']), 'tap');
  assert.ok(human.some((h) => h.includes('phonedock handoff request android-emulator:pdtest-a')), String(human));
  assert.ok(!human.some((h) => /--force|\/v1\//.test(h)), String(human));
  const agent = cliHints(conflict('mcp:codex:7', ['mcp:codex:7 is using this device…', `A person was asked to do something on it (handoff x by mcp:codex:7: "…").`]), 'tap');
  assert.ok(agent.includes('To take it over anyway: phonedock lease android-emulator:pdtest-a --force'), String(agent));
  assert.ok(agent.some((h) => h.includes('--owner app:human')), String(agent));
  const rm = cliHints(conflict('cli:other', ['cli:other is using this device…']), 'rm');
  assert.ok(rm.includes('To delete it anyway: phonedock rm android-emulator:pdtest-a --force'), String(rm));
  assert.ok(!rm.some((h) => h.includes('phonedock lease')), String(rm));
  assert.doesNotMatch(cliDetail(conflict('cli:other', []).detail) ?? '', /\/v1\//);
});

test('parseSpec: --disguise, --carrier and --seed populate spec.options.disguise additively', () => {
  const plain = parseSpec(parseArgs(['create', '--backend', 'android-emulator', '--name', 'pdtest-plain']));
  assert.equal(plain.options, undefined);

  const bare = parseSpec(parseArgs(['create', '--backend', 'android-emulator', '--name', 'pdtest-d1', '--disguise']));
  assert.deepEqual(bare.options, { disguise: { enabled: true } });

  const full = parseSpec(parseArgs([
    'create', '--backend', 'android-emulator', '--name', 'pdtest-d2',
    '--options', '{"gpu":"host"}', '--disguise', 'galaxy_s24', '--carrier', 'ee_uk', '--seed', 'deadbeef',
  ]));
  assert.deepEqual(full.options, {
    gpu: 'host',
    disguise: { enabled: true, profile: 'galaxy_s24', carrier: 'ee_uk', seed: 'deadbeef' },
  });

  const off = parseSpec(parseArgs(['create', '--backend', 'android-emulator', '--name', 'pdtest-off', '--no-disguise']));
  assert.equal(off.options, undefined);

  assert.throws(
    () => parseSpec(parseArgs(['create', '--backend', 'android-emulator', '--name', 'pdtest-bad', '--no-disguise', '--carrier', 'ee_uk'])),
    /require --disguise/,
  );
});

test('parseLaunchFlags: --arg (including leading dash), --extra, --args-json, --env, and mutual exclusion', () => {
  const argv1 = ['launch', 'sim', 'com.example.app', '--arg', '-UITesting', '--arg=-server', '--arg', 'staging', '--env', 'API_KEY=sec=ret'];
  const parsed1 = parseArgs(argv1);
  assert.deepEqual(parsed1.positionals, ['launch', 'sim', 'com.example.app']);
  assert.deepEqual(parseLaunchFlags(argv1, parsed1), {
    args: ['-UITesting', '-server', 'staging'],
    env: { API_KEY: 'sec=ret' },
  });

  const argv2 = ['launch', 'emu', 'com.example.app', '--extra', 'route=/home', '--extra=user=ada'];
  assert.deepEqual(parseLaunchFlags(argv2, parseArgs(argv2)), {
    args: { route: '/home', user: 'ada' },
  });

  const argv3 = ['launch', 'emu', 'com.example.app', '--args-json', '{"flag":true,"count":3}'];
  assert.deepEqual(parseLaunchFlags(argv3, parseArgs(argv3)), {
    args: { flag: true, count: 3 },
  });

  assert.throws(
    () => parseLaunchFlags(['launch', 'd', 'app', '--arg', '-a', '--extra', 'k=v'], parseArgs(['launch', 'd', 'app', '--arg', '-a', '--extra', 'k=v'])),
    /pass only one of --arg, --extra, or --args-json/,
  );
  assert.throws(
    () => parseLaunchFlags(['launch', 'd', 'app', '--env', 'NO_EQUALS'], parseArgs(['launch', 'd', 'app', '--env', 'NO_EQUALS'])),
    /--env takes NAME=VALUE/,
  );

  // Single left-to-right pass: a value that looks like another launch flag is consumed as a value, not re-parsed
  const argvFlagVal = ['launch', 'sim', 'com.example', '--arg', '--env'];
  const parsedFlagVal = parseArgs(argvFlagVal);
  assert.deepEqual(parsedFlagVal.positionals, ['launch', 'sim', 'com.example']);
  assert.deepEqual(parseLaunchFlags(argvFlagVal, parsedFlagVal), { args: ['--env'] });

  const argvChained = ['launch', 'sim', 'com.example', '--arg', '--extra', '--arg', '--args-json', '--env', 'K=--arg', '--expect', 'Welcome'];
  assert.deepEqual(parseLaunchFlags(argvChained, parseArgs(argvChained)), {
    args: ['--extra', '--args-json'],
    env: { K: '--arg' },
  });

  // __proto__, constructor, and prototype keys must be rejected by the CLI (never silently dropped)
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    assert.throws(
      () => parseLaunchFlags(['launch', 'sim', 'com.example', '--extra', `${key}=value`]),
      /Invalid launch argument key/,
    );
    assert.throws(
      () => parseLaunchFlags(['launch', 'sim', 'com.example', '--args-json', `{"${key}":"value"}`]),
      /Invalid launch argument key/,
    );
    assert.throws(
      () => parseLaunchFlags(['launch', 'sim', 'com.example', '--env', `${key}=value`]),
      /Invalid environment variable name/,
    );
  }
});

test('devices: an older iPhone shared on the Wi-Fi (or not checkable) is said under the table, every time', () => {
  const phone = { ...base, nativeId: '00008020-0000AAAA0000BBBB', name: 'pdtest-old' };
  const shared = devicesTable([{ ...phone, meta: { wdaSharing: 'shared', wdaSharedUrl: 'http://192.0.2.10:8100' } }]);
  assert.match(shared, /pdtest-old: anyone on this Wi-Fi can control it, without a password \(other Macs: phonedock connect --ios http:\/\/192\.0\.2\.10:8100\)/);
  assert.match(shared, /phonedock ios wda-stop --udid 00008020-0000AAAA0000BBBB/);
  assert.match(devicesTable([{ ...phone, meta: { wdaSharing: 'unknown' } }]), /couldn’t check whether other Macs/);
  for (const s of ['not_shared', null, undefined]) assert.doesNotMatch(devicesTable([{ ...phone, meta: { wdaSharing: s } }]), /Wi-Fi/);
});
