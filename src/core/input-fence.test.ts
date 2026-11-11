import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withInputFence } from './input-fence.ts';
import { run } from './exec.ts';
import { which } from './paths.ts';
import { PhoneDockError } from './types.ts';
import { hidType, hidClose } from '../backends/ios-hid.ts';
import { pymd3Python } from '../backends/pymd3-python.ts';

const denied = () => { throw new PhoneDockError('Taken over', 'lease_conflict', 409, undefined, undefined, 'not_sent'); };
test('a transport fence prevents spawning a command after asynchronous preparation', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pdtest-fence-')); const file = join(dir, 'sent');
  try {
    await assert.rejects(withInputFence(denied, async () => {
      await Promise.resolve();
      return run(process.execPath, ['-e', `require('node:fs').writeFileSync(${JSON.stringify(file)},'sent')`]);
    }), (e: any) => e.code === 'lease_conflict' && e.delivery === 'not_sent');
    assert.equal(existsSync(file), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a cold HID sidecar checks ownership again after waiting for ready, before stdin write', async () => {
  const python = which('python3.12') ?? pymd3Python() ?? which('python3'); assert.ok(python, 'Python 3.11+ is required for the fake HID transport');
  const dir = mkdtempSync(join(tmpdir(), 'pdtest-hid-fence-'));
  const script = join(dir, 'fake.py'), calls = join(dir, 'calls');
  writeFileSync(script, `import json,sys,time\ntime.sleep(0.05)\nprint(json.dumps({'event':'ready'}),flush=True)\nfor line in sys.stdin:\n m=json.loads(line)\n if m.get('cmd')=='quit': break\n with open(${JSON.stringify(calls)},'a') as f: f.write(line)\n print(json.dumps({'id':m['id'],'ok':True}),flush=True)\n`);
  const oldPy = process.env.PHONEDOCK_PYMD3_PYTHON, oldScript = process.env.PHONEDOCK_IOS_HID_SRC;
  process.env.PHONEDOCK_PYMD3_PYTHON = python; process.env.PHONEDOCK_IOS_HID_SRC = script;
  try {
    let allowed = true;
    const pending = withInputFence(() => { if (!allowed) denied(); }, () => hidType('pdtest-fake-hid-fence', 'must-not-send'));
    allowed = false;
    await assert.rejects(pending, (e: any) => e.code === 'lease_conflict' && e.delivery === 'not_sent');
    assert.equal(existsSync(calls), false);
  } finally {
    hidClose('pdtest-fake-hid-fence');
    if (oldPy === undefined) delete process.env.PHONEDOCK_PYMD3_PYTHON; else process.env.PHONEDOCK_PYMD3_PYTHON = oldPy;
    if (oldScript === undefined) delete process.env.PHONEDOCK_IOS_HID_SRC; else process.env.PHONEDOCK_IOS_HID_SRC = oldScript;
    rmSync(dir, { recursive: true, force: true });
  }
});
