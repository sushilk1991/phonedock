// Performance trace routes (see docs/API.md "Performance traces"). Registered onto the shared router; imported by
// main.ts after routes.ts. The lifecycle lives in trace.ts.
import { appNotesInfo } from '../core/app-notes.ts';
import { PhoneDockError } from '../core/types.ts';
import { checkLease, getDevice } from './core.ts';
import { badRequest } from './http.ts';
import { router as r, dev, need, num } from './routes.ts';
import { beginTrace, clampTimeLimit, findPrevious, listTraces, stopTraceFor, traceStatus } from './trace.ts';

r.post('/v1/devices/:id/trace/start', async (c) => {
  const { id, b, nid } = dev(c); checkLease(id, c.owner);
  need(b, 'startTrace', 'performance tracing', ['Traces work on iOS simulators, iPhones, Android emulators and Android phones.']);
  const body = await c.body();
  const appId = String(body.appId ?? body.app ?? '').trim();
  if (!appId) throw badRequest('appId required: the bundle id (iOS) or package name (Android) to trace');
  const d = await getDevice(id);
  if (d.state !== 'running') throw new PhoneDockError('The device is not running', 'device_not_running', 409, ['Boot it first, open the app, then start the trace.'], `${d.name} is ${d.state}`);
  const template = typeof body.template === 'string' && body.template.trim() ? body.template.trim() : undefined;
  const started = await beginTrace(d, b, nid, { appId, template, timeLimitSec: clampTimeLimit(body.timeLimitSec), launch: body.launch === true || body.launch === 'true' }, c.owner);
  const notes = appNotesInfo(appId);   // as on launch: the agent is about to drive this app
  return notes ? { ...started, appNotes: { updatedAt: notes.updatedAt, sizeBytes: notes.sizeBytes } } : started;
});

r.post('/v1/devices/:id/trace/stop', async (c) => {
  const { id } = dev(c);
  const body = await c.body();
  const compareTo = typeof body.compareTo === 'string' && body.compareTo.trim() ? body.compareTo.trim() : undefined;
  if (compareTo && compareTo !== 'none') findPrevious(id, '', '', '', compareTo);   // 404 now, before the trace is consumed
  const n = (v: unknown) => (v === undefined || v === null || v === '' || !Number.isFinite(Number(v)) ? undefined : Number(v));
  const res = await stopTraceFor(id, undefined, { top: n(body.top), triageChars: n(body.triageChars), compareTo });
  if (!res) throw new PhoneDockError('No trace is running on this device', 'not_tracing', 409, ['Start one first: start_trace (MCP) or phonedock trace start <device> --app <id>.'], `No active or unclaimed trace on ${id}`);
  return res;
});

r.get('/v1/devices/:id/trace', (c) => traceStatus(dev(c).id));
r.get('/v1/devices/:id/traces', (c) => listTraces(dev(c).id, Math.max(1, Math.min(num(c.q('limit'), 20)!, 200))));
