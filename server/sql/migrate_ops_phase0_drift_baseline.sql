-- Phase 0 drift baseline hardening.
--
-- Before this migration, runDriftCheck rolled the baseline forward on every
-- scan, which silently masked real drift between successive runs. The new
-- behavior:
--   * baseline rolls forward only on the very first scan, OR when an admin
--     explicitly accepts the new state (clears baseline_accepted_at).
--   * every scan stores its snapshot + diff summary in kinsta_scan_history,
--     so re-running drift confirms whether findings persist.
--
-- Idempotent.

ALTER TABLE kinsta_site_workspaces
  ADD COLUMN IF NOT EXISTS baseline_accepted_at TIMESTAMPTZ;

ALTER TABLE kinsta_site_workspaces
  ADD COLUMN IF NOT EXISTS baseline_accepted_by UUID;

-- Backfill: any workspace with an existing scan_json is treated as having an
-- already-accepted baseline so the new "no auto-rollover" behavior does not
-- immediately re-trigger findings on the next scan.
UPDATE kinsta_site_workspaces
   SET baseline_accepted_at = COALESCE(baseline_accepted_at, last_scan_at, NOW())
 WHERE scan_json IS NOT NULL
   AND scan_json::text <> '{}';

CREATE TABLE IF NOT EXISTS kinsta_scan_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_site_id UUID NOT NULL REFERENCES kinsta_sites(id) ON DELETE CASCADE,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  baseline_snapshot JSONB,
  fresh_snapshot JSONB,
  diff_summary JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kinsta_scan_history_site
  ON kinsta_scan_history (workspace_site_id, scanned_at DESC);
