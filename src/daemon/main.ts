// phonedockd – PhoneDock daemon entry. node:http only; binds 127.0.0.1.
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { DEFAULT_PORT } from '../core/paths.ts';
import { PhoneDockError, type BootOptions } from '../core/types.ts';
import { backends, initBackends, listDevices, loadState, state, writeDaemonInfo, startJob, getBackend } from './core.ts';
import { HANDLED, Raw, readBody, sendError, sendJson, type Ctx } from './http.ts';
import { router, VERSION } from './routes.ts';
import { metrics } from './metrics.ts';
import './routes-extra.ts'; // v0.2 routes (registers onto `router`; must load after routes.ts)
import './routes-flow.ts'; // POST /v1/devices/:id/flow (flow save)
import './routes-trace.ts'; // performance traces (same)
import './routes-notes.ts'; // app notes (same)
import { refreshAgentSkills } from './skills.ts';
import { abortAllTraces, reapOrphanTraces, traces } from './trace.ts';

const port = DEFAULT_PORT;

loadState();
await initBackends();
for (const t of reapOrphanTraces()) console.log(`[phonedockd] stopped a trace recorder left by an earlier daemon: ${t}`);
const token = writeDaemonInfo(port, VERSION);
const tokenBuf = Buffer.from(token);

function authorized(req: import('node:http').IncomingMessage, url: URL): boolean {
  const h = req.headers.authorization;
  const t = h?.startsWith('Bearer ') ? h.slice(7).trim() : url.searchParams.get('token') ?? '';
  const b = Buffer.from(t);
  return b.length === tokenBuf.length && timingSafeEqual(b, tokenBuf);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const method = req.method ?? 'GET';
  try {
    const m = router.match(method, url.pathname);
    if (!m) throw new PhoneDockError("The requested operation was not found", 'not_found', 404, undefined, [`No route ${method} ${url.pathname}`, ...['See docs/API.md']].filter(Boolean).join('\n'));
    if (m === 'method') throw new PhoneDockError("The requested operation is not allowed", 'method_not_allowed', 405, undefined, `Method ${method} not allowed on ${url.pathname}`);
    if (url.pathname !== '/v1/health' && !authorized(req, url)) throw new PhoneDockError("Authentication failed", 'unauthorized', 401, ["Check the authentication token."], ['Missing or bad token', ...['Read the token from $PHONEDOCK_HOME/daemon.json', 'Send Authorization: Bearer <token>']].filter(Boolean).join('\n'));
    let bodyP: Promise<unknown> | undefined;
    const ctx: Ctx = {
      req, res, url, params: m.params,
      owner: String(req.headers['x-phonedock-owner'] ?? 'anonymous').slice(0, 200) || 'anonymous',
      body: () => (bodyP ??= readBody(req)),
      q: (k) => url.searchParams.get(k) ?? undefined,
    };
    const started = performance.now();
    let out: unknown;
    try { out = await m.h(ctx); }
    finally {
      const elapsed = performance.now() - started;
      metrics.record('routes', `${method} ${m.path}`, elapsed);
      if (!res.headersSent && /\/(frame|screenshot|input)$/.test(m.path)) res.setHeader('Server-Timing', `route;dur=${elapsed.toFixed(2)}`);
    }
    if (out === HANDLED) return;
    if (out instanceof Raw) {
      if (res.headersSent) return;
      const body = typeof out.body === 'string' ? Buffer.from(out.body) : out.body;
      res.writeHead(out.status, { 'Content-Length': body.length, ...out.headers });
      res.end(body);
      return;
    }
    sendJson(res, 200, out ?? { ok: true });
  } catch (e) {
    if (!(e instanceof PhoneDockError)) console.error(`[phonedockd] ${method} ${url.pathname}:`, e);
    sendError(res, e);
  }
});
server.keepAliveTimeout = 30_000;
server.requestTimeout = 0; // long boot/install requests + streams

server.on('error', (e) => { console.error(`[phonedockd] listen failed: ${(e as Error).message}`); process.exit(1); });
server.listen(port, '127.0.0.1', () => {
  console.log(`[phonedockd] v${VERSION} listening on http://127.0.0.1:${port} (pid ${process.pid}); backends: ${backends.map((b) => b.id).join(', ')}`);
  void autoStart();
  refreshAgentSkills(port).catch((e) => console.error(`[phonedockd] skill refresh failed: ${(e as Error).message}`));
});

async function autoStart() {
  const recs = state.devices.filter((d) => d.autoStart);
  if (!recs.length) return;
  const devs = await listDevices(true);
  for (const r of recs) {
    const d = devs.find((x) => x.id === r.id);
    if (!d || d.state !== 'stopped') continue;
    let b; try { b = getBackend(r.backend); } catch { continue; }
    if (!b.boot) continue;
    console.log(`[phonedockd] autoStart: booting ${r.id}`);
    startJob('boot', async (p) => { await b.boot!(r.nativeId, { headless: r.spec?.headless ?? true, onProgress: p } as BootOptions); return { ok: true }; }, r.id);
  }
}

// Devices outlive the daemon: never kill emulators/VMs on exit.
// A running trace's recorder is stopped first (bounded), so no xctrace / perfetto outlives the daemon.
let exiting = false;
const shutdown = (sig: string) => {
  if (exiting) return; exiting = true;
  console.log(`[phonedockd] ${sig} – exiting (devices keep running)`); server.close();
  const stopTraces = traces.size ? Promise.race([abortAllTraces(`daemon exiting (${sig})`), new Promise((r) => setTimeout(r, 25_000))]) : Promise.resolve();
  void stopTraces.finally(() => setTimeout(() => process.exit(0), 300).unref());
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => console.error('[phonedockd] unhandledRejection', e));
