-- Kinsta Operations: drift findings (user-triggered drift detection results).
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS kinsta_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES kinsta_sites(id) ON DELETE CASCADE,
  environment_id UUID REFERENCES kinsta_environments(id) ON DELETE SET NULL,
  severity TEXT NOT NULL,                     -- 'critical' | 'warning' | 'info'
  category TEXT NOT NULL,                     -- 'wp_version_drift' | 'plugin_removed' | 'plugin_added' | 'siteurl_changed' | 'debug_enabled' | 'tracking_missing' | 'theme_changed' | etc
  summary TEXT NOT NULL,
  evidence_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_by UUID,
  acknowledged_at TIMESTAMPTZ,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_kfind_site_open
  ON kinsta_findings(site_id) WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_kfind_created
  ON kinsta_findings(created_at DESC);
