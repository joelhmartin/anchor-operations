import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerConnector,
  getConnector,
  getConnectorByCategoryProvider,
  listConnectors,
  _resetConnectorsForTests
} from '../connections/registry.js';

// Minimal valid connector shape for testing the registry itself.
function makeConnector(overrides = {}) {
  return {
    id: 'test/fake',
    serviceCategory: 'test',
    provider: 'fake',
    connectionTypes: ['api_key'],
    verifyConnection: async () => ({ status: 'missing', detail: 'test', capabilities: {} }),
    listCapabilities: async () => ({}),
    ...overrides
  };
}

test('registerConnector: stores and retrieves by id', () => {
  _resetConnectorsForTests();
  const def = makeConnector({ id: 'test/fake' });
  registerConnector(def);
  assert.deepEqual(getConnector('test/fake'), def);
});

test('registerConnector: throws on missing id', () => {
  _resetConnectorsForTests();
  assert.throws(() => registerConnector(makeConnector({ id: '' })), /non-empty/i);
  assert.throws(() => registerConnector(makeConnector({ id: undefined })), /non-empty/i);
});

test('registerConnector: throws on missing connectionTypes', () => {
  _resetConnectorsForTests();
  assert.throws(
    () => registerConnector(makeConnector({ connectionTypes: [] })),
    /connectionTypes/
  );
});

test('registerConnector: throws on invalid connectionType value', () => {
  _resetConnectorsForTests();
  assert.throws(
    () => registerConnector(makeConnector({ connectionTypes: ['unknown_type'] })),
    /connectionType/
  );
});

test('registerConnector: throws if verifyConnection is not a function', () => {
  _resetConnectorsForTests();
  assert.throws(
    () => registerConnector(makeConnector({ verifyConnection: 'not-a-function' })),
    /verifyConnection/
  );
});

test('getConnector: returns null for unknown id', () => {
  _resetConnectorsForTests();
  assert.equal(getConnector('nope/nope'), null);
});

test('listConnectors: returns all registered', () => {
  _resetConnectorsForTests();
  registerConnector(makeConnector({ id: 'a/b', serviceCategory: 'a', provider: 'b' }));
  registerConnector(makeConnector({ id: 'c/d', serviceCategory: 'c', provider: 'd' }));
  assert.equal(listConnectors().length, 2);
});

test('getConnectorByCategoryProvider: finds by serviceCategory and provider', () => {
  _resetConnectorsForTests();
  registerConnector(makeConnector({ id: 'task/monday', serviceCategory: 'task', provider: 'monday' }));
  registerConnector(makeConnector({ id: 'repo/github', serviceCategory: 'repo', provider: 'github' }));
  const c = getConnectorByCategoryProvider('task', 'monday');
  assert.ok(c, 'connector not found');
  assert.equal(c.id, 'task/monday');
  assert.equal(getConnectorByCategoryProvider('deployment', 'vercel'), null);
});

test('registerConnector: re-registration overwrites and does not duplicate', () => {
  _resetConnectorsForTests();
  const v1 = makeConnector({ id: 'x/y', serviceCategory: 'x', provider: 'y' });
  const v2 = makeConnector({ id: 'x/y', serviceCategory: 'x', provider: 'y' });
  v1.version = 1;
  v2.version = 2;
  registerConnector(v1);
  registerConnector(v2);
  assert.equal(listConnectors().length, 1);
  assert.equal(getConnector('x/y').version, 2);
});
