-- Command Center pivot — Phase B.
--
-- Reframes ops_findings into a Discovery model: adds status workflow, owner,
-- attention_score (computed in app code; see server/services/ops/attentionScore.js),
-- business_impact + affected_platforms for inbox rendering, and slots for
-- recommended_action / proposed_plan / evidence_pack that later phases populate.
--
-- Also extends ops_tool_approvals with finding_id + plan_action_id so future
-- Plan-driven approvals can correlate back to the originating discovery and
-- the specific plan step that produced them. The plan_action_id FK is added
-- in the Phase D migration (migrate_ops_plans.sql) once ops_plan_actions
-- exists.
--
-- Idempotent. Re-running the migration must be safe.

ALTER TABLE ops_findings
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','investigating','blocked','resolved','ignored')),
  ADD COLUMN IF NOT EXISTS attention_score NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS attention_recomputed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS business_impact TEXT,
  ADD COLUMN IF NOT EXISTS affected_platforms TEXT[],
  ADD COLUMN IF NOT EXISTS recommended_action_json JSONB,
  ADD COLUMN IF NOT EXISTS proposed_plan_json JSONB,
  ADD COLUMN IF NOT EXISTS owner_user_id UUID,
  ADD COLUMN IF NOT EXISTS evidence_pack_json JSONB,
  ADD COLUMN IF NOT EXISTS evidence_pack_built_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_ops_findings_attention
  ON ops_findings (attention_score DESC NULLS LAST)
  WHERE resolved_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_ops_findings_status
  ON ops_findings (status)
  WHERE status IN ('open','investigating');

CREATE INDEX IF NOT EXISTS idx_ops_findings_owner
  ON ops_findings (owner_user_id)
  WHERE owner_user_id IS NOT NULL;

-- Backfill: rows with resolved_at IS NOT NULL should reflect status='resolved';
-- everything else stays at the default ('open'). Idempotent — only updates
-- mismatched rows.
UPDATE ops_findings
   SET status = 'resolved'
 WHERE resolved_at IS NOT NULL
   AND status = 'open';

-- Backfill affected_platforms from category prefix (everything before the
-- first dot). Correlation findings cross multiple platforms so we mark them
-- as 'correlation'; later phases will populate the explicit platform list
-- when correlator rules are extended.
UPDATE ops_findings
   SET affected_platforms = ARRAY[split_part(category, '.', 1)]
 WHERE affected_platforms IS NULL
   AND category IS NOT NULL
   AND category NOT LIKE 'correlation.%';

UPDATE ops_findings
   SET affected_platforms = ARRAY['correlation']
 WHERE affected_platforms IS NULL
   AND category LIKE 'correlation.%';

-- ops_tool_approvals: add finding_id + plan_action_id so Plan-driven
-- approvals (Phase D) can correlate back to the originating discovery.
ALTER TABLE ops_tool_approvals
  ADD COLUMN IF NOT EXISTS finding_id UUID REFERENCES ops_findings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS plan_action_id UUID;

CREATE INDEX IF NOT EXISTS idx_ops_tool_approvals_finding
  ON ops_tool_approvals (finding_id)
  WHERE finding_id IS NOT NULL;
