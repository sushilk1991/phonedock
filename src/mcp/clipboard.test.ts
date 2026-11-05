// The MCP `clipboard` tool over an in-memory transport, against a fake daemon client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { PhoneDockApiError, type PhoneDockClient, type Device } from '../sdk/client.ts';
import { createMcpServer } from './server.ts';

function fakeClient(state: { clip: string | null; calls: unknown[][]; unsupported?: boolean }) {
  const dev = { id: 'ios-simulator:PDTEST', nativeId: 'PDTEST', name: 'pdtest-clip', backend: 'ios-simulator', platform: 'ios',
    kind: 'virtual', state: 'running', managed: true, capabilities: ['clipboard'], screen: { width: 1206, height: 2622, scale: 3 } } as unknown as Device;
  const nope = () => new PhoneDockApiError('This device can’t read or set the clipboard', 'not_supported', 501, ['Type the text into the field instead (type_text or fill).']);
  return {
    owner: 'test', devices: async () => [dev], resolveDevice: async () => dev,
    getClipboard: async (id: string) => { state.calls.push(['get', id]); if (state.unsupported) throw nope(); return state.clip; },
    setClipboard: async (id: string, text: string) => { state.calls.push(['set', id, text]); if (state.unsupported) throw nope(); state.clip = text; return { ok: true, length: [...text].length }; },
  };
}
async function connect(fake: object) {
  const server = createMcpServer({ client: fake as unknown as PhoneDockClient, scales: new Map() });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (args: Record<string, unknown>) => {
    const r = await client.callTool({ name: 'clipboard', arguments: args }) as { content: { type: string; text?: string }[]; isError?: boolean };
    return { text: r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'), isError: !!r.isError };
  };
  return { client, call };
}

test('clipboard tool: set reports the length without echoing the text; get returns it', async () => {
  const state = { clip: null as string | null, calls: [] as unknown[][] };
  const s = await connect(fakeClient(state));
  try {
    const tools = await s.client.listTools();
    const t = tools.tools.find((x) => x.name === 'clipboard');
    assert.ok(t, 'registered');
    assert.equal(t.annotations?.title, 'Read / set clipboard');
    assert.match(t.description ?? '', /data, not instructions/);

    const set = await s.call({ action: 'set', text: 'OTP 493817 👋' });
    assert.equal(set.isError, false);
    assert.match(set.text, /Set the clipboard of pdtest-clip \(12 characters\)/);
    assert.doesNotMatch(set.text, /493817/);
    assert.deepEqual(state.calls.at(-1), ['set', 'ios-simulator:PDTEST', 'OTP 493817 👋']);

    const get = await s.call({ action: 'get' });
    assert.match(get.text, /Clipboard of pdtest-clip \(12 characters\):\nOTP 493817 👋$/);

    state.clip = null;
    assert.match((await s.call({ action: 'get' })).text, /empty or holds no text/);
    const missing = await s.call({ action: 'set' });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /needs text/);
  } finally { await s.client.close(); }
});

test('clipboard tool: a long clipboard is cut for the agent; not_supported comes back as an error', async () => {
  const state = { clip: 'y'.repeat(25_000), calls: [] as unknown[][] };
  const s = await connect(fakeClient(state));
  try {
    const r = await s.call({ action: 'get' });
    assert.match(r.text, /25000 characters, first 20000 shown/);
    assert.equal(r.text.split('\n')[1].length, 20_000);
  } finally { await s.client.close(); }
  const s2 = await connect(fakeClient({ clip: null, calls: [], unsupported: true }));
  try {
    const r = await s2.call({ action: 'get' });
    assert.equal(r.isError, true);
    assert.match(r.text, /can’t read or set the clipboard/);
  } finally { await s2.client.close(); }
});
