/**
 * Bridge a connection to its credential (spec §3.1: env-var / Postgres, NOT
 * Secret Manager). ops_service_connections.credential_ref points at a
 * client_platform_credentials row. Pure classification is separated from the
 * DB/crypto wrapper so the decision logic is exhaustively testable.
 */
import { query } from '../../../db.js';
import { decrypt } from '../../security/encryption.js';

export function classifyCredentialResolution(connection, credentialRow) {
  if (!connection || !connection.credential_ref) {
    return { strategy: 'env', source: 'env_var' };
  }
  if (!credentialRow) {
    return { strategy: 'missing', source: null, reason: 'credential_ref not found' };
  }
  if (credentialRow.credentials_source === 'self_serve_oauth' && credentialRow.credentials_encrypted) {
    return { strategy: 'stored', source: 'self_serve_oauth' };
  }
  // agency_mcc / agency_sysuser / env_var rows resolve from process.env.
  return { strategy: 'agency_env', source: credentialRow.credentials_source };
}

export async function resolveCredentialForConnection(connection, { queryFn = query, decryptSecret = decrypt } = {}) {
  if (!connection || !connection.credential_ref) {
    return { strategy: 'env', source: 'env_var' };
  }
  const { rows } = await queryFn(
    'SELECT credentials_source, credentials_encrypted FROM client_platform_credentials WHERE id = $1',
    [connection.credential_ref]
  );
  const row = rows[0] || null;
  const classified = classifyCredentialResolution(connection, row);
  if (classified.strategy === 'stored') {
    return { ...classified, secret: decryptSecret(row.credentials_encrypted) };
  }
  return classified;
}
