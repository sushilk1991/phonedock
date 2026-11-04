// CLI output for leases and handoffs: the devices table and lease_conflict hints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhoneDockApiError } from '../sdk/client.ts';
import type { Device } from '../sdk/client.ts';
import { cliDetail, cliHints, devicesTable, humanCell, leaseCell } from './main.ts';

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
