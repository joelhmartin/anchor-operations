/** Database access check (north-star §0.2 Database). Required-table presence + R/W probe. */
import { query } from '../../../db.js';

export const REQUIRED_OPS_TABLES = [
  'ops_runs',
  'ops_run_definitions',
  'ops_check_results',
  'ops_findings',
  'ops_tool_approvals',
  'client_platform_credentials',
  'ops_access_audit_runs'
];

export async function checkOpsTables(queryFn = query, required = REQUIRED_OPS_TABLES) {
  try {
    const { rows } = await queryFn(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [required]
    );
    const have = new Set(rows.map((r) => r.table_name));
    const present = required.filter((t) => have.has(t));
    const missing = required.filter((t) => !have.has(t));
    return { status: missing.length ? 'degraded' : 'verified', present, missing };
  } catch (err) {
    return { status: 'failed', present: [], missing: [...required], detail: err?.message || String(err) };
  }
}

export async function probeReadWrite(queryFn = query) {
  try {
    await queryFn('SELECT 1');
    return { status: 'verified', detail: 'select ok' };
  } catch (err) {
    return { status: 'failed', detail: err?.message || String(err) };
  }
}
