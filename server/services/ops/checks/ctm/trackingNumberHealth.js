/**
 * ctm.tracking_number_health
 *
 * Checks the client's CTM/Twilio tracking numbers for: inactive state and
 * zero call activity in the last N days. Emits one finding per problem number.
 *
 * Data model adaptation:
 *   - Tracking numbers live in `twilio_tracking_numbers`, not a CTM-specific table.
 *   - The table has `is_active` (boolean) rather than a `status`/`last_error` column.
 *   - `listTrackingNumbers` maps `is_active=false` → status='inactive'; last_error is always null.
 *   - The 'disabled'/'error' checks in the template are merged: status='inactive' → critical finding.
 *   - Call counts query `call_logs` via tracking_number_id FK (with to_number fallback).
 */
import { registerCheck } from '../registry.js';
import { listTrackingNumbers, getNumberCallCount } from '../../../ctm.js';

const STALE_DAYS = 14;

async function handler({ clientUserId }) {
  const numbers = await listTrackingNumbers({ clientUserId });
  const findings = [];
  for (const n of numbers) {
    if (n.status === 'inactive') {
      findings.push({ severity: 'critical', number: n.formatted_number, reason: 'disabled' });
      continue;
    }
    const count = await getNumberCallCount({ clientUserId, numberId: n.id, days: STALE_DAYS });
    if (count === 0) {
      findings.push({ severity: 'warning', number: n.formatted_number, reason: `no calls in ${STALE_DAYS}d` });
    }
  }
  return {
    status: findings.length ? 'warn' : 'ok',
    severity: findings.some((f) => f.severity === 'critical') ? 'critical' : (findings.length ? 'warning' : 'info'),
    payload: { numbers_checked: numbers.length, findings },
    cost_cents: 0
  };
}

registerCheck('ctm.tracking_number_health', {
  umbrella: 'ctm',
  tier: 'daily_essential',
  handler,
  costEstimate: 0,
  requires: ['ctm']
});

export { handler };
