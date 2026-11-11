import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFlowReport } from './flow-report.ts';
import type { FlowResult } from './flow-runner.ts';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('HTML report embeds before/after evidence and a correctly scaled action marker without scripts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-report-'));
  try {
    const before = join(dir, 'before.png'), after = join(dir, 'after.png'); writeFileSync(before, png); writeFileSync(after, png);
    const flow: FlowResult = { name: '</script><script>alert(1)</script>', status: 'pass', ms: 1, startedAt: '', attempts: 1, artifacts: dir,
      steps: [{ index: 1, step: { kind: 'tap', at: { x: 0.5, y: 0.5, unit: 'px' } }, description: 'tap <button>', ms: 1, status: 'pass', beforeScreenshot: before, screenshot: after, actionPoint: { x: 0.5, y: 0.5 } }] };
    writeFlowReport(join(dir, 'report.html'), [flow]);
    const html = readFileSync(join(dir, 'report.html'), 'utf8');
    assert.ok(!html.includes('<script>'));
    assert.match(html, /aria-label="Action point" style="left:50%;top:50%"/);
    assert.match(html, /default-src 'none'/);
    assert.equal((html.match(/data:image\/png;base64,/g) ?? []).length, 2, 'step screenshots are not embedded twice');
    assert.match(html, /tap &lt;button&gt;/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('HTML report excludes escaping artifact symlinks and oversized evidence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pd-report-')), outside = mkdtempSync(join(tmpdir(), 'pd-report-outside-'));
  try {
    writeFileSync(join(outside, 'private.txt'), 'private outside contents'); symlinkSync(join(outside, 'private.txt'), join(dir, 'escape.txt'));
    writeFileSync(join(dir, 'large.txt'), ''); truncateSync(join(dir, 'large.txt'), 9 * 1024 * 1024);
    const flow: FlowResult = { name: 'Safe', status: 'pass', steps: [], ms: 0, startedAt: '', attempts: 1, artifacts: dir };
    writeFlowReport(join(dir, 'report.html'), [flow]);
    const html = readFileSync(join(dir, 'report.html'), 'utf8');
    assert.ok(!html.includes('private outside contents'));
    assert.match(html, /Evidence omitted because of report size limit: large.txt/);
    assert.ok(html.length < 10_000);
  } finally { rmSync(dir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
});
