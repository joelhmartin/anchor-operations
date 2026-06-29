// Operations migration runner.
//
// This standalone app OWNS the ops/kinsta schema in the shared database (see the
// three-app integration plan §3). These migrations are idempotent — every file is
// `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... IF NOT EXISTS` / seed upserts —
// so running them against the already-dormant ops_*/kinsta_* tables in the shared
// DB is safe. The main (anchor-hub) app no longer runs them.
//
// Order matters: foundation tables before the migrations that ALTER them, and
// the skills/bulk schema before the seed-skills sync.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from './db.js';

const SQL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sql');

// Run in this exact order. syncSeedSkills() runs after migrate_ops_skills_and_bulk.
const MIGRATIONS_BEFORE_SEED = [
  'migrate_kinsta_operations.sql',
  'migrate_kinsta_findings.sql',
  'migrate_ops_phase0_drift_baseline.sql',
  'migrate_ops_foundation.sql',
  'migrate_ops_vuln_feed.sql',
  'migrate_ops_seed_run_definitions.sql',
  'migrate_ops_seed_meta_run_definitions.sql',
  'migrate_ops_keyword_history.sql',
  'migrate_ops_seed_gads_run_definitions.sql',
  'migrate_ops_check_results_trend_index.sql',
  'migrate_ops_subscription_email.sql',
  'migrate_ops_monthly_cap.sql',
  'migrate_ops_audit_runs_deprecation_marker.sql',
  'migrate_ops_discoveries_upgrade.sql',
  'migrate_ops_skills_and_bulk.sql',
  'migrate_social_publishing.sql',
  'migrate_ops_chat.sql',
  'migrate_ops_chat_provider.sql',
  'migrate_ops_blog.sql',
  'migrate_ops_blog_ssh.sql',
  'migrate_ops_access_audit_runs.sql',
  'migrate_ops_service_connections.sql',
  'migrate_ops_platform_inventory.sql',
  'migrate_ops_client_assets.sql',
  'migrate_ops_f3_snapshots_baselines_memory.sql'
];

const MIGRATIONS_AFTER_SEED = ['migrate_ops_recipes.sql', 'migrate_ops_skill_model.sql', 'migrate_ops_run_definition_model.sql', 'migrate_ops_f2_inventory_columns.sql'];

async function runFile(file, { throwOnError = false } = {}) {
  try {
    const sql = await readFile(path.join(SQL_DIR, file), 'utf8');
    await query(sql);
    console.warn(`[migrations] applied ${file}`);
  } catch (err) {
    console.error(`[migrations] ${file} failed:`, err.message || err);
    if (throwOnError) throw err;
  }
}

/**
 * Run all ops migrations in order, then sync the seed skills.
 * @param {{ throwOnError?: boolean }} opts - throwOnError surfaces failures (use
 *   in the CLI migrate script); the server start path swallows them so a single
 *   bad migration never crashes a running instance.
 */
export async function runOpsMigrations(opts = {}) {
  for (const file of MIGRATIONS_BEFORE_SEED) {
    await runFile(file, opts);
  }
  try {
    const { syncSeedSkills } = await import('./services/ops/skills/seed.js');
    const r = await syncSeedSkills();
    console.warn(`[migrations] ops seed skills: created=${r.created} existed=${r.existed}`);
  } catch (e) {
    console.error('[migrations] seed skills failed:', e?.message || e);
    if (opts.throwOnError) throw e;
  }
  for (const file of MIGRATIONS_AFTER_SEED) {
    await runFile(file, opts);
  }
  console.warn('[migrations] all ops migrations completed');
}
