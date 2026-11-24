// Older iPhones' routes through the daemon's router with a fake ios-device backend: a failed setup job keeps
// wda_setup_failed and carries `cause`; `share` passes only as true; Stop and teams keep their shapes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockError, type Backend } from '../core/types.ts';
import { sendError, type Ctx } from './http.ts';

process.env.PHONEDOCK_HOME = mkdtempSync(join(tmpdir(), 'pd-routes-wda-'));
delete process.env.PHONEDOCK_DEVICE_FILTER;
const core = await import('./core.ts');
const { router } = await import('./routes.ts');

const UDID = '00008020-0000AAAA0000BBBB';
const calls: unknown[][] = [];
core.backends.push({
  id: 'ios-device', platform: 'ios', kind: 'physical', displayName: 'Fake iPhone', capabilities: [],
  available: async () => ({ ok: true }), listDevices: async () => [],
  connectWda: async () => ({}),
  async wdaSetup(udid: string, opts: unknown, p: (l: string) => void) {
    calls.push(['setup', udid, opts]); p('Checking Xcode and the iPhone…');
    const e = new PhoneDockError('Choose which team signs WebDriverAgent', 'wda_setup_failed', 409, ['Pick a team in PhoneDock.']);
    e.cause = 'team_required';
    throw e;
  },
  async wdaStop(udid: string) { calls.push(['stop', udid]); return { udid, stopped: true, confirmed: false }; },
  async wdaTeams() { return { teams: [{ id: 'AAAAA11111', name: 'Alpha', free: false }], xcode: true, xcodeVersion: '27.2' }; },
} as unknown as Backend);

async function call(method: string, path: string, body: unknown = {}): Promise<any> {
  const m = router.match(method, path);
  assert.ok(m && m !== 'method', `${method} ${path} exists`);
  return m.h({ params: m.params, owner: 'test', body: async () => body, q: () => undefined } as unknown as Ctx);
}

test('a failed setup job keeps wda_setup_failed and names the cause; share passes only as true', async () => {
  for (const [share, passed] of [[true, true], ['true', undefined], [undefined, undefined]] as const) {
    const raw = await call('POST', '/v1/ios/wda-setup', { udid: UDID, share });
    assert.equal(raw.status, 202);
    const { job } = JSON.parse(String(raw.body));
    assert.equal(job.deviceId, `ios-device:${UDID}`);
    let j = core.getJob(job.id);
    for (let i = 0; i < 100 && j.state === 'running'; i++) { await new Promise((r) => setTimeout(r, 5)); j = core.getJob(job.id); }
    assert.equal(j.state, 'failed');
    assert.deepEqual([j.error?.code, j.error?.cause], ['wda_setup_failed', 'team_required']);
    assert.equal((calls.at(-1)![2] as { share?: boolean }).share, passed, `share=${String(share)}`);
  }
});

test('an HTTP error carries cause when there is one', () => {
  let body = '';
  const res = { headersSent: false, writeHead() {}, end(s: string) { body = s; } } as unknown as ServerResponse;
  const e = new PhoneDockError('WebDriverAgent is already running on this iPhone', 'wda_setup_failed', 409);
  e.cause = 'wda_running';
  sendError(res, e);
  assert.equal(JSON.parse(body).error.cause, 'wda_running');
});

test('Stop Control and the team list keep their shapes', async () => {
  assert.deepEqual(await call('POST', '/v1/ios/wda-stop', { udid: UDID }), { ok: true, udid: UDID, stopped: true, confirmed: false });
  assert.deepEqual(calls.at(-1), ['stop', UDID]);
  await assert.rejects(Promise.resolve(call('POST', '/v1/ios/wda-stop', {})), (e: PhoneDockError) => e.code === 'bad_request');
  const t = await call('GET', '/v1/ios/wda-teams');
  assert.deepEqual(t.teams, [{ id: 'AAAAA11111', name: 'Alpha', free: false }]);
  assert.equal(t.xcode, true);
});
