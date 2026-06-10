-- Phase 3 — Operations rebuild website umbrella.
-- WPVuln cache for cross-referencing drift-scanned plugins against known
-- vulnerabilities. Refreshed daily by services/ops/feeds/wpvuln.js.
-- Idempotent.

CREATE TABLE IF NOT EXISTS ops_vuln_feed (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_slug TEXT NOT NULL,
  vuln_id TEXT NOT NULL,
  severity TEXT,
  fixed_in TEXT,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (plugin_slug, vuln_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_vuln_feed_slug ON ops_vuln_feed (plugin_slug);
CREATE INDEX IF NOT EXISTS idx_ops_vuln_feed_severity ON ops_vuln_feed (severity);
