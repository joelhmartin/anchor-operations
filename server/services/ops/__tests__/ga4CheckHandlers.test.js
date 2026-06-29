import test from 'node:test';
import assert from 'node:assert/strict';
import { GA4_CHECKS } from '../connections/ga4/checks/index.js';

function getCheck(id) {
  const c = GA4_CHECKS.find((c) => c.id === id);
  if (!c) throw new Error(`Check not found: ${id}`);
  return c;
}

function makeClient(overrideRows = []) {
  return {
    runReport: async () => [{
      dimensionHeaders: [],
      metricHeaders: [],
      rows: overrideRows,
      ...({})
    }]
  };
}

function makeClientByMetrics(metricMap) {
  return {
    runReport: async (req) => {
      const key = (req.metrics || []).map((m) => m.name).join(',');
      const dims = (req.dimensions || []).map((d) => d.name);
      const rows = metricMap[key] || metricMap['default'] || [];
      return [{
        dimensionHeaders: dims.map((n) => ({ name: n })),
        metricHeaders: (req.metrics || []).map((m) => ({ name: m.name })),
        rows
      }];
    }
  };
}

const BASE_CTX = { clientUserId: 'test-client', ga4PropertyId: '123456789' };

// --- ga4.connection_health ---

test('ga4.connection_health: pass when runReport succeeds', async () => {
  const check = getCheck('ga4.connection_health');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]) };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'pass');
  assert.ok(result.payload.property_id === '123456789');
});

test('ga4.connection_health: fail when runReport throws', async () => {
  const check = getCheck('ga4.connection_health');
  const ctx = { ...BASE_CTX, ga4Client: { runReport: async () => { throw new Error('permission denied'); } } };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.ok(/permission denied/.test(result.payload.error));
});

test('ga4.connection_health: skipped when no propertyId', async () => {
  const check = getCheck('ga4.connection_health');
  const result = await check.handler({ clientUserId: 'test-client' });
  assert.equal(result.status, 'skipped');
});

// --- ga4.traffic_drop ---

test('ga4.traffic_drop: fail when sessions dropped > 20%', async () => {
  const check = getCheck('ga4.traffic_drop');
  const client = makeClientByMetrics({
    'sessions,totalUsers,engagementRate,keyEvents,sessionKeyEventRate': [{
      dimensionValues: [], metricValues: [{ value: '800' }, { value: '0' }, { value: '0' }, { value: '0' }, { value: '0' }]
    }],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, ga4Baseline: { sessions: 1000 } };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(result.payload.drop_pct, 20);
});

test('ga4.traffic_drop: skipped when no baseline', async () => {
  const check = getCheck('ga4.traffic_drop');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]), ga4Baseline: {} };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'skipped');
});

// --- ga4.paid_search_sessions_drop ---

test('ga4.paid_search_sessions_drop: fail when paid sessions dropped > 20%', async () => {
  const check = getCheck('ga4.paid_search_sessions_drop');
  const client = makeClientByMetrics({
    'sessions,keyEvents': [{
      dimensionValues: [{ value: 'Paid Search' }],
      metricValues: [{ value: '400' }, { value: '20' }]
    }],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, ga4Baseline: { paid_search_sessions: 600 } };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
});

// --- ga4.organic_sessions_drop ---

test('ga4.organic_sessions_drop: pass when organic sessions within threshold', async () => {
  const check = getCheck('ga4.organic_sessions_drop');
  const client = makeClientByMetrics({
    'sessions,keyEvents': [{
      dimensionValues: [{ value: 'Organic Search' }],
      metricValues: [{ value: '900' }, { value: '40' }]
    }],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, ga4Baseline: { organic_sessions: 1000 } };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'pass');
});

// --- ga4.key_event_drop ---

test('ga4.key_event_drop: fail when key events dropped > 20%', async () => {
  const check = getCheck('ga4.key_event_drop');
  const client = makeClientByMetrics({
    'sessions,totalUsers,engagementRate,keyEvents,sessionKeyEventRate': [{
      dimensionValues: [], metricValues: [{ value: '1000' }, { value: '0' }, { value: '0' }, { value: '40' }, { value: '0' }]
    }],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, ga4Baseline: { key_events: 100 } };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(result.payload.drop_pct, 60);
});

// --- ga4.key_event_missing ---

test('ga4.key_event_missing: fail when a configured key event has 0 count', async () => {
  const check = getCheck('ga4.key_event_missing');
  const client = makeClientByMetrics({
    'eventCount': [
      { dimensionValues: [{ value: 'purchase' }], metricValues: [{ value: '10' }] }
    ],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, ga4ExpectedKeyEvents: ['generate_lead', 'purchase'] };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.payload.missing_key_events, ['generate_lead']);
});

test('ga4.key_event_missing: skipped when no expectedKeyEvents configured', async () => {
  const check = getCheck('ga4.key_event_missing');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]) };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'skipped');
});

// --- ga4.landing_page_conversion_drop ---

test('ga4.landing_page_conversion_drop: fail when top landing page conversion dropped', async () => {
  const check = getCheck('ga4.landing_page_conversion_drop');
  const client = makeClientByMetrics({
    'sessions,sessionKeyEventRate': [{
      dimensionValues: [{ value: '/' }],
      metricValues: [{ value: '1000' }, { value: '0.02' }]
    }],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, ga4Baseline: { landing_page_conversion_rate: 0.05 } };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
});

// --- ga4.ads_clicks_vs_sessions_gap ---

test('ga4.ads_clicks_vs_sessions_gap: skipped when ctx.adsClicks is absent', async () => {
  const check = getCheck('ga4.ads_clicks_vs_sessions_gap');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]) };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'skipped');
  assert.ok(/adsClicks/.test(result.payload.reason));
});

test('ga4.ads_clicks_vs_sessions_gap: fail when gap >= 30%', async () => {
  const check = getCheck('ga4.ads_clicks_vs_sessions_gap');
  const client = makeClientByMetrics({
    'sessions,keyEvents': [
      { dimensionValues: [{ value: 'Paid Search' }], metricValues: [{ value: '500' }, { value: '20' }] }
    ],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, adsClicks: 1000 };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(result.payload.gap_pct, 50);
});

// --- ga4.form_event_not_firing ---

test('ga4.form_event_not_firing: fail when all form events are zero', async () => {
  const check = getCheck('ga4.form_event_not_firing');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]) };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warning');
});

test('ga4.form_event_not_firing: pass when generate_lead is firing', async () => {
  const check = getCheck('ga4.form_event_not_firing');
  const client = makeClientByMetrics({
    'eventCount': [
      { dimensionValues: [{ value: 'generate_lead' }], metricValues: [{ value: '8' }] }
    ],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'pass');
});

// --- ga4.source_medium_anomaly ---

test('ga4.source_medium_anomaly: skipped when no baseline', async () => {
  const check = getCheck('ga4.source_medium_anomaly');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]), ga4Baseline: {} };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'skipped');
});

test('ga4.source_medium_anomaly: fail when a source/medium drops > 30%', async () => {
  const check = getCheck('ga4.source_medium_anomaly');
  const client = makeClientByMetrics({
    'sessions': [
      { dimensionValues: [{ value: 'google / cpc' }], metricValues: [{ value: '200' }] }
    ],
    default: []
  });
  const ctx = {
    ...BASE_CTX,
    ga4Client: client,
    ga4Baseline: { 'source_medium:google / cpc': 1000 }
  };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(result.payload.anomalies[0].source_medium, 'google / cpc');
});

// --- GA4_CHECKS structural contract ---

test('GA4_CHECKS has exactly 10 entries with required shape', () => {
  assert.equal(GA4_CHECKS.length, 10);
  const VALID_TIERS = new Set(['daily_essential', 'weekly_deep']);
  for (const check of GA4_CHECKS) {
    assert.ok(typeof check.id === 'string' && check.id.startsWith('ga4.'), `id format: ${check.id}`);
    assert.ok(VALID_TIERS.has(check.tier), `tier: ${check.tier}`);
    assert.ok(Array.isArray(check.requiredCapabilities), `requiredCapabilities array`);
    assert.ok(typeof check.handler === 'function', `handler function`);
  }
});

test('ga4.connection_health has tier daily_essential', () => {
  const c = getCheck('ga4.connection_health');
  assert.equal(c.tier, 'daily_essential');
});
