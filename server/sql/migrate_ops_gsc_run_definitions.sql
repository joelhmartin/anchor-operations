-- F7 — Add new gsc.* checks to existing website run definitions.
-- Uses jsonb_agg to append only checks not already present (idempotent).
-- gsc.connection_health → daily_essential
-- all others → weekly_deep and monthly_audit

UPDATE ops_run_definitions
SET check_set = check_set || '[{"check_id": "gsc.connection_health", "enabled": true}]'::jsonb
WHERE name = 'web_daily_essential'
  AND NOT (check_set @> '[{"check_id": "gsc.connection_health"}]'::jsonb);

UPDATE ops_run_definitions
SET check_set = check_set || '[
  {"check_id": "gsc.site_access_missing", "enabled": true},
  {"check_id": "gsc.click_drop", "enabled": true},
  {"check_id": "gsc.impression_drop", "enabled": true},
  {"check_id": "gsc.page_decline", "enabled": true},
  {"check_id": "gsc.query_decline", "enabled": true},
  {"check_id": "gsc.query_opportunity", "enabled": true},
  {"check_id": "gsc.page_indexing_issue", "enabled": true},
  {"check_id": "gsc.canonical_mismatch", "enabled": true},
  {"check_id": "gsc.device_specific_drop", "enabled": true},
  {"check_id": "gsc.zero_click_high_impression_pages", "enabled": true}
]'::jsonb
WHERE name IN ('web_weekly_deep', 'web_monthly_audit')
  AND NOT (check_set @> '[{"check_id": "gsc.click_drop"}]'::jsonb);
