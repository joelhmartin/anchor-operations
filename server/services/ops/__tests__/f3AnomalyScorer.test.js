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

test('falls back to pct_change when z_score is null (adverse + enough history)', () => {
  // cost_cents is lower-is-better, so an 80% INCREASE is adverse. With
  // sample_count >= MIN_SAMPLES_FOR_ALARM the pct fallback is trusted to alarm.
  const critical = scoreAnomaly({
    comparison: { comparable: true, z_score: null, pct_change: 0.8, direction: 'up', observed: 90, baseline_value: 50, sample_count: 12 },
    metric: 'cost_cents'
  });
  assert.equal(critical.severity, 'critical'); // |pct| >= 0.5
  const info = scoreAnomaly({
    comparison: { comparable: true, z_score: null, pct_change: 0.18, direction: 'up', observed: 59, baseline_value: 50, sample_count: 12 },
    metric: 'cost_cents'
  });
  assert.equal(info.severity, 'info'); // |pct| >= 0.15
});

test('C1: a pct-only deviation on thin history (sample_count < 4) cannot exceed info', () => {
  // Same adverse 80% jump, but only 3 samples back the baseline - too little
  // history to trust a raw day-over-day swing, so the alarm caps at info.
  const r = scoreAnomaly({
    comparison: { comparable: true, z_score: null, pct_change: 0.8, direction: 'up', observed: 90, baseline_value: 50, sample_count: 3 },
    metric: 'cost_cents'
  });
  assert.equal(r.severity, 'info');
});

test('I1: a favorable move (clicks UP, 4-sigma) is informational at most', () => {
  // clicks is higher-is-better; a big INCREASE is good news, not an alarm.
  const r = scoreAnomaly({
    comparison: { comparable: true, z_score: 4, pct_change: 1.2, direction: 'up', observed: 220, baseline_value: 100, sample_count: 30 },
    metric: 'clicks'
  });
  assert.equal(r.severity, 'info');
});

test('I1: a favorable move (cost_cents DOWN, 4-sigma) is informational at most', () => {
  // cost_cents is lower-is-better; a big DROP is good news.
  const r = scoreAnomaly({
    comparison: { comparable: true, z_score: -4, pct_change: -0.6, direction: 'down', observed: 40, baseline_value: 100, sample_count: 30 },
    metric: 'cost_cents'
  });
  assert.equal(r.severity, 'info');
});

test('zero baseline + non-zero observed: ADVERSE flip with history is critical (on/off flip)', () => {
  // cost_cents going 0 -> 50 is adverse; with enough history this is a real alarm.
  const r = scoreAnomaly({
    comparison: {
      comparable: true, baseline_value: 0, delta: 50, pct_change: null,
      z_score: null, direction: 'up', observed: 50, sample_count: 12
    },
    metric: 'cost_cents'
  });
  assert.equal(r.severity, 'critical');
  assert.equal(r.score, 1);
});

test('zero baseline flip is capped to info on thin history (no crying wolf)', () => {
  // Adverse flip but only 2 samples back the baseline -> cannot exceed info.
  const r = scoreAnomaly({
    comparison: {
      comparable: true, baseline_value: 0, delta: 50, pct_change: null,
      z_score: null, direction: 'up', observed: 50, sample_count: 2
    },
    metric: 'cost_cents'
  });
  assert.equal(r.severity, 'info');
});

test('zero baseline flip in a FAVORABLE direction is informational (conversions 0 -> 50)', () => {
  // More conversions is good news, even from a zero baseline.
  const r = scoreAnomaly({
    comparison: {
      comparable: true, baseline_value: 0, delta: 50, pct_change: null,
      z_score: null, direction: 'up', observed: 50, sample_count: 12
    },
    metric: 'conversions'
  });
  assert.equal(r.severity, 'info');
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
