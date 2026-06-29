/**
 * agentProfileResolver.js — PURE profile merger (no DB, no I/O).
 *
 * resolveProfile(cpRow, apRow) merges:
 *   cpRow: { client_type, ops_monthly_cap_cents }  from client_profiles
 *   apRow: ops_client_agent_profiles row | null
 *
 * Returns the effective policy object consumed by F4 (policyApplicator)
 * and F5 (notificationRouter). Shape is the contract defined in the F8 plan.
 *
 * HIPAA gate (never weakened):
 *   hipaa_restricted = client_type === 'medical' || Boolean(apRow?.hipaa_restricted)
 */

export function parseJsonArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return [];
}

export function parseJsonObject(val, defaults) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return { ...defaults, ...val };
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...defaults, ...parsed };
      }
    } catch {
      // fall through
    }
  }
  return defaults;
}

export function resolveProfile(cpRow, apRow) {
  const clientType = cpRow?.client_type ?? null;

  // HIPAA gate: never weakened. medical → always true.
  const hipaaRestricted = clientType === 'medical' || Boolean(apRow?.hipaa_restricted);

  return {
    enabled: Boolean(apRow?.enabled ?? false),
    client_name: apRow?.client_name ?? null,
    website_url: apRow?.website_url ?? null,
    client_type: clientType,
    hipaa_restricted: hipaaRestricted,

    primary_services: parseJsonArray(apRow?.primary_services_json),
    target_cpa_cents: apRow?.target_cpa_cents ?? null,
    daily_budget_expected_cents: apRow?.daily_budget_expected_cents ?? null,
    monthly_budget_expected_cents: apRow?.monthly_budget_expected_cents ?? null,
    monthly_budget_cap_cents: cpRow?.ops_monthly_cap_cents ?? null,
    lead_goal_monthly: apRow?.lead_goal_monthly ?? null,

    allowed_platforms: parseJsonArray(apRow?.allowed_platforms_json),
    auto_action_policy: parseJsonObject(apRow?.auto_action_policy_json, { mode: 'off', max_risk_level: 'low' }),
    notification_policy: parseJsonObject(apRow?.notification_policy_json, { email: true, digest_frequency: 'weekly' }),
    google_chat_policy: parseJsonObject(apRow?.google_chat_policy_json, { enabled: false, space_id: null }),

    agent_notes: apRow?.agent_notes ?? null
  };
}
