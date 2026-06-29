import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGa4Client } from '../connections/ga4/client.js';

test('buildGa4Client returns injected client unchanged', () => {
  const fake = { runReport: async () => [[]] };
  assert.strictEqual(buildGa4Client({ ga4Client: fake }), fake);
});

test('buildGa4Client throws on malformed GA4_SERVICE_ACCOUNT_KEY', () => {
  assert.throws(
    () => buildGa4Client({ env: { GA4_SERVICE_ACCOUNT_KEY: 'not-json' } }),
    /GA4_SERVICE_ACCOUNT_KEY is not valid JSON/
  );
});

test('buildGa4Client with empty env falls back to ADC (constructs without throw)', () => {
  assert.doesNotThrow(() => buildGa4Client({ env: {} }));
});

test('buildGa4Client with valid JSON key string constructs without throw', () => {
  const key = JSON.stringify({ type: 'service_account', project_id: 'p', private_key: 'k', client_email: 'e@p.iam.gserviceaccount.com' });
  assert.doesNotThrow(() => buildGa4Client({ env: { GA4_SERVICE_ACCOUNT_KEY: key } }));
});
