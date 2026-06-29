-- F7 — GSC property-to-client match cache (north-star §6.4).
-- One row per (client, GSC property). Upserted by discoverInventory().
-- Superseded by ops_platform_inventory when F1 lands; this table stays as-is
-- and both can be written to simultaneously.
CREATE TABLE IF NOT EXISTS ops_gsc_site_inventory (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id   uuid NOT NULL,
  site_url         text NOT NULL,
  permission_level text,
  property_type    text NOT NULL CHECK (property_type IN ('domain', 'url_prefix')),
  match_type       text NOT NULL CHECK (match_type IN (
                     'exact_config', 'sc_domain',
                     'url_prefix_https_www', 'url_prefix_https',
                     'url_prefix_http', 'manual')),
  match_confidence numeric(4,3) NOT NULL DEFAULT 0
                     CHECK (match_confidence >= 0 AND match_confidence <= 1),
  website_url      text,
  discovered_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_user_id, site_url)
);

CREATE INDEX IF NOT EXISTS idx_ops_gsc_inventory_client
  ON ops_gsc_site_inventory (client_user_id, match_confidence DESC);
