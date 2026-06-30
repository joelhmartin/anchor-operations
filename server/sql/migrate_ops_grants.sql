-- Ensure the least-privilege runtime role `ops_app` has DML on EVERY ops_/kinsta_
-- table. Migrations create new tables as the admin/owner role; the
-- ALTER DEFAULT PRIVILEGES in infra/sql/ops_app_role.sql only covers objects
-- created by the role that ran that script, so tables created by the migration
-- admin role can land without granting ops_app — causing "permission denied for
-- table ..." at runtime (e.g. ops_access_audit_runs, ops_service_connections).
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
        AND (tablename LIKE 'ops\_%' OR tablename LIKE 'kinsta\_%')
    LOOP
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO ops_app', r.tablename);
    END LOOP;
    EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ops_app';
  END IF;
END
$$;
