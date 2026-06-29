-- F4 — Recommendation → action engine (north-star §2.6).
-- Structures what ops_tool_approvals only audits: one row per recommended action
-- derived from a group of ops_findings, with deterministic risk + policy decision.
-- Idempotent.
CREATE TABLE IF NOT EXISTS ops_action_recommendations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id      uuid NOT NULL,
  run_id              uuid REFERENCES ops_runs(id) ON DELETE SET NULL,
  finding_ids         uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  category            text NOT NULL,
  title               text NOT NULL,
  summary             text NOT NULL DEFAULT '',
  rationale           text NOT NULL DEFAULT '',
  abstract_action_type text,
  action_args_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  mutating            boolean NOT NULL DEFAULT FALSE,
  destructive         boolean NOT NULL DEFAULT FALSE,
  budget_delta_cents  integer NOT NULL DEFAULT 0,
  risk_score          numeric(10,2),
  risk_tier           text CHECK (risk_tier IN ('low','medium','high','critical')),
  approval_level      text NOT NULL DEFAULT 'approval_required'
                        CHECK (approval_level IN ('none','approval_required','admin_required','blocked')),
  policy_reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status              text NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','approved','auto','executing','executed','failed','rejected','blocked','superseded')),
  approval_id         uuid REFERENCES ops_tool_approvals(id) ON DELETE SET NULL,
  preflight_json      jsonb,
  verification_json   jsonb,
  priority            integer NOT NULL DEFAULT 100,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  executed_at         timestamptz
);

CREATE INDEX IF NOT EXISTS ops_action_recommendations_client_idx
  ON ops_action_recommendations (client_user_id);
CREATE INDEX IF NOT EXISTS ops_action_recommendations_status_idx
  ON ops_action_recommendations (status);
CREATE INDEX IF NOT EXISTS ops_action_recommendations_risk_idx
  ON ops_action_recommendations (risk_score DESC NULLS LAST);
