-- Phase 10 — mark legacy `audit_runs` / `audit_schedules` tables as separate
-- from the new `ops_runs` pipeline. P6 of the rebuild locked this decision
-- (keep separate). Idempotent: COMMENT ON is always overwriting; tables may
-- not exist on fresh installs that haven't run the analytics audits migration
-- yet — gate via to_regclass.

DO $$
BEGIN
  IF to_regclass('public.audit_runs') IS NOT NULL THEN
    EXECUTE 'COMMENT ON TABLE audit_runs IS ''Legacy analytics audit runs — kept separate from ops_runs per ops-rebuild P6 (2026-05-05). Do not extend.''';
  END IF;
  IF to_regclass('public.audit_schedules') IS NOT NULL THEN
    EXECUTE 'COMMENT ON TABLE audit_schedules IS ''Legacy analytics audit schedules — kept separate from ops_runs per ops-rebuild P6 (2026-05-05). Do not extend.''';
  END IF;
END $$;
