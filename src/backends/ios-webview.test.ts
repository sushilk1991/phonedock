import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectIosSimWebView, type IosSimWebViewDeps } from './ios-webview.ts';

const DOM = {
  viewport: { width: 393, height: 852, offsetLeft: 0, offsetTop: 0, scale: 1 },
  text: 'Example Domain',
  elements: [{ tag: 'a', label: 'More information...', bounds: { x: 20, y: 200, width: 140, height: 22 } }],
};

const MEASURED = {
  viewport: { width: 393, height: 852, offsetLeft: 0, offsetTop: 0, scale: 1 },
  matchCount: 1,
  elements: [{
    tag: 'h1',
    id: 'hero-title',
    classes: ['heading', 'primary'],
    text: 'Example Domain',
    visible: true,
    bounds: { x: 16, y: 48, width: 361, height: 42 },
    styles: {
      display: 'block',
      position: 'static',
      visibility: 'visible',
      opacity: '1',
      zIndex: 'auto',
      fontSize: '32px',
      fontFamily: '-apple-system, sans-serif',
      fontWeight: '700',
      color: 'rgb(0, 0, 0)',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      padding: '0px',
      margin: '21px 0px',
      borderRadius: '0px',
    },
  }],
  truncated: false,
};

function fixture(reply: Record<string, unknown>, socketPath: string | null = '/tmp/rwi.sock') {
  const sent: Record<string, unknown>[] = [];
  const deps: IosSimWebViewDeps = {
    resolveSocket: async () => socketPath ?? undefined,
    scriptPath: () => '/fake/pd-ios-sim-webview.py',
    runHelper: async (_script, payload) => {
      sent.push(payload);
      return reply;
    },
  };
  return { deps, sent };
}

test('iOS simulator WebView snapshot works without appId and strips URL query/credentials', async () => {
  const f = fixture({
    ok: true,
    target: { id: 'PID:100:1', appId: 'com.apple.mobilesafari', title: 'Example Domain', url: 'https://user:pass@example.com/page?secret=1#hash' },
    value: DOM,
  });
  const res = await inspectIosSimWebView('11111111-2222-3333-4444-555555555555', { action: 'snapshot' }, f.deps);
  assert.equal(res.action, 'snapshot');
  if (res.action !== 'snapshot') assert.fail('snapshot');
  assert.equal(res.target.url, 'https://example.com/page');
  assert.equal(res.target.appId, 'com.apple.mobilesafari');
  assert.equal(res.elements.length, 1);
  assert.equal(res.elements[0].label, 'More information...');
  assert.equal(f.sent[0].socketPath, '/tmp/rwi.sock');
});

test('iOS simulator WebView measure returns bounding box and computed CSS styles', async () => {
  const f = fixture({
    ok: true,
    target: { id: 'PID:100:1', appId: 'com.apple.mobilesafari', title: 'Example Domain', url: 'https://example.com/' },
    value: MEASURED,
  });
  const res = await inspectIosSimWebView('11111111-2222-3333-4444-555555555555', { action: 'measure', selector: 'h1#hero-title' }, f.deps);
  assert.equal(res.action, 'measure');
  if (res.action !== 'measure') assert.fail('measure');
  assert.equal(res.selector, 'h1#hero-title');
  assert.equal(res.matchCount, 1);
  assert.equal(res.elements[0].tag, 'h1');
  assert.equal(res.elements[0].id, 'hero-title');
  assert.deepEqual(res.elements[0].classes, ['heading', 'primary']);
  assert.equal(res.elements[0].styles.fontSize, '32px');
  assert.equal(res.elements[0].visible, true);
});

test('iOS simulator WebView network capture redacts URL query strings and credentials', async () => {
  const f = fixture({
    ok: true,
    target: { id: 'PID:100:1', appId: 'com.apple.mobilesafari', title: 'App', url: 'https://example.com/' },
    requests: [{ method: 'GET', url: 'https://tok:sec@api.example.com/v1/items?key=123', status: 200, durationMs: 42 }],
    truncated: false,
  });
  const res = await inspectIosSimWebView('11111111-2222-3333-4444-555555555555', { action: 'network', captureMs: 500 }, f.deps);
  assert.equal(res.action, 'network');
  if (res.action !== 'network') assert.fail('network');
  assert.deepEqual(res.requests, [{ method: 'GET', url: 'https://api.example.com/v1/items', status: 200, durationMs: 42 }]);
});

test('iOS simulator WebView surfaces ambiguous targets and offline simulators cleanly', async () => {
  const amb = fixture({
    ok: false,
    code: 'ambiguous_target',
    error: 'multiple tabs',
    availableTargets: [
      { id: 'PID:1:1', appId: 'com.apple.mobilesafari', title: 'Tab 1', url: 'https://a.test/?q=secret' },
      { id: 'PID:1:2', appId: 'com.apple.mobilesafari', title: 'Tab 2', url: 'https://b.test/' },
    ],
  });
  await assert.rejects(
    inspectIosSimWebView('11111111-2222-3333-4444-555555555555', { action: 'snapshot' }, amb.deps),
    (e: any) => e.code === 'ambiguous_target' && !e.detail.includes('secret') && e.detail.includes('https://a.test/'),
  );

  const off = fixture({ ok: true }, null);
  await assert.rejects(
    inspectIosSimWebView('11111111-2222-3333-4444-555555555555', { action: 'snapshot' }, off.deps),
    (e: any) => e.code === 'offline',
  );

  await assert.rejects(
    inspectIosSimWebView('11111111-2222-3333-4444-555555555555', { action: 'measure', selector: '' }, off.deps),
    (e: any) => e.code === 'bad_request',
  );
});
