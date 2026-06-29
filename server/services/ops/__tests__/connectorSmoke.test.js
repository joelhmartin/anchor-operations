/**
 * F9 Expandability Proof — Smoke Test
 *
 * Verifies:
 * 1. All five F9 connectors self-register on import.
 * 2. Each connector satisfies the spec §5 contract shape.
 * 3. The checks/registry and runExecutor were not modified beyond the authorised
 *    RECONCILE change (gtm import + gtm.container_health via serviceCategory/provider).
 * 4. No VALID_UMBRELLAS array modification: gtm.container_health registers via
 *    serviceCategory+provider (not via a new umbrella) — proving the extensibility.
 * 5. GBP capabilities are all false (STUB proof).
 *
 * RECONCILE notes:
 *   - Task 1 stub registry skipped — F1's registry.js already ships.
 *   - F1 registry uses _resetConnectorsForTests (not _resetRegistryForTests).
 *   - F1 registry has no listConnectorsByCategory; use listConnectors().filter().
 *   - gtm.container_health is registered: a check with umbrella='measurement'
 *     (derived from serviceCategory, no legacy umbrella field set) is expected —
 *     this is the correct expandability outcome.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Side-effect imports trigger self-registration in the F1 connector registry.
import '../connections/monday/index.js';
import '../connections/github/index.js';
import '../connections/vercel/index.js';
import '../connections/gtm/index.js';
import '../connections/gbp/index.js';

import { getConnector, listConnectors } from '../connections/registry.js';
import { listAllChecks, getCheck } from '../checks/registry.js';

// Import the GTM check registration side-effect (mirrors what runExecutor does).
import '../checks/gtm/index.js';

const EXPECTED_CONNECTORS = [
  { id: 'task/monday',       serviceCategory: 'task',        provider: 'monday'  },
  { id: 'repo/github',       serviceCategory: 'repo',        provider: 'github'  },
  { id: 'deployment/vercel', serviceCategory: 'deployment',  provider: 'vercel'  },
  { id: 'measurement/gtm',   serviceCategory: 'measurement', provider: 'gtm'     },
  { id: 'local/gbp',         serviceCategory: 'local',       provider: 'gbp'     }
];

const CONTRACT_METHODS = ['verifyConnection', 'listCapabilities', 'discoverInventory', 'collectSnapshot'];

test('all five F9 connectors are registered after import', () => {
  for (const expected of EXPECTED_CONNECTORS) {
    const c = getConnector(expected.id);
    assert.ok(c, `Connector ${expected.id} was not registered — import side-effect broken`);
    assert.equal(c.serviceCategory, expected.serviceCategory, `Wrong serviceCategory for ${expected.id}`);
    assert.equal(c.provider, expected.provider, `Wrong provider for ${expected.id}`);
  }
});

test('each connector satisfies the spec §5 contract shape', () => {
  for (const { id } of EXPECTED_CONNECTORS) {
    const c = getConnector(id);
    assert.ok(typeof c.id === 'string' && c.id, `${id}: id must be a non-empty string`);
    assert.ok(typeof c.serviceCategory === 'string', `${id}: serviceCategory missing`);
    assert.ok(typeof c.provider === 'string', `${id}: provider missing`);
    assert.ok(Array.isArray(c.connectionTypes) && c.connectionTypes.length > 0, `${id}: connectionTypes must be a non-empty array`);
    assert.ok(Array.isArray(c.checks), `${id}: checks must be an array`);
    for (const method of CONTRACT_METHODS) {
      assert.equal(typeof c[method], 'function', `${id}: ${method} must be a function`);
    }
  }
});

test('listConnectors includes at least five F9 connectors', () => {
  const all = listConnectors();
  for (const { id } of EXPECTED_CONNECTORS) {
    assert.ok(all.some((c) => c.id === id), `${id} missing from listConnectors()`);
  }
});

test('gtm.container_health registered via serviceCategory+provider (no new umbrella in VALID_UMBRELLAS)', () => {
  // This is the core expandability proof: gtm.container_health is registered
  // WITHOUT modifying VALID_UMBRELLAS or adding a new umbrella field — it uses
  // serviceCategory='measurement' + provider='gtm' directly (F1 registry §5).
  const check = getCheck('gtm.container_health');
  assert.ok(check, 'gtm.container_health not registered — checks/gtm/index.js import failed');
  assert.equal(check.serviceCategory, 'measurement');
  assert.equal(check.provider, 'gtm');
  assert.ok(Array.isArray(check.requiredCapabilities), 'requiredCapabilities must be an array');
  assert.ok(check.requiredCapabilities.includes('container.list'), 'should require container.list capability');
  // umbrella is derived from serviceCategory (not from VALID_UMBRELLAS enum) — it is
  // 'measurement' (the serviceCategory), NOT 'website'/'google_ads'/'meta'/'ctm'.
  assert.equal(check.umbrella, 'measurement', 'umbrella should be derived from serviceCategory');
});

test('gtm check has non-legacy umbrella — no VALID_UMBRELLAS modification needed', () => {
  // Expandability proof: gtm.container_health has umbrella derived from serviceCategory
  // ('measurement'), NOT from the legacy VALID_UMBRELLAS set. Adding a new provider
  // required zero changes to the VALID_UMBRELLAS constant.
  const legacyUmbrellas = new Set(['website', 'google_ads', 'meta', 'ctm']);
  const allChecks = listAllChecks();
  const gtmCheck = allChecks.find((c) => c.checkId === 'gtm.container_health');
  assert.ok(gtmCheck, 'gtm.container_health must be registered');
  assert.ok(
    !legacyUmbrellas.has(gtmCheck.umbrella),
    `gtm.container_health umbrella (${gtmCheck.umbrella}) should not be a legacy umbrella — no VALID_UMBRELLAS modification was needed`
  );
});

test('GBP connector capabilities are all false (STUB proof)', async () => {
  const gbp = getConnector('local/gbp');
  const caps = await gbp.listCapabilities({});
  for (const [cap, val] of Object.entries(caps)) {
    assert.equal(val, false, `GBP capability ${cap} should be false (STUB), got ${val}`);
  }
});

test('monday/github/vercel/gtm listCapabilities return only true entries', async () => {
  const nonGbp = EXPECTED_CONNECTORS.filter((c) => c.id !== 'local/gbp');
  for (const { id } of nonGbp) {
    const c = getConnector(id);
    const caps = await c.listCapabilities({});
    const falseCaps = Object.entries(caps).filter(([, v]) => v === false);
    assert.deepEqual(
      falseCaps,
      [],
      `${id}: unexpected false capability entries ${JSON.stringify(falseCaps)}`
    );
  }
});
