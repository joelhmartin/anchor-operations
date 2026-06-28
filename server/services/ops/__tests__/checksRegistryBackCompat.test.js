import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerCheck, getCheck, listChecksForUmbrella,
  listChecksForServiceCategory, listChecksForProvider, _resetRegistryForTests
} from '../checks/registry.js';

const handler = async () => ({ status: 'pass' });

test('LEGACY umbrella check registers UNCHANGED and derives category/provider', () => {
  _resetRegistryForTests();
  // Byte-for-byte the shape existing checks use today — no new fields.
  registerCheck('web.ssl.expiry', { umbrella: 'website', tier: 'daily_essential', costEstimate: 0, requires: [], handler });
  const def = getCheck('web.ssl.expiry');
  assert.equal(def.umbrella, 'website');                 // preserved
  assert.equal(def.serviceCategory, 'website');          // derived
  assert.equal(def.provider, 'public_http');             // derived
  assert.deepEqual(def.requiredCapabilities, []);        // default → never gated
  assert.equal(listChecksForUmbrella('website').length, 1);
  assert.equal(listChecksForServiceCategory('website').length, 1);
});

test('all four shipped umbrellas still register and derive', () => {
  _resetRegistryForTests();
  registerCheck('a', { umbrella: 'google_ads', tier: 'daily_essential', handler });
  registerCheck('b', { umbrella: 'meta', tier: 'daily_essential', handler });
  registerCheck('c', { umbrella: 'ctm', tier: 'daily_essential', handler });
  assert.equal(getCheck('a').serviceCategory, 'paid_ads');
  assert.equal(getCheck('a').provider, 'google_ads');
  assert.equal(getCheck('b').provider, 'meta');
  assert.equal(getCheck('c').serviceCategory, 'call_tracking');
});

test('NEW contract: serviceCategory + provider + requiredCapabilities (no umbrella)', () => {
  _resetRegistryForTests();
  registerCheck('ga4.sessions', {
    serviceCategory: 'analytics', provider: 'ga4', requiredCapabilities: ['read'],
    tier: 'daily_essential', handler
  });
  const def = getCheck('ga4.sessions');
  assert.equal(def.serviceCategory, 'analytics');
  assert.equal(def.provider, 'ga4');
  assert.deepEqual(def.requiredCapabilities, ['read']);
  // legacy umbrella column is back-filled for ops_check_results.umbrella (NOT NULL)
  assert.ok(typeof def.umbrella === 'string' && def.umbrella.length > 0);
  assert.equal(listChecksForProvider('ga4').length, 1);
});

test('a check with neither umbrella nor (serviceCategory, provider) is rejected', () => {
  _resetRegistryForTests();
  assert.throws(
    () => registerCheck('bad', { tier: 'daily_essential', handler }),
    /umbrella.*or.*serviceCategory|serviceCategory.*provider/i
  );
});

test('an explicit serviceCategory overrides the umbrella derivation', () => {
  _resetRegistryForTests();
  registerCheck('web.host.kinsta', {
    umbrella: 'website', serviceCategory: 'hosting', provider: 'kinsta',
    tier: 'daily_essential', handler
  });
  const def = getCheck('web.host.kinsta');
  assert.equal(def.umbrella, 'website');     // legacy field preserved
  assert.equal(def.serviceCategory, 'hosting'); // explicit wins
  assert.equal(def.provider, 'kinsta');
});
