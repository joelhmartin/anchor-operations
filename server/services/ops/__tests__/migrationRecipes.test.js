import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '../../../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_PATH = path.join(__dirname, '..', '..', '..', 'sql', 'migrate_ops_recipes.sql');

test('migrate_ops_recipes: runs cleanly twice (idempotent)', async () => {
  const sql = await fs.readFile(SQL_PATH, 'utf8');
  await query(sql);
  await query(sql);

  const { rows: tables } = await query(`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename = 'ops_recipes'
  `);
  assert.equal(tables.length, 1, 'ops_recipes table should exist');

  const { rows: cols } = await query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'ops_skill_suggestions' AND column_name = 'created_recipe_id'
  `);
  assert.equal(cols.length, 1, 'ops_skill_suggestions.created_recipe_id column should exist');
});
