/**
 * ctm.webhook_sync
 *
 * Inspects recency of CTM webhook deliveries. Source of truth: call_logs
 * (the unified leads table). If the client has zero historic calls or no
 * call within STALE_HOURS, emit a warning.
 */
import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';

const STALE_HOURS = 24;

async function handler({ clientUserId }) {
  const { rows } = await query(
    `SELECT MAX(created_at) AS last_at FROM call_logs WHERE owner_user_id = $1`,
    [clientUserId]
  );
  const last = rows[0]?.last_at ? new Date(rows[0].last_at) : null;
  const findings = [];
  if (!last) {
    findings.push({ severity: 'warning', reason: 'no calls ever received via CTM' });
  } else {
    const hours = (Date.now() - last.getTime()) / 3_600_000;
    if (hours > STALE_HOURS) {
      findings.push({
        severity: 'warning',
        reason: `last CTM call was ${hours.toFixed(1)}h ago`,
        last_at: last.toISOString()
      });
    }
  }
  return {
    status: findings.length ? 'warn' : 'ok',
    severity: findings.length ? 'warning' : 'info',
    payload: { last_call_at: last?.toISOString() || null, findings },
    cost_cents: 0
  };
}

registerCheck('ctm.webhook_sync', {
  umbrella: 'ctm',
  tier: 'daily_essential',
  handler,
  costEstimate: 0,
  requires: ['ctm']
});

export { handler };
