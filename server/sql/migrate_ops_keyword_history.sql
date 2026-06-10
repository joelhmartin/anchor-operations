-- Phase 4 — Operations rebuild Google Ads keyword history.
-- Idempotent. Stores per-day snapshots of top keywords per customer so the
-- ops pipeline can detect ranking drops without re-querying long windows.

CREATE TABLE IF NOT EXISTS ops_keyword_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id TEXT NOT NULL,
  keyword TEXT NOT NULL,
  date DATE NOT NULL,
  avg_position NUMERIC,
  impressions INT,
  clicks INT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (customer_id, keyword, date)
);

CREATE INDEX IF NOT EXISTS idx_ops_keyword_history_customer_date
  ON ops_keyword_history (customer_id, date DESC);

CREATE INDEX IF NOT EXISTS idx_ops_keyword_history_keyword
  ON ops_keyword_history (keyword);
