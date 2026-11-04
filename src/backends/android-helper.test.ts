import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { HELPER_DEX_B64, HELPER_DEX_SHA256, HelperReplyParser, parseLabelLines } from './android-helper.ts';
import { parsePmPackages, parseUiautomatorXml } from './android-common.ts';

test('helper dex: embedded bytes match HELPER_DEX_SHA256 and are a dex file', () => {
  const dex = Buffer.from(HELPER_DEX_B64, 'base64');
  assert.equal(createHash('sha256').update(dex).digest('hex'), HELPER_DEX_SHA256);
  assert.equal(dex.subarray(0, 4).toString('latin1'), 'dex\n');
});

test('HelperReplyParser: PDREADY, PDOK split across chunks, PDERR, stray lines', () => {
  const p = new HelperReplyParser();
  const xml = '<?xml version="1.0"?><hierarchy rotation="0"><node text="héllo"/></hierarchy>';
  const bytes = Buffer.byteLength(xml);
  assert.deepEqual(p.push(Buffer.from('WARNING: linker noise\nPDREADY\n')), [{ ready: true }]);
  const msg = Buffer.from(`PDOK ${bytes} 1\n${xml}PDERR null root node\n`);
  assert.deepEqual(p.push(msg.subarray(0, 20)), []);                       // body incomplete
  const r = p.push(msg.subarray(20));
  assert.deepEqual(r, [{ ok: true, xml, idle: true }, { ok: false, error: 'null root node' }]);
  assert.deepEqual(p.push(Buffer.from(`PDOK 2 0 37\n\n\n`)), [{ ok: true, xml: '\n\n', idle: false, sinceEventMs: 37 }]); // body may hold newlines
});

test('HelperReplyParser: PDIN replies (by seq, between dump replies), notsent → not_sent, detail kept', () => {
  const p = new HelperReplyParser();
  const xml = '<hierarchy/>';
  const r = p.push(Buffer.from(`PDIN 7 sent 18\nPDOK ${xml.length} 1\n${xml}PDIN 8 notsent 0 unknown key\nPDIN 9 unknown 15003 java.lang.IllegalStateException: x\n`));
  assert.deepEqual(r, [
    { input: { seq: 7, delivery: 'sent', ms: 18 } },
    { ok: true, xml, idle: true },
    { input: { seq: 8, delivery: 'not_sent', ms: 0, detail: 'unknown key' } },
    { input: { seq: 9, delivery: 'unknown', ms: 15003, detail: 'java.lang.IllegalStateException: x' } },
  ]);
  assert.deepEqual(p.push(Buffer.from('PDIN 10 maybe 3\n')), []);   // not a reply this host knows: ignored
});

test('parseLabelLines: apk<TAB>label, empty labels kept, junk ignored', () => {
  const m = parseLabelLines('/data/app/~~a==/x-b==/base.apk\tPhoneDock Sample\n/system/app/Y.apk\t\r\nnoise\n');
  assert.equal(m.get('/data/app/~~a==/x-b==/base.apk'), 'PhoneDock Sample');
  assert.equal(m.get('/system/app/Y.apk'), '');
  assert.equal(m.size, 2);
});

test('parsePmPackages: paths with "=", versionCode optional, plain ids', () => {
  const out = [
    'package:/data/app/~~nWC3_a61hgZ9xT2OzrX-5g==/dev.phonedock.sample-4GxE0nKNHx-bbaQnH0Dukw==/base.apk=dev.phonedock.sample versionCode:1',
    'package:/system/app/Foo/Foo.apk=com.example.foo',
    'package:com.example.bare',
    '',
    'Error: something',
  ].join('\n');
  assert.deepEqual(parsePmPackages(out), [
    { id: 'dev.phonedock.sample', path: '/data/app/~~nWC3_a61hgZ9xT2OzrX-5g==/dev.phonedock.sample-4GxE0nKNHx-bbaQnH0Dukw==/base.apk', versionCode: '1' },
    { id: 'com.example.foo', path: '/system/app/Foo/Foo.apk' },
    { id: 'com.example.bare' },
  ]);
});

test('parseUiautomatorXml: helper output (same format as uiautomator dump) parses', () => {
  const xml = "<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation=\"0\"><node index=\"0\" text=\"\" class=\"android.widget.FrameLayout\" bounds=\"[0,0][1080,2424]\"><node index=\"0\" text=\"Greet\" resource-id=\"dev.phonedock.sample:id/greet\" class=\"android.widget.Button\" clickable=\"true\" bounds=\"[60,700][1020,826]\" /></node></hierarchy>";
  const roots = parseUiautomatorXml(xml);
  assert.equal(roots.length, 1);
  assert.equal(roots[0].children[0].attrs.text, 'Greet');
});
