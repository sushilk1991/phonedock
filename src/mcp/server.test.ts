import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PhoneDockApiError } from '../sdk/client.ts';
import { agentDetail, errorResult, noMatchHint, standardSpace } from './server.ts';

const txt = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? '').join('\n');

test('standardSpace: one fixed image space per screen size (longest side 1024)', () => {
  assert.deepEqual(standardSpace(1080, 2424), { scale: 2424 / 1024, imageWidth: 456, imageHeight: 1024, deviceWidth: 1080, deviceHeight: 2424, maxSize: 1024 });
  assert.equal(standardSpace(2424, 1080).imageWidth, 1024);   // landscape: same scale
  assert.equal(standardSpace(800, 600).scale, 1);
});

test('noMatchHint suggests scrolling only when something can scroll', () => {
  assert.match(noMatchHint(true, 'Submit'), /scroll_to\(text="Submit"\)/);
  assert.match(noMatchHint(false, 'Submit'), /Nothing on this screen scrolls/);
  assert.doesNotMatch(noMatchHint(false, 'Submit'), /scroll_to/);
  assert.match(noMatchHint(null, 'Submit'), /If the screen scrolls/);
});

test('errorResult: lease conflicts never suggest force or raw routes; a person holding it means wait / request_human', () => {
  const human = errorResult(new PhoneDockApiError('The device is in use by the person at the Mac (app:human)', 'lease_conflict', 409,
    ['A person is using this device (they took it over in the PhoneDock app). Wait until they hand it back, or ask them for it with a handoff request. It cannot be taken over from them.'],
    'Device android-emulator:x is leased by app:human since now\nAcquire it: POST /v1/devices/x/lease (force:true to take over)'));
  const t = txt(human);
  assert.match(t, /request_human/); assert.match(t, /wait/i);
  assert.doesNotMatch(t, /force|\/v1\//);
  const agent = txt(errorResult(new PhoneDockApiError('The device is in use by mcp:codex:12', 'lease_conflict', 409, ['mcp:codex:12 is using this device. Wait for it to finish.'], 'Device x is leased by mcp:codex:12 since now')));
  assert.match(agent, /cannot take a device over/); assert.doesNotMatch(agent, /force|\/v1\//);
  assert.equal(agentDetail('a\nGET /v1/devices lists them\nb'), 'a\nb');
});
