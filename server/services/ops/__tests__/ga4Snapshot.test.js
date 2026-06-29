import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSnapshot } from '../connections/ga4/snapshot.js';

function makeFakeClient(overrides = {}) {
  return {
    runReport: async (req) => {
      const dims = (req.dimensions || []).map((d) => d.name);
      const mets = (req.metrics || []).map((m) => m.name);

      const dimValues = dims.map((d) => {
        const MAP = {
          sessionDefaultChannelGrouping: 'Organic Search',
          sessionSourceMedium: 'google / organic',
          landingPage: '/',
          eventName: 'generate_lead'
        };
        return { value: MAP[d] || 'unknown' };
      });
      const metValues = mets.map((m) => {
        const MAP = {
          sessions: '1234', totalUsers: '900', engagementRate: '0.62',
          keyEvents: '80', sessionKeyEventRate: '0.065', eventCount: '45'
        };
        return { value: MAP[m] || '0' };
      });

      return [{
        dimensionHeaders: dims.map((n) => ({ name: n })),
        metricHeaders: mets.map((n) => ({ name: n })),
        rows: dimValues.length === 0 && metValues.length === 0 ? [] :
          [{ dimensionValues: dimValues, metricValues: metValues }],
        ...(overrides[mets.join(',')] || {})
      }];
    }
  };
}

test('collectSnapshot throws when propertyId is missing', async () => {
  await assert.rejects(
    () => collectSnapshot({ ga4Client: makeFakeClient(), env: {} }),
    /propertyId is required/
  );
});

test('collectSnapshot returns rows with the five normalized overall metrics', async () => {
  const rows = await collectSnapshot({
    ga4Client: makeFakeClient(),
    propertyId: '123456789',
    env: {}
  });

  const overallMetrics = rows
    .filter((r) => Object.keys(r.dimensions).length === 0)
    .map((r) => r.metric_name);

  assert.ok(overallMetrics.includes('sessions'), 'sessions present');
  assert.ok(overallMetrics.includes('users'), 'users present');
  assert.ok(overallMetrics.includes('engagement_rate'), 'engagement_rate present');
  assert.ok(overallMetrics.includes('key_events'), 'key_events present');
  assert.ok(overallMetrics.includes('conversion_rate'), 'conversion_rate present');
});

test('collectSnapshot returns channel-dimension rows', async () => {
  const rows = await collectSnapshot({ ga4Client: makeFakeClient(), propertyId: '123456789', env: {} });
  const channelRows = rows.filter((r) => r.dimensions.channel != null);
  assert.ok(channelRows.length > 0, 'at least one channel row returned');
  assert.ok(channelRows.every((r) => typeof r.metric_value === 'number'), 'metric_value is a number');
});

test('collectSnapshot returns source_medium-dimension rows', async () => {
  const rows = await collectSnapshot({ ga4Client: makeFakeClient(), propertyId: '123456789', env: {} });
  const smRows = rows.filter((r) => r.dimensions.source_medium != null);
  assert.ok(smRows.length > 0);
  assert.equal(smRows[0].dimensions.source_medium, 'google / organic');
});

test('collectSnapshot returns landing_page-dimension rows', async () => {
  const rows = await collectSnapshot({ ga4Client: makeFakeClient(), propertyId: '123456789', env: {} });
  const lpRows = rows.filter((r) => r.dimensions.landing_page != null);
  assert.ok(lpRows.length > 0);
});

test('collectSnapshot returns event_count rows for event dimension', async () => {
  const rows = await collectSnapshot({ ga4Client: makeFakeClient(), propertyId: '123456789', env: {} });
  const eventRows = rows.filter((r) => r.dimensions.event_name != null && r.metric_name === 'event_count');
  assert.ok(eventRows.length > 0);
  assert.equal(eventRows[0].dimensions.event_name, 'generate_lead');
});

test('collectSnapshot all rows have required shape', async () => {
  const rows = await collectSnapshot({ ga4Client: makeFakeClient(), propertyId: '123456789', env: {} });
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok('metric_name' in row, 'metric_name');
    assert.ok('metric_value' in row, 'metric_value');
    assert.ok('dimensions' in row, 'dimensions');
    assert.ok('metadata' in row, 'metadata');
    assert.equal(typeof row.metric_value, 'number');
  }
});
