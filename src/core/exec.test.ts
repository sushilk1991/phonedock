import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run } from './exec.ts';
import { PhoneDockError } from './types.ts';

test('subprocess failures keep diagnostics in detail', async () => {
  await assert.rejects(run(process.execPath, ['-e', 'process.stderr.write("bad".repeat(1000)); process.exit(7)'], { failureMessage: 'Couldn’t install the app' }), (e: unknown) => {
    assert.ok(e instanceof PhoneDockError);
    assert.equal(e.message, 'Couldn’t install the app');
    assert.equal(e.code, 'exec_failed');
    assert.equal(e.status, 500);
    assert.match(e.detail!, /exited 7: bad/);
    assert.ok(Buffer.byteLength(e.detail!.split('exited 7: ')[1]) <= 2048);
    return true;
  });
});

test('spawn failures also retain diagnostics', async () => {
  await assert.rejects(run('/nonexistent/phonedock-test-command', []), (e: unknown) => {
    assert.ok(e instanceof PhoneDockError);
    assert.equal(e.message, 'Couldn’t complete the operation');
    assert.match(e.detail!, /phonedock-test-command/);
    return true;
  });
});

test('EPIPE on stdin when child exits without reading becomes a failed result or exec_failed error', async () => {
  const largeInput = 'x'.repeat(512 * 1024);
  // Child exits immediately with code 1 without reading stdin
  const resFail = await run(process.execPath, ['-e', 'process.exit(1)'], { input: largeInput, allowFail: true });
  assert.notEqual(resFail.code, 0);

  // Child exits 0 without reading stdin: EPIPE still surfaces as a failed result under allowFail: true
  const resEarlyZero = await run(process.execPath, ['-e', 'process.exit(0)'], { input: largeInput, allowFail: true });
  assert.notEqual(resEarlyZero.code, 0);
  assert.match(resEarlyZero.stderr, /EPIPE|stdin write error|ERR_STREAM_DESTROYED/i);

  // Under allowFail: false, rejects cleanly with PhoneDockError instead of crashing the process
  await assert.rejects(
    run(process.execPath, ['-e', 'process.exit(0)'], { input: largeInput, allowFail: false }),
    (e: unknown) => e instanceof PhoneDockError && e.code === 'exec_failed',
  );
});
