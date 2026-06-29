-- F8: per-client agent profile (goals, policies). Extends client_profiles.
-- client_type and ops_monthly_cap_cents stay in client_profiles — not duplicated here.
-- The resolver (agentProfileResolver.js) merges both rows into the effective policy.
CREATE TABLE IF NOT EXISTS ops_client_agent_profiles (
  user_id                       uuid PRIMARY KEY
                                  REFERENCES users(id) ON DELETE CASCADE,

  -- Identity overrides (supplement client_profiles)
  enabled                       boolean NOT NULL DEFAULT false,
  client_name                   text,              -- display-name override (max 200 chars)
  website_url                   text,              -- primary site URL (max 500 chars)
  hipaa_restricted              boolean NOT NULL DEFAULT false,
                                                   -- true forces HIPAA gate regardless of client_type;
                                                   -- resolver also enforces: client_type='medical' → always true

  -- Goals
  primary_services_json         jsonb NOT NULL DEFAULT '[]'::jsonb,
                                                   -- string[] e.g. ["paid_ads","organic_search"]
  target_cpa_cents              int CHECK (target_cpa_cents IS NULL OR target_cpa_cents >= 0),
  daily_budget_expected_cents   int CHECK (daily_budget_expected_cents IS NULL OR daily_budget_expected_cents >= 0),
  monthly_budget_expected_cents int CHECK (monthly_budget_expected_cents IS NULL OR monthly_budget_expected_cents >= 0),
  lead_goal_monthly             int CHECK (lead_goal_monthly IS NULL OR lead_goal_monthly >= 0),

  -- Platform + automation policy
  allowed_platforms_json        jsonb NOT NULL DEFAULT '[]'::jsonb,
                                                   -- string[] e.g. ["google_ads","meta","ctm"]
  auto_action_policy_json       jsonb NOT NULL DEFAULT '{"mode":"off","max_risk_level":"low"}'::jsonb,
  notification_policy_json      jsonb NOT NULL DEFAULT '{"email":true,"digest_frequency":"weekly"}'::jsonb,
  google_chat_policy_json       jsonb NOT NULL DEFAULT '{"enabled":false,"space_id":null}'::jsonb,

  -- Freeform context
  agent_notes                   text,              -- max 2000 chars enforced in route layer

  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
