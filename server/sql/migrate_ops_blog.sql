-- Ops-owned blog publishing — posts scheduled + published to clients' self-hosted
-- WordPress via the REST API. Distinct from the dashboard's client-facing blog_posts.
-- Idempotent.

CREATE TABLE IF NOT EXISTS ops_blog_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  oauth_connection_id UUID,
  site_resource_id UUID,
  site_url TEXT,
  created_by UUID NOT NULL,
  title TEXT NOT NULL,
  content_markdown TEXT NOT NULL DEFAULT '',
  featured_file_upload_id UUID,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_for TIMESTAMPTZ,
  wp_post_id TEXT,
  wp_post_url TEXT,
  published_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_blog_posts_client ON ops_blog_posts (client_id, status);
CREATE INDEX IF NOT EXISTS idx_ops_blog_posts_due ON ops_blog_posts (scheduled_for) WHERE status = 'scheduled';
