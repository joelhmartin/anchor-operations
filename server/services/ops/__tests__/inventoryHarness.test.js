import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryRow } from '../connections/inventoryRow.js';
import { discoverAndPersist, runAllInventoryDiscovery } from '../connections/runInventoryDiscovery.js';
import { INVENTORY_CONNECTORS } from '../connections/index.js';

test('inventoryRow applies defaults and stringifies ids', () => {
  const r = inventoryRow({ object_type: 'campaign', external_id: 12345, name: 'Brand' });
  assert.equal(r.external_id, '12345');
  assert.equal(r.name, 'Brand');
  assert.equal(r.status, null);
  assert.equal(r.parent_external_id, null);
  assert.equal(r.url, null);
  assert.deepEqual(r.metadata, {});
});

test('inventoryRow throws when object_type or external_id is missing', () => {
  assert.throws(() => inventoryRow({ external_id: 'x' }), /object_type required/);
  assert.throws(() => inventoryRow({ object_type: 'x' }), /external_id required/);
});

test('discoverAndPersist sanitizes rows, builds scope, and persists', async () => {
  const captured = {};
  const fakeConnector = {
    serviceCategory: 'call_tracking',
    provider: 'ctm',
    discoverInventory: async () => ([
      // a name carrying an email must be redacted before persistence
      inventoryRow({ object_type: 'form_reactor', external_id: 'f1', name: 'Contact bob@acme.com', metadata: { note: 'reply to bob@acme.com' } })
    ])
  };
  const out = await discoverAndPersist(fakeConnector, { connectionId: 'conn-1', clientUserId: 42 }, {
    upsert: async (scope, rows) => { captured.scope = scope; captured.rows = rows; return { written: rows.length }; }
  });

  assert.equal(out.provider, 'ctm');
  assert.equal(out.discovered, 1);
  assert.equal(out.written, 1);
  assert.deepEqual(captured.scope, { connectionId: 'conn-1', clientUserId: 42, serviceCategory: 'call_tracking', provider: 'ctm' });
  // sanitization fired on name AND metadata
  assert.ok(!JSON.stringify(captured.rows).includes('bob@acme.com'), 'email redacted everywhere');
  assert.ok(captured.rows[0].name.includes('[REDACTED]'));
});

test('INVENTORY_CONNECTORS exports 7 connectors with discoverInventory', () => {
  assert.equal(INVENTORY_CONNECTORS.length, 7);
  for (const c of INVENTORY_CONNECTORS) {
    assert.ok(typeof c.id === 'string' && c.id, `${c.id ?? '?'} has id`);
    assert.ok(typeof c.discoverInventory === 'function', `${c.id} has discoverInventory`);
  }
});

test('runAllInventoryDiscovery calls each connector and returns results array', async () => {
  let calls = 0;
  const fakeUpsert = async (_scope, rows) => { calls++; return { written: rows.length }; };
  // Provide mocks for every client dependency so no real I/O or DB queries happen.
  const ctx = {
    // ga4: token skips getAdminAccessToken; fetchFn returns empty account list
    token: 'test-ga4-token',
    fetchFn: async () => ({ ok: true, json: async () => ({ accountSummaries: [] }), text: async () => '' }),
    clients: {
      resolveUrl: async () => null,                           // public_http → no url → []
      withCustomer: async () => ({ skipped: true }),          // google_ads → skipped → []
      kinsta: { listAllSites: async () => [] },               // kinsta → no sites → []
      assertNonMedical: async () => ({ skipped: true }),      // meta → skipped → []
    }
    // wordpress: no ctx.environmentId → returns [] without hitting clients
    // ctm: no ctx.clientUserId → returns [] without hitting clients
  };
  const results = await runAllInventoryDiscovery(ctx, { upsert: fakeUpsert });
  assert.equal(results.length, 7, 'one result per connector');
  assert.equal(calls, 7, 'upsert called for each connector');
});
