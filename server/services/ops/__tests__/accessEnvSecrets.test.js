import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCredentialPresence, auditCredentials, REQUIRED_CREDENTIALS } from '../access/envSecrets.js';

test('all required present → verified', () => {
  const r = checkCredentialPresence({ A: 'x', B: 'y' }, { required: ['A', 'B'] });
  assert.equal(r.status, 'verified');
  assert.deepEqual(r.missing, []);
});

test('a required var absent (or blank) → missing', () => {
  const r = checkCredentialPresence({ A: 'x', B: '   ' }, { required: ['A', 'B'] });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.missing, ['B']);
});

test('anyOf satisfied by one present var → verified', () => {
  const r = checkCredentialPresence({ GA4_SERVICE_ACCOUNT_KEY: '{...}' }, { anyOf: ['GA4_SERVICE_ACCOUNT_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] });
  assert.equal(r.status, 'verified');
});

test('anyOf with none present → missing', () => {
  const r = checkCredentialPresence({}, { anyOf: ['GA4_SERVICE_ACCOUNT_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.missing, ['GA4_SERVICE_ACCOUNT_KEY|GOOGLE_APPLICATION_CREDENTIALS']);
});

test('required present but optional missing → degraded (still usable)', () => {
  const r = checkCredentialPresence({ KINSTA_API_KEY: 'k' }, { required: ['KINSTA_API_KEY'], optional: ['KINSTA_USER'] });
  assert.equal(r.status, 'degraded');
  assert.deepEqual(r.optionalMissing, ['KINSTA_USER']);
});

test('auditCredentials flattens missing as "SERVICE: VAR" and never leaks values', () => {
  const env = { ENCRYPTION_KEY: 'k', JWT_SECRET: 'j', DATABASE_URL: 'postgres://x' };
  const out = auditCredentials(env, { core: REQUIRED_CREDENTIALS.core, meta: REQUIRED_CREDENTIALS.meta });
  assert.equal(out.services.core.status, 'verified');
  assert.equal(out.services.meta.status, 'missing');
  assert.ok(out.missing.includes('meta: FACEBOOK_SYSTEM_USER_TOKEN'));
  // value-leak guard: serialized result contains no secret values
  assert.ok(!JSON.stringify(out).includes('postgres://x'));
});
