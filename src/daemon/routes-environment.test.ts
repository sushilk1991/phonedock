import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Backend, Device } from '../core/types.ts';
import type { Ctx } from './http.ts';
process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pdtest-environment-routes-'));
delete process.env.PHONEDOCK_DEVICE_FILTER;
const core = await import('./core.ts');
const { environmentHandlers } = await import('./routes-environment.ts');
let commands = 0;
const id = 'ios-simulator:pdtest-environment-route';
const device = { id, nativeId: 'pdtest-environment-route', backend: 'ios-simulator', name: 'pdtest-environment-route', platform: 'ios', kind: 'virtual', state: 'running', managed: true, capabilities: [], screen: { width: 1200, height: 2400, scale: 3 } } as Device;
const fake = { id: 'ios-simulator', kind: 'virtual', platform: 'ios', listDevices: async () => [device], uiTree: async () => ({ source: 'accessibility', screen: device.screen, capturedAt: new Date().toISOString(), root: [{ ref: 'e1', type: 'Button', bounds: { x: 0, y: 100, width: 30, height: 30 }, clickable: true }] }) } as unknown as Backend;
core.backends.push(fake);
const handlers = environmentHandlers({ command: async () => { commands++; return { code: 0, stdout: '', stderr: '' }; }, adb: async () => assert.fail('no adb for iOS'), serial: async () => undefined });
const ctx = (body: unknown, owner = 'test') => ({ params: { id }, owner, body: async () => body, q: () => undefined } as unknown as Ctx);
test('environment routes expose scoped capabilities, validate input and enforce lease ownership', async () => {
  const caps = await handlers.get(ctx({})) as any;
  assert.ok(caps.supported); assert.ok(caps.permissions.services.includes('photos'));
  await assert.rejects(Promise.resolve(handlers.post(ctx({ action: 'permissions', state: 'grant', appId: 'com.example.test', permissions: ['camera'] }))), (e: any) => e.code === 'not_supported' && e.delivery === 'not_sent');
  assert.equal(commands, 0);
  core.acquireLease(id, 'other');
  await assert.rejects(Promise.resolve(handlers.post(ctx({ action: 'statusBar', mode: 'override' }))), (e: any) => e.code === 'lease_conflict');
  assert.equal(commands, 0); core.clearLeases();
  const result = await handlers.post(ctx({ action: 'statusBar', mode: 'override' })) as any;
  assert.equal(result.delivery, 'sent'); assert.equal(result.retrySafe, false); assert.equal(commands, 1);
  const log = readFileSync(join(process.env.PHONEDOCK_HOME!, 'devices', core.safeId(id), 'actions.jsonl'), 'utf8');
  assert.ok(log.includes('environment.statusBar'));
});
test('UI audit route reads the backend tree and screen scale but never sends input', async () => {
  const n = commands;
  const result = await handlers.audit(ctx({})) as any;
  assert.ok(result.findings.some((f: any) => f.kind === 'missing_label'));
  assert.ok(result.findings.some((f: any) => f.kind === 'small_target' && f.units === 'pt'));
  assert.equal(commands, n);
});

test('a human takeover stops a partially completed environment request before its next command', async () => {
  let calls = 0;
  const fenced = environmentHandlers({ command: async () => {
    calls++; core.acquireLease(id, core.HUMAN_OWNER, undefined, true);
    return { code: 0, stdout: '', stderr: '' };
  }, adb: async () => assert.fail('no adb for iOS'), serial: async () => undefined });
  core.acquireLease(id, 'test');
  try {
    await assert.rejects(Promise.resolve(fenced.post(ctx({ action: 'permissions', state: 'grant', appId: 'com.example.test', permissions: ['photos', 'microphone'] }))), (e: any) => e.code === 'lease_conflict' && e.delivery === 'sent');
    assert.equal(calls, 1);
  } finally { core.clearLeases(); }
});
