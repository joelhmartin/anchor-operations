-- Phase 8 — Operations rebuild: per-client monthly budget cap + rotation stub.
--
-- 1. client_profiles.ops_monthly_cap_cents — month-to-date AI/check spend cap.
--    Default 500 cents = $5/client/month per locked decision P7.
-- 2. client_run_subscriptions.rotation_group — 1-7 day-of-week rotation stub
--    (per plan §10.4 "Don't enable until needed"). Nullable.
--
-- Idempotent.

ALTER TABLE client_profiles
  ADD COLUMN IF NOT EXISTS ops_monthly_cap_cents INT NOT NULL DEFAULT 500;

ALTER TABLE client_run_subscriptions
  ADD COLUMN IF NOT EXISTS rotation_group SMALLINT;

-- Sanity guard: rotation_group must be 1..7 when set.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'client_run_subscriptions_rotation_group_chk'
  ) THEN
    ALTER TABLE client_run_subscriptions
      ADD CONSTRAINT client_run_subscriptions_rotation_group_chk
      CHECK (rotation_group IS NULL OR (rotation_group BETWEEN 1 AND 7));
  END IF;
END $$;
