import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSnapshotRows,
  collectAndPersistSnapshots,
  recomputeBaselinesForClient
} from '../baselines/snapshotCollection.js';

const CLIENT = '11111111-1111-1111-1111-111111111111';

test('normalizeSnapshotRows passes canonical (GSC-shaped) rows through', () => {
  const rows = [
    {
      client_user_id: CLIENT,
      snapshot_date: '2026-06-30',
      service: 'search_console',
      scope_type: 'site',
      scope_id: 'sc-domain:example.com',
      metrics_json: { clicks: 100, impressions: 2000, ctr: 0.05, position: 7.2 },
      source_run_id: null
    }
  ];
  const out = normalizeSnapshotRows(rows, {
    clientUserId: CLIENT, snapshotDate: '2026-06-30', service: 'search_console'
  });
  assert.equal(out.length, 1);
  assert.equal(out[0].scope_id, 'sc-domain:example.com');
  assert.equal(out[0].metrics_json.clicks, 100);
});

test('normalizeSnapshotRows folds flat (GA4-shaped) metric rows into metrics_json by scope', () => {
  const rows = [
    { metric_name: 'sessions', metric_value: 500, dimensions: {} },
    { metric_name: 'users', metric_value: 320, dimensions: {} },
    // a dimensioned row becomes its own scope
    { metric_name: 'sessions', metric_value: 90, dimensions: { channel: 'Organic Search' } }
  ];
  const out = normalizeSnapshotRows(rows, {
    clientUserId: CLIENT, snapshotDate: '2026-06-30', service: 'ga4',
    scopeType: 'property', defaultScopeId: 'prop-123'
  });
  // one aggregate scope (prop-123) + one channel scope
  assert.equal(out.length, 2);
  const agg = out.find((r) => r.scope_id === 'prop-123');
  assert.ok(agg, 'aggregate scope present');
  assert.equal(agg.metrics_json.sessions, 500);
  assert.equal(agg.metrics_json.users, 320);
  assert.equal(agg.service, 'ga4');
  assert.equal(agg.scope_type, 'property');
  const channel = out.find((r) => r.scope_id.includes('channel='));
  assert.equal(channel.metrics_json.sessions, 90);
});

test('normalizeSnapshotRows drops non-finite metric values', () => {
  const rows = [
    { metric_name: 'sessions', metric_value: 'oops', dimensions: {} },
    { metric_name: 'users', metric_value: 10, dimensions: {} }
  ];
  const out = normalizeSnapshotRows(rows, {
    clientUserId: CLIENT, snapshotDate: '2026-06-30', service: 'ga4', defaultScopeId: 'p1'
  });
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].metrics_json, { users: 10 });
});

test('collectAndPersistSnapshots calls connector + persists every normalized row', async () => {
  const persisted = [];
  const connector = {
    id: 'search_console',
    serviceCategory: 'organic_search',
    async collectSnapshot({ clientUserId }) {
      return [{
        client_user_id: clientUserId,
        snapshot_date: '2026-06-30',
        service: 'search_console',
        scope_type: 'site',
        scope_id: 'sc-domain:example.com',
        metrics_json: { clicks: 100, impressions: 2000 }
      }];
    }
  };
  const res = await collectAndPersistSnapshots({
    clientUserId: CLIENT, connector, snapshotDate: '2026-06-30',
    upsertSnapshot: async (row) => { persisted.push(row); return row; }
  });
  assert.equal(res.collected, 1);
  assert.equal(res.persisted, 1);
  assert.equal(persisted[0].metrics_json.clicks, 100);
});

test('recomputeBaselinesForClient computes a baseline per (service,scope,metric) series', async () => {
  const seriesKeys = [
    { service: 'search_console', scope_type: 'site', scope_id: 's1', metric: 'clicks' },
    { service: 'search_console', scope_type: 'site', scope_id: 's1', metric: 'impressions' }
  ];
  const computed = [];
  const res = await recomputeBaselinesForClient({
    clientUserId: CLIENT,
    asOf: '2026-06-30',
    listSeriesKeys: async () => seriesKeys,
    computeBaselines: async (args) => {
      computed.push(args);
      return { metric: args.metric, computed: 6, persisted: 3 };
    }
  });
  assert.equal(res.series, 2);
  assert.equal(res.persisted, 6); // 3 + 3
  assert.equal(computed[0].metric, 'clicks');
  assert.equal(computed[0].scopeId, 's1');
  assert.equal(computed[1].metric, 'impressions');
});
