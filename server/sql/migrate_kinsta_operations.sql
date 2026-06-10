-- Kinsta Operations: site management, SSH/SFTP, per-site workspace, audit log.
-- Idempotent. Safe to re-run.

CREATE TABLE IF NOT EXISTS kinsta_sites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kinsta_site_id TEXT UNIQUE NOT NULL,
  site_name TEXT NOT NULL,
  display_name TEXT,
  archived_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kinsta_environments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES kinsta_sites(id) ON DELETE CASCADE,
  kinsta_environment_id TEXT UNIQUE NOT NULL,
  environment_name TEXT NOT NULL,
  is_live BOOLEAN NOT NULL DEFAULT FALSE,
  primary_domain TEXT,
  ssh_host TEXT,
  ssh_ip TEXT,
  ssh_port INT,
  ssh_username TEXT,
  ssh_password_encrypted TEXT,
  ssh_password_fetched_at TIMESTAMPTZ,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_kinsta_envs_site ON kinsta_environments(site_id);
CREATE INDEX IF NOT EXISTS idx_kinsta_envs_live ON kinsta_environments(is_live) WHERE is_live = TRUE;

CREATE TABLE IF NOT EXISTS kinsta_site_workspaces (
  site_id UUID PRIMARY KEY REFERENCES kinsta_sites(id) ON DELETE CASCADE,
  claude_md TEXT NOT NULL DEFAULT '',
  scan_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  agent_prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_scan_at TIMESTAMPTZ,
  last_scan_status TEXT,
  last_scan_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS kinsta_site_clients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id UUID NOT NULL REFERENCES kinsta_sites(id) ON DELETE CASCADE,
  client_user_id UUID NOT NULL,
  relationship TEXT NOT NULL DEFAULT 'primary',
  notes TEXT,
  created_by UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT kinsta_site_clients_unique UNIQUE (site_id, client_user_id, relationship)
);
CREATE INDEX IF NOT EXISTS idx_ksc_client ON kinsta_site_clients(client_user_id);
CREATE INDEX IF NOT EXISTS idx_ksc_site ON kinsta_site_clients(site_id);

CREATE TABLE IF NOT EXISTS kinsta_ssh_command_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  environment_id UUID NOT NULL REFERENCES kinsta_environments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  channel TEXT NOT NULL,
  command_summary TEXT,
  exit_code INT,
  duration_ms INT,
  triggered_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ksshlog_env ON kinsta_ssh_command_log(environment_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ksshlog_user ON kinsta_ssh_command_log(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS kinsta_bulk_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  action TEXT NOT NULL,
  params_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'queued',
  total_targets INT NOT NULL,
  completed_targets INT NOT NULL DEFAULT 0,
  result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_kbulk_status ON kinsta_bulk_operations(status, created_at DESC);
