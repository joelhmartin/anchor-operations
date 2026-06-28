-- F1 — ops_client_assets (expandability §6).
-- A client's web presence modeled as discrete assets (a site is NOT one WP
-- install): website, landing_page, blog, repo, deployment, … Each MAY link to
-- the connection that manages it. Idempotent.
CREATE TABLE IF NOT EXISTS ops_client_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id  uuid NOT NULL,
  asset_type      text NOT NULL,
  provider        text,
  url             text,
  label           text,
  connection_id   uuid REFERENCES ops_service_connections(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','archived')),
  attributes_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_user_id, asset_type, url)
);

CREATE INDEX IF NOT EXISTS idx_ops_client_assets_client
  ON ops_client_assets (client_user_id);
CREATE INDEX IF NOT EXISTS idx_ops_client_assets_connection
  ON ops_client_assets (connection_id);
