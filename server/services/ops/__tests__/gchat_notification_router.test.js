import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDailyDigest, sendCriticalAlert, sendApprovalNeeded } from '../notifications/notificationRouter.js';

function makeQueryFn(scenarios) {
  return async (sql, params) => {
    const s = scenarios.find((sc) => sql.includes(sc.match));
    if (!s) throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    if (s.throws) throw new Error(s.throws);
    return { rows: s.rows };
  };
}

const fakeRun = { id: 'run-1', client_user_id: 'client-1', tier: 'daily_essential', status: 'completed' };
const fakeFinding = { id: 'fnd-1', client_user_id: 'client-1', severity: 'critical', category: 'ctm.x', summary: 'Drop detected', business_impact: null };
const fakeClient = { display_name: 'ACME Corp' };

test('sendDailyDigest: skips when no webhook URL configured', async () => {
  const result = await sendDailyDigest(
    { clientUserId: 'client-1', runId: 'run-1' },
    {
      resolveWebhookUrl: async () => null,
      queryFn: makeQueryFn([
        { match: 'ops_runs', rows: [fakeRun] },
        { match: 'ops_findings', rows: [] },
        { match: 'users', rows: [fakeClient] }
      ])
    }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_webhook_url');
});

test('sendDailyDigest: calls sender and returns sent:true on success', async () => {
  let sentArgs = null;
  const result = await sendDailyDigest(
    { clientUserId: 'client-1', runId: 'run-1' },
    {
      resolveWebhookUrl: async () => 'https://chat.example.com/hook',
      sendFn: async (args) => { sentArgs = args; return { sent: true }; },
      queryFn: makeQueryFn([
        { match: 'ops_runs', rows: [fakeRun] },
        { match: 'ops_findings', rows: [fakeFinding] },
        { match: 'users', rows: [fakeClient] }
      ])
    }
  );
  assert.equal(result.sent, true);
  assert.ok(sentArgs, 'sender was called');
  assert.equal(sentArgs.eventType, 'daily_digest');
  // Verify no PII in the webhook call args
  assert.ok(!JSON.stringify(sentArgs).includes('@'), 'no email in payload');
});

test('sendDailyDigest: skips when run not found', async () => {
  const result = await sendDailyDigest(
    { clientUserId: 'c', runId: 'missing' },
    {
      resolveWebhookUrl: async () => 'https://x',
      queryFn: makeQueryFn([{ match: 'ops_runs', rows: [] }, { match: 'users', rows: [fakeClient] }])
    }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'run_not_found');
});

test('sendApprovalNeeded: degrades gracefully when F4 table missing', async () => {
  const result = await sendApprovalNeeded(
    { clientUserId: 'c', actionRecommendationId: 'ar-1' },
    {
      resolveWebhookUrl: async () => 'https://x',
      queryFn: makeQueryFn([
        { match: 'ops_action_recommendations', throws: 'relation "ops_action_recommendations" does not exist' },
        { match: 'users', rows: [fakeClient] }
      ])
    }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'f4_not_built');
});

test('sendApprovalNeeded: uses abstract_action_type and risk_tier columns (proposed status)', async () => {
  let capturedSql = null;
  const result = await sendApprovalNeeded(
    { clientUserId: 'c', actionRecommendationId: 'ar-1' },
    {
      resolveWebhookUrl: async () => 'https://x',
      sendFn: async () => ({ sent: true }),
      queryFn: async (sql, params) => {
        if (sql.includes('ops_action_recommendations')) {
          capturedSql = sql;
          return { rows: [{ id: 'ar-1', action_type: 'adjust_budget', risk_level: 'medium', summary: 'Bump budget' }] };
        }
        if (sql.includes('users')) return { rows: [{ display_name: 'ACME' }] };
        return { rows: [] };
      }
    }
  );
  assert.ok(capturedSql, 'queried ops_action_recommendations');
  assert.ok(capturedSql.includes('abstract_action_type'), 'uses abstract_action_type column');
  assert.ok(capturedSql.includes('risk_tier'), 'uses risk_tier column');
  assert.ok(capturedSql.includes("status = 'proposed'"), "queries proposed status");
});
