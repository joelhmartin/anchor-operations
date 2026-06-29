import test from 'node:test';
import assert from 'node:assert/strict';
import connector, {
  verifyConnection,
  listCapabilities,
  discoverInventory,
  collectSnapshot
} from '../connections/gbp/index.js';

test('verifyConnection: always returns missing with STUB detail', async () => {
  const r = await verifyConnection({});
  assert.equal(r.status, 'missing');
  assert.ok(r.detail.includes('STUB'), `detail should contain 'STUB', got: ${r.detail}`);
  assert.deepEqual(r.capabilities, {});
});

test('verifyConnection: does not call any network (no fetch needed)', async () => {
  let called = false;
  const r = await verifyConnection({
    env: { GBP_SERVICE_ACCOUNT_KEY: 'sk' },
    fetch: async () => { called = true; throw new Error('should not be called'); }
  });
  assert.equal(r.status, 'missing');
  assert.equal(called, false);
});

test('listCapabilities: returns all four GBP capabilities as false', async () => {
  const caps = await listCapabilities({});
  assert.equal(caps['gbp.connection_health'], false);
  assert.equal(caps['gbp.review_summary'], false);
  assert.equal(caps['gbp.profile_status'], false);
  assert.equal(caps['gbp.hours_mismatch'], false);
});

test('discoverInventory: always returns empty array', async () => {
  const rows = await discoverInventory({});
  assert.deepEqual(rows, []);
});

test('collectSnapshot: always returns empty array', async () => {
  const snaps = await collectSnapshot({});
  assert.deepEqual(snaps, []);
});

test('connector shape: id, serviceCategory, provider present', () => {
  assert.equal(connector.id, 'local/gbp');
  assert.equal(connector.serviceCategory, 'local');
  assert.equal(connector.provider, 'gbp');
  assert.ok(Array.isArray(connector.connectionTypes));
  assert.ok(Array.isArray(connector.checks));
});

test('connector self-registers on import', async () => {
  const { getConnector } = await import('../connections/registry.js');
  const c = getConnector('local/gbp');
  assert.ok(c, 'local/gbp not in registry');
  assert.equal(c.serviceCategory, 'local');
  assert.equal(c.provider, 'gbp');
});
