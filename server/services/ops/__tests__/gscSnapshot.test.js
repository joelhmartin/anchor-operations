import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSnapshot } from '../connections/gsc/snapshot.js';

const FAKE_AGGREGATE = { rows: [{ clicks: 1200, impressions: 45000, ctr: 0.0267, position: 18.3 }] };
const FAKE_BY_PAGE = {
  rows: [
    { keys: ['/blog/seo-tips'], clicks: 340, impressions: 12000, ctr: 0.028, position: 8.5 },
    { keys: ['/services/'], clicks: 200, impressions: 8000, ctr: 0.025, position: 12.1 }
  ]
};
const FAKE_BY_QUERY = {
  rows: [
    { keys: ['seo agency'], clicks: 180, impressions: 5000, ctr: 0.036, position: 5.2 }
  ]
};
const FAKE_BY_DEVICE = {
  rows: [
    { keys: ['MOBILE'], clicks: 700, impressions: 26000, ctr: 0.027, position: 19.1 },
    { keys: ['DESKTOP'], clicks: 450, impressions: 17000, ctr: 0.026, position: 16.8 }
  ]
};

function makeQueryAnalytics() {
  return async (_token, _siteUrl, body) => {
    const dims = body.dimensions || [];
    if (dims.length === 0) return FAKE_AGGREGATE;
    if (dims[0] === 'page')   return FAKE_BY_PAGE;
    if (dims[0] === 'query')  return FAKE_BY_QUERY;
    if (dims[0] === 'device') return FAKE_BY_DEVICE;
    return { rows: [] };
  };
}

test('collectSnapshot returns rows for all four scope types', async () => {
  const snaps = await collectSnapshot({
    clientUserId: 'cuid-1',
    siteUrl: 'sc-domain:example.com',
    token: 'fake-tok',
    date: '2026-06-28',
    _queryAnalytics: makeQueryAnalytics()
  });

  const types = [...new Set(snaps.map((s) => s.scope_type))].sort();
  assert.deepEqual(types, ['device', 'page', 'query', 'site']);

  const agg = snaps.find((s) => s.scope_type === 'site');
  assert.ok(agg, 'aggregate row present');
  assert.equal(agg.client_user_id, 'cuid-1');
  assert.equal(agg.service, 'search_console');
  assert.equal(agg.scope_id, 'sc-domain:example.com');
  assert.equal(agg.snapshot_date, '2026-06-28');
  assert.equal(agg.source_run_id, null);
  assert.deepEqual(agg.metrics_json, { clicks: 1200, impressions: 45000, ctr: 0.0267, position: 18.3 });

  const pages = snaps.filter((s) => s.scope_type === 'page');
  assert.equal(pages.length, 2);
  assert.equal(pages[0].scope_id, '/blog/seo-tips');
  assert.deepEqual(pages[0].metrics_json, { clicks: 340, impressions: 12000, ctr: 0.028, position: 8.5 });

  const queries = snaps.filter((s) => s.scope_type === 'query');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].scope_id, 'seo agency');

  const devices = snaps.filter((s) => s.scope_type === 'device');
  assert.equal(devices.length, 2);
  const mobile = devices.find((s) => s.scope_id === 'MOBILE');
  assert.equal(mobile.metrics_json.clicks, 700);
});

test('collectSnapshot returns empty array when queryAnalytics throws', async () => {
  const snaps = await collectSnapshot({
    clientUserId: 'cuid-1',
    siteUrl: 'sc-domain:example.com',
    token: 'fake-tok',
    date: '2026-06-28',
    _queryAnalytics: async () => { throw new Error('GSC 429'); }
  });
  assert.equal(snaps.length, 0);
});

test('collectSnapshot passes correct date window to queryAnalytics', async () => {
  const calls = [];
  const _queryAnalytics = async (_tok, _site, body) => {
    calls.push({ startDate: body.startDate, endDate: body.endDate, dims: body.dimensions });
    return { rows: [] };
  };
  await collectSnapshot({ clientUserId: 'c', siteUrl: 'sc-domain:x.com', token: 't', date: '2026-06-28', _queryAnalytics });
  // All calls should use the same 28-day window
  for (const c of calls) {
    assert.equal(c.endDate, '2026-06-28');
    assert.equal(c.startDate, '2026-06-01');  // 28 days back from 2026-06-28
  }
});
