-- ============================================================================
-- ops_app — least-privilege DB role for the standalone Operations app.
-- Run ONCE against the shared Cloud SQL `anchor` instance (as a superuser /
-- the instance owner). See the three-app integration plan §2.
--
-- Ops is a READ-heavy consumer of client data and the WRITER/owner of the ops
-- + kinsta tables. It must NOT be able to write the main app's CRM tables.
--
-- Usage:
--   psql "$ADMIN_DATABASE_URL" -v ops_password="'<strong-password>'" \
--        -f infra/sql/ops_app_role.sql
-- Then store  postgresql://ops_app:<password>@<host>:5432/anchor  as the
-- Secret Manager secret `anchor-db-url-ops` (mounted as DATABASE_URL).
-- ============================================================================

-- 1. Role (login). Password passed via -v ops_password to avoid hardcoding.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    CREATE ROLE ops_app LOGIN;
  END IF;
END
$$;

\if :{?ops_password}
  ALTER ROLE ops_app PASSWORD :ops_password;
\endif

-- 2. Connect + schema usage.
GRANT CONNECT ON DATABASE anchor TO ops_app;
GRANT USAGE ON SCHEMA public TO ops_app;

-- 3. READ access to the client data ops reads live (owned by the main app).
--    No INSERT/UPDATE/DELETE — ops never mutates these.
GRANT SELECT ON
  users,
  client_profiles,
  client_account_members,
  brand_assets,
  tracking_configs,
  oauth_connections
TO ops_app;

-- Tracking-number health + CTM checks read these (see services/ops/checks/ctm).
GRANT SELECT ON twilio_tracking_numbers, call_logs TO ops_app;

-- 4. FULL DML on the tables ops OWNS (ops_* + kinsta_*).
--    These already exist (dormant) in the shared DB; ops runs its idempotent
--    migrations against them. Grant DML on each existing ops_/kinsta_ table.
DO $$
DECLARE r record;
BEGIN
  FOR r IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND (tablename LIKE 'ops\_%' OR tablename LIKE 'kinsta\_%')
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO ops_app', r.tablename);
  END LOOP;
END
$$;

-- 5. Sequences for the ops-owned tables (serial/identity inserts).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ops_app;

-- 6. Default privileges so future ops_/kinsta_ tables created by the migrations
--    are usable. (Applies to objects created by the role running this script.)
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ops_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ops_app;

-- NOTE: a few ops migrations ALTER main-owned base tables (e.g.
-- client_profiles.ops_monthly_cap_cents, audit_runs deprecation marker). Those
-- ALTERs must be applied by an owner/superuser, not ops_app. Run the migrations
-- once as the admin role (yarn db:migrate with ADMIN_DATABASE_URL), then have the
-- running app connect as ops_app for normal operation.
