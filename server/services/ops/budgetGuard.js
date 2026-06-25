/**
 * Budget guard — Phase 8.
 *
 * Per-client month-to-date spend vs `client_profiles.ops_monthly_cap_cents`.
 * Scheduled fanout consults this before enqueueing a run; over-cap clients
 * get skipped + a `budget.throttled` finding is written so the cap is visible.
 *
 * Manual triggers from `POST /api/ops/runs` bypass the cap (admin override)
 * but emit `operations.run_manual_override_budget` for audit.
 */

import { query } from '../../db.js';
import { recomputeForFinding } from './attentionScore.js';

const DEFAULT_CAP_CENTS = 500;

// Estimated headroom a pending run requires before it can be enqueued.
// Mirrors `TIER_BUDGET_CENTS` in `runExecutor.js` — keep in sync. Tier budget
// is the executor's hard per-run ceiling, so using it as the pre-enqueue
// estimate is conservative-but-safe: a run that fits the cap by this estimate
// will never push month-to-date spend above the cap by more than a partial
// over-shoot during its final check (which the executor itself halts on).
const TIER_BUDGET_CENTS = {
  daily_essential: 50,
  weekly_deep: 200,
  monthly_audit: 500,
  on_demand: 250
};
const DEFAULT_RUN_ESTIMATE_CENTS = 250;

/**
 * Resolve the estimated cost of a pending run, in cents. Callers can pass
 * an explicit `estimateCents` to override the tier default (e.g. a definition
 * with a known cheaper/expensive shape). When neither is given the gate
 * degrades to the legacy "spend < cap" check by treating the estimate as 0.
 */
export function estimateRunCostCents({ tier, estimateCents } = {}) {
  if (Number.isFinite(estimateCents) && estimateCents >= 0) return estimateCents;
  if (!tier) return 0;
  return TIER_BUDGET_CENTS[tier] ?? DEFAULT_RUN_ESTIMATE_CENTS;
}

export async function getMonthlyCapCents(clientUserId) {
  if (!clientUserId) return DEFAULT_CAP_CENTS;
  const { rows } = await query(
    `SELECT ops_monthly_cap_cents FROM client_profiles WHERE user_id = $1`,
    [clientUserId]
  );
  const cap = rows[0]?.ops_monthly_cap_cents;
  return Number.isFinite(cap) ? cap : DEFAULT_CAP_CENTS;
}

export async function getMonthToDateSpendCents(clientUserId) {
  if (!clientUserId) return 0;
  const { rows } = await query(
    `
    SELECT COALESCE(SUM(cost_estimate_cents), 0)::INT AS spend
      FROM ops_runs
     WHERE client_user_id = $1
       AND created_at >= date_trunc('month', NOW())
    `,
    [clientUserId]
  );
  return rows[0]?.spend || 0;
}

/**
 * Returns `{ allowed, capCents, spendCents, estimateCents }`. The gate is
 * projected: `spendCents + estimateCents <= capCents`. Callers should pass
 * the run's `tier` (and/or an explicit `estimateCents`) so the pending run's
 * cost enters the decision — without it, the function degrades to the legacy
 * "spend strictly less than cap" check (estimate = 0).
 *
 * If `allowed === false`, the caller (scheduleFanout) should skip enqueue +
 * persist a `budget.throttled` finding via `recordBudgetThrottle`.
 */
export async function checkBudget(clientUserId, options = {}) {
  const [capCents, spendCents] = await Promise.all([
    getMonthlyCapCents(clientUserId),
    getMonthToDateSpendCents(clientUserId)
  ]);
  const estimateCents = estimateRunCostCents(options);
  return {
    allowed: spendCents + estimateCents <= capCents,
    capCents,
    spendCents,
    estimateCents
  };
}

export async function recordBudgetThrottle(
  clientUserId,
  runDefinitionId,
  capCents,
  spendCents,
  estimateCents = 0
) {
  const projectedCents = spendCents + estimateCents;
  const summary = estimateCents > 0
    ? `Skipped scheduled run — projected spend ${spendCents}¢ + estimate ${estimateCents}¢ = ${projectedCents}¢ would exceed cap ${capCents}¢`
    : `Skipped scheduled run — month-to-date spend ${spendCents}¢ is at or above cap ${capCents}¢`;
  const { rows } = await query(
    `
    INSERT INTO ops_findings
      (run_id, client_user_id, severity, category, summary, evidence_json)
    VALUES (NULL, $1, 'warning', 'budget.throttled', $2, $3)
    RETURNING id
    `,
    [
      clientUserId,
      summary,
      {
        run_definition_id: runDefinitionId,
        cap_cents: capCents,
        spend_cents: spendCents,
        estimate_cents: estimateCents,
        projected_cents: projectedCents
      }
    ]
  );
  const findingId = rows[0]?.id;
  if (findingId) {
    try {
      await recomputeForFinding(findingId);
    } catch (err) {
      console.warn(`[ops/budgetGuard] attention-score recompute failed for ${findingId}: ${err?.message || err}`);
    }
  }
}
