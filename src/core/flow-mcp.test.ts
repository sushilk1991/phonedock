// Exercise the real MCP -> flow runner -> shared comparison path, without any daemon or device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp/server.ts';
import type { PhoneDockClient } from '../sdk/client.ts';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('MCP run_flow enforces baselines and emits a self-contained suite report', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-flow-mcp-'));
  const d = { id: 'fake:pdtest-mcp', name: 'pdtest-mcp', backend: 'fake', nativeId: 'pdtest-mcp', platform: 'ios', kind: 'virtual', managed: true, state: 'running', capabilities: [] };
  const fake = { owner: 'test', resolveDevice: async () => d, device: async () => d, lease: async () => ({}), releaseLease: async () => ({}),
    screenshot: async () => ({ data: png }), uiText: async () => '', ui: async () => ({}), logs: async () => '' };
  const server = createMcpServer({ client: fake as unknown as PhoneDockClient, scales: new Map() });
  const [a, b] = InMemoryTransport.createLinkedPair(); const client = new Client({ name: 'flow-test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  try {
    // A corrupt existing baseline proves MCP actually invokes comparison (the previous implementation skipped it).
    writeFileSync(join(dir, 'baseline.png'), 'invalid baseline');
    const result = await client.callTool({ name: 'run_flow', arguments: { device: d.id, flow: `name: Check\nsteps:\n  - screenshot: { name: home, baseline: ${JSON.stringify(join(dir, 'baseline.png'))} }\n`, baseline_root: dir, artifacts_dir: join(dir, 'artifacts') } });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /valid PNG/);
    assert.match(readFileSync(join(dir, 'artifacts', 'report.html'), 'utf8'), /Check/);
    assert.match(readFileSync(join(dir, 'artifacts', 'report.html'), 'utf8'), /data:image\/png;base64,/);
  } finally { await client.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); }
});
