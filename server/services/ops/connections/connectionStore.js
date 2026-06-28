/**
 * CRUD + status lifecycle over ops_service_connections (spec §6). This store
 * OWNS the connection status lifecycle:
 *   missing → configured → verified → degraded → failed → disabled
 * with disable/recover edges. Capabilities are stored as a JSON array.
 */
import { query } from '../../../db.js';

export const STATUS_LIFECYCLE = {
  missing:    ['configured', 'disabled'],
  configured: ['verified', 'failed', 'missing', 'disabled'],
  verified:   ['degraded', 'failed', 'configured', 'disabled'],
  degraded:   ['verified', 'failed', 'disabled'],
  failed:     ['configured', 'verified', 'disabled'],
  disabled:   ['configured', 'missing']
};

export function canTransitionStatus(from, to) {
  if (!from) return true;            // first set
  if (from === to) return true;      // idempotent re-set
  return (STATUS_LIFECYCLE[from] || []).includes(to);
}

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    client_user_id: row.client_user_id,
    service_category: row.service_category,
    provider: row.provider,
    connection_type: row.connection_type,
    credential_ref: row.credential_ref,
    status: row.status,
    capabilities: Array.isArray(row.capabilities_json) ? row.capabilities_json : [],
    detail: row.detail,
    metadata: row.metadata || {},
    last_verified_at: row.last_verified_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function upsertConnection({
  clientUserId,
  serviceCategory,
  provider,
  connectionType = null,
  credentialRef = null,
  status = 'missing',
  capabilities = [],
  detail = null,
  metadata = {}
} = {}) {
  if (!clientUserId) throw new Error('connectionStore: clientUserId required');
  if (!serviceCategory) throw new Error('connectionStore: serviceCategory required');
  if (!provider) throw new Error('connectionStore: provider required');

  // Enforce lifecycle transition when the row already exists — prevents callers
  // from jumping e.g. missing → verified by going through upsert instead of
  // setConnectionStatus (which carries the explicit transition check).
  const existing = await getConnection(clientUserId, serviceCategory, provider);
  if (existing && !canTransitionStatus(existing.status, status)) {
    throw new Error(
      `connectionStore: illegal status transition ${existing.status} → ${status} during upsert`
    );
  }

  const { rows } = await query(
    `
    INSERT INTO ops_service_connections
      (client_user_id, service_category, provider, connection_type, credential_ref,
       status, capabilities_json, detail, metadata, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, now())
    ON CONFLICT (client_user_id, service_category, provider) DO UPDATE
      SET connection_type   = EXCLUDED.connection_type,
          credential_ref    = COALESCE(EXCLUDED.credential_ref, ops_service_connections.credential_ref),
          status            = EXCLUDED.status,
          capabilities_json = EXCLUDED.capabilities_json,
          detail            = EXCLUDED.detail,
          metadata          = EXCLUDED.metadata,
          updated_at        = now()
    RETURNING *
    `,
    [
      clientUserId, serviceCategory, provider, connectionType, credentialRef,
      status, JSON.stringify(capabilities), detail, JSON.stringify(metadata)
    ]
  );
  return serialize(rows[0]);
}

export async function setConnectionStatus(id, status, { detail = null, capabilities = null, lastVerifiedAt = null } = {}) {
  if (!id) throw new Error('connectionStore: id required');
  const cur = await query('SELECT status FROM ops_service_connections WHERE id = $1', [id]);
  const from = cur.rows[0]?.status;
  if (from === undefined) throw new Error('connectionStore: connection not found');
  if (!canTransitionStatus(from, status)) {
    throw new Error(`connectionStore: illegal status transition ${from} → ${status}`);
  }

  const { rows } = await query(
    `
    UPDATE ops_service_connections
       SET status            = $2,
           detail            = COALESCE($3, detail),
           capabilities_json = COALESCE($4::jsonb, capabilities_json),
           last_verified_at  = COALESCE($5, last_verified_at),
           updated_at        = now()
     WHERE id = $1
     RETURNING *
    `,
    [id, status, detail, capabilities == null ? null : JSON.stringify(capabilities), lastVerifiedAt]
  );
  return serialize(rows[0]);
}

export async function getConnection(clientUserId, serviceCategory, provider) {
  const { rows } = await query(
    `SELECT * FROM ops_service_connections
      WHERE client_user_id = $1 AND service_category = $2 AND provider = $3
      LIMIT 1`,
    [clientUserId, serviceCategory, provider]
  );
  return serialize(rows[0]);
}

export async function listConnectionsForClient(clientUserId) {
  const { rows } = await query(
    `SELECT * FROM ops_service_connections
      WHERE client_user_id = $1
      ORDER BY service_category, provider`,
    [clientUserId]
  );
  return rows.map(serialize);
}
