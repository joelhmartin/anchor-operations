import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../../../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.join(__dirname, '..', '..', '..', 'sql', 'migrate_ops_skills_and_bulk.sql');

test('migrate_ops_skills_and_bulk: runs cleanly twice', async () => {
  const sql = await fs.readFile(SQL_PATH, 'utf8');
  await query(sql);
  await query(sql);
  const { rows: tables } = await query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename IN ('ops_skills','ops_skill_versions','ops_skill_suggestions','ops_bulk_schedules','ops_bulk_runs')
    ORDER BY tablename
  `);
  assert.equal(tables.length, 5);
  const { rows: cols } = await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'ops_runs' AND column_name IN ('bulk_run_id','skill_id','skill_version_number')
  `);
  assert.equal(cols.length, 3);
});
