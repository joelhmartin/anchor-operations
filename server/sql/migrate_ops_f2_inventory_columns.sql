-- F2 — extend ops_platform_inventory with additional columns needed by
-- discoverInventory connectors. F1 ships the base table; this migration
-- adds the columns F2 writes. Idempotent (ADD COLUMN IF NOT EXISTS).
ALTER TABLE ops_platform_inventory
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS parent_external_id text,
  ADD COLUMN IF NOT EXISTS url text;

-- Relax NOT NULL on client_user_id: discovery can run in a system-level
-- context without a user scope (F1 created it NOT NULL; connectors that
-- lack a client user scope will pass NULL here).
ALTER TABLE ops_platform_inventory
  ALTER COLUMN client_user_id DROP NOT NULL;
