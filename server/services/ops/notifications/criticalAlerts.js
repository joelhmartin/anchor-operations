/**
 * Critical-finding fan-out → agency Google Chat space (V8).
 *
 * After a run's correlator produces findings, this posts ONE critical-alert
 * card per un-alerted `severity='critical'` finding into the agency's internal
 * Chat space (via sendCriticalAlert's agency-webhook fallback). It is
 * agency-internal only — no client email, no per-client notification.
 *
 * Dedup: sendWebhookMessage persists an `ops_notification_events` row per
 * dispatch (event_type='critical_alert', reference_id=<finding uuid>). Before
 * sending we check for an existing such row and skip if present, so a re-invoke
 * for the same run/finding never double-posts.
 *
 * Never throws outward — a Chat failure must never fail the run. Per-finding
 * sends are wrapped in try/catch so one bad finding can't stop the rest.
 */
import { query } from '../../../db.js';
import { sendCriticalAlert } from './notificationRouter.js';

/** True if a critical_alert event already exists for this finding. */
async function alreadyAlerted(findingId, queryFn) {
  const { rows } = await queryFn(
    `SELECT 1
       FROM ops_notification_events
      WHERE event_type = 'critical_alert' AND reference_id = $1
      LIMIT 1`,
    [findingId]
  );
  return rows.length > 0;
}

/**
 * Load the run's client + its CRITICAL findings, then post one agency Chat
 * alert per finding that has not already been alerted.
 *
 * @param {{ runId: string }} params
 * @param {object} [deps]
 * @param {Function} [deps.queryFn]  - Injectable DB query (default: db.query).
 * @param {Function} [deps.sendFn]   - Injectable single-alert sender (default: sendCriticalAlert).
 * @returns {{ sent:number, skipped:number, total:number }}
 */
export async function notifyCriticalFindings({ runId }, deps = {}) {
  const { queryFn = query, sendFn = sendCriticalAlert } = deps;
  if (!runId) return { sent: 0, skipped: 0, total: 0 };

  const { rows: runRows } = await queryFn(
    `SELECT id, client_user_id FROM ops_runs WHERE id = $1 LIMIT 1`,
    [runId]
  );
  const run = runRows[0];
  if (!run) return { sent: 0, skipped: 0, total: 0 };

  const { rows: findings } = await queryFn(
    `SELECT id FROM ops_findings WHERE run_id = $1 AND severity = 'critical'`,
    [runId]
  );

  let sent = 0;
  let skipped = 0;
  for (const f of findings) {
    try {
      if (await alreadyAlerted(f.id, queryFn)) {
        skipped++;
        continue;
      }
      const result = await sendFn(
        { clientUserId: run.client_user_id, findingId: f.id },
        deps.sendDeps || {}
      );
      if (result?.sent === false || result?.skipped) skipped++;
      else sent++;
    } catch (err) {
      skipped++;
      console.warn(`[ops/criticalAlerts] alert failed for finding ${f.id}: ${err.message}`);
    }
  }

  return { sent, skipped, total: findings.length };
}

export default { notifyCriticalFindings };
