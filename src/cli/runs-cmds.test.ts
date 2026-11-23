import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PhoneDockApiError, PhoneDockClient } from '../sdk/client.ts';
import { parseArgs } from './args.ts';
import { runsCmd } from './runs-cmds.ts';

test('PhoneDockClient.exportRun(id, "json") and `runs export --format json` return/write a JSON string without crashing', async () => {
  const sample = {
    schemaVersion: 1,
    id: '2026-11-23T12-00-00-000Z-a1b2',
    status: 'pass',
    startedAt: '2026-11-23T12:00:00.000Z',
    endedAt: '2026-11-23T12:00:01.000Z',
    durationMs: 1000,
    attempts: 1,
    owner: 'cli:test',
  };
  const jsonBody = JSON.stringify(sample, null, 2) + '\n';
  const server = createServer((req, res) => {
    if (req.url === `/v1/runs/${sample.id}/export?format=json`) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(jsonBody);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const client = new PhoneDockClient({ baseUrl: `http://127.0.0.1:${addr.port}`, token: 'test-token', autoStart: false });
  const dir = mkdtempSync(join(tmpdir(), 'pd-cli-runs-'));
  try {
    const exported = await client.exportRun(sample.id, 'json');
    assert.equal(typeof exported, 'string');
    assert.deepEqual(JSON.parse(exported), sample);

    let captured = '';
    const codeStdout = await runsCmd(client, parseArgs(['runs', 'export', sample.id, '--format', 'json']), false, {
      stdout: (s) => { captured += s; },
    });
    assert.equal(codeStdout, 0);
    assert.deepEqual(JSON.parse(captured), sample);

    const outPath = join(dir, 'run.json');
    let fileMsg = '';
    const codeFile = await runsCmd(client, parseArgs(['runs', 'export', sample.id, '--format', 'json', '-o', outPath]), false, {
      stdout: (s) => { fileMsg += s; },
    });
    assert.equal(codeFile, 0);
    assert.match(fileMsg, /\(json\)/);
    assert.deepEqual(JSON.parse(readFileSync(outPath, 'utf8')), sample);
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('PhoneDockClient.exportRun wraps post-header stream failures as PhoneDockApiError (daemon_unreachable)', async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': '500' });
    res.write('{"partial":');
    res.socket?.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const client = new PhoneDockClient({ baseUrl: `http://127.0.0.1:${addr.port}`, token: 'test-token', autoStart: false });
  try {
    await assert.rejects(
      client.exportRun('2026-11-23T12-00-00-000Z-a1b2', 'json'),
      (e: unknown) => e instanceof PhoneDockApiError && e.code === 'daemon_unreachable' && e.status === 0,
    );
  } finally {
    server.close();
  }
});
