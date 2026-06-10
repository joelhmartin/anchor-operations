/**
 * Per-client platform credential store — Phase 1 skeleton.
 *
 * Backed by client_platform_credentials. Reuses services/security/encryption.js
 * for at-rest encryption of self-serve OAuth payloads. Agency-level credentials
 * (sources: agency_mcc, agency_sysuser, env_var) leave credentials_encrypted
 * NULL and resolve from process.env at read time.
 */

import { query } from '../../db.js';
import { encrypt, decrypt } from '../security/encryption.js';

const VALID_SOURCES = new Set([
  'agency_mcc',
  'agency_sysuser',
  'self_serve_oauth',
  'env_var'
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(name, value) {
  if (!UUID_RE.test(String(value || ''))) {
    throw new Error(`credentialStore: invalid uuid for ${name}`);
  }
}

function serialize(row, { includeSecret = false } = {}) {
  if (!row) return null;
  const out = {
    id: row.id,
    client_user_id: row.client_user_id,
    platform: row.platform,
    account_id: row.account_id,
    credentials_source: row.credentials_source,
    credentials_present: Boolean(row.credentials_encrypted),
    scope_metadata: row.scope_metadata || {},
    last_validated_at: row.last_validated_at,
    last_validation_error: row.last_validation_error,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
  if (includeSecret && row.credentials_encrypted) {
    out.credentials = decrypt(row.credentials_encrypted);
  }
  return out;
}

/**
 * Resolve a credential row for a (client, platform[, accountId]) tuple.
 * Returns the row plus a `resolveSecret()` helper that returns the plaintext
 * payload (decrypting at-rest secrets, or pulling agency-level values from
 * process.env at read time).
 */
export async function getCredential(clientUserId, platform, accountId = null) {
  assertUuid('client_user_id', clientUserId);
  if (!platform) throw new Error('credentialStore: platform required');

  const params = [clientUserId, platform];
  let sql = `
    SELECT * FROM client_platform_credentials
     WHERE client_user_id = $1 AND platform = $2
  `;
  if (accountId) {
    sql += ' AND account_id = $3';
    params.push(accountId);
  }
  sql += ' ORDER BY created_at DESC LIMIT 1';

  const { rows } = await query(sql, params);
  const row = rows[0];
  if (!row) return null;

  return {
    ...serialize(row),
    resolveSecret: () => {
      if (row.credentials_source === 'self_serve_oauth' && row.credentials_encrypted) {
        return decrypt(row.credentials_encrypted);
      }
      // Agency-level sources: caller is expected to read process.env directly.
      // We surface the source so the caller picks the right env-var bundle.
      return null;
    }
  };
}

/**
 * Insert or update a credential for a client. Encrypts the secret payload for
 * self-serve OAuth; ignores it for agency-level sources.
 *
 * @param {object} input
 * @param {string} input.clientUserId
 * @param {string} input.platform
 * @param {string} input.accountId
 * @param {string} input.source        one of VALID_SOURCES
 * @param {string} [input.secret]      plaintext payload (only meaningful for self_serve_oauth)
 * @param {object} [input.scopeMetadata]
 */
export async function putCredential(input = {}) {
  const {
    clientUserId,
    platform,
    accountId,
    source,
    secret = null,
    scopeMetadata = {}
  } = input;

  assertUuid('client_user_id', clientUserId);
  if (!platform) throw new Error('credentialStore: platform required');
  if (!accountId) throw new Error('credentialStore: account_id required');
  if (!VALID_SOURCES.has(source)) {
    throw new Error(`credentialStore: invalid source "${source}"`);
  }

  let encrypted = null;
  if (source === 'self_serve_oauth' && secret) {
    encrypted = encrypt(secret);
    if (!encrypted) {
      throw new Error('credentialStore: encryption unavailable; cannot store secret');
    }
  }

  const { rows } = await query(
    `
    INSERT INTO client_platform_credentials
      (client_user_id, platform, account_id, credentials_source,
       credentials_encrypted, scope_metadata, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
    ON CONFLICT (client_user_id, platform, account_id) DO UPDATE
      SET credentials_source = EXCLUDED.credentials_source,
          credentials_encrypted = COALESCE(EXCLUDED.credentials_encrypted, client_platform_credentials.credentials_encrypted),
          scope_metadata = EXCLUDED.scope_metadata,
          updated_at = NOW()
    RETURNING *
    `,
    [clientUserId, platform, accountId, source, encrypted, scopeMetadata]
  );

  return serialize(rows[0]);
}

/**
 * Mark a credential as validated (or capture the validation error).
 * Phase 1 records the result; per-platform validation logic lands in later
 * phases.
 */
export async function validateCredential(credentialId, { ok, error = null } = {}) {
  assertUuid('credential_id', credentialId);
  const { rows } = await query(
    `
    UPDATE client_platform_credentials
       SET last_validated_at = NOW(),
           last_validation_error = $2,
           updated_at = NOW()
     WHERE id = $1
     RETURNING *
    `,
    [credentialId, ok ? null : error || 'unknown error']
  );
  return serialize(rows[0]);
}

/**
 * Replace the encrypted secret for an existing credential row. Only valid for
 * self_serve_oauth rows.
 */
export async function rotateCredential(credentialId, newSecret) {
  assertUuid('credential_id', credentialId);
  if (!newSecret) throw new Error('credentialStore: rotateCredential requires a new secret');

  const existing = await query(
    'SELECT credentials_source FROM client_platform_credentials WHERE id = $1',
    [credentialId]
  );
  const row = existing.rows[0];
  if (!row) throw new Error('credentialStore: credential not found');
  if (row.credentials_source !== 'self_serve_oauth') {
    throw new Error('credentialStore: only self_serve_oauth credentials can be rotated');
  }

  const encrypted = encrypt(newSecret);
  if (!encrypted) throw new Error('credentialStore: encryption unavailable');

  const { rows } = await query(
    `
    UPDATE client_platform_credentials
       SET credentials_encrypted = $2,
           last_validated_at = NULL,
           last_validation_error = NULL,
           updated_at = NOW()
     WHERE id = $1
     RETURNING *
    `,
    [credentialId, encrypted]
  );
  return serialize(rows[0]);
}

export async function deleteCredential(credentialId) {
  assertUuid('credential_id', credentialId);
  await query('DELETE FROM client_platform_credentials WHERE id = $1', [credentialId]);
}

export async function listCredentialsForClient(clientUserId) {
  assertUuid('client_user_id', clientUserId);
  const { rows } = await query(
    `SELECT * FROM client_platform_credentials WHERE client_user_id = $1 ORDER BY platform, account_id`,
    [clientUserId]
  );
  return rows.map((r) => serialize(r));
}
