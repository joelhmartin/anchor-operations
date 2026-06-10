-- Idempotent migration: add per-skill model override.
-- Null = inherit from OPERATIONS_AGENT_MODEL / VERTEX_MODEL env var.

ALTER TABLE ops_skills          ADD COLUMN IF NOT EXISTS model TEXT;
ALTER TABLE ops_skill_versions  ADD COLUMN IF NOT EXISTS model TEXT;
