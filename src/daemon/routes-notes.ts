// App notes (src/core/app-notes.ts): per-app learnings shared by every agent on this Mac. Not tied to a device, so
// no lease. Registered onto the shared router; imported by main.ts after routes.ts.
import { appNotesPath, deleteAppNotes, listAppNotes, readAppNotes, saveAppNotes, validateAppId } from '../core/app-notes.ts';
import { router as r } from './routes.ts';

r.get('/v1/app-notes', () => listAppNotes());
r.get('/v1/app-notes/:appId', (c) => {
  const appId = validateAppId(c.params.appId);
  return readAppNotes(appId) ?? { appId, path: appNotesPath(appId), notes: null };
});
r.add('PUT', '/v1/app-notes/:appId', async (c) => ({ ok: true, ...saveAppNotes(c.params.appId, (await c.body())?.notes) }));
r.del('/v1/app-notes/:appId', (c) => ({ ok: true, ...deleteAppNotes(c.params.appId) }));
