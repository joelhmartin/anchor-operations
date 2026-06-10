-- Phase 1 — Operations rebuild domain foundation.
--
-- Introduces the new run/check/finding/credential domain model. No new
-- functionality yet — bones only. Existing kinsta_* tables remain in place;
-- a backward-compat view (kinsta_findings_compat) lets legacy readers see
-- kinsta-category rows from ops_findings during the transition.
--
-- Idempotent. Re-running the migration must be safe.

-- ---------------------------------------------------------------------------
-- ops_run_definitions — declarative templates for runs (tier + check_set).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_run_definitions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  tier TEXT NOT NULL,
  umbrellas TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  check_set JSONB NOT NULL DEFAULT '[]'::jsonb,
  default_for_new_clients BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_run_definitions_tier
  ON ops_run_definitions (tier);

-- ---------------------------------------------------------------------------
-- client_run_subscriptions — which definitions apply to which client, with
-- optional schedule overrides.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_run_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL,
  run_definition_id UUID NOT NULL REFERENCES ops_run_definitions(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  schedule_cron TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_user_id, run_definition_id)
);

CREATE INDEX IF NOT EXISTS idx_client_run_subscriptions_client
  ON client_run_subscriptions (client_user_id);

-- ---------------------------------------------------------------------------
-- ops_runs — one row per executed (or queued) run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL,
  run_definition_id UUID REFERENCES ops_run_definitions(id) ON DELETE SET NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL,
  trigger TEXT NOT NULL,
  triggered_by UUID,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  duration_ms INTEGER,
  token_usage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  cost_estimate_cents INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_runs_client_created
  ON ops_runs (client_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_runs_status
  ON ops_runs (status);

-- ---------------------------------------------------------------------------
-- ops_check_results — per-check evidence rows for a run.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_check_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES ops_runs(id) ON DELETE CASCADE,
  umbrella TEXT NOT NULL,
  check_id TEXT NOT NULL,
  status TEXT NOT NULL,
  severity TEXT,
  payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  duration_ms INTEGER,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_check_results_run
  ON ops_check_results (run_id);
CREATE INDEX IF NOT EXISTS idx_ops_check_results_check
  ON ops_check_results (umbrella, check_id);

-- ---------------------------------------------------------------------------
-- ops_findings — synthesized, actionable findings (cross-platform OK).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES ops_runs(id) ON DELETE CASCADE,
  client_user_id UUID NOT NULL,
  severity TEXT NOT NULL,
  category TEXT NOT NULL,
  summary TEXT NOT NULL,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  linked_check_result_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_findings_open
  ON ops_findings (client_user_id, resolved_at)
  WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_ops_findings_run
  ON ops_findings (run_id);
CREATE INDEX IF NOT EXISTS idx_ops_findings_category
  ON ops_findings (category);

-- ---------------------------------------------------------------------------
-- ops_reports — rendered run reports (HTML in v1; PDF deferred).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL UNIQUE REFERENCES ops_runs(id) ON DELETE CASCADE,
  format TEXT NOT NULL,
  storage_uri TEXT,
  size_bytes INTEGER,
  rendered_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------------------------------------------------------------------------
-- client_platform_credentials — per-client credential ledger. Agency-level
-- sources (agency_mcc, agency_sysuser, env_var) leave credentials_encrypted
-- NULL and resolve from env at read time.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS client_platform_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL,
  platform TEXT NOT NULL,
  account_id TEXT NOT NULL,
  credentials_source TEXT NOT NULL,
  credentials_encrypted TEXT,
  scope_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_validated_at TIMESTAMPTZ,
  last_validation_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_user_id, platform, account_id)
);

CREATE INDEX IF NOT EXISTS idx_client_platform_credentials_client
  ON client_platform_credentials (client_user_id);

-- ---------------------------------------------------------------------------
-- ops_tool_approvals — durable record of admin-approved tool invocations
-- and their execution results (used by the AI supervisor in Phase 7).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_tool_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID REFERENCES ops_runs(id) ON DELETE SET NULL,
  user_id UUID,
  tool_name TEXT NOT NULL,
  args_hash TEXT NOT NULL,
  args_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  approved_at TIMESTAMPTZ,
  executed_at TIMESTAMPTZ,
  execution_result_json JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_tool_approvals_run
  ON ops_tool_approvals (run_id);
CREATE INDEX IF NOT EXISTS idx_ops_tool_approvals_args_hash
  ON ops_tool_approvals (args_hash);

-- ---------------------------------------------------------------------------
-- Backward-compat view: legacy readers of "kinsta findings" can keep working
-- by reading from ops_findings filtered to kinsta-category rows.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW kinsta_findings_compat AS
  SELECT
    id,
    run_id,
    client_user_id,
    severity,
    category,
    summary,
    evidence_json,
    linked_check_result_ids,
    acknowledged_by,
    acknowledged_at,
    resolved_at,
    resolved_by,
    resolution_note,
    created_at
  FROM ops_findings
  WHERE category LIKE 'kinsta.%';
