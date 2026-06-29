/**
 * Outgoing notification router — Phase 1.
 * Loads ops data, renders a card, and dispatches via sendWebhookMessage.
 * All DB reads are injectable for testing.
 */
import { query } from '../../../db.js';
import { resolveClientWebhookUrl, sendWebhookMessage } from './googleChatWebhook.js';
import {
  renderDailyDigestCard,
  renderCriticalAlertCard,
  renderApprovalNeededCard,
  renderActionResultCard
} from './renderGoogleChatDigest.js';

async function loadClientName(clientUserId, queryFn = query) {
  const { rows } = await queryFn(
    `SELECT COALESCE(cp.business_name, u.name, u.email) AS display_name
       FROM users u
       LEFT JOIN client_profiles cp ON cp.user_id = u.id
      WHERE u.id = $1 LIMIT 1`,
    [clientUserId]
  );
  return rows[0]?.display_name || 'Unknown Client';
}

async function dispatch(webhookUrl, { cardsV2, threadKey }, meta, deps) {
  const sendFn = deps.sendFn || sendWebhookMessage;
  return sendFn({
    webhookUrl,
    cardsV2,
    threadKey,
    clientUserId: meta.clientUserId,
    eventType: meta.eventType,
    referenceId: meta.referenceId,
    referenceType: meta.referenceType
  });
}

export async function sendDailyDigest({ clientUserId, runId }, deps = {}) {
  const { resolveWebhookUrl = resolveClientWebhookUrl, queryFn = query } = deps;

  const webhookUrl = await resolveWebhookUrl(clientUserId);
  if (!webhookUrl) return { skipped: true, reason: 'no_webhook_url' };

  const clientName = await loadClientName(clientUserId, queryFn);

  const { rows: runRows } = await queryFn(
    `SELECT id, client_user_id, tier, status FROM ops_runs WHERE id = $1 LIMIT 1`,
    [runId]
  );
  const run = runRows[0];
  if (!run) return { skipped: true, reason: 'run_not_found' };

  const { rows: findingRows } = await queryFn(
    `SELECT id, severity, category, summary
       FROM ops_findings
      WHERE run_id = $1 AND status NOT IN ('resolved','ignored')
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        attention_score DESC NULLS LAST
      LIMIT 10`,
    [runId]
  );

  const findingCounts = { critical: 0, warning: 0, info: 0 };
  for (const f of findingRows) {
    findingCounts[f.severity] = (findingCounts[f.severity] || 0) + 1;
  }

  const card = renderDailyDigestCard({
    runId: run.id,
    clientName,
    runStatus: run.status,
    tier: run.tier,
    findingCounts,
    topFindings: findingRows
  });

  return dispatch(webhookUrl, card, { clientUserId, eventType: 'daily_digest', referenceId: runId, referenceType: 'run' }, deps);
}

export async function sendCriticalAlert({ clientUserId, findingId }, deps = {}) {
  const { resolveWebhookUrl = resolveClientWebhookUrl, queryFn = query } = deps;

  const webhookUrl = await resolveWebhookUrl(clientUserId);
  if (!webhookUrl) return { skipped: true, reason: 'no_webhook_url' };

  const clientName = await loadClientName(clientUserId, queryFn);

  const { rows } = await queryFn(
    `SELECT id, severity, category, summary, business_impact
       FROM ops_findings WHERE id = $1 LIMIT 1`,
    [findingId]
  );
  const finding = rows[0];
  if (!finding) return { skipped: true, reason: 'finding_not_found' };

  const card = renderCriticalAlertCard({
    findingId: finding.id,
    clientName,
    summary: finding.summary,
    severity: finding.severity,
    category: finding.category,
    businessImpact: finding.business_impact
  });

  return dispatch(webhookUrl, card, { clientUserId, eventType: 'critical_alert', referenceId: findingId, referenceType: 'finding' }, deps);
}

export async function sendApprovalNeeded({ clientUserId, actionRecommendationId }, deps = {}) {
  const { resolveWebhookUrl = resolveClientWebhookUrl, queryFn = query } = deps;

  const webhookUrl = await resolveWebhookUrl(clientUserId);
  if (!webhookUrl) return { skipped: true, reason: 'no_webhook_url' };

  const clientName = await loadClientName(clientUserId, queryFn);

  let rec;
  try {
    const { rows } = await queryFn(
      `SELECT id, abstract_action_type AS action_type, risk_tier AS risk_level, summary
         FROM ops_action_recommendations
        WHERE id = $1 AND status = 'proposed' LIMIT 1`,
      [actionRecommendationId]
    );
    rec = rows[0];
  } catch (err) {
    if (err.message.includes('does not exist')) return { skipped: true, reason: 'f4_not_built' };
    throw err;
  }
  if (!rec) return { skipped: true, reason: 'action_rec_not_found_or_not_pending' };

  const card = renderApprovalNeededCard({
    actionRecommendationId: rec.id,
    clientName,
    actionType: rec.action_type,
    riskLevel: rec.risk_level,
    summary: rec.summary
  });

  return dispatch(webhookUrl, card, { clientUserId, eventType: 'approval_needed', referenceId: actionRecommendationId, referenceType: 'action_recommendation' }, deps);
}

export async function sendActionResult({ clientUserId, actionRecommendationId, outcome, detail }, deps = {}) {
  const { resolveWebhookUrl = resolveClientWebhookUrl, queryFn = query } = deps;

  const webhookUrl = await resolveWebhookUrl(clientUserId);
  if (!webhookUrl) return { skipped: true, reason: 'no_webhook_url' };

  const clientName = await loadClientName(clientUserId, queryFn);

  let actionType = 'action';
  try {
    const { rows } = await queryFn(
      `SELECT abstract_action_type AS action_type FROM ops_action_recommendations WHERE id = $1 LIMIT 1`,
      [actionRecommendationId]
    );
    actionType = rows[0]?.action_type || 'action';
  } catch {
    // F4 not built — still send with generic label
  }

  const card = renderActionResultCard({ actionRecommendationId, clientName, actionType, outcome, detail });
  return dispatch(webhookUrl, card, { clientUserId, eventType: 'action_result', referenceId: actionRecommendationId, referenceType: 'action_recommendation' }, deps);
}
