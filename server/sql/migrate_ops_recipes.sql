-- Idempotent migration: ops_recipes (agent-grown reusable techniques) +
-- a column on ops_skill_suggestions tagging it as a recipe proposal.

CREATE TABLE IF NOT EXISTS ops_recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  umbrella TEXT NOT NULL CHECK (umbrella IN ('website','google_ads','meta','ctm')),
  title TEXT NOT NULL,
  recipe_md TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user','agent')),
  proposed_from_run_id UUID,                 -- ops_runs.id, no FK to keep loose-coupled
  approved_by_user_id UUID REFERENCES users(id),
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_recipes_umbrella
  ON ops_recipes(umbrella) WHERE archived_at IS NULL;

-- Repurpose existing ops_skill_suggestions: when status='approved' AND a new column
-- 'created_recipe_id' is set, the approval created a recipe. (skill_id remains the
-- "context skill" the suggestion arose from but is not edited on approve anymore.)
ALTER TABLE ops_skill_suggestions
  ADD COLUMN IF NOT EXISTS created_recipe_id UUID REFERENCES ops_recipes(id) ON DELETE SET NULL;
