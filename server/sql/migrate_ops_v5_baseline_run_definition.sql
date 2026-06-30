-- V5 — Baseline anomaly run definition.
-- Registers a daily_essential run definition whose check_set runs the
-- snapshot.metric_anomaly check. A client subscribed to this definition gets a
-- daily run that scores its latest snapshot against learned baselines and
-- (via the correlator) writes an ops_findings row when a metric deviates.
--
-- Idempotent: ops_run_definitions has no unique constraint on name, so we
-- upsert by name explicitly (update if present, insert otherwise).

WITH upsert AS (
  UPDATE ops_run_definitions
     SET description = 'Daily snapshot anomaly scan: compares the latest per-client snapshot to learned baselines and flags significant metric deviations.',
         tier        = 'daily_essential',
         umbrellas   = ARRAY['baselines']::text[],
         check_set   = '[{"check_id":"snapshot.metric_anomaly","enabled":true}]'::jsonb,
         updated_at  = now()
   WHERE name = 'baselines_daily_essential'
  RETURNING id
)
INSERT INTO ops_run_definitions (name, description, tier, umbrellas, check_set, default_for_new_clients)
SELECT
  'baselines_daily_essential',
  'Daily snapshot anomaly scan: compares the latest per-client snapshot to learned baselines and flags significant metric deviations.',
  'daily_essential',
  ARRAY['baselines']::text[],
  '[{"check_id":"snapshot.metric_anomaly","enabled":true}]'::jsonb,
  false
WHERE NOT EXISTS (SELECT 1 FROM upsert);
