import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../db.js';

const TABLES = ['ops_service_connections', 'ops_platform_inventory', 'ops_client_assets'];

test('F1 migration created all three tables', async () => {
  const { rows } = await query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [TABLES]
  );
  const have = new Set(rows.map((r) => r.table_name));
  for (const t of TABLES) assert.ok(have.has(t), `${t} exists`);
});

test('ops_service_connections enforces the locked status vocabulary', async () => {
  const { rows } = await query(
    `SELECT cc.check_clause
       FROM information_schema.check_constraints cc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = cc.constraint_name
      WHERE ccu.table_name = 'ops_service_connections'
        AND ccu.column_name = 'status'`
  );
  const clause = rows.map((r) => r.check_clause).join(' ');
  for (const s of ['missing', 'configured', 'verified', 'degraded', 'failed', 'disabled']) {
    assert.ok(clause.includes(s), `status CHECK includes ${s}`);
  }
});
