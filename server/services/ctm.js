// Slim CTM data shim for the standalone Operations app.
//
// The full CTM service lives in the main (anchor-hub) app — it owns CRM call
// ingestion, AI classification, auto-star, etc. Operations only needs to read
// tracking-number metadata and recent call counts for the `ctm.*` health checks
// (see services/ops/checks/ctm/trackingNumberHealth.js). Those two functions are
// pure reads against the shared DB, so we re-implement just them here rather than
// drag the entire CRM tree into this app.
import { query as _dbQuery } from '../db.js';

/**
 * List the Twilio tracking numbers owned by a client.
 * Shape matches the original ctm.js contract consumed by trackingNumberHealth.
 */
export async function listTrackingNumbers({ clientUserId }) {
  const result = await _dbQuery(
    `SELECT id, phone_number, friendly_name, is_active, source_type, campaign_name
     FROM twilio_tracking_numbers
     WHERE client_user_id = $1
     ORDER BY created_at ASC`,
    [clientUserId]
  );
  return result.rows.map((r) => ({
    id: r.id,
    formatted_number: r.friendly_name || r.phone_number,
    phone_number: r.phone_number,
    status: r.is_active ? 'active' : 'inactive',
    last_error: null
  }));
}

/**
 * Count call_logs rows linked to a specific tracking number in the last N days.
 * Uses the tracking_number_id FK when available; falls back to matching to_number
 * for calls imported before the FK existed.
 */
export async function getNumberCallCount({ clientUserId, numberId, days }) {
  const numRow = await _dbQuery(
    `SELECT phone_number FROM twilio_tracking_numbers WHERE id = $1 AND client_user_id = $2`,
    [numberId, clientUserId]
  );
  if (!numRow.rows.length) return 0;
  const phoneNumber = numRow.rows[0].phone_number;

  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const result = await _dbQuery(
    `SELECT COUNT(*) AS cnt
     FROM call_logs
     WHERE owner_user_id = $1
       AND started_at >= $2
       AND (tracking_number_id = $3 OR to_number = $4)`,
    [clientUserId, since, numberId, phoneNumber]
  );
  return parseInt(result.rows[0]?.cnt || '0', 10);
}
