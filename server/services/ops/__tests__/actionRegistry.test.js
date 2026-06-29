import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAction, ABSTRACT_ACTIONS } from '../actions/registry.js';

const fakeConnector = { id: 'kinsta', actions: { preflight: async () => ({}), execute: async () => ({}) } };
const getConnector = async (p) => (p === 'kinsta' ? fakeConnector : null);

test('resolves website.clear_cache → hosting.kinsta.clear_cache when client has the capability', async () => {
  const r = await resolveAction('website.clear_cache', {
    capabilities: [{ provider: 'kinsta', capabilities: ['clear_cache', 'create_backup'] }],
    getConnector
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'kinsta');
  assert.equal(r.providerActionType, 'hosting.kinsta.clear_cache');
  assert.equal(r.connector, fakeConnector);
});

test('unknown abstract action → not ok', async () => {
  const r = await resolveAction('website.nope', { capabilities: [{ provider: 'kinsta', capabilities: ['clear_cache'] }], getConnector });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown abstract action/i);
});

test('no provider advertises the capability → capability_unavailable', async () => {
  const r = await resolveAction('website.clear_cache', { capabilities: [{ provider: 'kinsta', capabilities: ['read'] }], getConnector });
  assert.equal(r.ok, false);
  assert.match(r.reason, /capability_unavailable/i);
});

test('capable provider but no connector wired → not ok', async () => {
  const r = await resolveAction('website.clear_cache', {
    capabilities: [{ provider: 'kinsta', capabilities: ['clear_cache'] }],
    getConnector: async () => null
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /connector/i);
});

test('every seeded abstract action is provider-neutral and non-destructive', () => {
  for (const [type, def] of Object.entries(ABSTRACT_ACTIONS)) {
    assert.equal(def.destructive, false, `${type} must not be destructive this phase`);
    for (const provType of Object.values(def.providerActionByProvider)) {
      assert.ok(provType.includes('.'), `${provType} should be a namespaced provider action`);
    }
  }
});
