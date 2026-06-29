/**
 * Persistence for discovered inventory (ops_platform_inventory, spec §2.3).
 * Upsert keyed on (connection_id, object_type, external_id) so re-running
 * discovery refreshes existing rows and bumps last_seen_at rather than
 * duplicating. queryFn is injectable for tests.
 *
 * Reconcile note: F1 created this table with column `attributes_json` (not
 * `metadata`) and `discovered_at` (not `first_seen_at`). This store maps
 * the F2 row shape accordingly. listInventory aliases both back to the
 * canonical names so callers see a consistent interface.
 */
import { query } from '../../../db.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function toUuid(v) {
  if (v == null) return null;
  const s = String(v);
  return UUID_RE.test(s) ? s : null;
}

export async function upsertInventory(scope = {}, rows = [], queryFn = query) {
  const { connectionId, clientUserId = null, serviceCategory, provider } = scope;
  if (!connectionId) throw new Error('upsertInventory: connectionId required');
  if (!serviceCategory || !provider) throw new Error('upsertInventory: serviceCategory + provider required');

  let written = 0;
  for (const r of rows) {
    await queryFn(
      `INSERT INTO ops_platform_inventory
         (connection_id, client_user_id, service_category, provider,
          object_type, external_id, name, status, parent_external_id, url,
          attributes_json, discovered_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now(), now())
       ON CONFLICT (connection_id, object_type, external_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         parent_external_id = EXCLUDED.parent_external_id,
         url = EXCLUDED.url,
         attributes_json = EXCLUDED.attributes_json,
         last_seen_at = now()`,
      [
        connectionId,
        toUuid(clientUserId),
        serviceCategory,
        provider,
        r.object_type,
        r.external_id,
        r.name ?? null,
        r.status ?? null,
        r.parent_external_id ?? null,
        r.url ?? null,
        JSON.stringify(r.metadata || {})
      ]
    );
    written += 1;
  }
  return { written };
}

export async function listInventory(connectionId, queryFn = query) {
  const { rows } = await queryFn(
    `SELECT *, attributes_json AS metadata, discovered_at AS first_seen_at
       FROM ops_platform_inventory
      WHERE connection_id = $1
      ORDER BY object_type, external_id`,
    [connectionId]
  );
  return rows;
}
