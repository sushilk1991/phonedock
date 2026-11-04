import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { Histogram, Metrics, instrumentBackend } from './metrics.ts';

test('histogram retains a bounded window while count and max span its lifetime', () => {
  const h = new Histogram(3);
  for (const value of [100, 1, 2, 3, 4, -1, NaN]) h.record(value);
  assert.deepEqual(h.snapshot(), { count: 5, p50: 3, p95: 4, max: 100 });
});

test('backend timing records success and failure without changing behavior', async () => {
  const metrics = new Metrics();
  const b = instrumentBackend({ value: 3, sync() { return this.value; }, async fail() { throw new Error('failed'); } }, 'fake', metrics);
  assert.equal(b.sync(), 3);
  await assert.rejects(b.fail(), /failed/);
  assert.equal(metrics.snapshot().backends['fake.sync'].count, 1);
  assert.equal(metrics.snapshot().backends['fake.fail'].count, 1);
});
