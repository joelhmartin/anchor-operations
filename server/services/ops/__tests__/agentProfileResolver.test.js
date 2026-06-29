import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfile, parseJsonArray, parseJsonObject } from '../agentProfileResolver.js';

// ── parseJsonArray ──────────────────────────────────────────────────────────

test('parseJsonArray: already-parsed array passes through', () => {
  assert.deepEqual(parseJsonArray(['a', 'b']), ['a', 'b']);
});

test('parseJsonArray: JSON string is parsed', () => {
  assert.deepEqual(parseJsonArray('["x","y"]'), ['x', 'y']);
});

test('parseJsonArray: null/undefined/non-array returns []', () => {
  assert.deepEqual(parseJsonArray(null), []);
  assert.deepEqual(parseJsonArray(undefined), []);
  assert.deepEqual(parseJsonArray(42), []);
  assert.deepEqual(parseJsonArray('not-json'), []);
});

// ── parseJsonObject ─────────────────────────────────────────────────────────

test('parseJsonObject: merges object over defaults', () => {
  const defaults = { mode: 'off', max_risk_level: 'low' };
  assert.deepEqual(parseJsonObject({ mode: 'auto' }, defaults), { mode: 'auto', max_risk_level: 'low' });
});

test('parseJsonObject: JSON string is parsed and merged', () => {
  const defaults = { email: true, digest_frequency: 'weekly' };
  assert.deepEqual(parseJsonObject('{"email":false}', defaults), { email: false, digest_frequency: 'weekly' });
});

test('parseJsonObject: null/invalid returns defaults', () => {
  const defaults = { enabled: false, space_id: null };
  assert.deepEqual(parseJsonObject(null, defaults), defaults);
  assert.deepEqual(parseJsonObject('bad-json', defaults), defaults);
});

// ── resolveProfile: HIPAA gate ───────────────────────────────────────────────

test('resolveProfile: medical client_type forces hipaa_restricted=true even if profile says false', () => {
  const cp = { client_type: 'medical', ops_monthly_cap_cents: 500 };
  const ap = { hipaa_restricted: false, enabled: true, client_name: 'Test', website_url: null,
    primary_services_json: [], target_cpa_cents: null, daily_budget_expected_cents: null,
    monthly_budget_expected_cents: null, lead_goal_monthly: null, allowed_platforms_json: [],
    auto_action_policy_json: { mode: 'off', max_risk_level: 'low' },
    notification_policy_json: { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json: { enabled: false, space_id: null }, agent_notes: null };
  const profile = resolveProfile(cp, ap);
  assert.equal(profile.hipaa_restricted, true, 'medical client must always be hipaa_restricted');
  assert.equal(profile.client_type, 'medical');
});

test('resolveProfile: non-medical with hipaa_restricted=true stays restricted', () => {
  const cp = { client_type: 'ecommerce', ops_monthly_cap_cents: 500 };
  const ap = { hipaa_restricted: true, enabled: false, client_name: null, website_url: null,
    primary_services_json: [], target_cpa_cents: null, daily_budget_expected_cents: null,
    monthly_budget_expected_cents: null, lead_goal_monthly: null, allowed_platforms_json: [],
    auto_action_policy_json: { mode: 'off', max_risk_level: 'low' },
    notification_policy_json: { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json: { enabled: false, space_id: null }, agent_notes: null };
  const profile = resolveProfile(cp, ap);
  assert.equal(profile.hipaa_restricted, true);
});

test('resolveProfile: non-medical with hipaa_restricted=false is not restricted', () => {
  const cp = { client_type: 'ecommerce', ops_monthly_cap_cents: 500 };
  const ap = { hipaa_restricted: false, enabled: true, client_name: null, website_url: null,
    primary_services_json: [], target_cpa_cents: null, daily_budget_expected_cents: null,
    monthly_budget_expected_cents: null, lead_goal_monthly: null, allowed_platforms_json: [],
    auto_action_policy_json: { mode: 'off', max_risk_level: 'low' },
    notification_policy_json: { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json: { enabled: false, space_id: null }, agent_notes: null };
  const profile = resolveProfile(cp, ap);
  assert.equal(profile.hipaa_restricted, false);
  assert.equal(profile.client_type, 'ecommerce');
});

// ── resolveProfile: null apRow (no profile row yet) ─────────────────────────

test('resolveProfile: null apRow yields safe defaults and inherits cap from client_profiles', () => {
  const cp = { client_type: null, ops_monthly_cap_cents: 1000 };
  const profile = resolveProfile(cp, null);
  assert.equal(profile.enabled, false);
  assert.equal(profile.hipaa_restricted, false);
  assert.equal(profile.monthly_budget_cap_cents, 1000, 'cap from client_profiles');
  assert.deepEqual(profile.primary_services, []);
  assert.deepEqual(profile.allowed_platforms, []);
  assert.deepEqual(profile.auto_action_policy, { mode: 'off', max_risk_level: 'low' });
  assert.deepEqual(profile.notification_policy, { email: true, digest_frequency: 'weekly' });
  assert.deepEqual(profile.google_chat_policy, { enabled: false, space_id: null });
  assert.equal(profile.agent_notes, null);
});

test('resolveProfile: null cpRow ops_monthly_cap_cents yields null monthly_budget_cap_cents', () => {
  const cp = { client_type: null, ops_monthly_cap_cents: null };
  const profile = resolveProfile(cp, null);
  assert.equal(profile.monthly_budget_cap_cents, null);
});

// ── resolveProfile: fields from apRow ───────────────────────────────────────

test('resolveProfile: monthly_budget_cap_cents comes from client_profiles, monthly_budget_expected_cents from apRow', () => {
  const cp = { client_type: null, ops_monthly_cap_cents: 2500 };
  const ap = { hipaa_restricted: false, enabled: true, client_name: 'ACME', website_url: 'https://acme.com',
    primary_services_json: ['paid_ads'], target_cpa_cents: 500, daily_budget_expected_cents: 1000,
    monthly_budget_expected_cents: 25000, lead_goal_monthly: 50, allowed_platforms_json: ['google_ads', 'meta'],
    auto_action_policy_json: { mode: 'suggest', max_risk_level: 'medium' },
    notification_policy_json: { email: false, digest_frequency: 'daily' },
    google_chat_policy_json: { enabled: true, space_id: 'spaces/ABC123' }, agent_notes: 'VIP client' };
  const profile = resolveProfile(cp, ap);
  assert.equal(profile.monthly_budget_cap_cents, 2500, 'cap = client_profiles value');
  assert.equal(profile.monthly_budget_expected_cents, 25000, 'goal = apRow value');
  assert.equal(profile.client_name, 'ACME');
  assert.equal(profile.website_url, 'https://acme.com');
  assert.equal(profile.target_cpa_cents, 500);
  assert.deepEqual(profile.primary_services, ['paid_ads']);
  assert.deepEqual(profile.allowed_platforms, ['google_ads', 'meta']);
  assert.deepEqual(profile.auto_action_policy, { mode: 'suggest', max_risk_level: 'medium' });
  assert.deepEqual(profile.notification_policy, { email: false, digest_frequency: 'daily' });
  assert.deepEqual(profile.google_chat_policy, { enabled: true, space_id: 'spaces/ABC123' });
  assert.equal(profile.agent_notes, 'VIP client');
});

test('resolveProfile: JSONB columns stored as strings (pg raw) are parsed correctly', () => {
  const cp = { client_type: null, ops_monthly_cap_cents: 500 };
  // pg sometimes returns JSONB as already-parsed objects; ensure both forms work
  const ap = { hipaa_restricted: false, enabled: true, client_name: null, website_url: null,
    primary_services_json: '["organic_search","website"]',
    target_cpa_cents: null, daily_budget_expected_cents: null,
    monthly_budget_expected_cents: null, lead_goal_monthly: null,
    allowed_platforms_json: '["ctm"]',
    auto_action_policy_json: '{"mode":"auto","max_risk_level":"high"}',
    notification_policy_json: '{"email":true,"digest_frequency":"none"}',
    google_chat_policy_json: '{"enabled":false,"space_id":null}', agent_notes: null };
  const profile = resolveProfile(cp, ap);
  assert.deepEqual(profile.primary_services, ['organic_search', 'website']);
  assert.deepEqual(profile.allowed_platforms, ['ctm']);
  assert.deepEqual(profile.auto_action_policy, { mode: 'auto', max_risk_level: 'high' });
  assert.deepEqual(profile.notification_policy, { email: true, digest_frequency: 'none' });
});
