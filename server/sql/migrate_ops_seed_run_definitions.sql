-- Phase 3 — Operations rebuild website umbrella.
-- Seed three run definitions for the website umbrella: daily essential,
-- weekly deep, and monthly audit. Idempotent via WHERE NOT EXISTS on name.

INSERT INTO ops_run_definitions (name, description, tier, umbrellas, check_set, default_for_new_clients)
SELECT
  'web_daily_essential',
  'Daily essential website checks: tracking install, SSL expiry, uptime',
  'daily_essential',
  ARRAY['website']::TEXT[],
  '[
    {"check_id": "web.tracking_install", "enabled": true},
    {"check_id": "web.ssl.expiry_within_30d", "enabled": true},
    {"check_id": "web.ssl.expiry_within_7d", "enabled": true},
    {"check_id": "web.uptime.reachable", "enabled": true}
  ]'::jsonb,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM ops_run_definitions WHERE name = 'web_daily_essential'
);

INSERT INTO ops_run_definitions (name, description, tier, umbrellas, check_set, default_for_new_clients)
SELECT
  'web_weekly_deep',
  'Weekly deep website checks: PSI (mobile + desktop), GSC, SEMrush, schema, Kinsta drift, WP security',
  'weekly_deep',
  ARRAY['website']::TEXT[],
  '[
    {"check_id": "web.psi", "enabled": true},
    {"check_id": "web.gsc.coverage_errors", "enabled": true},
    {"check_id": "web.gsc.manual_actions", "enabled": true},
    {"check_id": "web.gsc.crux_lcp", "enabled": true},
    {"check_id": "web.gsc.indexed_pages_drop", "enabled": true},
    {"check_id": "web.semrush.organic_traffic_drop", "enabled": true},
    {"check_id": "web.semrush.top_keywords_lost", "enabled": true},
    {"check_id": "web.semrush.toxic_backlinks", "enabled": true},
    {"check_id": "web.schema.has_organization", "enabled": true},
    {"check_id": "web.schema.has_localbusiness", "enabled": true},
    {"check_id": "web.schema.parse_errors", "enabled": true},
    {"check_id": "web.kinsta.drift", "enabled": true},
    {"check_id": "web.wp_security", "enabled": true}
  ]'::jsonb,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM ops_run_definitions WHERE name = 'web_weekly_deep'
);

INSERT INTO ops_run_definitions (name, description, tier, umbrellas, check_set, default_for_new_clients)
SELECT
  'web_monthly_audit',
  'Monthly audit: full website check set including broken links',
  'monthly_audit',
  ARRAY['website']::TEXT[],
  '[
    {"check_id": "web.tracking_install", "enabled": true},
    {"check_id": "web.ssl.expiry_within_30d", "enabled": true},
    {"check_id": "web.ssl.expiry_within_7d", "enabled": true},
    {"check_id": "web.uptime.reachable", "enabled": true},
    {"check_id": "web.psi", "enabled": true},
    {"check_id": "web.gsc.coverage_errors", "enabled": true},
    {"check_id": "web.gsc.manual_actions", "enabled": true},
    {"check_id": "web.gsc.crux_lcp", "enabled": true},
    {"check_id": "web.gsc.indexed_pages_drop", "enabled": true},
    {"check_id": "web.semrush.organic_traffic_drop", "enabled": true},
    {"check_id": "web.semrush.top_keywords_lost", "enabled": true},
    {"check_id": "web.semrush.toxic_backlinks", "enabled": true},
    {"check_id": "web.schema.has_organization", "enabled": true},
    {"check_id": "web.schema.has_localbusiness", "enabled": true},
    {"check_id": "web.schema.parse_errors", "enabled": true},
    {"check_id": "web.kinsta.drift", "enabled": true},
    {"check_id": "web.wp_security", "enabled": true},
    {"check_id": "web.broken_links", "enabled": true}
  ]'::jsonb,
  FALSE
WHERE NOT EXISTS (
  SELECT 1 FROM ops_run_definitions WHERE name = 'web_monthly_audit'
);
