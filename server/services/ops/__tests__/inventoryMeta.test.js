import test from 'node:test';
import assert from 'node:assert/strict';
import meta from '../connections/providers/meta.js';

function fakeGraph() {
  return async (subpath) => {
    if (/^act_99\?/.test(subpath)) return { id: 'act_99', name: 'Acme Ads', account_status: 1 };
    if (/campaigns/.test(subpath)) return { data: [{ id: 'c1', name: 'Promo', status: 'ACTIVE' }] };
    if (/adspixels/.test(subpath)) return { data: [{ id: 'px1', name: 'Site Pixel' }] };
    return {};
  };
}

test('meta connector emits ad_account/campaign/pixel rows for a non-medical client', async () => {
  let graphCalled = false;
  const rows = await meta.discoverInventory({
    clients: {
      assertNonMedical: async () => ({ skipped: false }),
      getAdAccountClient: async () => ({ ok: true, adAccountId: 'act_99', graph: (p) => { graphCalled = true; return fakeGraph()(p); } })
    }
  });

  assert.ok(graphCalled, 'graph was queried for a non-medical client');
  const acct = rows.find((r) => r.object_type === 'ad_account');
  assert.equal(acct.external_id, 'act_99');
  const campaign = rows.find((r) => r.object_type === 'campaign');
  assert.equal(campaign.external_id, 'c1');
  assert.equal(campaign.parent_external_id, 'act_99');
  const pixel = rows.find((r) => r.object_type === 'pixel');
  assert.equal(pixel.external_id, 'px1');
});

test('meta connector returns [] and issues NO graph call for a medical client (HIPAA gate)', async () => {
  let graphCalled = false;
  const rows = await meta.discoverInventory({
    clients: {
      assertNonMedical: async () => ({ skipped: true, outcome: { status: 'skipped', payload: { reason: 'hipaa_no_meta' } } }),
      getAdAccountClient: async () => { graphCalled = true; return { ok: true, adAccountId: 'act_99', graph: fakeGraph() }; }
    }
  });
  assert.deepEqual(rows, []);
  assert.equal(graphCalled, false, 'no Meta client constructed and no Graph call for a medical client');
});
