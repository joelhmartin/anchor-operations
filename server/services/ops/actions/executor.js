/**
 * Action engine executor. Every mutation: policy gate → resolve provider action →
 * preflight → execute → verify → audit (reusing the ops_tool_approvals chain) →
 * persist. All boundaries injected; defaults wire the real modules.
 */
import crypto from 'node:crypto';
import { query } from '../../../db.js';
import { gateForExecution } from './policy.js';
import { resolveAction } from './registry.js';
import { runPreflight } from './preflight.js';
import * as auditMod from './audit.js';
import { getRecommendation as getRecommendationDefault, setRecommendationDecision as setDecisionDefault, setRecommendationResult as setResultDefault } from '../recommendations/recommendationStore.js';
import { loadClientPolicyContext } from '../policyContext.js';

function hashArgs(args) {
  return crypto.createHash('sha256').update(JSON.stringify(args || {})).digest('hex');
}

async function defaultInsertApproval({ userId, recommendation, providerActionType, args }) {
  const { rows } = await query(
    `INSERT INTO ops_tool_approvals (run_id, user_id, tool_name, args_hash, args_json, finding_id)
     VALUES (NULL, $1, $2, $3, $4, $5) RETURNING id`,
    [userId, providerActionType, hashArgs(args), args || {}, recommendation.finding_ids?.[0] || null]
  );
  return rows[0].id;
}

async function defaultFinalizeApproval(approvalId, payload) {
  await query(
    `UPDATE ops_tool_approvals SET approved_at = COALESCE(approved_at, NOW()), executed_at = NOW(), execution_result_json = $2 WHERE id = $1`,
    [approvalId, payload || {}]
  );
}

async function defaultCapabilities(clientUserId) {
  try {
    const mod = await import('../connections/registry.js'); // F1
    if (typeof mod.loadCapabilities === 'function') return await mod.loadCapabilities(clientUserId);
  } catch { /* F1 not present yet */ }
  return [];
}

export async function verifyAction({ connector, providerActionType, actionArgs, ctx }) {
  try {
    const pf = connector?.actions?.preflight;
    if (typeof pf !== 'function') return { ok: true, detail: 'unverified' };
    const after = await pf(providerActionType, actionArgs, ctx);
    return { ok: true, detail: after?.currentState ?? 'verified' };
  } catch (err) {
    return { ok: true, detail: `unverified: ${err?.message || err}` };
  }
}

export async function executeAction({ recommendationId, userId, actorIsAdmin = true }, deps = {}) {
  const {
    getRecommendation = getRecommendationDefault,
    setRecommendationResult = setResultDefault,
    policyContext = loadClientPolicyContext,
    resolve = resolveAction,
    preflight = runPreflight,
    capabilities = defaultCapabilities,
    audit = auditMod,
    finalizeApproval = defaultFinalizeApproval
  } = deps;

  const rec = await getRecommendation(recommendationId);
  if (!rec) return { ok: false, status: 'failed', error: 'recommendation not found' };

  const norm = {
    abstractActionType: rec.abstract_action_type,
    mutating: rec.mutating,
    destructive: rec.destructive,
    budgetDeltaCents: rec.budget_delta_cents,
    riskTier: rec.risk_tier,
    approvalLevel: rec.approval_level
  };
  const ctx = await policyContext(rec.client_user_id);
  const gate = gateForExecution(norm, { clientType: ctx.clientType, mutationsEnabled: ctx.mutationsEnabled, actorIsAdmin });
  if (!gate.allow) {
    const status = gate.requiredLevel === 'blocked' ? 'blocked' : 'failed';
    await setRecommendationResult(recommendationId, { status });
    return { ok: false, status, reasons: gate.reasons };
  }

  const caps = await capabilities(rec.client_user_id);
  const resolved = await resolve(norm.abstractActionType, { capabilities: caps });
  if (!resolved.ok) {
    await setRecommendationResult(recommendationId, { status: 'failed', preflight: { resolveError: resolved.reason } });
    return { ok: false, status: 'failed', error: resolved.reason };
  }

  const actionArgs = rec.action_args_json || {};
  const execCtx = { userId, clientUserId: rec.client_user_id };
  const pf = await preflight({ providerActionType: resolved.providerActionType, actionArgs, connector: resolved.connector, ctx: execCtx });
  if (!pf.ok) {
    await setRecommendationResult(recommendationId, { status: 'failed', preflight: pf });
    return { ok: false, status: 'failed', error: pf.error };
  }

  await audit.auditApproved({ userId, recommendationId, approvalId: rec.approval_id, providerActionType: resolved.providerActionType });

  let result, ok = false;
  try {
    result = await resolved.connector.actions.execute(resolved.providerActionType, actionArgs, execCtx);
    ok = !result?.error;
  } catch (err) {
    result = { error: err?.message || String(err) };
    ok = false;
  }

  const verification = ok ? await verifyAction({ connector: resolved.connector, providerActionType: resolved.providerActionType, actionArgs, ctx: execCtx }) : null;

  await audit.auditExecuted({ userId, recommendationId, approvalId: rec.approval_id, providerActionType: resolved.providerActionType, success: ok, failureReason: ok ? null : result?.error });
  if (rec.approval_id) await finalizeApproval(rec.approval_id, { ok, result, verification });
  await setRecommendationResult(recommendationId, { status: ok ? 'executed' : 'failed', preflight: pf, verification, executedAt: new Date() });

  return { ok, status: ok ? 'executed' : 'failed', result };
}

export async function proposeAction({ recommendationId, userId }, deps = {}) {
  const {
    getRecommendation = getRecommendationDefault,
    setRecommendationDecision = setDecisionDefault,
    capabilities = defaultCapabilities,
    resolve = resolveAction,
    insertApproval = defaultInsertApproval,
    audit = auditMod
  } = deps;

  const rec = await getRecommendation(recommendationId);
  if (!rec) return { error: 'recommendation not found' };
  if (rec.approval_level === 'blocked') return { error: 'recommendation is blocked' };
  if (!rec.mutating || !rec.abstract_action_type) return { error: 'advisory recommendation; nothing to execute' };

  const caps = await capabilities(rec.client_user_id);
  const resolved = await resolve(rec.abstract_action_type, { capabilities: caps });
  const providerActionType = resolved.ok ? resolved.providerActionType : rec.abstract_action_type;

  const approvalId = await insertApproval({ userId, recommendation: rec, providerActionType, args: rec.action_args_json || {} });
  await audit.auditProposed({ userId, clientUserId: rec.client_user_id, recommendationId, approvalId, providerActionType, argsHash: hashArgs(rec.action_args_json || {}) });

  const autoRun = rec.approval_level === 'none';
  await setRecommendationDecision(recommendationId, { status: autoRun ? 'approved' : 'proposed', approvalId });
  return { approvalId, status: autoRun ? 'approved' : 'proposed' };
}

export async function rejectAction({ recommendationId, userId, reason }, deps = {}) {
  const {
    getRecommendation = getRecommendationDefault,
    setRecommendationDecision = setDecisionDefault,
    finalizeApproval = defaultFinalizeApproval,
    audit = auditMod
  } = deps;
  const rec = await getRecommendation(recommendationId);
  if (!rec) return { error: 'recommendation not found' };
  await setRecommendationDecision(recommendationId, { status: 'rejected', approvalId: rec.approval_id || null });
  if (rec.approval_id) await finalizeApproval(rec.approval_id, { rejected: true, reason: String(reason || '').slice(0, 500) || null });
  await audit.auditRejected({ userId, recommendationId, approvalId: rec.approval_id, reason });
  return { ok: true };
}

export default { proposeAction, executeAction, rejectAction, verifyAction };
