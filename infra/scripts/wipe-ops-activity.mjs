/**
 * One-time ops-activity wipe. Run as DB admin via the Cloud SQL Auth Proxy.
 *
 *   ADMIN_DATABASE_URL=postgres://... node infra/scripts/wipe-ops-activity.mjs            # dry-run
 *   ADMIN_DATABASE_URL=postgres://... node infra/scripts/wipe-ops-activity.mjs --apply
 *   ADMIN_DATABASE_URL=postgres://... node infra/scripts/wipe-ops-activity.mjs --apply --include-social
 *
 * Deletes ops-owned ACTIVITY tables only (see wipePlan.js). social_posts is
 * excluded unless --include-social is passed. NEVER wired into migrations/cron.
 */
import pg from 'pg';
import { planWipe, SOCIAL_TABLES } from '../../server/services/ops/wipePlan.js';

const apply = process.argv.includes('--apply');
const includeSocial = process.argv.includes('--include-social');
const url = process.env.ADMIN_DATABASE_URL;
if (!url) {
  console.error('ADMIN_DATABASE_URL is required');
  process.exit(1);
}

const plan = planWipe({ includeSocial });
const client = new pg.Client({ connectionString: url });

const run = async () => {
  await client.connect();

  // Seatbelt: report social_posts volume before any social wipe.
  const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM social_posts');
  console.warn(`[wipe] social_posts currently holds ${rows[0].n} row(s).`);
  if (!includeSocial) console.warn('[wipe] social tables EXCLUDED (pass --include-social to include).');

  console.warn(`[wipe] plan (${apply ? 'APPLY' : 'DRY-RUN'}):`, plan.join(', '));
  if (!apply) {
    console.warn('[wipe] dry-run only — no rows deleted. Re-run with --apply.');
    await client.end();
    return;
  }

  await client.query('BEGIN');
  try {
    for (const table of plan) {
      const res = await client.query(`DELETE FROM ${table}`); // table from allowlist constant only
      console.warn(`[wipe] ${table}: ${res.rowCount} deleted`);
    }
    await client.query('COMMIT');
    console.warn('[wipe] committed.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('[wipe] rolled back:', err.message);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
};

run().catch((err) => {
  console.error('[wipe] fatal:', err.message);
  process.exit(1);
});
