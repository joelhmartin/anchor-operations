import { query } from '../../../db.js';

export async function loadSnapshotSeries({
  clientUserId, service, scopeType, scopeId, metric, asOf, lookbackDays = 95
}) {
  const { rows } = await query(
    `SELECT snapshot_date::text AS date, (metrics_json->>$6)::numeric AS value
       FROM ops_daily_snapshots
      WHERE client_user_id = $1
        AND service = $2
        AND scope_type = $3
        AND scope_id = $4
        AND snapshot_date < $5::date
        AND snapshot_date >= ($5::date - $7::int)
        AND metrics_json ? $6
      ORDER BY snapshot_date ASC`,
    [clientUserId, service, scopeType, scopeId, asOf, metric, lookbackDays]
  );
  return rows
    .filter((r) => r.value !== null)
    .map((r) => ({ date: r.date, value: Number(r.value) }))
    .filter((r) => Number.isFinite(r.value));
}

export async function upsertBaseline({
  clientUserId, service, scopeType, scopeId, metric, period,
  baseline_value, stddev, sample_count, window_start, window_end
}) {
  const { rows } = await query(
    `INSERT INTO ops_metric_baselines
       (client_user_id, service, scope_type, scope_id, metric, period,
        baseline_value, stddev, sample_count, window_start, window_end, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
     ON CONFLICT (client_user_id, service, scope_type, scope_id, metric, period)
     DO UPDATE SET baseline_value = EXCLUDED.baseline_value,
                   stddev = EXCLUDED.stddev,
                   sample_count = EXCLUDED.sample_count,
                   window_start = EXCLUDED.window_start,
                   window_end = EXCLUDED.window_end,
                   computed_at = NOW()
     RETURNING *`,
    [clientUserId, service, scopeType, scopeId, metric, period,
     baseline_value, stddev, sample_count, window_start, window_end]
  );
  return rows[0];
}

export async function getBaselines({ clientUserId, service, scopeType, scopeId, metric }) {
  const { rows } = await query(
    `SELECT * FROM ops_metric_baselines
      WHERE client_user_id = $1 AND service = $2 AND scope_type = $3
        AND scope_id = $4 AND metric = $5
      ORDER BY period ASC`,
    [clientUserId, service, scopeType, scopeId, metric]
  );
  return rows;
}
