import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAction, rejectAction } from '../actions/executor.js';

function harness(recOver = {}) {
  const events = [];
  const rec = {
    id: 'rec-1', client_user_id: 'c1', abstract_action_type: 'website.clear_cache',
    action_args_json: { scope: 'full' }, mutating: true, destructive: false,
    budget_delta_cents: 0, risk_tier: 'medium', approval_level: 'approval_required',
    finding_ids: ['f1'], approval_id: 'appr-1', status: 'approved', ...recOver
  };
  const connector = {
    actions: {
      preflight: async () => ({ currentState: { cache: 'warm' }, assetsAffected: 1 }),
      execute: async (type, args) => ({ ok: true, cleared: true, type, args })
    }
  };
  const result = {};
  const deps = {
    getRecommendation: async () => rec,
    setRecommendationResult: async (id, p) => { result.value = { id, ...p }; return { id, ...p }; },
    policyContext: async () => ({ clientType: 'standard', mutationsEnabled: false }),
    resolve: async () => ({ ok: true, provider: 'kinsta', providerActionType: 'hosting.kinsta.clear_cache', connector }),
    capabilities: async () => [{ provider: 'kinsta', capabilities: ['clear_cache'] }],
    audit: {
      auditApproved: async (a) => events.push(['approved', a]),
      auditExecuted: async (a) => events.push(['executed', a]),
      auditRejected: async (a) => events.push(['rejected', a])
    },
    finalizeApproval: async () => {}
  };
  return { rec, connector, deps, events, result };
}

test('executeAction: gate → resolve → preflight → execute → verify → audit → persist', async () => {
  const h = harness();
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'executed');
  assert.equal(h.result.value.status, 'executed');
  assert.ok(h.result.value.verification, 'verification recorded');
  const types = h.events.map((e) => e[0]);
  assert.deepEqual(types, ['approved', 'executed']);
});

test('blocked recommendation never calls execute', async () => {
  const h = harness({ destructive: true, approval_level: 'blocked' });
  let executed = false;
  h.connector.actions.execute = async () => { executed = true; return {}; };
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.equal(out.ok, false);
  assert.equal(out.status, 'blocked');
  assert.equal(executed, false);
});

test('admin_required + non-admin actor refuses', async () => {
  const h = harness({ risk_tier: 'critical', approval_level: 'admin_required' });
  let executed = false;
  h.connector.actions.execute = async () => { executed = true; return {}; };
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: false }, h.deps);
  assert.equal(out.ok, false);
  assert.equal(executed, false);
});

test('capability-unavailable resolution → failed, no execute, no tool_executed success', async () => {
  const h = harness();
  h.deps.resolve = async () => ({ ok: false, reason: 'capability_unavailable: no connected provider offers clear_cache' });
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.equal(out.ok, false);
  assert.equal(out.status, 'failed');
});

test('connector.execute throwing → failed + tool_executed(success=false)', async () => {
  const h = harness();
  h.connector.actions.execute = async () => { throw new Error('kinsta 500'); };
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.equal(out.ok, false);
  assert.equal(out.status, 'failed');
  const executed = h.events.find((e) => e[0] === 'executed');
  assert.equal(executed[1].success, false);
});

test('capabilities loaded from connectionStore shape flows to resolveAction', async () => {
  const h = harness();
  let capsSeen;
  h.deps.resolve = async (type, { capabilities }) => { capsSeen = capabilities; return { ok: false, reason: 'test' }; };
  h.deps.capabilities = async () => [{ provider: 'kinsta', capabilities: ['clear_cache'] }];
  await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.deepEqual(capsSeen, [{ provider: 'kinsta', capabilities: ['clear_cache'] }]);
});

test('advisory recommendation: Approve = acknowledge → executed + audit rows, no resolve/execute', async () => {
  const h = harness({ mutating: false, abstract_action_type: null, approval_level: 'none', approval_id: null, status: 'proposed' });
  let resolved = false, executed = false;
  h.deps.resolve = async () => { resolved = true; return { ok: false, reason: 'should not be called' }; };
  h.connector.actions.execute = async () => { executed = true; return {}; };
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'executed');
  assert.equal(out.advisory, true);
  assert.equal(resolved, false, 'null action never resolved');
  assert.equal(executed, false, 'connector.execute never called');
  assert.equal(h.result.value.status, 'executed');
  const types = h.events.map((e) => e[0]);
  assert.deepEqual(types, ['approved', 'executed'], 'audit chain recorded for acknowledge');
  assert.equal(h.events.find((e) => e[0] === 'executed')[1].success, true);
});

test('malformed mutating rec (no abstract_action_type) → failed, no tool_executed audit row', async () => {
  const h = harness({ mutating: true, abstract_action_type: null, status: 'approved' });
  let executed = false;
  h.connector.actions.execute = async () => { executed = true; return {}; };
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.equal(out.ok, false);
  assert.equal(out.status, 'failed');
  assert.ok(out.error, 'error message present');
  assert.equal(executed, false, 'connector.execute never called');
  assert.equal(h.events.some((e) => e[0] === 'executed'), false, 'no tool_executed audit row written');
});

test('advisory recommendation with approval_id: finalizeApproval called + status executed', async () => {
  const h = harness({ mutating: false, abstract_action_type: null, approval_level: 'none', approval_id: 'appr-advisory', status: 'proposed' });
  let finalizedWith = null;
  h.deps.finalizeApproval = async (id, payload) => { finalizedWith = { id, payload }; };
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'executed');
  assert.equal(out.advisory, true);
  assert.ok(finalizedWith, 'finalizeApproval was called');
  assert.equal(finalizedWith.id, 'appr-advisory');
  assert.deepEqual(finalizedWith.payload, { ok: true, advisory: true });
  assert.equal(h.result.value.status, 'executed');
});

test('executeAction: finalized status is not re-executable (executor-level defense)', async () => {
  for (const finalStatus of ['executed', 'rejected', 'failed']) {
    const h = harness({ status: finalStatus });
    let executed = false;
    h.connector.actions.execute = async () => { executed = true; return {}; };
    const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
    assert.equal(out.ok, false, `status=${finalStatus}: ok must be false`);
    assert.equal(out.status, finalStatus, `status=${finalStatus}: returned status echoed`);
    assert.equal(executed, false, `status=${finalStatus}: connector not called`);
  }
});

test('rejectAction sets rejected + emits tool_rejected', async () => {
  const h = harness();
  let saved;
  h.deps.setRecommendationDecision = async (id, p) => { saved = { id, ...p }; return saved; };
  const out = await rejectAction({ recommendationId: 'rec-1', userId: 'u1', reason: 'not now' }, h.deps);
  assert.equal(out.ok, true);
  assert.equal(saved.status, 'rejected');
  assert.ok(h.events.some((e) => e[0] === 'rejected'));
});
