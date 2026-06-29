import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGscToken } from '../connections/gsc/auth.js';

test('resolveGscToken: uses GA4_SERVICE_ACCOUNT_KEY when present', async () => {
  const fakeKey = JSON.stringify({ type: 'service_account', client_email: 'sa@p.iam.gserviceaccount.com' });
  let capturedOpts;
  const _createAuth = (opts) => {
    capturedOpts = opts;
    return { getAccessToken: async () => 'sa-token' };
  };
  const token = await resolveGscToken({ env: { GA4_SERVICE_ACCOUNT_KEY: fakeKey }, _createAuth });
  assert.equal(token, 'sa-token');
  assert.equal(capturedOpts.credentials.type, 'service_account');
  assert.deepEqual(capturedOpts.scopes, ['https://www.googleapis.com/auth/webmasters.readonly']);
});

test('resolveGscToken: falls through to ADC on K_SERVICE when SA key absent', async () => {
  let callCount = 0;
  const _createAuth = (opts) => {
    callCount += 1;
    // first call (SA key path) never reached; second call (ADC path) returns token
    return { getAccessToken: async () => (opts.credentials ? null : 'adc-token') };
  };
  const token = await resolveGscToken({ env: { K_SERVICE: 'anchor-ops' }, _createAuth });
  assert.equal(token, 'adc-token');
});

test('resolveGscToken: falls through to ADC on GOOGLE_APPLICATION_CREDENTIALS', async () => {
  const _createAuth = (opts) => ({ getAccessToken: async () => (opts.credentials ? null : 'adc-token-2') });
  const token = await resolveGscToken({
    env: { GOOGLE_APPLICATION_CREDENTIALS: '/var/secrets/sa.json' },
    _createAuth
  });
  assert.equal(token, 'adc-token-2');
});

test('resolveGscToken: uses oauthFallback when no service credentials', async () => {
  const token = await resolveGscToken({ env: {}, oauthFallback: async () => 'oauth-token' });
  assert.equal(token, 'oauth-token');
});

test('resolveGscToken: returns null when nothing is configured', async () => {
  const token = await resolveGscToken({ env: {}, _createAuth: () => ({ getAccessToken: async () => null }) });
  assert.equal(token, null);
});

test('resolveGscToken: falls through gracefully when SA key JSON is malformed', async () => {
  const token = await resolveGscToken({
    env: { GA4_SERVICE_ACCOUNT_KEY: 'not-json' },
    oauthFallback: async () => 'fallback-token'
  });
  assert.equal(token, 'fallback-token');
});
