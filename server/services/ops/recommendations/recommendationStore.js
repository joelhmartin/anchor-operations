import { query } from '../../../db.js';

export async function createRecommendation(rec = {}) {
  const { rows } = await query(
    `INSERT INTO ops_action_recommendations
       (client_user_id, run_id, finding_ids, category, title, summary, rationale,
        abstract_action_type, action_args_json, mutating, destructive, budget_delta_cents,
        risk_score, risk_tier, approval_level, policy_reasons_json, status, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)
     RETURNING *`,
    [
      rec.clientUserId,
      rec.runId || null,
      rec.findingIds || [],
      rec.category,
      rec.title,
      rec.summary || '',
      rec.rationale || '',
      rec.abstractActionType || null,
      JSON.stringify(rec.actionArgs || {}),
      Boolean(rec.mutating),
      Boolean(rec.destructive),
      Number.isFinite(rec.budgetDeltaCents) ? rec.budgetDeltaCents : 0,
      rec.riskScore ?? null,
      rec.riskTier || null,
      rec.approvalLevel || 'approval_required',
      JSON.stringify(rec.policyReasons || []),
      rec.status || 'proposed',
      Number.isFinite(rec.priority) ? rec.priority : 100
    ]
  );
  return rows[0];
}

export async function getRecommendation(id) {
  const { rows } = await query(`SELECT * FROM ops_action_recommendations WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function listRecommendations({ clientUserId, status } = {}) {
  const clauses = [];
  const params = [];
  if (clientUserId) { params.push(clientUserId); clauses.push(`client_user_id = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM ops_action_recommendations ${where}
      ORDER BY risk_score DESC NULLS LAST, created_at DESC`,
    params
  );
  return rows;
}

export async function setRecommendationDecision(id, { status, approvalId = null, decidedAt = new Date() } = {}) {
  const { rows } = await query(
    `UPDATE ops_action_recommendations
        SET status = $2, approval_id = $3, decided_at = $4, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status, approvalId, decidedAt]
  );
  return rows[0] || null;
}

export async function setRecommendationResult(id, { status, preflight = null, verification = null, executedAt = null } = {}) {
  const { rows } = await query(
    `UPDATE ops_action_recommendations
        SET status = $2,
            preflight_json = COALESCE($3::jsonb, preflight_json),
            verification_json = COALESCE($4::jsonb, verification_json),
            executed_at = COALESCE($5, executed_at),
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status, preflight ? JSON.stringify(preflight) : null, verification ? JSON.stringify(verification) : null, executedAt]
  );
  return rows[0] || null;
}
