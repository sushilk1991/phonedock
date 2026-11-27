import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  PasscodeStore,
  createFileSecretStore,
  createKeychainSecretStore,
  keychainAccount,
  keychainService,
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

test('keychainService derives canonically from path regardless of PHONEDOCK_HOME env presence', () => {
  const defaultPath = join(homedir(), 'Library', 'Application Support', 'PhoneDock');
  const prevHome = process.env.PHONEDOCK_HOME;
  const prevSvc = process.env.PHONEDOCK_PASSCODE_SERVICE;
  delete process.env.PHONEDOCK_PASSCODE_SERVICE;
  try {
    delete process.env.PHONEDOCK_HOME;
    const implicit = keychainService(defaultPath);
    process.env.PHONEDOCK_HOME = defaultPath;
    const explicit = keychainService(defaultPath);
    assert.equal(implicit, 'com.phonedock.passcode');
    assert.equal(explicit, 'com.phonedock.passcode');
    const custom = keychainService('/tmp/pd-custom-home-xyz');
    assert.match(custom, /^com\.phonedock\.passcode\.[0-9a-f]{12}$/);
  } finally {
    if (prevHome === undefined) delete process.env.PHONEDOCK_HOME; else process.env.PHONEDOCK_HOME = prevHome;
    if (prevSvc === undefined) delete process.env.PHONEDOCK_PASSCODE_SERVICE; else process.env.PHONEDOCK_PASSCODE_SERVICE = prevSvc;
  }
});

test('createKeychainSecretStore writes hex over stdin via `security -i`, never puts secret in argv, and uses fixed errors', async () => {
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

  const failing = createKeychainSecretStore('com.phonedock.test', async () => ({
    stdout: '',
    stderr: 'security: SecKeychainItemAdd failed for 9876 / 39383736',
    code: 0,
  }));
  await assert.rejects(
    () => failing.set(acct, '9876'),
    (e: PhoneDockError) => e.code === 'keychain_failed' && !String(e.detail).includes('9876') && !String(e.detail).includes('39383736'),
  );

  const missing = createKeychainSecretStore('com.phonedock.test', async () => ({
    stdout: '',
    stderr: 'security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.',
    code: 44,
  }));
  assert.equal(await missing.get(acct), null);
});

test('PasscodeStore SQLite shares state across instances, preserves enabled on update, blocks unfinished attempts, and revokes durably on delete', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-passcode-test-'));
  let store1: PasscodeStore | undefined;
  let store2: PasscodeStore | undefined;
  try {
    const dbPath = join(dir, 'passcodes.sqlite');
    const secretPath = join(dir, 'passcodes.secrets.json');
    let ticks = 0;
    const secrets = createFileSecretStore(secretPath);
    store1 = new PasscodeStore({ dbPath, secretStore: secrets, now: () => `2026-11-27T12:00:0${ticks++}Z` });
    store2 = new PasscodeStore({ dbPath, secretStore: secrets, now: () => `2026-11-27T12:00:1${ticks++}Z` });

    const id = 'android-emulator:pdtest-pin';
    assert.equal(store1.isAutoUnlockReady(id), false);
    assert.throws(() => store1!.setEnabled(id, true), (e: PhoneDockError) => e.code === 'passcode_not_set');

    // First save enables by default; second daemon immediately sees it.
    await store1.savePasscode(id, '4321');
    assert.equal(store1.isAutoUnlockReady(id), true);
    assert.equal(store2.isAutoUnlockReady(id), true);
    assert.equal(await store2.getSecret(id), '4321');
    assert.equal(statSync(dbPath).mode & 0o777, 0o600);
    assert.equal(readFileSync(dbPath).includes('4321'), false);

    // Updating a disabled passcode preserves enabled=false unless explicitly re-enabled.
    store1.setEnabled(id, false);
    assert.equal(store2.isAutoUnlockReady(id), false);
    await store1.savePasscode(id, '5678');
    assert.equal(store2.status(id, { supported: true }).enabled, false);
    store2.setEnabled(id, true);
    assert.equal(store1.isAutoUnlockReady(id), true);

    // Unfinished (crash-interrupted) pending attempt immediately blocks a second daemon and persists across restart!
    const attemptId = store1.reserveAttempt(id);
    assert.ok(attemptId);
    assert.equal(store2.isAutoUnlockReady(id), false);
    assert.throws(() => store2!.reserveAttempt(id), (e: PhoneDockError) => e.code === 'passcode_tripped' && e.status === 409);

    // Completing as failed converts to tripped; setEnabled refuses until re-saved.
    store1.completeAttempt(id, attemptId, { ok: false, error: 'still locked', tripReason: 'wrong pin' });
    assert.throws(() => store2!.setEnabled(id, true), (e: PhoneDockError) => e.code === 'passcode_tripped');

    // Re-saving clears tripped; updating explicitly with enabled=true re-enables.
    await store1.savePasscode(id, '1234', { enabled: true });
    assert.equal(store2.isAutoUnlockReady(id), true);

    // Durable pre-delete revocation: even if Keychain delete fails, SQLite record is already revoked!
    const failingDelStore = new PasscodeStore({
      dbPath,
      secretStore: {
        storageName: 'keychain',
        set: async () => {},
        get: async () => '1234',
        del: async () => { throw new Error('keychain locked'); },
      },
    });
    await failingDelStore.remove(id);
    assert.equal(store1.status(id, { supported: true }).hasPasscode, false);
    assert.equal(store2.isAutoUnlockReady(id), false);
    failingDelStore.close();
  } finally {
    store1?.close();
    store2?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
