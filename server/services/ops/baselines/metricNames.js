export const NORMALIZED_METRICS = [
  'cost_cents',
  'impressions',
  'clicks',
  'conversions',
  'conversion_value_cents',
  'sessions',
  'users',
  'leads',
  'calls',
  'forms',
  'ctr',
  'cvr',
  'cpa_cents'
];

export const DERIVED_METRICS = ['ctr', 'cvr', 'cpa_cents'];

const NORMALIZED_SET = new Set(NORMALIZED_METRICS);

export function isNormalizedMetric(name) {
  return NORMALIZED_SET.has(name);
}

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function normalizeMetrics(raw = {}) {
  const metrics = {};
  const extras = {};
  for (const [key, value] of Object.entries(raw)) {
    if (NORMALIZED_SET.has(key)) {
      const n = toFiniteNumber(value);
      if (n !== null) metrics[key] = n;
    } else {
      extras[key] = value;
    }
  }
  return { metrics, extras };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

export function deriveMetrics(metrics = {}) {
  const out = { ...metrics };
  for (const key of DERIVED_METRICS) delete out[key];
  const { impressions, clicks, conversions, cost_cents } = metrics;

  if (Number.isFinite(impressions) && impressions > 0 && Number.isFinite(clicks)) {
    out.ctr = round6(clicks / impressions);
  }
  if (Number.isFinite(clicks) && clicks > 0 && Number.isFinite(conversions)) {
    out.cvr = round6(conversions / clicks);
  }
  if (Number.isFinite(conversions) && conversions > 0 && Number.isFinite(cost_cents)) {
    out.cpa_cents = Math.round(cost_cents / conversions);
  }
  return out;
}
