import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAndPersistBaselines } from '../baselines/computeBaselines.js';

test('computeAndPersistBaselines loads series, computes, persists non-empty periods', async () => {
  const series = [];
  for (let i = 1; i <= 27; i++) {
    series.push({ date: `2026-06-${String(i).padStart(2, '0')}`, value: 100 });
  }
  const upserted = [];
  const out = await computeAndPersistBaselines({
    clientUserId: 'c1', service: 'paid_ads', scopeType: 'account', scopeId: 'a1',
    metric: 'cost_cents', asOf: '2026-06-28',
    loadSnapshotSeries: async () => series,
    upsertBaseline: async (row) => { upserted.push(row); return { id: 'x', ...row }; }
  });

  assert.equal(out.metric, 'cost_cents');
  assert.equal(out.computed, 6);                 // all periods computed
  assert.ok(out.persisted >= 3 && out.persisted <= 6);
  // every persisted row carries identity + a positive sample_count
  for (const r of upserted) {
    assert.equal(r.clientUserId, 'c1');
    assert.equal(r.metric, 'cost_cents');
    assert.ok(r.sample_count > 0);
  }
  // previous_month had no June-only data → not persisted
  assert.equal(upserted.some((r) => r.period === 'previous_month'), false);
});

test('computeAndPersistBaselines persists nothing when there is no history', async () => {
  const out = await computeAndPersistBaselines({
    clientUserId: 'c1', service: 'paid_ads', scopeType: 'account', scopeId: 'a1',
    metric: 'cost_cents', asOf: '2026-06-28',
    loadSnapshotSeries: async () => [],
    upsertBaseline: async () => { throw new Error('should not be called'); }
  });
  assert.equal(out.persisted, 0);
  assert.equal(out.computed, 6);
});
