import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pasteUnicode, resolveForegroundApp } from './ios-input.ts';
import { PhoneDockError } from '../core/types.ts';

test('Unicode paste: confirmed text restores clipboard; an intervening user copy is retained', async () => {
  const calls: unknown[] = [];
  const deps = { begin: async (text: string, secret: boolean) => { calls.push(['begin', text, secret]); return { token: 't', restorable: true }; },
    paste: async () => { calls.push('paste'); }, verify: async () => true,
    finish: async (token: string, confirmed: boolean) => { calls.push(['finish', token, confirmed]); return { restored: true }; } };
  await pasteUnicode('café', true, deps);
  assert.deepEqual(calls, [['begin', 'café', true], 'paste', ['finish', 't', true]]);
  // A changed clipboard is not an input failure: paste was verified, and the person's newer value wins.
  await pasteUnicode('café', false, { ...deps, finish: async () => ({ restored: false, reason: 'clipboard_changed' }) });
});

test('unconfirmed paste and failed acknowledgements never retry or leak secret text', async () => {
  let sent = 0; const finished: boolean[] = [];
  const deps = { begin: async () => ({ token: 't', restorable: true }), paste: async () => { sent++; }, verify: async () => false,
    finish: async (_token: string, confirmed: boolean) => { finished.push(confirmed); return { restored: false }; } };
  await assert.rejects(pasteUnicode('secret-密码', true, deps), (e: unknown) => e instanceof PhoneDockError && e.code === 'paste_unconfirmed' && e.delivery === 'unknown' && !JSON.stringify(e).includes('secret-密码'));
  assert.equal(sent, 1); assert.deepEqual(finished, [false]);
  await assert.rejects(pasteUnicode('secret-密码', true, { ...deps, paste: async () => { throw new Error('secret-密码'); } }), (e: unknown) => e instanceof PhoneDockError && e.delivery === 'unknown' && !JSON.stringify(e).includes('secret-密码'));
});

test('foreground app lookup needs an exact PID and a unique app executable, never a label guess or extension', () => {
  const apps = [{ bundleIdentifier: 'com.example.app', name: 'Example', url: 'file:///private/var/App%20One.app' }];
  const procs = [{ processIdentifier: 42, executable: '/private/var/App One.app/AppOne' }];
  assert.deepEqual(resolveForegroundApp(42, apps, procs), { id: 'com.example.app', name: 'Example' });
  const unknown = (fn: () => unknown) => assert.throws(fn, (e: any) => e.code === 'foreground_unknown');
  unknown(() => resolveForegroundApp(43, apps, procs));
  unknown(() => resolveForegroundApp(null, apps, procs));
  unknown(() => resolveForegroundApp(42, apps, [{ processIdentifier: 42, executable: '/private/var/App One.app/PlugIns/Thing.appex/Thing' }]));
  unknown(() => resolveForegroundApp(42, [...apps, { ...apps[0], bundleIdentifier: 'com.other.app' }], procs));
  unknown(() => resolveForegroundApp(42, apps, [{ processIdentifier: 42, executable: '/private/var/App One.appOther/Other' }]));
  assert.equal(resolveForegroundApp(42, [], [{ processIdentifier: 42, bundleIdentifier: 'com.apple.springboard' }]), null);
});

test('takeover while preparing paste sends no keys and conditionally cleans up its own clipboard write', async () => {
  let checks = 0; let pastes = 0; const finishes: boolean[] = [];
  await assert.rejects(pasteUnicode('密码', true, {
    beforeInput: () => { if (++checks === 2) throw new PhoneDockError('A person took over', 'lease_conflict', 409); },
    begin: async () => ({ token: 't', restorable: true }), paste: async () => { pastes++; }, verify: async () => true,
    finish: async (_token, safeToRestore) => { finishes.push(safeToRestore); return { restored: true }; },
  }), (e: unknown) => e instanceof PhoneDockError && e.code === 'lease_conflict' && e.delivery === 'not_sent');
  assert.equal(pastes, 0); assert.deepEqual(finishes, [true]);
});
