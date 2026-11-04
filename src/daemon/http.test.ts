import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ServerResponse } from 'node:http';
import { sendError } from './http.ts';
import { PhoneDockError } from '../core/types.ts';

test('error response preserves existing fields and includes optional detail', () => {
  let status = 0; let body = '';
  const res = { headersSent: false, writeHead(s: number) { status = s; }, end(s: string) { body = s; } } as unknown as ServerResponse;
  sendError(res, new PhoneDockError('Couldn’t install the app', 'exec_failed', 500, ['Try again'], 'command exited 1'));
  assert.equal(status, 500);
  assert.deepEqual(JSON.parse(body), { error: { code: 'exec_failed', message: 'Couldn’t install the app', hints: ['Try again'], detail: 'command exited 1' } });
  sendError(res, new PhoneDockError('Not found', 'not_found', 404));
  assert.equal(status, 404);
  assert.deepEqual(JSON.parse(body), { error: { code: 'not_found', message: 'Not found' } });
});
