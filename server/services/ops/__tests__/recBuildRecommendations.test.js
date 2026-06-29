import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendations } from '../recommendations/buildRecommendations.js';

const findings = [
  { id: 'f1', client_user_id: 'c1', run_id: 'r1', severity: 'critical',
    category: 'correlation.gtm_missing_with_kinsta_drift', summary: 'GTM missing; drift.',
    affected_platforms: ['website', 'google_ads'], business_impact: 'leads', created_at: new Date() },
  { id: 'f2', client_user_id: 'c1', run_id: 'r1', severity: 'info',
    category: 'correlation.unmapped_thing', summary: 'minor note',
    affected_platforms: ['website'], business_impact: null, created_at: new Date() }
];

function fakeStore() {
  const saved = [];
  return { saved, createRecommendation: async (rec) => { const row = { id: `rec-${saved.length + 1}`, ...rec }; saved.push(row); return row; } };
}

test('buildRecommendations runs the deterministic pipeline + single LLM call per group', async () => {
  const store = fakeStore();
  let llmCalls = 0;
  const out = await buildRecommendations({ clientUserId: 'c1', runId: 'r1' }, {
    loadFindings: async () => findings,
    baselineLookup: async () => ({ baseline_value: 10, stddev: 2, n: 30 }), // present → baselineDelta computed (F3 schema)
    policyContext: async () => ({ clientType: 'standard', mutationsEnabled: false, monthlyCapCents: 500 }),
    summarize: async (group) => { llmCalls += 1; return { title: `T:${group.category}`, summary: 's', rationale: 'r', priority: 5 }; },
    store
  });
  assert.equal(out.recommendations.length, 2, 'one recommendation per group');
  assert.equal(llmCalls, 2, 'exactly one summarize call per group');

  const mapped = store.saved.find((r) => r.category === 'correlation.gtm_missing_with_kinsta_drift');
  assert.equal(mapped.abstractActionType, 'website.clear_cache');
  assert.equal(mapped.mutating, true);
  // critical severity + 2 platforms + business_impact → critical risk tier → admin_required
  assert.equal(mapped.approvalLevel, 'admin_required');
  assert.equal(mapped.riskTier, 'critical');
  assert.ok(mapped.riskScore > 0);

  const advisory = store.saved.find((r) => r.category === 'correlation.unmapped_thing');
  assert.equal(advisory.abstractActionType, null);
  assert.equal(advisory.approvalLevel, 'none');
  assert.equal(advisory.status, 'proposed');
});

test('destructive-style critical on a medical client → blocked or admin, persisted', async () => {
  const store = fakeStore();
  await buildRecommendations({ clientUserId: 'cM', runId: null }, {
    loadFindings: async () => [findings[0]],
    baselineLookup: async () => null,
    policyContext: async () => ({ clientType: 'medical', mutationsEnabled: false, monthlyCapCents: null }),
    summarize: async () => ({ title: 't', summary: 's', rationale: 'r', priority: 1 }),
    store
  });
  const rec = store.saved[0];
  assert.equal(rec.approvalLevel, 'admin_required'); // medical escalates approval_required → admin_required
  assert.ok(['proposed'].includes(rec.status));
});

test('F3 baseline_value/stddev fields produce non-null baselineDelta in riskScore', async () => {
  const store = fakeStore();
  const capturedInputs = [];
  await buildRecommendations({ clientUserId: 'c1', runId: 'r1' }, {
    loadFindings: async () => [
      { id: 'f1', client_user_id: 'c1', run_id: 'r1', severity: 'critical',
        category: 'correlation.gtm_missing_with_kinsta_drift', summary: 'GTM missing',
        affected_platforms: ['website'], business_impact: null, attention_score: 15, created_at: new Date() }
    ],
    baselineLookup: async () => ({ baseline_value: 10, stddev: 2, sample_count: 30 }),
    policyContext: async () => ({ clientType: 'standard', mutationsEnabled: false }),
    summarize: async (group, computed) => { capturedInputs.push(computed); return { title: 't', summary: 's', rationale: 'r', priority: 1 }; },
    store
  });
  assert.ok(capturedInputs[0].baselineDelta !== null, 'baselineDelta should be non-null with F3 baseline');
  assert.ok(capturedInputs[0].baselineDelta > 0, 'delta = (15-10)/2 = 2.5');
});

test('old mean/stdev shape produces null baselineDelta (legacy shape rejected)', async () => {
  const store = fakeStore();
  const capturedInputs = [];
  await buildRecommendations({ clientUserId: 'c1', runId: 'r1' }, {
    loadFindings: async () => [
      { id: 'f1', client_user_id: 'c1', run_id: 'r1', severity: 'critical',
        category: 'correlation.gtm_missing_with_kinsta_drift', summary: 'GTM missing',
        affected_platforms: ['website'], business_impact: null, attention_score: 15, created_at: new Date() }
    ],
    baselineLookup: async () => ({ mean: 10, stdev: 2 }), // wrong field names → neutral
    policyContext: async () => ({ clientType: 'standard', mutationsEnabled: false }),
    summarize: async (group, computed) => { capturedInputs.push(computed); return { title: 't', summary: 's', rationale: 'r', priority: 1 }; },
    store
  });
  assert.equal(capturedInputs[0].baselineDelta, null, 'wrong field names → null (neutral)');
});

test('no findings → no recommendations, no LLM calls', async () => {
  const store = fakeStore();
  let llmCalls = 0;
  const out = await buildRecommendations({ clientUserId: 'c1' }, {
    loadFindings: async () => [],
    baselineLookup: async () => null,
    policyContext: async () => ({ clientType: null, mutationsEnabled: false }),
    summarize: async () => { llmCalls += 1; return { title: 't', summary: 's', rationale: 'r', priority: 1 }; },
    store
  });
  assert.equal(out.recommendations.length, 0);
  assert.equal(llmCalls, 0);
});
