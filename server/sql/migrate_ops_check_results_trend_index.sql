-- Phase 6 — Operations rebuild: trend storage / index.
--
-- Denormalizes client_user_id onto ops_check_results so trend queries
-- ("show me the last 5 runs of check X for client Y") avoid joining
-- ops_runs every time. Backfills existing rows from ops_runs.
--
-- The runExecutor now writes client_user_id at insert time (see
-- server/services/ops/runExecutor.js — persistCheckResult).
--
-- Idempotent.

ALTER TABLE ops_check_results
  ADD COLUMN IF NOT EXISTS client_user_id UUID;

UPDATE ops_check_results r
   SET client_user_id = run.client_user_id
  FROM ops_runs run
 WHERE r.run_id = run.id
   AND r.client_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_ops_check_results_trend
  ON ops_check_results (client_user_id, check_id, created_at DESC);
