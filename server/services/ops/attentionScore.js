/**
 * Attention score — Command Center ranker.
 *
 * Pure deterministic formula (no AI). Higher = more attention-worthy.
 *
 *   score =
 *       severity_weight        // critical=100, warning=40, info=10
 *     × recency_factor          // exp(-age_days / 7)
 *     × not_acked_factor        // 1.0 if acknowledged_at IS NULL else 0.3
 *     × business_impact_factor  // 1.5 if business_impact set else 1.0
 *     × correlation_factor      // 1.4 if category LIKE 'correlation.%'
 *     × budget_factor           // 1.6 if category IN ('budget.exceeded','budget.throttled')
 *
 * Recompute triggers (callers wire in):
 *   - correlator.js after persisting a correlation finding
 *   - runExecutor.js after persistBudgetExceededFinding
 *   - budgetGuard.js after recordBudgetThrottle
 *   - routes/ops.js PUT /findings/:id when status changes
 *   - routes/ops.js POST /internal/attention-recompute (Cloud Scheduler nightly)
 */

import { query } from '../../db.js';

const SEVERITY_WEIGHTS = { critical: 100, warning: 40, info: 10 };

export function computeScore(finding) {
  if (!finding) return 0;
  const severityWeight = SEVERITY_WEIGHTS[finding.severity] ?? 10;

  // Guard against missing or unparsable created_at — fall back to "fresh" so
  // we still emit a finite score the UI can rank.
  const created = finding.created_at instanceof Date ? finding.created_at : new Date(finding.created_at);
  const validCreated = created instanceof Date && !Number.isNaN(created.getTime());
  const ageDays = validCreated ? Math.max(0, (Date.now() - created.getTime()) / 86400000) : 0;
  const recency = Math.exp(-ageDays / 7);

  const notAcked = finding.acknowledged_at ? 0.3 : 1.0;
  const impact = finding.business_impact ? 1.5 : 1.0;
  const category = String(finding.category || '');
  const correlation = category.startsWith('correlation.') ? 1.4 : 1.0;
  const budget = category === 'budget.exceeded' || category === 'budget.throttled' ? 1.6 : 1.0;

  const raw = severityWeight * recency * notAcked * impact * correlation * budget;
  // 2 decimal places, fits NUMERIC(10,2).
  return Math.round(raw * 100) / 100;
}

export async function recomputeForFinding(findingId) {
  if (!findingId) return null;
  const { rows } = await query(
    `SELECT id, severity, category, created_at, acknowledged_at, business_impact
       FROM ops_findings WHERE id = $1`,
    [findingId]
  );
  const row = rows[0];
  if (!row) return null;
  const score = computeScore(row);
  await query(
    `UPDATE ops_findings
        SET attention_score = $2,
            attention_recomputed_at = NOW()
      WHERE id = $1`,
    [findingId, score]
  );
  return score;
}

/**
 * Recompute attention_score for every open/investigating finding. Invoked
 * nightly via Cloud Scheduler hitting /api/ops/internal/attention-recompute.
 * Returns the count of rows updated.
 *
 * Single batched UPDATE via unnest() to avoid N+1 round trips when a portfolio
 * accumulates hundreds of open findings.
 */
export async function recomputeAllOpen() {
  const { rows } = await query(
    `SELECT id, severity, category, created_at, acknowledged_at, business_impact
       FROM ops_findings
      WHERE status IN ('open','investigating')`
  );
  if (rows.length === 0) return 0;

  const ids = rows.map((r) => r.id);
  const scores = rows.map((r) => computeScore(r));

  await query(
    `UPDATE ops_findings AS f
        SET attention_score = s.score,
            attention_recomputed_at = NOW()
       FROM (
         SELECT UNNEST($1::uuid[]) AS id,
                UNNEST($2::numeric[]) AS score
       ) AS s
      WHERE f.id = s.id`,
    [ids, scores]
  );
  return rows.length;
}

export default { computeScore, recomputeForFinding, recomputeAllOpen };
