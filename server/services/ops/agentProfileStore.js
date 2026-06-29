/**
 * agentProfileStore.js — DB I/O for ops_client_agent_profiles.
 *
 * getAgentProfile(clientUserId)           → row | null
 * upsertAgentProfile(clientUserId, fields) → row
 * loadResolvedProfile(clientUserId)        → { clientUserId, ...ResolvedProfile }
 *
 * loadResolvedProfile is the function F4 (policyApplicator) and F5
 * (notificationRouter) should call. It queries both tables and delegates
 * to the pure resolveProfile() for the merge.
 */

import { query } from '../../db.js';
import { resolveProfile } from './agentProfileResolver.js';

export async function getAgentProfile(clientUserId) {
  const { rows } = await query(
    'SELECT * FROM ops_client_agent_profiles WHERE user_id = $1',
    [clientUserId]
  );
  return rows[0] || null;
}

export async function upsertAgentProfile(clientUserId, fields) {
  const {
    enabled = false,
    client_name = null,
    website_url = null,
    hipaa_restricted = false,
    primary_services_json = [],
    target_cpa_cents = null,
    daily_budget_expected_cents = null,
    monthly_budget_expected_cents = null,
    lead_goal_monthly = null,
    allowed_platforms_json = [],
    auto_action_policy_json = { mode: 'off', max_risk_level: 'low' },
    notification_policy_json = { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json = { enabled: false, space_id: null },
    agent_notes = null
  } = fields;

  const { rows } = await query(
    `INSERT INTO ops_client_agent_profiles
       (user_id, enabled, client_name, website_url, hipaa_restricted,
        primary_services_json, target_cpa_cents, daily_budget_expected_cents,
        monthly_budget_expected_cents, lead_goal_monthly, allowed_platforms_json,
        auto_action_policy_json, notification_policy_json, google_chat_policy_json,
        agent_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (user_id) DO UPDATE SET
       enabled                       = EXCLUDED.enabled,
       client_name                   = EXCLUDED.client_name,
       website_url                   = EXCLUDED.website_url,
       hipaa_restricted              = EXCLUDED.hipaa_restricted,
       primary_services_json         = EXCLUDED.primary_services_json,
       target_cpa_cents              = EXCLUDED.target_cpa_cents,
       daily_budget_expected_cents   = EXCLUDED.daily_budget_expected_cents,
       monthly_budget_expected_cents = EXCLUDED.monthly_budget_expected_cents,
       lead_goal_monthly             = EXCLUDED.lead_goal_monthly,
       allowed_platforms_json        = EXCLUDED.allowed_platforms_json,
       auto_action_policy_json       = EXCLUDED.auto_action_policy_json,
       notification_policy_json      = EXCLUDED.notification_policy_json,
       google_chat_policy_json       = EXCLUDED.google_chat_policy_json,
       agent_notes                   = EXCLUDED.agent_notes,
       updated_at                    = NOW()
     RETURNING *`,
    [
      clientUserId,
      Boolean(enabled),
      client_name,
      website_url,
      Boolean(hipaa_restricted),
      JSON.stringify(Array.isArray(primary_services_json) ? primary_services_json : []),
      target_cpa_cents,
      daily_budget_expected_cents,
      monthly_budget_expected_cents,
      lead_goal_monthly,
      JSON.stringify(Array.isArray(allowed_platforms_json) ? allowed_platforms_json : []),
      JSON.stringify(typeof auto_action_policy_json === 'object' && auto_action_policy_json !== null ? auto_action_policy_json : { mode: 'off', max_risk_level: 'low' }),
      JSON.stringify(typeof notification_policy_json === 'object' && notification_policy_json !== null ? notification_policy_json : { email: true, digest_frequency: 'weekly' }),
      JSON.stringify(typeof google_chat_policy_json === 'object' && google_chat_policy_json !== null ? google_chat_policy_json : { enabled: false, space_id: null }),
      agent_notes
    ]
  );
  return rows[0];
}

export async function loadResolvedProfile(clientUserId) {
  const [{ rows: cpRows }, apRow] = await Promise.all([
    query(
      'SELECT client_type, ops_monthly_cap_cents FROM client_profiles WHERE user_id = $1',
      [clientUserId]
    ),
    getAgentProfile(clientUserId)
  ]);
  const cpRow = cpRows[0] || { client_type: null, ops_monthly_cap_cents: null };
  return { clientUserId, ...resolveProfile(cpRow, apRow) };
}
