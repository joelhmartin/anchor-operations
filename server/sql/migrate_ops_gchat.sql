-- Google Chat cockpit tables (north-star §2.7, §2.8). Idempotent.

-- ops_notification_events — delivery log for Chat/email/dashboard notifications.
-- NO PII stored here: payload_json holds IDs and counts only.
CREATE TABLE IF NOT EXISTS ops_notification_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL CHECK (channel IN ('google_chat','email','dashboard')),
  event_type      text NOT NULL,
  -- 'daily_digest','critical_alert','approval_needed','action_result','command_reply'
  client_user_id  uuid,
  reference_id    uuid,       -- run_id | finding_id | action_recommendation_id
  reference_type  text,       -- 'run' | 'finding' | 'action_recommendation'
  thread_key      text,       -- Chat thread key for threading replies
  space_name      text,       -- Chat space resource name (e.g. spaces/AAAA)
  status          text NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent','failed','skipped')),
  error_text      text,
  payload_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_notification_events_client
  ON ops_notification_events (client_user_id, created_at DESC)
  WHERE client_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ops_notification_events_ref
  ON ops_notification_events (reference_id)
  WHERE reference_id IS NOT NULL;

-- ops_chat_user_mappings — Google Chat user ID → Anchor user.
-- Populated via /anchorops connect flow or admin UI.
CREATE TABLE IF NOT EXISTS ops_chat_user_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_user_id  text NOT NULL UNIQUE,   -- e.g. 'users/1234567890'
  anchor_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name    text,                   -- cached from Chat event; never used for authz
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_chat_user_mappings_anchor
  ON ops_chat_user_mappings (anchor_user_id);
