import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConnector, assertValidConnector, CONNECTION_TYPES } from '../connections/types/contract.js';
import {
  registerConnector, getConnector, getConnectorByCategoryProvider, listConnectors, _resetConnectorsForTests
} from '../connections/registry.js';

const goodConnector = () => ({
  id: 'wordpress',
  serviceCategory: 'cms',
  provider: 'wordpress',
  connectionTypes: ['ssh', 'api_key'],
  async verifyConnection() { return { status: 'verified', detail: '', capabilities: [] }; },
  async discoverInventory() { return []; },
  async collectSnapshot() { return []; },
  async listCapabilities() { return ['read', 'run_wp_cli']; },
  actions: {},
  checks: []
});

test('CONNECTION_TYPES are the locked set', () => {
  assert.deepEqual(CONNECTION_TYPES, ['service_account', 'oauth', 'api_key', 'webhook', 'ssh']);
});

test('a fully-formed connector validates', () => {
  const r = validateConnector(goodConnector());
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('missing verifyConnection fails the order law', () => {
  const c = goodConnector();
  delete c.verifyConnection;
  const r = validateConnector(c);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /verifyConnection/.test(e)));
});

test('missing listCapabilities fails (no actions-only connectors)', () => {
  const c = goodConnector();
  delete c.listCapabilities;
  assert.equal(validateConnector(c).valid, false);
});

test('an unknown connectionType is rejected', () => {
  const c = goodConnector();
  c.connectionTypes = ['carrier_pigeon'];
  const r = validateConnector(c);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /connectionType/.test(e)));
});

test('assertValidConnector throws with joined errors', () => {
  assert.throws(() => assertValidConnector({ id: 'x' }), /serviceCategory|provider|connectionTypes/);
});

test('registry registers, fetches by id and by category/provider', () => {
  _resetConnectorsForTests();
  registerConnector(goodConnector());
  assert.equal(getConnector('wordpress').provider, 'wordpress');
  assert.equal(getConnectorByCategoryProvider('cms', 'wordpress').id, 'wordpress');
  assert.equal(getConnectorByCategoryProvider('cms', 'ghost'), null);
  assert.equal(listConnectors().length, 1);
});

test('registry rejects an invalid connector at registration', () => {
  _resetConnectorsForTests();
  assert.throws(() => registerConnector({ id: 'bad' }), /serviceCategory|provider/);
});
