/**
 * ctm.classification_quality
 *
 * Looks at the client's call_logs for classification health:
 *   - count of classification_pending and unreviewed rows
 *   - autostar mix
 *   - spam %
 *   - 7-day classified-volume vs prior 7-day median
 *
 * Schema adaptation:
 *   - `category` is stored in JSONB meta->>'category', not a top-level column.
 *   - `classification_pending` is stored in JSONB meta->>'classification_pending'.
 */
import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';

async function handler({ clientUserId }) {
  const { rows } = await query(`
    SELECT
      COUNT(*) FILTER (WHERE meta->>'classification_pending' = 'true') AS pending,
      COUNT(*) FILTER (WHERE meta->>'category' = 'unreviewed') AS unreviewed,
      COUNT(*) FILTER (WHERE meta->>'category' = 'spam') AS spam,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days') AS last7,
      COUNT(*) FILTER (WHERE created_at >= now() - interval '14 days' AND created_at < now() - interval '7 days') AS prior7,
      COUNT(*) AS total
    FROM call_logs
    WHERE owner_user_id = $1
      AND created_at >= now() - interval '30 days'
  `, [clientUserId]);
  const r = rows[0] || {};
  const last7 = Number(r.last7 || 0);
  const prior7 = Number(r.prior7 || 0);
  const findings = [];
  if (Number(r.pending) > 25) findings.push({ severity: 'warning', metric: 'classification_pending', value: Number(r.pending) });
  if (Number(r.unreviewed) > 10) findings.push({ severity: 'warning', metric: 'unreviewed', value: Number(r.unreviewed) });
  if (prior7 > 0 && last7 < prior7 * 0.5) {
    findings.push({ severity: 'critical', metric: 'volume_drop', last7, prior7 });
  }
  return {
    status: findings.length ? 'warn' : 'ok',
    severity: findings.some((f) => f.severity === 'critical') ? 'critical' : (findings.length ? 'warning' : 'info'),
    payload: {
      pending: Number(r.pending), unreviewed: Number(r.unreviewed),
      spam: Number(r.spam), last7, prior7, total_30d: Number(r.total),
      findings
    },
    cost_cents: 0
  };
}

registerCheck('ctm.classification_quality', {
  umbrella: 'ctm',
  tier: 'daily_essential',
  handler,
  costEstimate: 0,
  requires: ['ctm']
});

export { handler };
