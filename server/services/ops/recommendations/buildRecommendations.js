/**
 * Recommendation pipeline orchestrator (north-star §16.2 deterministic-first).
 * collect → compute risk → compare F3 baselines → group → LLM summarize/prioritize
 * → policy decides approval → persist. Every number is computed before the single
 * LLM call; the LLM only drafts prose + priority. All boundaries are injected.
 */
import { query } from '../../../db.js';
import { groupFindings } from './groupFindings.js';
import { buildAbstractAction } from './actionFactory.js';
import { scoreRisk } from './riskScorer.js';
import { decideApproval, isBlocked } from './policyApplicator.js';
import { summarizeGroup } from './summarizeFindings.js';
import { createRecommendation as createRecommendationDefault } from './recommendationStore.js';
import { loadClientPolicyContext } from '../policyContext.js';

async function defaultLoadFindings(clientUserId, runId) {
  const params = [clientUserId];
  let where = `client_user_id = $1 AND resolved_at IS NULL`;
  if (runId) { params.push(runId); where += ` AND run_id = $2`; }
  const { rows } = await query(
    `SELECT id, client_user_id, run_id, severity, category, summary,
            affected_platforms, business_impact, attention_score,
            linked_check_result_ids, created_at
       FROM ops_findings WHERE ${where} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  return rows;
}

// F3 stub: returns null until ops_metric_baselines lands. baselineDelta = null ⇒ neutral risk.
async function defaultBaselineLookup() { return null; }

function computeBaselineDelta(baseline, finding) {
  // F3 stores baseline_value (mean) and stddev — align with ops_metric_baselines schema.
  if (!baseline || !Number.isFinite(baseline.stddev) || baseline.stddev <= 0) return null;
  const observed = Number(finding.attention_score);
  if (!Number.isFinite(observed)) return null;
  return Math.max(0, (observed - baseline.baseline_value) / baseline.stddev);
}

export async function buildRecommendations({ clientUserId, runId = null }, deps = {}) {
  const {
    loadFindings = (c, r) => defaultLoadFindings(c, r),
    baselineLookup = defaultBaselineLookup,
    policyContext = loadClientPolicyContext,
    summarize = (group, computed) => summarizeGroup(group, computed, { llm: deps.llm }),
    store = { createRecommendation: createRecommendationDefault }
  } = deps;

  const findings = await loadFindings(clientUserId, runId);
  const groups = groupFindings(findings);
  if (!groups.length) return { recommendations: [] };

  const ctx = await policyContext(clientUserId);
  const recommendations = [];

  for (const group of groups) {
    const action = buildAbstractAction(group);

    // Enrich with F3 baseline anomaly (deterministic).
    const baseline = await baselineLookup({ clientUserId, metric: group.category });
    const baselineDelta = computeBaselineDelta(baseline, group.findings[0] || {});

    const risk = scoreRisk(
      { severity: group.severity, affectedPlatformCount: group.affectedPlatforms.length, businessImpact: Boolean(group.findings[0]?.business_impact), baselineDelta },
      { clientType: ctx.clientType, destructive: action.destructive, mutating: action.mutating, budgetDeltaCents: action.budgetDeltaCents }
    );

    const decision = decideApproval(
      { abstractActionType: action.abstractActionType, mutating: action.mutating, destructive: action.destructive, budgetDeltaCents: action.budgetDeltaCents, riskTier: risk.tier },
      { clientType: ctx.clientType, mutationsEnabled: ctx.mutationsEnabled }
    );

    const computed = { riskScore: risk.score, riskTier: risk.tier, approvalLevel: decision.approvalLevel, baselineDelta };
    const draft = await summarize(group, computed);

    const row = await store.createRecommendation({
      clientUserId,
      runId,
      findingIds: group.findingIds,
      category: group.category,
      title: draft.title,
      summary: draft.summary,
      rationale: draft.rationale,
      abstractActionType: action.abstractActionType,
      actionArgs: action.actionArgs,
      mutating: action.mutating,
      destructive: action.destructive,
      budgetDeltaCents: action.budgetDeltaCents,
      riskScore: risk.score,
      riskTier: risk.tier,
      approvalLevel: decision.approvalLevel,
      policyReasons: decision.reasons,
      status: isBlocked(decision.approvalLevel) ? 'blocked' : 'proposed',
      priority: draft.priority
    });
    recommendations.push(row);
  }

  return { recommendations };
}

export default { buildRecommendations };
