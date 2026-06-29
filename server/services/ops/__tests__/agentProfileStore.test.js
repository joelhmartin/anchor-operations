import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../db.js';
import { getAgentProfile, upsertAgentProfile, loadResolvedProfile } from '../agentProfileStore.js';

// ── getAgentProfile: unknown UUID returns null ───────────────────────────────
test('getAgentProfile returns null for a non-existent user_id', async () => {
  const result = await getAgentProfile('00000000-0000-0000-0000-000000000000');
  assert.equal(result, null);
});

// ── loadResolvedProfile: no profile row → safe defaults ─────────────────────
test('loadResolvedProfile returns safe defaults when no agent profile row exists', async () => {
  let userRows;
  try {
    const res = await query("SELECT id FROM users WHERE role = 'client' LIMIT 1");
    userRows = res.rows;
  } catch {
    console.log('SKIP: users table not in this test environment');
    return;
  }
  if (userRows.length === 0) {
    console.log('SKIP: no client user found in DB');
    return;
  }
  const clientUserId = userRows[0].id;

  await query('DELETE FROM ops_client_agent_profiles WHERE user_id = $1', [clientUserId]);

  const profile = await loadResolvedProfile(clientUserId);
  assert.equal(profile.clientUserId, clientUserId);
  assert.equal(profile.enabled, false);
  assert.deepEqual(profile.primary_services, []);
  assert.deepEqual(profile.allowed_platforms, []);
  assert.deepEqual(profile.auto_action_policy, { mode: 'off', max_risk_level: 'low' });
  assert.deepEqual(profile.notification_policy, { email: true, digest_frequency: 'weekly' });
  assert.deepEqual(profile.google_chat_policy, { enabled: false, space_id: null });
});

// ── upsertAgentProfile + getAgentProfile round-trip ─────────────────────────
test('upsertAgentProfile inserts then updates, getAgentProfile retrieves', async () => {
  let userRows;
  try {
    const res = await query("SELECT id FROM users WHERE role = 'client' LIMIT 1");
    userRows = res.rows;
  } catch {
    // users table absent — test against a synthetic UUID directly in ops_client_agent_profiles
    userRows = [];
  }

  let clientUserId;
  let synthetic = false;
  if (userRows.length === 0) {
    // No FK in test table — use synthetic UUID
    clientUserId = '00000000-f8f8-0000-0000-000000000001';
    synthetic = true;
    console.log('NOTE: using synthetic UUID (no client user in DB)');
  } else {
    clientUserId = userRows[0].id;
  }

  await query('DELETE FROM ops_client_agent_profiles WHERE user_id = $1', [clientUserId]);

  const inserted = await upsertAgentProfile(clientUserId, {
    enabled: true,
    client_name: '__f8test__',
    website_url: 'https://f8test.example.com',
    hipaa_restricted: false,
    primary_services_json: ['paid_ads', 'organic_search'],
    target_cpa_cents: 1500,
    daily_budget_expected_cents: 5000,
    monthly_budget_expected_cents: 100000,
    lead_goal_monthly: 40,
    allowed_platforms_json: ['google_ads', 'ctm'],
    auto_action_policy_json: { mode: 'suggest', max_risk_level: 'medium' },
    notification_policy_json: { email: false, digest_frequency: 'daily' },
    google_chat_policy_json: { enabled: true, space_id: 'spaces/TEST123' },
    agent_notes: 'f8 integration test'
  });

  assert.equal(inserted.user_id, clientUserId);
  assert.equal(inserted.enabled, true);
  assert.equal(inserted.client_name, '__f8test__');
  assert.equal(inserted.target_cpa_cents, 1500);
  assert.equal(inserted.agent_notes, 'f8 integration test');

  const fetched = await getAgentProfile(clientUserId);
  assert.ok(fetched, 'row must exist after upsert');
  assert.equal(fetched.user_id, clientUserId);
  assert.equal(fetched.client_name, '__f8test__');

  const updated = await upsertAgentProfile(clientUserId, {
    enabled: false,
    client_name: '__f8test_v2__',
    website_url: null,
    hipaa_restricted: true,
    primary_services_json: [],
    target_cpa_cents: null,
    daily_budget_expected_cents: null,
    monthly_budget_expected_cents: null,
    lead_goal_monthly: null,
    allowed_platforms_json: [],
    auto_action_policy_json: { mode: 'off', max_risk_level: 'low' },
    notification_policy_json: { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json: { enabled: false, space_id: null },
    agent_notes: null
  });
  assert.equal(updated.enabled, false);
  assert.equal(updated.client_name, '__f8test_v2__');
  assert.equal(updated.hipaa_restricted, true);
  assert.equal(updated.target_cpa_cents, null);

  await query('DELETE FROM ops_client_agent_profiles WHERE user_id = $1', [clientUserId]);
});

// ── loadResolvedProfile: merges client_profiles cap ─────────────────────────
test('loadResolvedProfile merges monthly_budget_cap_cents from client_profiles', async () => {
  let userRows;
  try {
    const res = await query(
      "SELECT u.id, cp.ops_monthly_cap_cents FROM users u LEFT JOIN client_profiles cp ON cp.user_id = u.id WHERE u.role = 'client' LIMIT 1"
    );
    userRows = res.rows;
  } catch {
    console.log('SKIP: users/client_profiles tables not in this test environment');
    return;
  }
  if (userRows.length === 0) {
    console.log('SKIP: no client user found in DB');
    return;
  }
  const { id: clientUserId, ops_monthly_cap_cents } = userRows[0];

  await query('DELETE FROM ops_client_agent_profiles WHERE user_id = $1', [clientUserId]);

  const profile = await loadResolvedProfile(clientUserId);
  assert.equal(profile.monthly_budget_cap_cents, ops_monthly_cap_cents ?? null,
    'monthly_budget_cap_cents must come from client_profiles.ops_monthly_cap_cents');
  assert.equal(profile.clientUserId, clientUserId);
});
