// POST /v1/devices/:id/flow – turn this device's action log (+ what the daemon saw on screen) into a flow file
// (src/core/flow.ts). The caller writes the file; the daemon may run from the app bundle with no useful cwd.
import { FlowError, flowFromLog, parseStep, writeFlow, type LogEntry, type Step } from '../core/flow.ts';
import { getDevice, readActions, uiCache } from './core.ts';
import { badRequest } from './http.ts';
import { cleanTree } from './media.ts';
import { readObservations } from './observe.ts';
import { router as r, dev, truthy } from './routes.ts';

const yes = (v: unknown) => v === true || truthy(String(v));
const GAP_MS = 15 * 60_000;   // a pause this long starts a new session (the default range is the latest session)

/** "10m" / "90s" / "2h" / "1d" before `now`, or an ISO time. */
export function parseSince(v: unknown, now = Date.now()): number | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  const s = String(v).trim();
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|min|h|d)$/i.exec(s);
  if (m) return now - Number(m[1]) * ({ ms: 1, s: 1000, m: 60_000, min: 60_000, h: 3_600_000, d: 86_400_000 } as Record<string, number>)[m[2].toLowerCase()];
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw badRequest(`since/until must be an ISO time or a duration like 10m, 2h (got "${s}")`);
  return t;
}

/** Where the latest session starts: the last lease taken (by the owner, if given; an agent's session usually starts
 *  with one), or after the last pause of 15 minutes, whichever is later. */
export function sessionStart(entries: LogEntry[], owner?: string): number | undefined {
  const own = (e: LogEntry) => !owner || e.owner === owner || (owner.endsWith('*') && (e.owner ?? '').startsWith(owner.slice(0, -1)));
  const mine = entries.filter((e) => e.owner !== 'daemon' && own(e));
  if (!mine.length) return undefined;
  let start = Date.parse(mine[mine.length - 1].at);
  for (let i = mine.length - 2; i >= 0; i--) {
    const t = Date.parse(mine[i].at);
    if (start - t > GAP_MS) break;
    start = t;
  }
  start -= 2000;   // include the screen read just before the first action
  const lease = [...mine].reverse().find((e) => e.action?.action === 'lease.acquire');
  return lease ? Math.max(start, Date.parse(lease.at)) : start;
}

function assertionsFrom(v: unknown): Step[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw badRequest('assertions must be a list: texts that must be visible, or steps such as {"assert_text": {...}}');
  return v.map((a, i) => {
    try {
      if (typeof a === 'string') return /^!/.test(a) ? parseStep({ assert_not_visible: a.slice(1) }) : parseStep({ assert_visible: a });
      return parseStep(a);
    } catch (e) { throw badRequest(`assertions[${i}]: ${(e as Error).message}`); }
  });
}

r.post('/v1/devices/:id/flow', async (c) => {
  const { id, b, nid } = dev(c);
  const body = await c.body();
  const device = await getDevice(id);
  const owner = typeof body.owner === 'string' && body.owner ? body.owner : undefined;
  const until = parseSince(body.until);
  const entries = readActions(id, 10_000) as LogEntry[];
  let since = parseSince(body.since);
  const defaulted = since === undefined;
  if (since === undefined) since = sessionStart(entries, owner);
  const assertions = assertionsFrom(body.assertions);
  // Read the screen once more so the flow can end on what is there now (also when the agent never re-read it).
  if (until === undefined && b.uiTree && device.state === 'running') {
    try { uiCache.set(id, cleanTree(await b.uiTree(nid))); } catch { /* the flow just gets no final assertion */ }
  }
  const obs = readObservations(id, since ?? 0);
  const now = new Date().toISOString();
  let res;
  try {
    res = flowFromLog(entries, obs, {
      since: since !== undefined ? new Date(since).toISOString() : undefined,
      until: until !== undefined ? new Date(until).toISOString() : undefined,
      owner, name: typeof body.name === 'string' && body.name ? body.name : undefined,
      appId: typeof body.appId === 'string' && body.appId ? body.appId : undefined,
      platform: device.platform === 'android' || device.platform === 'ios' ? device.platform : undefined,
      osVersion: device.osVersion, device: device.name, model: device.model,
      screen: device.screen ? { width: device.screen.width, height: device.screen.height } : undefined,
      assertions, autoAssert: body.autoAssert === undefined ? true : yes(body.autoAssert), keepNoise: yes(body.keepNoise), now,
    });
  } catch (e) {
    if (e instanceof FlowError) throw badRequest(e.message);
    throw e;
  }
  const format = body.format === 'json' ? 'json' : 'yaml';
  const text = format === 'json' ? writeFlow(res.flow, 'json') : res.text;
  if (defaulted && since !== undefined) res.warnings.unshift(`used the latest session: actions since ${new Date(since).toISOString()}${owner ? ` by ${owner}` : ''} (pass since to change it)`);
  return {
    flow: res.flow, text, format, warnings: res.warnings, dropped: res.dropped, stats: res.stats,
    range: { since: since !== undefined ? new Date(since).toISOString() : null, until: until !== undefined ? new Date(until).toISOString() : now, owner: owner ?? null },
  };
});
