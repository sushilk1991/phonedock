import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  androidIntentExtraFlags,
  hasLaunchOptions,
  iosLaunchArgv,
  iosPrefixedEnv,
  launchLogMeta,
  launchSecretValues,
  launchSummarySuffix,
  redactLaunchStep,
  validateLaunchOptions,
} from './launch-options.ts';
import { expandSecretForms, redactInputValue, redactSecretStrings } from './secrets.ts';
import { PhoneDockError } from './types.ts';
import { shQuote } from '../backends/android-common.ts';

test('validateLaunchOptions: accepts string[], typed object args, and string env; normalises empty', () => {
  assert.equal(validateLaunchOptions(undefined, undefined), undefined);
  assert.equal(validateLaunchOptions([], {}), undefined);
  assert.deepEqual(validateLaunchOptions(['-UITesting', '1'], undefined), { args: ['-UITesting', '1'] });
  assert.deepEqual(
    validateLaunchOptions({ flag: true, count: 42, big: 9007199254740991, ratio: 1.5, token: 'abc' }, { API_TOKEN: 's3cr3t' }),
    { args: { flag: true, count: 42, big: 9007199254740991, ratio: 1.5, token: 'abc' }, env: { API_TOKEN: 's3cr3t' } },
  );
  assert.equal(hasLaunchOptions(undefined), false);
  assert.equal(hasLaunchOptions({ args: [], env: {} }), false);
  assert.equal(hasLaunchOptions({ args: ['-x'] }), true);
  assert.equal(hasLaunchOptions({ env: { A: '1' } }), true);
});

test('validateLaunchOptions: rejects invalid types, unsafe integers (> 2^53), bad env keys, NULs, oversized', () => {
  assert.throws(() => validateLaunchOptions('not-array-or-obj', undefined), /args must be an array/);
  assert.throws(() => validateLaunchOptions([123], undefined), /must be a string/);
  assert.throws(() => validateLaunchOptions(['a\0b'], undefined), /NUL/);
  assert.throws(() => validateLaunchOptions({ x: { nested: 1 } }, undefined), /string, number, or boolean/);
  assert.throws(() => validateLaunchOptions({ x: Number.NaN }, undefined), /finite number/);
  assert.throws(() => validateLaunchOptions({ x: Number.POSITIVE_INFINITY }, undefined), /finite number/);
  // Unsafe integer beyond 2^53 - 1
  assert.throws(() => validateLaunchOptions({ big: 9007199254740992 }, undefined), /safe 53-bit range/);
  assert.throws(() => validateLaunchOptions({ big: -9007199254740992 }, undefined), /safe 53-bit range/);
  assert.throws(() => validateLaunchOptions(undefined, { 'BAD-NAME': '1' }), /Invalid environment variable name/);
  assert.throws(() => validateLaunchOptions(undefined, { '1ABC': '1' }), /Invalid environment variable name/);
  assert.throws(() => validateLaunchOptions(undefined, { OK: 42 }), /must be a string/);
  assert.throws(() => validateLaunchOptions(Array.from({ length: 65 }, (_, i) => `a${i}`), undefined), /Too many/);
  assert.throws(() => validateLaunchOptions(['x'.repeat(4097)], undefined), /too long/);
});

test('iosLaunchArgv and iosPrefixedEnv: maps array/map args and SIMCTL/DEVICECTL prefixes without mutating base', () => {
  assert.deepEqual(iosLaunchArgv(['-UITesting', '--mode', 'staging']), ['-UITesting', '--mode', 'staging']);
  assert.deepEqual(
    iosLaunchArgv({ isUITestRunning: true, '-alreadyDashed': 'ok', retryLimit: 3 }),
    ['-isUITestRunning', 'true', '-alreadyDashed', 'ok', '-retryLimit', '3'],
  );
  const base = { PATH: '/usr/bin' };
  const sim = iosPrefixedEnv('SIMCTL_CHILD_', base, { API_KEY: 'secret-1', MODE: 'test' });
  assert.equal(sim.SIMCTL_CHILD_API_KEY, 'secret-1');
  assert.equal(sim.SIMCTL_CHILD_MODE, 'test');
  assert.equal(sim.PATH, '/usr/bin');
  assert.equal((base as Record<string, string>).SIMCTL_CHILD_API_KEY, undefined);

  const dev = iosPrefixedEnv('DEVICECTL_CHILD_', base, { TOKEN: 'secret-2' });
  assert.equal(dev.DEVICECTL_CHILD_TOKEN, 'secret-2');
});

test('androidIntentExtraFlags: maps booleans, int32, int64, floats, and shell-quoted strings with special characters', () => {
  const flags = androidIntentExtraFlags(
    {
      flagTrue: true,
      flagFalse: false,
      smallInt: 42,
      minInt32: -2147483648,
      maxInt32: 2147483647,
      longInt: 2147483648,
      negLong: -9007199254740991,
      ratio: 3.25,
      tricky: `a b 'c' "d" $HOME \`id\` ; & \n café 🚀`,
    },
    shQuote,
  );
  assert.deepEqual(flags, [
    '--ez', "'flagTrue'", 'true',
    '--ez', "'flagFalse'", 'false',
    '--ei', "'smallInt'", '42',
    '--ei', "'minInt32'", '-2147483648',
    '--ei', "'maxInt32'", '2147483647',
    '--el', "'longInt'", '2147483648',
    '--el', "'negLong'", '-9007199254740991',
    '--ef', "'ratio'", '3.25',
    '--es', "'tricky'", `'a b '\\''c'\\'' "d" $HOME \`id\` ; & \n café 🚀'`,
  ]);
  assert.throws(() => androidIntentExtraFlags({ huge: 9007199254740992 }, shQuote), /safe 53-bit range/);
});

test('secret helpers: launchLogMeta, launchSummarySuffix, launchSecretValues, redactLaunchStep never leak values', () => {
  const opts = { args: { token: 'top-secret-token', flag: true }, env: { API_KEY: 'super-secret-key' } };
  const meta = launchLogMeta(opts);
  assert.deepEqual(meta, { hasArgs: true, argKeys: ['token', 'flag'], envKeys: ['API_KEY'] });
  assert.ok(!JSON.stringify(meta).includes('top-secret-token'));
  assert.ok(!JSON.stringify(meta).includes('super-secret-key'));

  const summary = launchSummarySuffix(opts);
  assert.equal(summary, ' (with 2 args, 1 env var)');

  const secrets = launchSecretValues(opts);
  assert.ok(secrets.includes('top-secret-token'));
  assert.ok(secrets.includes('super-secret-key'));

  const redacted = redactLaunchStep({ kind: 'launch', app: 'com.x', stop: true, arguments: opts.args, env: opts.env });
  assert.deepEqual(redacted, {
    kind: 'launch', app: 'com.x', stop: true,
    arguments: { token: '•••', flag: '•••' },
    env: { API_KEY: '•••' },
  });
  const redactedArr = redactLaunchStep({ kind: 'launch', app: 'com.x', stop: true, arguments: ['-secret', 'val'] });
  assert.deepEqual(redactedArr.arguments, ['•••', '•••']);
});

test('launchSecretValues: redacts strings and finite numbers >= 3 chars; keeps booleans and < 3 chars unredacted', () => {
  const secrets = launchSecretValues({
    args: { token: 123456, neg: -42, pin: 99, zero: 0, flag: true, off: false, short: 'ab', minStr: 'abc' },
    env: { OTP: '4567', SHORT: '12' },
  });
  assert.ok(secrets.includes('123456'));
  assert.ok(secrets.includes('-42'));
  assert.ok(secrets.includes('abc'));
  assert.ok(secrets.includes('4567'));
  assert.ok(!secrets.includes('99'));
  assert.ok(!secrets.includes('0'));
  assert.ok(!secrets.includes('true'));
  assert.ok(!secrets.includes('false'));
  assert.ok(!secrets.includes('ab'));
  assert.ok(!secrets.includes('12'));
});

test('expandSecretForms and redactSecretStrings: scrub JSON-escaped forms without clobbering unrelated fields', () => {
  const secret = 'abc"def';
  const forms = expandSecretForms([secret]);
  assert.ok(forms.includes('abc"def'));
  assert.ok(forms.includes('abc\\"def'));
  const diag = `Expected ${JSON.stringify(secret)} on screen`;
  assert.equal(redactInputValue(diag, [secret]), 'Expected "•••" on screen');
  assert.deepEqual(
    redactSecretStrings({ text: 'Welcome', detail: diag }, [secret]),
    { text: 'Welcome', detail: 'Expected "•••" on screen' },
  );
});

test('validateLaunchOptions: rejects __proto__, constructor, and prototype keys in both args and env with 400', () => {
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const rawArgs = JSON.parse(`{"${key}":"value"}`);
    assert.throws(
      () => validateLaunchOptions(rawArgs, undefined),
      (e: unknown) => e instanceof PhoneDockError && e.status === 400 && e.code === 'bad_request' && e.delivery === 'not_sent',
    );
    const rawEnv = JSON.parse(`{"${key}":"value"}`);
    assert.throws(
      () => validateLaunchOptions(undefined, rawEnv),
      (e: unknown) => e instanceof PhoneDockError && e.status === 400 && e.code === 'bad_request' && e.delivery === 'not_sent',
    );
  }
});
