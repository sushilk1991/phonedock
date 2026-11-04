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
