// Per-device unattended passcode unlock routes (docs/API.md "Unattended Unlock").
// Security invariant: agents (owner starting with `mcp:`) can NEVER set, modify, read, or delete a passcode.
// Passcodes are never returned, logged, or echoed in errors.
import { redactSecretStrings } from '../core/secrets.ts';
import { PhoneDockError } from '../core/types.ts';
import { checkLease, deviceDecorators, emit, getBackend, getDevice, invalidateDevices, logAction, splitId, uiCache } from './core.ts';
import { initPasscodes, passcodeManager } from './passcodes.ts';
import { dev, router as r } from './routes.ts';

initPasscodes({
  emitEvent: emit,
  logAction,
  invalidateDevices,
  clearUiCache: (id) => { uiCache.delete(id); },
  getDevice: (id) => getDevice(id),
  getBackend,
  splitId,
  checkLease,
});

deviceDecorators.push((d) => {
  d.meta = { ...(d.meta ?? {}), passcode: passcodeManager().deviceMeta(d) };
});

function forbidMcpOwner(owner: string, action: string): void {
  if (/^mcp:/i.test(owner)) {
    throw new PhoneDockError(
      `Agents cannot ${action} a device passcode`,
      'forbidden',
      403,
      ['Ask the user to configure Unattended Unlock in PhoneDock Device Settings or run `phonedock passcode set <device>`.'],
    );
  }
}

r.get('/v1/devices/:id/passcode', async (c) => {
  const { id } = dev(c);
  return passcodeManager().status(id);
});

r.add('PUT', '/v1/devices/:id/passcode', async (c) => {
  forbidMcpOwner(c.owner, 'save or change');
  const { id } = dev(c);
  const body = (await c.body()) as { passcode?: unknown; enabled?: unknown };
  const secret = typeof body?.passcode === 'string' && body.passcode.length ? [body.passcode] : [];
  try {
    return await passcodeManager().configure(id, body, c.owner);
  } catch (e) {
    if (secret.length && e instanceof PhoneDockError) {
      e.message = redactSecretStrings(e.message, secret);
      if (e.detail) e.detail = redactSecretStrings(e.detail, secret);
      if (e.hints) e.hints = e.hints.map((h) => redactSecretStrings(h, secret));
    }
    throw e;
  }
});

r.del('/v1/devices/:id/passcode', async (c) => {
  forbidMcpOwner(c.owner, 'remove');
  const { id } = dev(c);
  return passcodeManager().remove(id, c.owner);
});

r.post('/v1/devices/:id/unlock', async (c) => {
  const { id } = dev(c);
  return passcodeManager().unlock(id, c.owner);
});
