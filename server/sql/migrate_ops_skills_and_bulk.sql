-- Idempotent migration: ops_skills, ops_skill_versions, ops_skill_suggestions,
-- ops_bulk_schedules, ops_bulk_runs + ALTER ops_runs.

CREATE TABLE IF NOT EXISTS ops_skills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  umbrella TEXT NOT NULL CHECK (umbrella IN ('website','google_ads','meta','ctm')),
  title TEXT NOT NULL,
  prompt_md TEXT NOT NULL,
  collectors_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  cost_estimate_cents INTEGER NOT NULL DEFAULT 0,
  created_by UUID REFERENCES users(id),
  archived_at TIMESTAMPTZ,
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_skills_umbrella ON ops_skills(umbrella) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS ops_skill_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID NOT NULL REFERENCES ops_skills(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  prompt_md TEXT NOT NULL,
  collectors_json JSONB NOT NULL,
  edited_by_user_id UUID REFERENCES users(id),
  edited_by_agent BOOLEAN NOT NULL DEFAULT FALSE,
  edit_reason TEXT,
  approved_from_suggestion_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_ops_skill_versions_skill ON ops_skill_versions(skill_id, version_number DESC);

CREATE TABLE IF NOT EXISTS ops_skill_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id UUID REFERENCES ops_skills(id) ON DELETE CASCADE,
  run_id UUID,
  proposed_slug TEXT,
  proposed_umbrella TEXT,
  proposed_title TEXT,
  proposed_prompt_md TEXT NOT NULL,
  proposed_collectors_json JSONB NOT NULL,
  rationale TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reviewed_by_user_id UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  reviewer_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_skill_suggestions_pending
  ON ops_skill_suggestions(skill_id, created_at DESC) WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS ops_bulk_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  skill_ids UUID[] NOT NULL,
  cadence TEXT NOT NULL CHECK (cadence IN ('daily','weekly','monthly')),
  day_of_week SMALLINT CHECK (day_of_week IS NULL OR (day_of_week BETWEEN 0 AND 6)),
  day_of_month SMALLINT CHECK (day_of_month IS NULL OR (day_of_month BETWEEN 1 AND 28)),
  hour_local SMALLINT NOT NULL DEFAULT 8 CHECK (hour_local BETWEEN 0 AND 23),
  timezone TEXT NOT NULL DEFAULT 'America/Chicago',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_bulk_schedules_due
  ON ops_bulk_schedules(next_run_at) WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS ops_bulk_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bulk_schedule_id UUID REFERENCES ops_bulk_schedules(id) ON DELETE SET NULL,
  trigger TEXT NOT NULL CHECK (trigger IN ('schedule','manual')),
  triggered_by_user_id UUID REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','running','complete','partial','failed')),
  client_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  findings_count INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_ops_bulk_runs_started ON ops_bulk_runs(started_at DESC);

ALTER TABLE ops_runs ADD COLUMN IF NOT EXISTS bulk_run_id UUID REFERENCES ops_bulk_runs(id) ON DELETE SET NULL;
ALTER TABLE ops_runs ADD COLUMN IF NOT EXISTS skill_id UUID REFERENCES ops_skills(id);
ALTER TABLE ops_runs ADD COLUMN IF NOT EXISTS skill_version_number INTEGER;

CREATE INDEX IF NOT EXISTS idx_ops_runs_bulk ON ops_runs(bulk_run_id) WHERE bulk_run_id IS NOT NULL;
