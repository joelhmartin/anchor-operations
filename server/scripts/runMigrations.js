// CLI: run the ops migrations once and exit. Used by `yarn db:migrate` and by the
// Cloud Run "migrate" job. Surfaces failures (non-zero exit) so CI/ops notice.
import '../loadEnv.js';
import { runOpsMigrations } from '../migrations.js';
import { pool } from '../db.js';

runOpsMigrations({ throwOnError: true })
  .then(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('[db:migrate] failed:', err?.message || err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
