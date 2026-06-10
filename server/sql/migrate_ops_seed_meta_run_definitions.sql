-- Phase 5 — Operations rebuild: Meta umbrella run definitions.
--
-- Two run definitions seeded:
--   meta_daily_essential — pixel.health, capi.health, account.spending_limit,
--     adset.delivery_issues, account.disapproved_ads.
--   meta_weekly_deep     — full Meta check set.
--
-- HIPAA: every Meta check enforces assertNonMedical() at handler entry. Medical
-- clients receive status='skipped' with payload_json={reason:'hipaa_no_meta'}.
-- Idempotent via WHERE NOT EXISTS on name.

INSERT INTO ops_run_definitions (name, description, tier, umbrellas, check_set, default_for_new_clients)
SELECT
  'meta_daily_essential',
  'Daily essential Meta checks: pixel/CAPI health, spending limit, delivery issues, disapproved ads (skipped for medical clients per HIPAA policy)',
  'daily_essential',
  ARRAY['meta']::TEXT[],
  '[
    {"check_id": "meta.pixel.health", "enabled": true},
    {"check_id": "meta.capi.health", "enabled": true},
    {"check_id": "meta.account.spending_limit", "enabled": true},
    {"check_id": "meta.adset.delivery_issues", "enabled": true},
    {"check_id": "meta.account.disapproved_ads", "enabled": true}
  ]'::jsonb,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM ops_run_definitions WHERE name = 'meta_daily_essential'
);

INSERT INTO ops_run_definitions (name, description, tier, umbrellas, check_set, default_for_new_clients)
SELECT
  'meta_weekly_deep',
  'Weekly deep Meta audit: full pixel/CAPI, audience, delivery, creative, and account-level checks (skipped for medical clients per HIPAA policy)',
  'weekly_deep',
  ARRAY['meta']::TEXT[],
  '[
    {"check_id": "meta.pixel.health", "enabled": true},
    {"check_id": "meta.capi.health", "enabled": true},
    {"check_id": "meta.capi.match_quality", "enabled": true},
    {"check_id": "meta.pixel.event_coverage", "enabled": true},
    {"check_id": "meta.pixel.deduplication", "enabled": true},
    {"check_id": "meta.audience.size", "enabled": true},
    {"check_id": "meta.audience.overlap", "enabled": true},
    {"check_id": "meta.adset.delivery_issues", "enabled": true},
    {"check_id": "meta.adset.learning_phase", "enabled": true},
    {"check_id": "meta.adset.frequency", "enabled": true},
    {"check_id": "meta.creative.fatigue", "enabled": true},
    {"check_id": "meta.account.spending_limit", "enabled": true},
    {"check_id": "meta.account.business_verification", "enabled": true},
    {"check_id": "meta.account.domain_verification", "enabled": true},
    {"check_id": "meta.account.attribution_setting", "enabled": true},
    {"check_id": "meta.account.ios14_aem_priority", "enabled": true},
    {"check_id": "meta.account.disapproved_ads", "enabled": true}
  ]'::jsonb,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM ops_run_definitions WHERE name = 'meta_weekly_deep'
);
