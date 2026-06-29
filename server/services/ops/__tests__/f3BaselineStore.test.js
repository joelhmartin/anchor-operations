import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query } from '../../../db.js';
import { loadSnapshotSeries, upsertBaseline, getBaselines } from '../baselines/baselineStore.js';

const CLIENT = randomUUID();
const SERVICE = 'paid_ads';
const SCOPE_TYPE = 'account';
const SCOPE_ID = 'acc-123';

async function seedSnapshot(date, metrics) {
  await query(
    `INSERT INTO ops_daily_snapshots (client_user_id, snapshot_date, service, scope_type, scope_id, metrics_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (client_user_id, snapshot_date, service, scope_type, scope_id)
     DO UPDATE SET metrics_json = EXCLUDED.metrics_json`,
    [CLIENT, date, SERVICE, SCOPE_TYPE, SCOPE_ID, JSON.stringify(metrics)]
  );
}

test('loadSnapshotSeries returns numeric points before asOf, ascending', async () => {
  await seedSnapshot('2026-06-25', { cost_cents: 1000, clicks: 10 });
  await seedSnapshot('2026-06-26', { cost_cents: 2000, clicks: 20 });
  await seedSnapshot('2026-06-28', { cost_cents: 9999, clicks: 99 }); // == asOf, excluded

  const series = await loadSnapshotSeries({
    clientUserId: CLIENT, service: SERVICE, scopeType: SCOPE_TYPE, scopeId: SCOPE_ID,
    metric: 'cost_cents', asOf: '2026-06-28'
  });
  assert.deepEqual(series, [
    { date: '2026-06-25', value: 1000 },
    { date: '2026-06-26', value: 2000 }
  ]);
});

test('loadSnapshotSeries skips rows missing the metric key', async () => {
  await seedSnapshot('2026-06-27', { clicks: 5 }); // no cost_cents
  const series = await loadSnapshotSeries({
    clientUserId: CLIENT, service: SERVICE, scopeType: SCOPE_TYPE, scopeId: SCOPE_ID,
    metric: 'cost_cents', asOf: '2026-06-28'
  });
  assert.equal(series.find((p) => p.date === '2026-06-27'), undefined);
});

test('upsertBaseline is idempotent on the unique key and getBaselines reads it back', async () => {
  const base = {
    clientUserId: CLIENT, service: SERVICE, scopeType: SCOPE_TYPE, scopeId: SCOPE_ID,
    metric: 'cost_cents', period: '7_day', baseline_value: 1500, stddev: 500,
    sample_count: 2, window_start: '2026-06-21', window_end: '2026-06-27'
  };
  const first = await upsertBaseline(base);
  assert.equal(Number(first.baseline_value), 1500);
  const second = await upsertBaseline({ ...base, baseline_value: 1600, sample_count: 3 });
  assert.equal(Number(second.baseline_value), 1600);
  assert.equal(second.id, first.id, 'upsert updates the same row');

  const all = await getBaselines({
    clientUserId: CLIENT, service: SERVICE, scopeType: SCOPE_TYPE, scopeId: SCOPE_ID, metric: 'cost_cents'
  });
  assert.equal(all.length, 1);
  assert.equal(all[0].period, '7_day');
});
