import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PasscodeStore,
  createFileSecretStore,
  createKeychainSecretStore,
  keychainAccount,
  validatePasscode,
} from './passcode-store.ts';
import type { PhoneDockError } from './types.ts';

test('validatePasscode accepts printable ASCII and rejects empty, newlines, non-ASCII, and >128 chars', () => {
  assert.equal(validatePasscode('1234'), '1234');
  assert.equal(validatePasscode('Abc!@# 99'), 'Abc!@# 99');
  assert.throws(() => validatePasscode(''), (e: PhoneDockError) => e.code === 'bad_request' && e.status === 400);
  assert.throws(() => validatePasscode('1234\n'), (e: PhoneDockError) => e.code === 'bad_request');
  assert.throws(() => validatePasscode('1234\r'), (e: PhoneDockError) => e.code === 'bad_request');
  assert.throws(() => validatePasscode('páss'), (e: PhoneDockError) => e.code === 'bad_request');
  assert.throws(() => validatePasscode('a'.repeat(129)), (e: PhoneDockError) => e.code === 'bad_request');
});

test('createKeychainSecretStore writes hex over stdin via `security -i`, never puts secret in argv, and redacts errors', async () => {
  const calls: { cmd: string; args: string[]; input?: string }[] = [];
  const store = createKeychainSecretStore('com.phonedock.test', async (cmd, args, opts) => {
    calls.push({ cmd, args, input: typeof opts?.input === 'string' ? opts.input : undefined });
    if (args[0] === '-i') return { stdout: '', stderr: '', code: 0 };
    if (args[0] === 'find-generic-password') return { stdout: '2580\n', stderr: '', code: 0 };
    if (args[0] === 'delete-generic-password') return { stdout: '', stderr: '', code: 0 };
    return { stdout: '', stderr: '', code: 1 };
  });

  const acct = keychainAccount('android-device:SER123');
  assert.match(acct, /^[0-9a-f]{32}$/);
  await store.set(acct, '2580');
  assert.equal(calls[0].cmd, '/usr/bin/security');
  assert.deepEqual(calls[0].args, ['-i']);
  assert.equal(calls[0].args.join(' ').includes('2580'), false);
  assert.equal(calls[0].input, `add-generic-password -U -s com.phonedock.test -a ${acct} -X 32353830\n`);

  assert.equal(await store.get(acct), '2580');
  await store.del(acct);
  assert.deepEqual(calls[2].args, ['delete-generic-password', '-s', 'com.phonedock.test', '-a', acct]);

  // Error from security -i must redact both raw secret and hex representation.
  const failing = createKeychainSecretStore('com.phonedock.test', async () => ({
    stdout: '',
    stderr: 'security: SecKeychainItemAdd failed for 9876 / 39383736',
    code: 0,
  }));
  await assert.rejects(
    () => failing.set(acct, '9876'),
    (e: PhoneDockError) => e.code === 'keychain_failed' && !String(e.detail).includes('9876') && !String(e.detail).includes('39383736'),
  );

  // Not found (exit 44) returns null cleanly.
  const missing = createKeychainSecretStore('com.phonedock.test', async () => ({
    stdout: '',
    stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
    code: 44,
  }));
  assert.equal(await missing.get(acct), null);
});

test('PasscodeStore persists 0600 metadata without secrets, enforces 1-failure circuit breaker, and cleans up on delete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-passcode-test-'));
  try {
    const metaPath = join(dir, 'passcodes.json');
    const secretPath = join(dir, 'passcodes.secrets.json');
    let ticks = 0;
    const store = new PasscodeStore({
      metaPath,
      secretStore: createFileSecretStore(secretPath),
      now: () => `2026-11-27T12:00:0${ticks++}Z`,
    });

    const id = 'android-emulator:pdtest-pin';
    assert.equal(store.isAutoUnlockReady(id), false);
    assert.throws(() => store.setEnabled(id, true), (e: PhoneDockError) => e.code === 'passcode_not_set');

    await store.savePasscode(id, '4321');
    assert.equal(store.isAutoUnlockReady(id), true);
    assert.equal(await store.getSecret(id), '4321');

    // passcodes.json must be mode 0600 and NEVER contain the passcode itself.
    const metaRaw = readFileSync(metaPath, 'utf8');
    assert.equal(metaRaw.includes('4321'), false);
    assert.equal(statSync(metaPath).mode & 0o777, 0o600);
    assert.equal(statSync(secretPath).mode & 0o777, 0o600);

    const st = store.status(id, { supported: true });
    assert.equal(st.hasPasscode, true);
    assert.equal(st.enabled, true);
    assert.equal(st.tripped, null);
    assert.equal(JSON.stringify(st).includes('4321'), false);

    // Trip the 1-failure circuit breaker: disables auto-unlock and blocks re-enabling without re-saving.
    store.recordOutcome(id, { ok: false, error: 'still locked', trip: true, tripReason: 'wrong pin' });
    assert.equal(store.isAutoUnlockReady(id), false);
    assert.equal(store.status(id, { supported: true }).enabled, false);
    assert.equal(store.status(id, { supported: true }).tripped?.reason, 'wrong pin');
    assert.throws(() => store.setEnabled(id, true), (e: PhoneDockError) => e.code === 'passcode_tripped' && e.status === 409);

    // Re-saving clears the circuit breaker and re-enables.
    await store.savePasscode(id, '5678');
    assert.equal(store.isAutoUnlockReady(id), true);
    assert.equal(store.status(id, { supported: true }).tripped, null);
    assert.equal(await store.getSecret(id), '5678');

    // Reload from disk preserves metadata.
    const reloaded = new PasscodeStore({ metaPath, secretStore: createFileSecretStore(secretPath) });
    assert.equal(reloaded.isAutoUnlockReady(id), true);
    assert.equal(await reloaded.getSecret(id), '5678');

    // Deletion removes both metadata and secret.
    await reloaded.onDeviceDeleted(id);
    assert.equal(reloaded.isAutoUnlockReady(id), false);
    assert.equal(await reloaded.getSecret(id), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
