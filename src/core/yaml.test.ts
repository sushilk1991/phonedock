import { test } from 'node:test';
import assert from 'node:assert/strict';
import { YAML_COMMENT, YamlError, parse, stringify } from './yaml.ts';

test('yaml: block mappings, lists of mappings, flow collections, comments', () => {
  const src = `# a flow
name: Greet   # trailing comment
appId: dev.phonedock.sample
minOS: "16"
steps:
  - launch: dev.phonedock.sample
  - tap: Greet
  - tap: { text: Notifications, type: Switch }
  - fill:
      field: Your name
      value: Ada
  - assert_visible: "Hello, Ada!"
  - wait_for: idle
  - back
  - swipe: [up, 0.5]
list:
- a
- 'it''s'
`;
  assert.deepEqual(parse(src), {
    name: 'Greet', appId: 'dev.phonedock.sample', minOS: '16',
    steps: [
      { launch: 'dev.phonedock.sample' }, { tap: 'Greet' }, { tap: { text: 'Notifications', type: 'Switch' } },
      { fill: { field: 'Your name', value: 'Ada' } }, { assert_visible: 'Hello, Ada!' }, { wait_for: 'idle' }, 'back',
      { swipe: ['up', 0.5] },
    ],
    list: ['a', "it's"],
  });
});

test('yaml: scalars follow the YAML 1.2 core schema (yes/no/on stay strings)', () => {
  assert.deepEqual(parse('a: true\nb: ~\nc: 12\nd: 1.5\ne: yes\nf: on\ng: 1.2.3\nh: "12"\ni: -3\nj:\nk: http://x.y/z?a=1#frag\n'),
    { a: true, b: null, c: 12, d: 1.5, e: 'yes', f: 'on', g: '1.2.3', h: '12', i: -3, j: null, k: 'http://x.y/z?a=1#frag' });
  assert.deepEqual(parse('s: "tab\\there \\u00e9 \\"q\\""\n'), { s: 'tab\there é "q"' });
  assert.deepEqual(parse('t: |\n  line 1\n  line 2\nu: >-\n  folded\n  text\n'), { t: 'line 1\nline 2\n', u: 'folded text' });
});

test('yaml: clear errors with line numbers for what the subset does not read', () => {
  const err = (s: string, re: RegExp) => assert.throws(() => parse(s), (e: unknown) => e instanceof YamlError && re.test(e.message));
  err('a: Error: try again\n', /line 1: .*quoted/);
  err('a: 1\na: 2\n', /line 2: duplicate key "a"/);
  err('a: &x 1\n', /anchors/);
  err('a:\n\t- b\n', /tabs/);
  err('a: "open\n', /unterminated/);
  err('steps:\n  - tap: x\n   bad: 1\n', /line 3/);
  err('a: 1\n---\nb: 2\n', /one document/);
});

test('yaml: stringify round-trips and quotes what needs quoting', () => {
  const v = {
    name: 'Greet', minOS: '16', n: 3, ok: true, nothing: null,
    steps: [{ launch: 'x' }, { tap: { text: 'Hello, Ada!', type: 'Switch' } }, 'back', { fill: { field: { id: 'nameField' }, value: 'Ada' } },
      { assert_visible: 'Error: no' }, { type: 'yes' }, { type: '' }, { type: ' padded ' }, { type: '#hash' }, { type: 'a\nb' }],
  };
  const y = stringify(v);
  assert.deepEqual(parse(y), v);
  assert.match(y, /minOS: "16"/);
  assert.match(y, /tap: \{ text: "Hello, Ada!", type: Switch \}/);
  assert.match(y, /assert_visible: "Error: no"/);
  assert.match(y, /^ {2}- back$/m);
});

test('yaml: YAML_COMMENT writes comment lines above an item', () => {
  const step = { tap: { at: '50%,60%' } } as Record<string | symbol, unknown>;
  step[YAML_COMMENT] = 'fragile: raw coordinates';
  const y = stringify({ steps: [step] });
  assert.match(y, /^steps:\n {2}# fragile: raw coordinates\n {2}- tap: \{ at: "50%,60%" \}\n$/);
  assert.deepEqual(parse(y), { steps: [{ tap: { at: '50%,60%' } }] });
});
