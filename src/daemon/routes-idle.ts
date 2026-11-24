// GET/POST /v1/idle-sleep: when idle Android emulators PhoneDock created go to sleep (src/daemon/idle-sleep.ts).
// A top-level path: /v1/devices/:id/settings is a phone's own settings, and `phonedock settings <device>` is its CLI.
import { badRequest } from './http.ts';
import { router as r } from './routes.ts';
import { idleSleepStatus, parseIdleDuration, setIdleSleep } from './idle-sleep.ts';

r.get('/v1/idle-sleep', () => idleSleepStatus());
r.post('/v1/idle-sleep', async (c) => {
  const body = (await c.body()) as { timeoutSec?: unknown; after?: unknown };
  const v = 'timeoutSec' in body ? (body.timeoutSec === null ? null : parseIdleDuration(body.timeoutSec))
    : 'after' in body ? parseIdleDuration(body.after) : undefined;
  if (v === undefined) throw badRequest('timeoutSec (null, 600, 900, 1800 or 3600) or after ("off", "10m", "15m", "30m", "1h") required');
  setIdleSleep(v);
  return idleSleepStatus();
});
