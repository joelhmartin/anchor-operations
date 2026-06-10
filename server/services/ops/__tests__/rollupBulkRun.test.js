/**
 * rollupBulkRun — unit tests.
 *
 * Tests the _rollupBulkRunForTests export directly, bypassing the full
 * executeRun/executeSkillRun path (which requires Vertex credentials).
 *
 * Strategy: create the minimum required rows (ops_skills, ops_bulk_runs,
 * ops_runs) directly via SQL, call rollupBulkRun, assert the parent row
 * is updated correctly, then clean up in finally.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../db.js';
import { createSkill } from '../skills/store.js';
import { _rollupBulkRunForTests as rollupBulkRun } from '../runExecutor.js';

// Deterministic client UUID — not a real user, ops_runs.client_user_id has no FK.
const CLIENT_ID = '00000000-0000-0000-0000-000000000099';

/**
 * Create a minimal ops_bulk_runs row (no schedule, manual trigger).
 * Returns the bulk run id.
 */
async function createBulkRun(skillId) {
  // ops_bulk_runs requires bulk_schedule_id to be nullable (ON DELETE SET NULL).
  // We need a real ops_bulk_schedules row or omit it — schema allows null via ON DELETE SET NULL.
  // Insert a temporary schedule so the FK is satisfied, then we can reference it.
  const { rows: schedRows } = await query(
    `INSERT INTO ops_bulk_schedules (name, skill_ids, cadence, enabled)
     VALUES ('rollup-test-sched', ARRAY[$1::uuid], 'daily', false)
     RETURNING id`,
    [skillId]
  );
  const scheduleId = schedRows[0].id;

  const { rows } = await query(
    `INSERT INTO ops_bulk_runs (bulk_schedule_id, trigger, status, client_count)
     VALUES ($1, 'manual', 'running', 0)
     RETURNING id`,
    [scheduleId]
  );
  return { bulkRunId: rows[0].id, scheduleId };
}

/**
 * Insert a child ops_runs row linked to the bulk run.
 */
async function createChildRun(skillId, bulkRunId, status, costEstimateCents = 0) {
  const { rows } = await query(
    `INSERT INTO ops_runs (client_user_id, status, tier, trigger, skill_id, bulk_run_id, cost_estimate_cents)
     VALUES ($1, $2, 'on_demand', 'manual', $3, $4, $5)
     RETURNING id`,
    [CLIENT_ID, status, skillId, bulkRunId, costEstimateCents]
  );
  return rows[0].id;
}

/**
 * Insert a finding tied to a child ops_run.
 */
async function createFinding(runId) {
  await query(
    `INSERT INTO ops_findings (run_id, client_user_id, severity, category, summary, evidence_json)
     VALUES ($1, $2, 'info', 'skill.test', 'test finding', '{}')`,
    [runId, CLIENT_ID]
  );
}

// ---------------------------------------------------------------------------

test('rollupBulkRun: all complete → status=complete, cost summed, completed_at set', async () => {
  const skill = await createSkill({
    slug: `t.rollup.complete.${Date.now()}`,
    umbrella: 'website',
    title: 'rollup test skill',
    promptMd: '# test',
    collectors: []
  });
  const { bulkRunId, scheduleId } = await createBulkRun(skill.id);

  try {
    // Two completed children, 10 cents each, 1 finding apiece.
    const runId1 = await createChildRun(skill.id, bulkRunId, 'completed', 10);
    const runId2 = await createChildRun(skill.id, bulkRunId, 'completed', 10);
    await createFinding(runId1);
    await createFinding(runId2);

    await rollupBulkRun(bulkRunId);

    const { rows } = await query('SELECT * FROM ops_bulk_runs WHERE id = $1', [bulkRunId]);
    const parent = rows[0];

    assert.equal(parent.status, 'complete', 'all complete children → status=complete');
    assert.equal(parent.cost_cents, 20, 'cost_cents should sum child cost_estimate_cents');
    assert.equal(parent.findings_count, 2, 'findings_count should count ops_findings rows');
    assert.ok(parent.completed_at !== null, 'completed_at should be set when all terminal');
  } finally {
    await query('DELETE FROM ops_findings WHERE run_id IN (SELECT id FROM ops_runs WHERE bulk_run_id = $1)', [bulkRunId]).catch(() => {});
    await query('DELETE FROM ops_runs WHERE bulk_run_id = $1', [bulkRunId]).catch(() => {});
    await query('DELETE FROM ops_bulk_runs WHERE id = $1', [bulkRunId]).catch(() => {});
    await query('DELETE FROM ops_bulk_schedules WHERE id = $1', [scheduleId]).catch(() => {});
    await query('DELETE FROM ops_skills WHERE id = $1', [skill.id]).catch(() => {});
  }
});

test('rollupBulkRun: one failed + one complete → status=partial', async () => {
  const skill = await createSkill({
    slug: `t.rollup.partial.${Date.now()}`,
    umbrella: 'website',
    title: 'rollup partial test skill',
    promptMd: '# test',
    collectors: []
  });
  const { bulkRunId, scheduleId } = await createBulkRun(skill.id);

  try {
    await createChildRun(skill.id, bulkRunId, 'completed', 5);
    await createChildRun(skill.id, bulkRunId, 'failed', 5);

    await rollupBulkRun(bulkRunId);

    const { rows } = await query('SELECT * FROM ops_bulk_runs WHERE id = $1', [bulkRunId]);
    const parent = rows[0];

    assert.equal(parent.status, 'partial', 'one failed child → status=partial');
    assert.equal(parent.cost_cents, 10, 'cost_cents should still sum all children');
    assert.ok(parent.completed_at !== null, 'completed_at should be set (all children are terminal)');
  } finally {
    await query('DELETE FROM ops_runs WHERE bulk_run_id = $1', [bulkRunId]).catch(() => {});
    await query('DELETE FROM ops_bulk_runs WHERE id = $1', [bulkRunId]).catch(() => {});
    await query('DELETE FROM ops_bulk_schedules WHERE id = $1', [scheduleId]).catch(() => {});
    await query('DELETE FROM ops_skills WHERE id = $1', [skill.id]).catch(() => {});
  }
});

test('rollupBulkRun: one running child → status=running, completed_at unchanged', async () => {
  const skill = await createSkill({
    slug: `t.rollup.running.${Date.now()}`,
    umbrella: 'website',
    title: 'rollup running test skill',
    promptMd: '# test',
    collectors: []
  });
  const { bulkRunId, scheduleId } = await createBulkRun(skill.id);

  try {
    await createChildRun(skill.id, bulkRunId, 'completed', 10);
    await createChildRun(skill.id, bulkRunId, 'running', 0);

    // Capture completed_at before (should be null initially).
    const { rows: before } = await query('SELECT completed_at FROM ops_bulk_runs WHERE id = $1', [bulkRunId]);
    assert.equal(before[0].completed_at, null, 'completed_at should start null');

    await rollupBulkRun(bulkRunId);

    const { rows } = await query('SELECT * FROM ops_bulk_runs WHERE id = $1', [bulkRunId]);
    const parent = rows[0];

    assert.equal(parent.status, 'running', 'in-flight child → status=running');
    assert.equal(parent.completed_at, null, 'completed_at should remain null while children are running');
  } finally {
    await query('DELETE FROM ops_runs WHERE bulk_run_id = $1', [bulkRunId]).catch(() => {});
    await query('DELETE FROM ops_bulk_runs WHERE id = $1', [bulkRunId]).catch(() => {});
    await query('DELETE FROM ops_bulk_schedules WHERE id = $1', [scheduleId]).catch(() => {});
    await query('DELETE FROM ops_skills WHERE id = $1', [skill.id]).catch(() => {});
  }
});

test('rollupBulkRun: null bulkRunId is a no-op', async () => {
  // Should not throw.
  await rollupBulkRun(null);
  await rollupBulkRun(undefined);
});
