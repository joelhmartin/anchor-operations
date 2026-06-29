import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PERIODS,
  MIN_STDDEV_SAMPLES,
  windowForPeriod,
  selectSamples,
  computeStats,
  computeBaselinesForSeries
} from '../baselines/computeBaselines.js';

const AS_OF = '2026-06-28'; // a Sunday (UTC)

test('ALL_PERIODS is the exact ordered set', () => {
  assert.deepEqual(ALL_PERIODS, [
    '7_day', '30_day', 'weekday_4_week', 'previous_month', 'trailing_90_day', 'month_to_date'
  ]);
  assert.equal(MIN_STDDEV_SAMPLES, 4);
});

test('windowForPeriod: rolling windows exclude the observed day', () => {
  assert.deepEqual(windowForPeriod('7_day', AS_OF), { start: '2026-06-21', end: '2026-06-27' });
  assert.deepEqual(windowForPeriod('30_day', AS_OF), { start: '2026-05-29', end: '2026-06-27' });
  assert.deepEqual(windowForPeriod('trailing_90_day', AS_OF), { start: '2026-03-30', end: '2026-06-27' });
});

test('windowForPeriod: weekday_4_week bounds the four prior same-weekdays', () => {
  assert.deepEqual(windowForPeriod('weekday_4_week', AS_OF), { start: '2026-05-31', end: '2026-06-21' });
});

test('windowForPeriod: previous_month + month_to_date', () => {
  assert.deepEqual(windowForPeriod('previous_month', AS_OF), { start: '2026-05-01', end: '2026-05-31' });
  assert.deepEqual(windowForPeriod('month_to_date', AS_OF), { start: '2026-06-01', end: '2026-06-27' });
});

test('selectSamples weekday_4_week keeps only matching weekday (Sundays)', () => {
  const series = [
    { date: '2026-05-31', value: 1 }, // Sun
    { date: '2026-06-01', value: 99 }, // Mon (excluded)
    { date: '2026-06-07', value: 2 }, // Sun
    { date: '2026-06-14', value: 3 }, // Sun
    { date: '2026-06-21', value: 4 }, // Sun
    { date: '2026-06-27', value: 99 } // Sat (outside weekday window)
  ];
  assert.deepEqual(selectSamples(series, 'weekday_4_week', AS_OF), [1, 2, 3, 4]);
});

test('selectSamples 7_day keeps only the contiguous prior-7 window', () => {
  const series = [
    { date: '2026-06-20', value: 99 }, // before window
    { date: '2026-06-21', value: 10 },
    { date: '2026-06-27', value: 16 },
    { date: '2026-06-28', value: 99 }  // the observed day, excluded
  ];
  assert.deepEqual(selectSamples(series, '7_day', AS_OF), [10, 16]);
});

test('computeStats: mean + sample stddev when >= MIN_STDDEV_SAMPLES', () => {
  const r = computeStats([10, 20, 30, 40]);
  assert.equal(r.count, 4);
  assert.equal(r.mean, 25);
  // sample stddev = sqrt(500/3) ~= 12.909944
  assert.ok(Math.abs(r.stddev - 12.909944) < 1e-5);
});

test('computeStats: stddev null below threshold, mean still computed', () => {
  const r = computeStats([10, 20, 30]);
  assert.equal(r.count, 3);
  assert.equal(r.mean, 20);
  assert.equal(r.stddev, null);
});

test('computeStats: empty → all null/zero', () => {
  assert.deepEqual(computeStats([]), { count: 0, mean: null, stddev: null });
});

test('computeBaselinesForSeries returns one row per period with rounded stats', () => {
  // 30 contiguous days each value 100 → mean 100, stddev 0 over enough samples.
  const series = [];
  for (let i = 1; i <= 31; i++) {
    const d = String(i).padStart(2, '0');
    series.push({ date: `2026-05-${d}`, value: 100 });
  }
  for (let i = 1; i <= 27; i++) {
    const d = String(i).padStart(2, '0');
    series.push({ date: `2026-06-${d}`, value: 100 });
  }
  const rows = computeBaselinesForSeries({ series, asOf: AS_OF });
  assert.equal(rows.length, 6);
  const byPeriod = Object.fromEntries(rows.map((r) => [r.period, r]));
  assert.equal(byPeriod['7_day'].baseline_value, 100);
  assert.equal(byPeriod['7_day'].sample_count, 7);
  assert.equal(byPeriod['7_day'].stddev, 0);
  assert.equal(byPeriod['previous_month'].sample_count, 31); // May has 31 days
  assert.equal(byPeriod['previous_month'].baseline_value, 100);
  assert.deepEqual(
    { s: byPeriod['7_day'].window_start, e: byPeriod['7_day'].window_end },
    { s: '2026-06-21', e: '2026-06-27' }
  );
});

test('computeBaselinesForSeries: empty window → null baseline, zero samples', () => {
  const rows = computeBaselinesForSeries({ series: [], asOf: AS_OF });
  for (const r of rows) {
    assert.equal(r.baseline_value, null);
    assert.equal(r.stddev, null);
    assert.equal(r.sample_count, 0);
  }
});
