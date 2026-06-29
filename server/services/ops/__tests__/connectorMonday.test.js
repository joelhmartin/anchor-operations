import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyConnection, listCapabilities, discoverInventory } from '../connections/monday/index.js';

function fakeFetch(json, { ok = true, status = 200 } = {}) {
  return async (_url, _opts) => ({
    ok,
    status,
    text: async () => JSON.stringify(json),
    json: async () => json
  });
}

test('verifyConnection: valid token → verified with capabilities', async () => {
  const fetch = fakeFetch({ data: { me: { id: '123', name: 'Joel Martin', email: 'jmartin@anchorcorps.com' } } });
  const r = await verifyConnection({ env: { MONDAY_API_TOKEN: 'tok_live' }, fetch });
  assert.equal(r.status, 'verified');
  assert.ok(r.detail.includes('Joel Martin'), `detail: ${r.detail}`);
  assert.equal(r.capabilities['task.create'], true);
  assert.equal(r.capabilities['task.list'], true);
});

test('verifyConnection: missing token → missing (no fetch call)', async () => {
  let fetchCalled = false;
  const fetch = async () => { fetchCalled = true; return {}; };
  const r = await verifyConnection({ env: {}, fetch });
  assert.equal(r.status, 'missing');
  assert.ok(r.detail.includes('MONDAY_API_TOKEN'));
  assert.equal(fetchCalled, false, 'fetch must not be called when token is absent');
});

test('verifyConnection: blank token → missing', async () => {
  const r = await verifyConnection({ env: { MONDAY_API_TOKEN: '   ' }, fetch: async () => ({}) });
  assert.equal(r.status, 'missing');
});

test('verifyConnection: API returns non-ok → failed', async () => {
  const fetch = fakeFetch({ errors: [{ message: 'Unauthorized' }] }, { ok: false, status: 401 });
  const r = await verifyConnection({ env: { MONDAY_API_TOKEN: 'bad' }, fetch });
  assert.equal(r.status, 'failed');
});

test('verifyConnection: GQL errors array → failed', async () => {
  const fetch = fakeFetch({ errors: [{ message: 'invalid_token' }] });
  const r = await verifyConnection({ env: { MONDAY_API_TOKEN: 'tok' }, fetch });
  assert.equal(r.status, 'failed');
  assert.ok(r.detail.includes('invalid_token'));
});

test('listCapabilities: returns task capability map without ctx', async () => {
  const caps = await listCapabilities({});
  assert.equal(caps['task.create'], true);
  assert.equal(caps['task.list'], true);
  assert.equal(caps['board.list'], true);
});

test('discoverInventory: maps boards to inventory rows', async () => {
  const fetch = fakeFetch({
    data: { boards: [{ id: '42', name: 'Operations Board', description: 'Main ops tracking' }] }
  });
  const rows = await discoverInventory({ env: { MONDAY_API_TOKEN: 'tok' }, fetch });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, 'monday');
  assert.equal(r.serviceCategory, 'task');
  assert.equal(r.externalId, '42');
  assert.equal(r.name, 'Operations Board');
  assert.equal(r.meta.description, 'Main ops tracking');
});

test('discoverInventory: empty boards list → empty array', async () => {
  const fetch = fakeFetch({ data: { boards: [] } });
  const rows = await discoverInventory({ env: { MONDAY_API_TOKEN: 'tok' }, fetch });
  assert.deepEqual(rows, []);
});

test('connector self-registers on import', async () => {
  const { getConnector } = await import('../connections/registry.js');
  const c = getConnector('task/monday');
  assert.ok(c, 'task/monday connector not in registry');
  assert.equal(c.serviceCategory, 'task');
  assert.equal(c.provider, 'monday');
  assert.ok(Array.isArray(c.connectionTypes));
});
