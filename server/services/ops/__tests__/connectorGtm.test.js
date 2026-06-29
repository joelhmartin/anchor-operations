import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyConnection, listCapabilities, discoverInventory } from '../connections/gtm/index.js';

const fakeToken = async () => 'fake-access-token-for-tests';

function fakeFetch(responses) {
  // responses: array of { url_match?: string, json: object, ok?: boolean }
  return async (url, _opts) => {
    const match = responses.find((r) => !r.url_match || url.includes(r.url_match)) || responses[0];
    return {
      ok: match.ok !== false,
      json: async () => match.json,
      text: async () => JSON.stringify(match.json)
    };
  };
}

test('verifyConnection: valid credentials → verified', async () => {
  const fetch = fakeFetch([{ json: { account: [{ accountId: '123', name: 'Anchor GTM' }] } }]);
  const r = await verifyConnection({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.equal(r.status, 'verified');
  assert.ok(r.detail.includes('1 account'), `detail: ${r.detail}`);
  assert.equal(r.capabilities['container.list'], true);
});

test('verifyConnection: missing key → missing (no token call, no fetch call)', async () => {
  let tokenCalled = false;
  let fetchCalled = false;
  const r = await verifyConnection({
    env: {},
    fetch: async () => { fetchCalled = true; return {}; },
    getAccessToken: async () => { tokenCalled = true; return 'tok'; }
  });
  assert.equal(r.status, 'missing');
  assert.equal(tokenCalled, false);
  assert.equal(fetchCalled, false);
});

test('verifyConnection: blank key → missing', async () => {
  const r = await verifyConnection({ env: { GTM_SERVICE_ACCOUNT_KEY: '   ' }, getAccessToken: fakeToken });
  assert.equal(r.status, 'missing');
});

test('verifyConnection: API 403 → failed', async () => {
  const fetch = fakeFetch([{ json: { error: { code: 403 } }, ok: false }]);
  const r = await verifyConnection({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.equal(r.status, 'failed');
});

test('verifyConnection: zero accounts visible → verified with count 0', async () => {
  const fetch = fakeFetch([{ json: {} }]);
  const r = await verifyConnection({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.equal(r.status, 'verified');
  assert.ok(r.detail.includes('0 account'), `detail: ${r.detail}`);
});

test('listCapabilities: returns gtm capability map', async () => {
  const caps = await listCapabilities({});
  assert.equal(caps['container.list'], true);
  assert.equal(caps['tags.list'], true);
  assert.equal(caps['triggers.list'], true);
  assert.equal(caps['variables.list'], true);
});

test('discoverInventory: maps accounts + containers to inventory rows', async () => {
  // Put more-specific '/containers' first so it matches container URLs before the
  // accounts entry (which would also match since container URLs contain '/accounts/123/containers').
  const fetch = fakeFetch([
    {
      url_match: '/containers',
      json: { container: [{ containerId: 'abc456', name: 'Anchor Main', publicId: 'GTM-ABCDE', usageContext: ['WEB'] }] }
    },
    {
      json: { account: [{ accountId: '123', name: 'Anchor GTM', path: 'accounts/123' }] }
    }
  ]);
  const rows = await discoverInventory({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, 'gtm');
  assert.equal(r.serviceCategory, 'measurement');
  assert.equal(r.externalId, 'abc456');
  assert.equal(r.name, 'Anchor Main');
  assert.equal(r.meta.publicId, 'GTM-ABCDE');
  assert.equal(r.meta.accountName, 'Anchor GTM');
  assert.deepEqual(r.meta.usageContext, ['WEB']);
});

test('discoverInventory: account with no containers contributes no rows', async () => {
  const fetch = fakeFetch([
    { url_match: '/containers', json: { container: [] } },
    { json: { account: [{ accountId: '999', name: 'Empty', path: 'accounts/999' }] } }
  ]);
  const rows = await discoverInventory({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.deepEqual(rows, []);
});

test('discoverInventory: inaccessible account (non-ok containers response) is skipped', async () => {
  const fetch = async (url, _opts) => {
    if (url.includes('/containers')) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ account: [{ accountId: '1', name: 'X', path: 'accounts/1' }] }) };
  };
  const rows = await discoverInventory({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.deepEqual(rows, []);
});

test('connector self-registers on import', async () => {
  const { getConnector } = await import('../connections/registry.js');
  const c = getConnector('measurement/gtm');
  assert.ok(c, 'measurement/gtm not in registry');
  assert.equal(c.serviceCategory, 'measurement');
  assert.equal(c.provider, 'gtm');
  assert.ok(c.checks.includes('gtm.container_health'), 'gtm.container_health should be in connector.checks (RECONCILE)');
});
