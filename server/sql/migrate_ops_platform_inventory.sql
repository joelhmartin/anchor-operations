-- F1 — ops_platform_inventory (north-star §2.3, spec §6).
-- External objects discovered for a connection (pages, campaigns, properties…).
-- Populated by connector discoverInventory() in F2; F1 ships the table only.
-- Idempotent.
CREATE TABLE IF NOT EXISTS ops_platform_inventory (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id   uuid NOT NULL,
  connection_id    uuid REFERENCES ops_service_connections(id) ON DELETE CASCADE,
  service_category text NOT NULL,
  provider         text NOT NULL,
  object_type      text NOT NULL,
  external_id      text NOT NULL,
  name             text,
  attributes_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovered_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, object_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_platform_inventory_client
  ON ops_platform_inventory (client_user_id, service_category);
CREATE INDEX IF NOT EXISTS idx_ops_platform_inventory_connection
  ON ops_platform_inventory (connection_id);
