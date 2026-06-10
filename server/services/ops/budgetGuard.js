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
 * Returns `{ allowed, capCents, spendCents }`. If `allowed === false`, the
 * caller (scheduleFanout) should skip enqueue + persist a `budget.throttled`
 * finding via `recordBudgetThrottle`.
 */
export async function checkBudget(clientUserId) {
  const [capCents, spendCents] = await Promise.all([
    getMonthlyCapCents(clientUserId),
    getMonthToDateSpendCents(clientUserId)
  ]);
  return {
    allowed: spendCents < capCents,
    capCents,
    spendCents
  };
}

export async function recordBudgetThrottle(clientUserId, runDefinitionId, capCents, spendCents) {
  const { rows } = await query(
    `
    INSERT INTO ops_findings
      (run_id, client_user_id, severity, category, summary, evidence_json)
    VALUES (NULL, $1, 'warning', 'budget.throttled', $2, $3)
    RETURNING id
    `,
    [
      clientUserId,
      `Skipped scheduled run — month-to-date spend ${spendCents}¢ is at or above cap ${capCents}¢`,
      { run_definition_id: runDefinitionId, cap_cents: capCents, spend_cents: spendCents }
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
