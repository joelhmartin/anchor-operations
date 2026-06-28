-- F1 — ops_service_connections (north-star §2.1, spec §6).
-- Formalizes client_platform_credentials linkage and OWNS the status lifecycle:
--   missing → configured → verified → degraded → failed → disabled
-- Idempotent. Re-running must be safe.
CREATE TABLE IF NOT EXISTS ops_service_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id   uuid NOT NULL,
  service_category text NOT NULL,
  provider         text NOT NULL,
  connection_type  text,
  credential_ref   uuid REFERENCES client_platform_credentials(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'missing'
                     CHECK (status IN ('missing','configured','verified','degraded','failed','disabled')),
  capabilities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail           text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_user_id, service_category, provider)
);

CREATE INDEX IF NOT EXISTS idx_ops_service_connections_client
  ON ops_service_connections (client_user_id);
CREATE INDEX IF NOT EXISTS idx_ops_service_connections_cat_prov
  ON ops_service_connections (service_category, provider);
