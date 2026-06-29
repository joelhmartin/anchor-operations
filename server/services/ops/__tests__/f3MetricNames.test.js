import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NORMALIZED_METRICS,
  DERIVED_METRICS,
  isNormalizedMetric,
  normalizeMetrics,
  deriveMetrics
} from '../baselines/metricNames.js';

test('vocabulary is the exact closed set', () => {
  assert.deepEqual(NORMALIZED_METRICS, [
    'cost_cents', 'impressions', 'clicks', 'conversions', 'conversion_value_cents',
    'sessions', 'users', 'leads', 'calls', 'forms', 'ctr', 'cvr', 'cpa_cents'
  ]);
  assert.deepEqual(DERIVED_METRICS, ['ctr', 'cvr', 'cpa_cents']);
});

test('isNormalizedMetric recognizes vocab and rejects extras', () => {
  assert.equal(isNormalizedMetric('clicks'), true);
  assert.equal(isNormalizedMetric('cpa_cents'), true);
  assert.equal(isNormalizedMetric('search_impression_share'), false);
  assert.equal(isNormalizedMetric(''), false);
});

test('normalizeMetrics splits normalized numbers from provider extras', () => {
  const { metrics, extras } = normalizeMetrics({
    cost_cents: 12345,
    clicks: 200,
    impressions: 10000,
    search_impression_share: 0.42,
    campaign_name: 'Brand'
  });
  assert.deepEqual(metrics, { cost_cents: 12345, clicks: 200, impressions: 10000 });
  assert.deepEqual(extras, { search_impression_share: 0.42, campaign_name: 'Brand' });
});

test('normalizeMetrics drops non-numeric values for normalized keys (no NaN)', () => {
  const { metrics } = normalizeMetrics({ clicks: 'oops', impressions: 5, conversions: null });
  assert.deepEqual(metrics, { impressions: 5 });
});

test('normalizeMetrics coerces numeric strings for normalized keys', () => {
  const { metrics } = normalizeMetrics({ cost_cents: '500', clicks: '10' });
  assert.deepEqual(metrics, { cost_cents: 500, clicks: 10 });
});

test('deriveMetrics computes ctr/cvr/cpa_cents from base metrics', () => {
  const out = deriveMetrics({ impressions: 1000, clicks: 50, conversions: 5, cost_cents: 10000 });
  assert.equal(out.ctr, 0.05);          // 50 / 1000
  assert.equal(out.cvr, 0.1);           // 5 / 50
  assert.equal(out.cpa_cents, 2000);    // 10000 / 5, rounded to int cents
});

test('deriveMetrics never divides by zero and never invents missing bases', () => {
  const out = deriveMetrics({ impressions: 0, clicks: 0, conversions: 0, cost_cents: 100 });
  assert.equal('ctr' in out, false);
  assert.equal('cvr' in out, false);
  assert.equal('cpa_cents' in out, false);
  const out2 = deriveMetrics({ sessions: 10 }); // no ads bases at all
  assert.deepEqual(out2, { sessions: 10 });
});
