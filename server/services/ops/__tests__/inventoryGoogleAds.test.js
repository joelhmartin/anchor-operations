import test from 'node:test';
import assert from 'node:assert/strict';
import googleAds from '../connections/providers/google_ads.js';

const fakeCustomer = {
  query: async (gaql) => {
    if (/FROM campaign\b/.test(gaql)) return [{ campaign: { id: 111, name: 'Brand', status: 2 } }];
    if (/FROM ad_group\b/.test(gaql)) return [{ ad_group: { id: 222, name: 'Exact', status: 2, campaign: 'customers/9/campaigns/111' } }];
    if (/FROM conversion_action\b/.test(gaql)) return [{ conversion_action: { id: 333, name: 'Call', status: 2 } }];
    return [];
  }
};

test('google_ads connector emits campaign/ad_group/conversion_action rows', async () => {
  const rows = await googleAds.discoverInventory({ clients: { withCustomer: async () => ({ customer: fakeCustomer, customerId: '9' }) } });

  const campaign = rows.find((r) => r.object_type === 'campaign');
  assert.equal(campaign.external_id, '111');
  assert.equal(campaign.name, 'Brand');

  const adGroup = rows.find((r) => r.object_type === 'ad_group');
  assert.equal(adGroup.external_id, '222');
  assert.equal(adGroup.parent_external_id, '111', 'ad group links to its campaign id');

  const conv = rows.find((r) => r.object_type === 'conversion_action');
  assert.equal(conv.external_id, '333');
  assert.equal(conv.name, 'Call');
});

test('google_ads connector returns [] when the client is not linked/credentialed', async () => {
  const rows = await googleAds.discoverInventory({ clients: { withCustomer: async () => ({ skipped: true, reason: 'no Google Ads customer_id linked for client' }) } });
  assert.deepEqual(rows, []);
});
