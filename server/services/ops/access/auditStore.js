/**
 * Persistence for Access Audit runs (ops_access_audit_runs).
 * One row per audit; created in 'running', finalized to a terminal status.
 */
import { query } from '../../../db.js';

export async function createAuditRun() {
  const { rows } = await query(
    `INSERT INTO ops_access_audit_runs (status) VALUES ('running')
     RETURNING id, status, created_at`
  );
  return rows[0];
}

export async function finishAuditRun(id, {
  status,
  environment = null,
  serviceAccount = null,
  projectId = null,
  summary = {},
  details = {},
  missing = [],
  warnings = []
} = {}) {
  const { rows } = await query(
    `UPDATE ops_access_audit_runs
        SET status = $2,
            environment = $3,
            service_account = $4,
            project_id = $5,
            summary_json = $6::jsonb,
            details_json = $7::jsonb,
            missing_json = $8::jsonb,
            warnings_json = $9::jsonb,
            finished_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      id, status, environment, serviceAccount, projectId,
      JSON.stringify(summary), JSON.stringify(details),
      JSON.stringify(missing), JSON.stringify(warnings)
    ]
  );
  return rows[0] || null;
}

export async function getLatestAuditRun() {
  const { rows } = await query(
    `SELECT * FROM ops_access_audit_runs ORDER BY created_at DESC LIMIT 1`
  );
  return rows[0] || null;
}
