// Daemon HTTP routes for retrievable flow run records (schemaVersion: 1):
//   GET  /v1/runs                -> RunSummary[] (filtered, newest first)
//   GET  /v1/runs/:runId         -> RunRecord
//   GET  /v1/runs/:runId/export  -> Markdown (public-safe) or JSON
//   POST /v1/runs                -> validate (<= 2 MB, <= 2000 steps, schemaVersion: 1), write atomically (409 on dup), emit SSE
import { PhoneDockError, type RunStatus } from '../core/types.ts';
import {
  assertValidRunId,
  formatRunMarkdown,
  listRunSummaries,
  MAX_RUN_BODY_BYTES,
  readRunRecord,
  validateRunRecord,
  writeRunRecord,
} from '../core/run-store.ts';
import { emit } from './core.ts';
import { badRequest, Raw } from './http.ts';
import { router as r } from './routes.ts';

const VALID_STATUSES = new Set<RunStatus>(['pass', 'fail', 'skip']);

r.get('/v1/runs', (c) => {
  const limitRaw = c.q('limit');
  let limit = 50;
  if (limitRaw !== undefined) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 200) throw badRequest('limit must be an integer between 1 and 200');
    limit = n;
  }
  const statusRaw = c.q('status');
  if (statusRaw !== undefined && !VALID_STATUSES.has(statusRaw as RunStatus)) {
    throw badRequest('status must be pass | fail | skip');
  }
  return listRunSummaries({
    device: c.q('device'),
    status: statusRaw as RunStatus | undefined,
    flow: c.q('flow'),
    appId: c.q('appId'),
    limit,
  });
});

r.get('/v1/runs/:runId', (c) => {
  const id = assertValidRunId(c.params.runId);
  const run = readRunRecord(id);
  if (!run) throw new PhoneDockError('The run record was not found', 'not_found', 404, undefined, `No run ${id}`);
  return run;
});

r.get('/v1/runs/:runId/export', (c) => {
  const id = assertValidRunId(c.params.runId);
  const fmt = (c.q('format') ?? 'md').toLowerCase();
  if (fmt !== 'md' && fmt !== 'json') throw badRequest('format must be md or json');
  const run = readRunRecord(id);
  if (!run) throw new PhoneDockError('The run record was not found', 'not_found', 404, undefined, `No run ${id}`);
  if (fmt === 'json') {
    return new Raw(200, JSON.stringify(run, null, 2) + '\n', {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
  }
  return new Raw(200, formatRunMarkdown(run), {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'no-store',
  });
});

r.post('/v1/runs', async (c) => {
  const body = await c.body(MAX_RUN_BODY_BYTES);
  const serialized = JSON.stringify(body ?? null);
  if (Buffer.byteLength(serialized) > MAX_RUN_BODY_BYTES) {
    throw new PhoneDockError('The request is too large', 'too_large', 413, undefined, `Run record body exceeds ${MAX_RUN_BODY_BYTES} bytes.`);
  }
  const valid = validateRunRecord(body);
  const summary = writeRunRecord(valid);
  emit('run', summary);
  return new Raw(201, JSON.stringify(summary), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
});
