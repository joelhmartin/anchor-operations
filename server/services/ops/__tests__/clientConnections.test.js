import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getClientConnections,
  verifyClientConnection,
  PROVIDERS,
  PROVIDER_CATEGORY
} from '../connections/clientConnections.js';

const CLIENT = '00000000-0000-0000-0000-000000000001';

// A fake queryFn that dispatches on SQL text so getClientConnections/verify can
// run fully offline (no DB, no network).
function makeQueryFn({ profile = {}, meta = [], kinstaCount = 0, conns = [], capture } = {}) {
  return async (sql, params) => {
    if (/FROM client_profiles/.test(sql)) return { rows: profile ? [profile] : [] };
    if (/FROM meta_page_links/.test(sql)) return { rows: meta };
    if (/FROM kinsta_site_clients\s/.test(sql) && /COUNT/.test(sql)) return { rows: [{ n: kinstaCount }] };
    if (/FROM kinsta_site_clients ksc/.test(sql)) return { rows: meta._kinstaRows || [] };
    if (/FROM ops_service_connections/.test(sql)) return { rows: conns };
    if (/INSERT INTO ops_service_connections/.test(sql)) {
      if (capture) capture.push({ sql, params });
      // mimic RETURNING row (VALUES $1..$5 = client, category, provider, status, detail)
      return {
        rows: [
          {
            service_category: params[1],
            provider: params[2],
            status: params[3],
            detail: params[4],
            last_verified_at: new Date('2026-01-01T00:00:00Z')
          }
        ]
      };
    }
    return { rows: [] };
  };
}

test('PROVIDERS covers the six platforms', () => {
  assert.deepEqual(new Set(PROVIDERS), new Set(['google_ads', 'ga4', 'meta', 'website', 'ctm', 'kinsta']));
  assert.equal(PROVIDER_CATEGORY.meta, 'paid_ads');
});

test('getClientConnections derives status from columns + join tables', async () => {
  const queryFn = makeQueryFn({
    profile: {
      user_id: CLIENT,
      google_ads_account_id: '123-456-7890',
      google_ads_access_provided: true,
      ga4_access_status: '',
      ga4_access_provided: false,
      meta_access_status: '',
      meta_access_provided: false,
      website_access_status: 'provided',
      website_access_provided: false,
      ctm_account_number: '580197',
      ctm_api_key: null,
      call_tracking_main_number: null
    },
    meta: [{ id: 'link-1', fb_page_id: '1129176073610199' }],
    kinstaCount: 0,
    conns: []
  });

  const out = await getClientConnections(CLIENT, queryFn);
  const by = Object.fromEntries(out.map((c) => [c.provider, c]));

  assert.equal(by.google_ads.status, 'connected');
  assert.equal(by.google_ads.accountRef, '123-456-7890');
  assert.equal(by.meta.status, 'connected'); // page link present
  assert.equal(by.meta.accountRef, '1129176073610199');
  assert.equal(by.ctm.status, 'connected');
  assert.equal(by.website.status, 'partial'); // status text but provided=false
  assert.equal(by.ga4.status, 'not_provided');
  assert.equal(by.kinsta.status, 'not_provided');
  assert.equal(out.length, 6);
});

test('getClientConnections overlays a persisted verify result', async () => {
  const queryFn = makeQueryFn({
    profile: { user_id: CLIENT },
    meta: [],
    kinstaCount: 0,
    conns: [
      {
        service_category: 'paid_ads',
        provider: 'meta',
        status: 'verified',
        detail: 'Page token resolved',
        last_verified_at: new Date('2026-02-02T00:00:00Z')
      }
    ]
  });
  const out = await getClientConnections(CLIENT, queryFn);
  const meta = out.find((c) => c.provider === 'meta');
  assert.equal(meta.status, 'connected'); // verified → connected
  assert.equal(meta.detail, 'Page token resolved');
  assert.ok(meta.lastVerifiedAt);
});

test('verifyClientConnection(meta) resolves a page token read-only and persists', async () => {
  const capture = [];
  const queryFn = makeQueryFn({ meta: [{ id: 'link-1', fb_page_id: '999' }], capture });
  let postedCalled = false;
  const result = await verifyClientConnection(
    { clientUserId: CLIENT, provider: 'meta' },
    {
      query: queryFn,
      // read-only token resolver; if anyone tried to post we'd flip postedCalled
      getPageToken: async (id) => {
        assert.equal(id, 'link-1');
        return 'EA>token<';
      }
    }
  );
  assert.equal(postedCalled, false);
  assert.equal(result.status, 'connected');
  assert.equal(result.rawStatus, 'verified');
  assert.equal(result.service_category, 'paid_ads');
  assert.equal(capture.length, 1);
  assert.equal(capture[0].params[2], 'meta'); // provider persisted
  assert.equal(capture[0].params[3], 'verified'); // status persisted
});

test('verifyClientConnection(meta) with no link → not_provided (missing)', async () => {
  const queryFn = makeQueryFn({ meta: [] });
  const result = await verifyClientConnection(
    { clientUserId: CLIENT, provider: 'meta' },
    { query: queryFn, getPageToken: async () => 'should-not-be-called' }
  );
  assert.equal(result.rawStatus, 'missing');
  assert.equal(result.status, 'not_provided');
});

test('verifyClientConnection(kinsta) verified when linked site is present', async () => {
  const queryFn = async (sql, params) => {
    if (/FROM kinsta_site_clients ksc/.test(sql)) {
      return { rows: [{ kinsta_site_id: 'abc', site_name: 'Demo' }] };
    }
    if (/INSERT INTO ops_service_connections/.test(sql)) {
      return {
        rows: [{ service_category: params[1], provider: params[2], status: params[3], detail: params[4], last_verified_at: new Date() }]
      };
    }
    return { rows: [] };
  };
  const result = await verifyClientConnection(
    { clientUserId: CLIENT, provider: 'kinsta' },
    { query: queryFn, listAllSites: async () => [{ id: 'abc', name: 'Demo' }, { id: 'zzz' }] }
  );
  assert.equal(result.rawStatus, 'verified');
  assert.equal(result.status, 'connected');
});

test('verifyClientConnection rejects an unknown provider', async () => {
  await assert.rejects(() => verifyClientConnection({ clientUserId: CLIENT, provider: 'bogus' }, {}));
});
