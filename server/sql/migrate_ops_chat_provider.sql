ALTER TABLE ops_chat_threads ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'google';
-- Existing threads were all Claude; backfill them so their history replays on the Anthropic runtime.
UPDATE ops_chat_threads SET provider = 'anthropic'
 WHERE provider = 'google' AND model_id LIKE 'claude-%';
