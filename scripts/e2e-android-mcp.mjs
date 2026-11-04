#!/usr/bin/env node
// MCP smoke test used by scripts/e2e-android.sh: runs `bin/phonedock mcp` over stdio and calls
// list_devices, screenshot, get_ui and tap once each against one device.
// Usage: PHONEDOCK_PORT=47480 node scripts/e2e-android-mcp.mjs <device> [expectText]
// Prints one JSON line per call and exits non-zero on the first failure.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const device = process.argv[2];
const expectText = process.argv[3] ?? 'PhoneDock Sample';
if (!device) { console.error('usage: e2e-android-mcp.mjs <device> [expectText]'); process.exit(2); }
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');

const transport = new StdioClientTransport({
  command: join(repo, 'bin', 'phonedock'),
  args: ['mcp'],
  env: { ...process.env, PHONEDOCK_OWNER: process.env.PHONEDOCK_OWNER ?? 'e2e:mcp' },
  stderr: 'pipe',
});
const client = new Client({ name: 'phonedock-e2e', version: '1.0.0' });

function fail(msg) { console.log(JSON.stringify({ ok: false, error: msg })); process.exitCode = 1; throw new Error(msg); }
function texts(r) { return (r.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n'); }
async function call(name, args, check) {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args });
  const ms = Date.now() - t0;
  if (r.isError) fail(`${name}: tool error: ${texts(r).slice(0, 400)}`);
  const why = check(r);
  if (why) fail(`${name}: ${why}`);
  console.log(JSON.stringify({ ok: true, tool: name, ms, text: texts(r).split('\n')[0].slice(0, 160) }));
  return r;
}

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  const names = new Set(tools.map((t) => t.name));
  for (const n of ['list_devices', 'screenshot', 'get_ui', 'tap']) if (!names.has(n)) fail(`tool ${n} missing (have ${tools.length})`);
  console.log(JSON.stringify({ ok: true, tool: 'tools/list', count: tools.length }));

  await call('list_devices', { platform: 'android' }, (r) => texts(r).includes(device.replace(/^.*:/, '')) ? null : `device ${device} not listed`);
  await call('screenshot', { device, max_size: 640 }, (r) => {
    const img = (r.content ?? []).find((c) => c.type === 'image');
    if (!img) return 'no image content';
    const head = Buffer.from(img.data, 'base64').subarray(0, 4);
    const isJpeg = head[0] === 0xff && head[1] === 0xd8;
    const isPng = head.toString('latin1', 1, 4) === 'PNG';
    return isJpeg || isPng ? null : `image is neither JPEG nor PNG (${img.mimeType})`;
  });
  await call('get_ui', { device }, (r) => texts(r).includes(expectText) ? null : `get_ui has no "${expectText}"`);
  await call('tap', { device, text: 'Greet' }, (r) => /Tapped/i.test(texts(r)) ? null : `unexpected tap result: ${texts(r).slice(0, 200)}`);
  await call('get_ui', { device }, (r) => /Hello, /.test(texts(r)) ? null : 'no "Hello, …" after tapping Greet');
} catch (e) {
  if (!process.exitCode) { console.log(JSON.stringify({ ok: false, error: String(e?.message ?? e) })); process.exitCode = 1; }
} finally {
  await client.close().catch(() => {});
}
