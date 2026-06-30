-- Ensure the least-privilege runtime role `ops_app` has DML on EVERY ops_/kinsta_
-- table. Migrations create new tables as the admin/owner role; the
-- ALTER DEFAULT PRIVILEGES in infra/sql/ops_app_role.sql only covers objects
-- created by the role that ran that script, so tables created by the migration
-- admin role can land without granting ops_app — causing "permission denied for
-- table ..." at runtime (e.g. ops_access_audit_runs, ops_service_connections).
--
-- A few ops-runtime tables don't carry the ops_/kinsta_ prefix and so were
-- missed by the prefix loop. The proven case: `client_run_subscriptions`, which
-- the schedule-fanout endpoint reads (and the subscriptions API writes) — its
-- absence here made POST /api/ops/internal/fanout 500 with
-- "permission denied for table client_run_subscriptions", blocking daily run
-- fanout. Such tables are listed in EXTRA_OPS_TABLES below.
--
-- This idempotent grant loop closes the gap and is safe to run on every deploy.
-- Guarded on ops_app existing, so it's a no-op in local dev (which connects as a
-- superuser and has no ops_app role). Keep this migration LAST so it covers every
-- table created earlier in the same run.
DO $$
DECLARE r record;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'ops_app') THEN
    FOR r IN
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND (tablename LIKE 'ops\_%'
             OR tablename LIKE 'kinsta\_%'
             OR tablename IN ('client_run_subscriptions'))
    LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO ops_app', r.tablename);
    END LOOP;
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ops_app';
  END IF;
END
$$;
