import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAnomaly, scoreAcrossPeriods } from '../baselines/anomalyScorer.js';

test('not comparable → none', () => {
  const r = scoreAnomaly({ comparison: { comparable: false }, metric: 'cost_cents' });
  assert.equal(r.severity, 'none');
  assert.equal(r.score, 0);
});

test('high z-score → critical, score saturates at 1', () => {
  const r = scoreAnomaly({
    comparison: { comparable: true, z_score: 5, pct_change: 1, direction: 'up', observed: 100, baseline_value: 50 },
    metric: 'cost_cents'
  });
  assert.equal(r.severity, 'critical');
  assert.equal(r.score, 1);
  assert.equal(r.direction, 'up');
  assert.match(r.reason, /cost_cents/);
});

test('moderate z-score → warning', () => {
  const r = scoreAnomaly({
    comparison: { comparable: true, z_score: 2.2, pct_change: 0.1, direction: 'down', observed: 40, baseline_value: 50 },
    metric: 'clicks'
  });
  assert.equal(r.severity, 'warning');
  assert.ok(r.score > 0 && r.score < 1);
});

test('small z-score → info', () => {
  const r = scoreAnomaly({
    comparison: { comparable: true, z_score: 1.2, pct_change: 0.05, direction: 'up', observed: 53, baseline_value: 50 },
    metric: 'clicks'
  });
  assert.equal(r.severity, 'info');
});

test('within tolerance → none', () => {
  const r = scoreAnomaly({
    comparison: { comparable: true, z_score: 0.3, pct_change: 0.02, direction: 'up', observed: 51, baseline_value: 50 },
    metric: 'clicks'
  });
  assert.equal(r.severity, 'none');
});

test('falls back to pct_change when z_score is null', () => {
  const critical = scoreAnomaly({
    comparison: { comparable: true, z_score: null, pct_change: 0.8, direction: 'up', observed: 90, baseline_value: 50 },
    metric: 'cost_cents'
  });
  assert.equal(critical.severity, 'critical'); // |pct| >= 0.5
  const info = scoreAnomaly({
    comparison: { comparable: true, z_score: null, pct_change: 0.18, direction: 'up', observed: 59, baseline_value: 50 },
    metric: 'cost_cents'
  });
  assert.equal(info.severity, 'info'); // |pct| >= 0.15
});

test('scoreAcrossPeriods returns the most anomalous period', () => {
  const r = scoreAcrossPeriods({
    metric: 'cost_cents',
    comparisonsByPeriod: {
      '7_day': { comparable: true, z_score: 1.1, pct_change: 0.05, direction: 'up' },
      '30_day': { comparable: true, z_score: 4.0, pct_change: 0.9, direction: 'up' },
      'previous_month': { comparable: false }
    }
  });
  assert.equal(r.period, '30_day');
  assert.equal(r.severity, 'critical');
});
