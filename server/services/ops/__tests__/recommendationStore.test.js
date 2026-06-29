import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createRecommendation, getRecommendation, listRecommendations,
  setRecommendationDecision, setRecommendationResult
} from '../recommendations/recommendationStore.js';

test('recommendation store: create → list → decision → result round-trips', async () => {
  const clientUserId = crypto.randomUUID();
  const created = await createRecommendation({
    clientUserId,
    findingIds: [crypto.randomUUID()],
    category: 'correlation.gtm_missing_with_kinsta_drift',
    title: 'Clear cache after deploy stripped GTM',
    summary: 'Deploy likely stripped the tracking snippet.',
    rationale: 'Kinsta drift + GTM missing correlate.',
    abstractActionType: 'website.clear_cache',
    actionArgs: { scope: 'full' },
    mutating: true,
    destructive: false,
    budgetDeltaCents: 0,
    riskScore: 72.5,
    riskTier: 'high',
    approvalLevel: 'approval_required',
    policyReasons: ['mutating action; mutations disabled by default'],
    priority: 1
  });
  assert.ok(created.id);
  assert.equal(created.status, 'proposed');
  assert.equal(created.approval_level, 'approval_required');
  assert.equal(created.mutating, true);

  const listed = await listRecommendations({ clientUserId, status: 'proposed' });
  assert.ok(listed.some((r) => r.id === created.id));

  const approvalRow = await query_approval(clientUserId);
  const decided = await setRecommendationDecision(created.id, { status: 'approved', approvalId: approvalRow });
  assert.equal(decided.status, 'approved');
  assert.equal(decided.approval_id, approvalRow);
  assert.ok(decided.decided_at);

  const done = await setRecommendationResult(created.id, {
    status: 'executed',
    preflight: { blastRadius: 1 },
    verification: { ok: true },
    executedAt: new Date()
  });
  assert.equal(done.status, 'executed');
  assert.deepEqual(done.verification_json, { ok: true });
  assert.ok(done.executed_at);

  const fetched = await getRecommendation(created.id);
  assert.equal(fetched.id, created.id);
});

async function query_approval(clientUserId) {
  const { query } = await import('../../../db.js');
  const { rows } = await query(
    `INSERT INTO ops_tool_approvals (run_id, user_id, tool_name, args_hash, args_json)
     VALUES (NULL, $1, $2, $3, $4) RETURNING id`,
    [clientUserId, 'website.clear_cache', 'hash', {}]
  );
  return rows[0].id;
}
