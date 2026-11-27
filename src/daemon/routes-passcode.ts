// Per-device unattended passcode unlock routes (docs/API.md "Unattended Unlock").
// Security invariants:
// - Agents (owner starting with `mcp:`) can NEVER save, modify, or delete a passcode.
// - Malformed JSON returns a fixed `bad_json` error (never forwarding parser input snippets).
// - Explicit POST /unlock runs through `inputRoute(..., { skipAutoUnlock: true })` so it participates in the
//   per-device input queue, temporary claim, ownership fence, and request receipt.
import { PhoneDockError } from '../core/types.ts';
import { checkLease, deviceDecorators, emit, getBackend, getDevice, invalidateDevices, logAction, splitId, uiCache } from './core.ts';
import { inputRoute } from './delivery.ts';
import { inputScope } from './execution.ts';
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
      undefined,
      'not_sent',
    );
  }
}

r.get('/v1/devices/:id/passcode', async (c) => {
  const { id } = dev(c);
  return passcodeManager().status(id);
});

r.add('PUT', '/v1/devices/:id/passcode', async (c) => {
  forbidMcpOwner(c.owner, 'save or change');
  let body: { passcode?: unknown; enabled?: unknown };
  try {
    body = (await c.body()) as { passcode?: unknown; enabled?: unknown };
  } catch (e) {
    if (e instanceof PhoneDockError && e.code === 'payload_too_large') {
      throw new PhoneDockError('Request body is too large', 'payload_too_large', 413);
    }
    throw new PhoneDockError('Invalid JSON body', 'bad_json', 400);
  }
  const { id } = dev(c);
  return passcodeManager().configure(id, body ?? {}, c.owner);
});

r.del('/v1/devices/:id/passcode', async (c) => {
  forbidMcpOwner(c.owner, 'remove');
  const { id } = dev(c);
  return passcodeManager().remove(id, c.owner);
});

r.post('/v1/devices/:id/unlock', inputRoute(async (c) => {
  const { id } = dev(c);
  const scope = inputScope();
  return passcodeManager().unlock(id, c.owner, {
    skipLeaseCheck: true, // inputRoute already checked the lease and holds the active input claim
    assertOwnership: () => scope?.assertAllowed(),
  });
}, { skipAutoUnlock: true }));
