/**
 * Snapshot persistence (V5) — the WRITE side of the snapshot → baseline →
 * anomaly chain. F1 connectors' collectSnapshot() return ops_daily_snapshots-
 * shaped rows but NOTHING persisted them; this closes that gap.
 *
 * `baselineStore.js` owns the READ side the baseline math consumes
 * (loadSnapshotSeries) and the baseline rows (upsertBaseline/getBaselines).
 * This module owns the snapshot upsert + the "latest observed day" reader the
 * anomaly check compares against a baseline.
 *
 * Snapshots store NUMERIC AGGREGATES ONLY (no PHI).
 */

import { query } from '../../../db.js';

/**
 * Upsert one ops_daily_snapshots row. Idempotent on the table's UNIQUE key
 * (client_user_id, snapshot_date, service, scope_type, scope_id) so a re-run on
 * the same day overwrites rather than duplicates.
 *
 * @param {object} row
 * @param {string} row.client_user_id
 * @param {string} row.snapshot_date   ISO 'YYYY-MM-DD'
 * @param {string} row.service
 * @param {string} row.scope_type
 * @param {string} row.scope_id
 * @param {object} row.metrics_json     flat map metricName -> number (+ extras)
 * @param {string|null} [row.source_run_id]
 * @returns {Promise<object>} the persisted row
 */
export async function upsertSnapshot({
  client_user_id, snapshot_date, service, scope_type, scope_id,
  metrics_json = {}, source_run_id = null
}) {
  if (!client_user_id) throw new Error('upsertSnapshot: client_user_id required');
  if (!snapshot_date) throw new Error('upsertSnapshot: snapshot_date required');
  if (!service || !scope_type || scope_id === undefined || scope_id === null) {
    throw new Error('upsertSnapshot: service, scope_type, scope_id required');
  }
  const { rows } = await query(
    `INSERT INTO ops_daily_snapshots
       (client_user_id, snapshot_date, service, scope_type, scope_id, metrics_json, source_run_id)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     ON CONFLICT (client_user_id, snapshot_date, service, scope_type, scope_id)
     DO UPDATE SET metrics_json = EXCLUDED.metrics_json,
                   source_run_id = EXCLUDED.source_run_id,
                   captured_at = NOW()
     RETURNING *`,
    [client_user_id, snapshot_date, service, scope_type, String(scope_id),
     JSON.stringify(metrics_json), source_run_id]
  );
  return rows[0];
}

/**
 * The most recent snapshot date on record for a client (across all services),
 * or null when the client has no snapshots. Used as the default asOf for the
 * anomaly check (the "today" we compare against the baseline).
 */
export async function getLatestSnapshotDate({ clientUserId }) {
  const { rows } = await query(
    `SELECT MAX(snapshot_date)::text AS d FROM ops_daily_snapshots WHERE client_user_id = $1`,
    [clientUserId]
  );
  return rows[0]?.d || null;
}

/**
 * For each distinct (service, scope_type, scope_id) the client has, return the
 * single most-recent snapshot row on/at-or-before `asOf` (DISTINCT ON). This is
 * the observed "latest day" the anomaly check scores against stored baselines.
 *
 * @returns {Promise<Array<{service,scope_type,scope_id,snapshot_date,metrics_json}>>}
 */
export async function listLatestScopeSnapshots({ clientUserId, asOf = null }) {
  const params = [clientUserId];
  let dateFilter = '';
  if (asOf) {
    params.push(asOf);
    dateFilter = `AND snapshot_date <= $2::date`;
  }
  const { rows } = await query(
    `SELECT DISTINCT ON (service, scope_type, scope_id)
            service, scope_type, scope_id,
            snapshot_date::text AS snapshot_date,
            metrics_json
       FROM ops_daily_snapshots
      WHERE client_user_id = $1 ${dateFilter}
      ORDER BY service, scope_type, scope_id, snapshot_date DESC`,
    params
  );
  return rows;
}

/**
 * Distinct (service, scope_type, scope_id, metric) series for a client, derived
 * from the numeric keys present in metrics_json across all snapshot rows. The
 * baseline recompute iterates these so every metric that has history gets a
 * baseline.
 *
 * @returns {Promise<Array<{service,scope_type,scope_id,metric}>>}
 */
export async function listSnapshotSeriesKeys({ clientUserId, asOf = null }) {
  const params = [clientUserId];
  let dateFilter = '';
  if (asOf) {
    params.push(asOf);
    dateFilter = `AND snapshot_date <= $2::date`;
  }
  const { rows } = await query(
    `SELECT DISTINCT service, scope_type, scope_id, m.key AS metric
       FROM ops_daily_snapshots s,
            LATERAL jsonb_each(s.metrics_json) AS m(key, value)
      WHERE s.client_user_id = $1 ${dateFilter}
        AND jsonb_typeof(m.value) = 'number'
      ORDER BY service, scope_type, scope_id, metric`,
    params
  );
  return rows;
}
