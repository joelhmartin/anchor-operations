import test from 'node:test';
import assert from 'node:assert/strict';
import { compareMetric } from '../baselines/compareMetric.js';

test('compareMetric computes delta, pct, and z-score', () => {
  const r = compareMetric(100, { baseline_value: 50, stddev: 10, sample_count: 5 });
  assert.equal(r.comparable, true);
  assert.equal(r.delta, 50);
  assert.equal(r.pct_change, 1);   // (100-50)/50
  assert.equal(r.z_score, 5);      // (100-50)/10
  assert.equal(r.direction, 'up');
});

test('compareMetric down direction + negative values', () => {
  const r = compareMetric(20, { baseline_value: 50, stddev: 10, sample_count: 5 });
  assert.equal(r.delta, -30);
  assert.equal(r.pct_change, -0.6);
  assert.equal(r.z_score, -3);
  assert.equal(r.direction, 'down');
});

test('compareMetric: null baseline → not comparable', () => {
  const r = compareMetric(100, { baseline_value: null, stddev: null, sample_count: 0 });
  assert.equal(r.comparable, false);
});

test('compareMetric: zero baseline → pct_change null (no divide by zero)', () => {
  const r = compareMetric(5, { baseline_value: 0, stddev: null, sample_count: 4 });
  assert.equal(r.comparable, true);
  assert.equal(r.pct_change, null);
  assert.equal(r.z_score, null);
  assert.equal(r.direction, 'up');
});

test('compareMetric: no stddev → z_score null but still comparable', () => {
  const r = compareMetric(60, { baseline_value: 50, stddev: null, sample_count: 3 });
  assert.equal(r.comparable, true);
  assert.equal(r.z_score, null);
  assert.equal(r.pct_change, 0.2);
});

test('compareMetric: equal value → flat', () => {
  const r = compareMetric(50, { baseline_value: 50, stddev: 10, sample_count: 5 });
  assert.equal(r.direction, 'flat');
  assert.equal(r.delta, 0);
});
