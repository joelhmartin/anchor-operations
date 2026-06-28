import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCredentialResolution, resolveCredentialForConnection } from '../connections/credentialResolver.js';

test('no credential_ref → pure env strategy', () => {
  const r = classifyCredentialResolution({ credential_ref: null }, null);
  assert.equal(r.strategy, 'env');
  assert.equal(r.source, 'env_var');
});

test('credential_ref set but row missing → missing', () => {
  const r = classifyCredentialResolution({ credential_ref: 'abc' }, null);
  assert.equal(r.strategy, 'missing');
});

test('self_serve_oauth with encrypted payload → stored', () => {
  const r = classifyCredentialResolution(
    { credential_ref: 'abc' },
    { credentials_source: 'self_serve_oauth', credentials_encrypted: 'cipher' }
  );
  assert.equal(r.strategy, 'stored');
  assert.equal(r.source, 'self_serve_oauth');
});

test('agency source → agency_env (caller reads process.env)', () => {
  const r = classifyCredentialResolution(
    { credential_ref: 'abc' },
    { credentials_source: 'agency_mcc', credentials_encrypted: null }
  );
  assert.equal(r.strategy, 'agency_env');
  assert.equal(r.source, 'agency_mcc');
});

test('resolveCredentialForConnection decrypts only the stored strategy (DI, no DB/crypto)', async () => {
  const queryFn = async () => ({ rows: [{ credentials_source: 'self_serve_oauth', credentials_encrypted: 'cipher' }] });
  const decryptSecret = (c) => (c === 'cipher' ? '{"token":"t"}' : null);
  const out = await resolveCredentialForConnection({ credential_ref: 'abc' }, { queryFn, decryptSecret });
  assert.equal(out.strategy, 'stored');
  assert.equal(out.secret, '{"token":"t"}');
});

test('resolveCredentialForConnection returns env strategy without touching the DB', async () => {
  let called = false;
  const queryFn = async () => { called = true; return { rows: [] }; };
  const out = await resolveCredentialForConnection({ credential_ref: null }, { queryFn, decryptSecret: () => null });
  assert.equal(out.strategy, 'env');
  assert.equal(called, false);
});
