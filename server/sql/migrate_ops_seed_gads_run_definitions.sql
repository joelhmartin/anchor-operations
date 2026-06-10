-- Phase 4 — Operations rebuild Google Ads run definitions.
-- Seeds two run definitions for the google_ads umbrella:
--   gads_daily_essential — budget pacing, disapproved ads, conversion firing
--   gads_weekly_deep     — full audit set
-- Idempotent via WHERE NOT EXISTS on name.

INSERT INTO ops_run_definitions (name, description, tier, umbrellas, check_set, default_for_new_clients)
SELECT
  'gads_daily_essential',
  'Daily essential Google Ads checks: budget pacing, disapproved ads, conversion firing',
  'daily_essential',
  ARRAY['google_ads']::TEXT[],
  '[
    {"check_id": "gads.account.budget_pacing", "enabled": true},
    {"check_id": "gads.account.disapproved_ads", "enabled": true},
    {"check_id": "gads.conversion_tag.firing", "enabled": true}
  ]'::jsonb,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM ops_run_definitions WHERE name = 'gads_daily_essential'
);

INSERT INTO ops_run_definitions (name, description, tier, umbrellas, check_set, default_for_new_clients)
SELECT
  'gads_weekly_deep',
  'Weekly deep Google Ads audit: conversion tracking, account config, negative keywords, keyword history, suggested checks',
  'weekly_deep',
  ARRAY['google_ads']::TEXT[],
  '[
    {"check_id": "gads.conversion_tag.installed", "enabled": true},
    {"check_id": "gads.conversion_tag.firing", "enabled": true},
    {"check_id": "gads.conversion_action.cpa_drift", "enabled": true},
    {"check_id": "gads.conversion_source.validity", "enabled": true},
    {"check_id": "gads.negative_keywords.recent_changes", "enabled": true},
    {"check_id": "gads.negative_keywords.coverage", "enabled": true},
    {"check_id": "gads.account.linked_analytics", "enabled": true},
    {"check_id": "gads.account.linked_search_console", "enabled": true},
    {"check_id": "gads.account.linked_merchant_center", "enabled": true},
    {"check_id": "gads.account.disapproved_ads", "enabled": true},
    {"check_id": "gads.account.budget_pacing", "enabled": true},
    {"check_id": "gads.account.location_bid_modifiers", "enabled": true},
    {"check_id": "gads.account.device_bid_modifiers", "enabled": true},
    {"check_id": "gads.account.audience_lists.populated", "enabled": true},
    {"check_id": "gads.account.audience_lists.size", "enabled": true},
    {"check_id": "gads.account.ad_extensions.sitelinks", "enabled": true},
    {"check_id": "gads.account.ad_extensions.callouts", "enabled": true},
    {"check_id": "gads.account.ad_extensions.callout_phone", "enabled": true},
    {"check_id": "gads.account.auto_applied_recommendations", "enabled": true},
    {"check_id": "gads.keywords.position_changes", "enabled": true},
    {"check_id": "gads.account.smart_bidding.adoption", "enabled": true},
    {"check_id": "gads.search_terms.brand_competitors", "enabled": true},
    {"check_id": "gads.account.url_options.tracking_template", "enabled": true},
    {"check_id": "gads.account.final_url_suffix", "enabled": true},
    {"check_id": "gads.account.experiments.active", "enabled": true}
  ]'::jsonb,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM ops_run_definitions WHERE name = 'gads_weekly_deep'
);
