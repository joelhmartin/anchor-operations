-- Pro AI chat — persistent conversation threads + messages.
-- Stores full Anthropic content blocks for faithful replay. Idempotent.

CREATE TABLE IF NOT EXISTS ops_chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID,
  created_by UUID NOT NULL,
  title TEXT,
  model_id TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ops_chat_threads_client
  ON ops_chat_threads (client_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ops_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES ops_chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content_json JSONB NOT NULL,
  usage_json JSONB,
  cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_chat_messages_thread
  ON ops_chat_messages (thread_id, created_at);
