-- meta_page_links: per-client mapping to one FB Page (and its IG Business account, if any)
CREATE TABLE IF NOT EXISTS meta_page_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fb_page_id TEXT NOT NULL,
  fb_page_name TEXT NOT NULL,
  ig_user_id TEXT,
  ig_username TEXT,
  page_access_token_encrypted TEXT,
  scheduling_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  last_health_check_at TIMESTAMPTZ,
  last_health_status TEXT,
  last_health_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  archived_at TIMESTAMPTZ,
  UNIQUE (client_id, fb_page_id)
);
CREATE INDEX IF NOT EXISTS idx_meta_page_links_client ON meta_page_links(client_id) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS social_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  page_link_id UUID NOT NULL REFERENCES meta_page_links(id),
  created_by UUID NOT NULL REFERENCES users(id),
  platforms TEXT[] NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  link_url TEXT,
  media JSONB NOT NULL DEFAULT '[]'::jsonb,
  scheduled_for TIMESTAMPTZ,
  status TEXT NOT NULL CHECK (status IN ('draft','scheduled','publishing','published','partially_published','failed','cancelled')),
  fb_post_id TEXT,
  ig_media_id TEXT,
  published_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_posts_client_status ON social_posts(client_id, status);
CREATE INDEX IF NOT EXISTS idx_social_posts_scheduled_due ON social_posts(scheduled_for) WHERE status='scheduled';
CREATE INDEX IF NOT EXISTS idx_social_posts_calendar ON social_posts(client_id, COALESCE(scheduled_for, published_at, created_at));

CREATE TABLE IF NOT EXISTS social_media_tokens (
  jti TEXT PRIMARY KEY,
  file_upload_id UUID NOT NULL REFERENCES file_uploads(id) ON DELETE CASCADE,
  post_id UUID REFERENCES social_posts(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_social_media_tokens_expires ON social_media_tokens(expires_at) WHERE revoked_at IS NULL;
