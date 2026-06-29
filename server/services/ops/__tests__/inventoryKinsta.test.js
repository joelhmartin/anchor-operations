import test from 'node:test';
import assert from 'node:assert/strict';
import kinsta from '../connections/providers/kinsta.js';

const fakeKinsta = {
  listAllSites: async () => ([
    {
      id: 'site-1',
      display_name: 'Acme',
      company: 'co1',
      status: 'active',
      primaryDomain: { name: 'acme.com' },
      environments: [
        { id: 'env-1', name: 'Live', domains: [{ name: 'acme.com', type: 'live' }, { name: 'www.acme.com', type: 'alias' }] }
      ]
    }
  ]),
  pickKinstaEnvironmentSummary: (env) => ({
    environment_name: env.name,
    is_live: env.name === 'Live',
    primary_domain: 'acme.com',
    ssh_host: '1.2.3.4'
  })
};

test('kinsta connector emits site → environment → domain rows', async () => {
  const rows = await kinsta.discoverInventory({ clients: { kinsta: fakeKinsta } });

  const site = rows.find((r) => r.object_type === 'site');
  assert.equal(site.external_id, 'site-1');
  assert.equal(site.name, 'Acme');
  assert.equal(site.url, 'https://acme.com');

  const env = rows.find((r) => r.object_type === 'environment');
  assert.equal(env.external_id, 'env-1');
  assert.equal(env.parent_external_id, 'site-1');
  assert.equal(env.status, 'live');

  const domains = rows.filter((r) => r.object_type === 'domain');
  assert.equal(domains.length, 2);
  assert.ok(domains.every((d) => d.parent_external_id === 'env-1'));
  assert.ok(domains.some((d) => d.external_id === 'www.acme.com'));
});

test('kinsta connector honors per-connection site scope', async () => {
  const rows = await kinsta.discoverInventory({
    clients: { kinsta: fakeKinsta },
    connection: { metadata: { kinstaSiteIds: ['other-site'] } }
  });
  assert.equal(rows.length, 0, 'site-1 is filtered out by the scope');
});
