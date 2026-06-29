import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRows, aggregateFirstRow } from '../connections/ga4/_reportParser.js';
import { discoverInventory } from '../connections/ga4/inventory.js';

// --- parseRows ---

test('parseRows: empty response returns []', () => {
  assert.deepEqual(parseRows(null, ['sessions']), []);
  assert.deepEqual(parseRows({ rows: null }, ['sessions']), []);
  assert.deepEqual(parseRows({ rows: [] }, ['sessions']), []);
});

test('parseRows: parses dimension and metric values correctly', () => {
  const response = {
    dimensionHeaders: [{ name: 'sessionDefaultChannelGrouping' }],
    metricHeaders: [{ name: 'sessions' }, { name: 'keyEvents' }],
    rows: [
      { dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '1234' }, { value: '56' }] }
    ]
  };
  const rows = parseRows(response, ['sessions', 'keyEvents']);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].dimensions, { sessionDefaultChannelGrouping: 'Organic Search' });
  assert.equal(rows[0].metrics.sessions, 1234);
  assert.equal(rows[0].metrics.keyEvents, 56);
});

test('aggregateFirstRow: returns all-zero record when no rows', () => {
  const result = aggregateFirstRow({ rows: [] }, ['sessions', 'totalUsers']);
  assert.deepEqual(result, { sessions: 0, totalUsers: 0 });
});

test('aggregateFirstRow: returns first row metrics', () => {
  const response = {
    dimensionHeaders: [],
    metricHeaders: [{ name: 'sessions' }],
    rows: [{ dimensionValues: [], metricValues: [{ value: '999' }] }]
  };
  assert.equal(aggregateFirstRow(response, ['sessions']).sessions, 999);
});

// --- discoverInventory ---

function makeAdminFetch(responses) {
  return async (url) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    const body = key ? responses[key] : {};
    return { ok: true, json: async () => body, text: async () => '' };
  };
}

test('discoverInventory builds rows for account, property, data stream, and key event', async () => {
  const fetchFn = makeAdminFetch({
    accountSummaries: {
      accountSummaries: [{
        account: 'accounts/111',
        displayName: 'Acme Inc',
        propertySummaries: [{
          property: 'properties/222',
          displayName: 'Acme Website',
          propertyType: 'PROPERTY_TYPE_ORDINARY'
        }]
      }]
    },
    'properties/222/dataStreams': {
      dataStreams: [{
        name: 'properties/222/dataStreams/333',
        displayName: 'Web Stream',
        type: 'WEB_DATA_STREAM',
        webStreamData: { measurementId: 'G-ACME1234' }
      }]
    },
    'properties/222/keyEvents': {
      keyEvents: [{
        name: 'properties/222/keyEvents/444',
        eventName: 'generate_lead',
        countingMethod: 'ONCE_PER_EVENT'
      }]
    }
  });

  const rows = await discoverInventory({ token: 'fake', fetchFn });

  const byType = (t) => rows.filter((r) => r.object_type === t);
  assert.equal(byType('ga4_account').length, 1);
  assert.equal(byType('ga4_property').length, 1);
  assert.equal(byType('ga4_data_stream').length, 1);
  assert.equal(byType('ga4_key_event').length, 1);

  const prop = byType('ga4_property')[0];
  assert.equal(prop.external_id, 'properties/222');
  assert.equal(prop.display_name, 'Acme Website');

  const stream = byType('ga4_data_stream')[0];
  assert.equal(stream.metadata.measurement_id, 'G-ACME1234');

  const ke = byType('ga4_key_event')[0];
  assert.equal(ke.display_name, 'generate_lead');
  assert.equal(ke.metadata.event_name, 'generate_lead');

  assert.ok(rows.every((r) => typeof r.discovered_at === 'string'));
});

test('discoverInventory handles Admin API errors on sub-resources gracefully', async () => {
  const fetchFn = makeAdminFetch({
    accountSummaries: {
      accountSummaries: [{
        account: 'accounts/111',
        displayName: 'Acme',
        propertySummaries: [{ property: 'properties/222', displayName: 'Acme Web', propertyType: 'PROPERTY_TYPE_ORDINARY' }]
      }]
    },
  });
  const badFetch = async (url) => {
    if (url.includes('accountSummaries')) return (await fetchFn(url));
    return { ok: false, status: 500, text: async () => 'error' };
  };

  const rows = await discoverInventory({ token: 'fake', fetchFn: badFetch });
  assert.ok(rows.some((r) => r.object_type === 'ga4_account'));
  assert.ok(rows.some((r) => r.object_type === 'ga4_property'));
});
