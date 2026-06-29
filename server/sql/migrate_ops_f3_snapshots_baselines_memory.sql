-- F3 — Snapshots + baselines + memory (north-star §2.4, §2.5, §2.9).
-- Idempotent. The "knows normal" learning loop sits underneath the run spine.
-- Snapshots store NUMERIC AGGREGATES ONLY (no PHI). Baselines + anomaly scoring
-- read these rows deterministically; the LLM never does metric math here.

-- ---------------------------------------------------------------------------
-- ops_daily_snapshots (§2.4) — one row per client/day/service/scope object.
-- metrics_json is a flat map of normalized metricName -> number, plus provider
-- extras. Written by F1 connectors' collectSnapshot(); read by the baseline
-- engine. UNIQUE key makes daily writes upsertable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_daily_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL,
  snapshot_date DATE NOT NULL,
  service       TEXT NOT NULL,          -- service_category or provider id (e.g. paid_ads, ga4)
  scope_type    TEXT NOT NULL,          -- account | campaign | property | site | ...
  scope_id      TEXT NOT NULL,          -- external id of the scoped object
  metrics_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_run_id UUID,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_user_id, snapshot_date, service, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_daily_snapshots_series
  ON ops_daily_snapshots (client_user_id, service, scope_type, scope_id, snapshot_date DESC);

-- ---------------------------------------------------------------------------
-- ops_metric_baselines (§2.5) — one row per client/scope/metric/period.
-- baseline_value = mean daily value over the window; stddev null when too few
-- samples; sample_count = days of data used. Upserted by computeAndPersistBaselines.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_metric_baselines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL,
  service       TEXT NOT NULL,
  scope_type    TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  metric        TEXT NOT NULL,          -- normalized metric name
  period        TEXT NOT NULL,          -- 7_day|30_day|weekday_4_week|previous_month|trailing_90_day|month_to_date
  baseline_value NUMERIC,
  stddev        NUMERIC,
  sample_count  INT NOT NULL DEFAULT 0,
  window_start  DATE,
  window_end    DATE,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_user_id, service, scope_type, scope_id, metric, period)
);

CREATE INDEX IF NOT EXISTS idx_ops_metric_baselines_lookup
  ON ops_metric_baselines (client_user_id, service, scope_type, scope_id, metric);

-- ---------------------------------------------------------------------------
-- ops_agent_memory (§2.9) — curated per-client memory. Learned from approved/
-- rejected recommendations, repeated false positives, stable configs, and
-- manual notes. fact_key dedupes; occurrences/confidence accrue on repeat.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_agent_memory (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'client',  -- 'client' or a service name
  fact_type     TEXT NOT NULL,          -- approved_pattern|rejected_pattern|false_positive|stable_config|manual_note
  fact_key      TEXT NOT NULL,
  fact_value    JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence    NUMERIC NOT NULL DEFAULT 0.5,
  occurrences   INT NOT NULL DEFAULT 1,
  source        TEXT NOT NULL DEFAULT 'learned',  -- learned | manual
  status        TEXT NOT NULL DEFAULT 'active',   -- active | archived
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID,
  UNIQUE (client_user_id, scope, fact_type, fact_key)
);

CREATE INDEX IF NOT EXISTS idx_ops_agent_memory_client
  ON ops_agent_memory (client_user_id, status, fact_type);
