-- Access Audit (north-star §0.3). One row per audit run.
CREATE TABLE IF NOT EXISTS ops_access_audit_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','verified','degraded','failed','error')),
  environment     text,
  service_account text,
  project_id      text,
  summary_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  details_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_json    jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings_json   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS ops_access_audit_runs_created_idx
  ON ops_access_audit_runs (created_at DESC);
