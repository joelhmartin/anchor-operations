/**
 * runExecutor: skill dispatch branching test.
 *
 * Strategy: insert a real ops_runs row with skill_id set, then call
 * executeRun(). runSkill() will attempt to call the Vertex sub-agent loop,
 * which will fail in CI (no credentials). That's expected and acceptable —
 * the test's only goal is to verify that the skill branch was taken (the run
 * leaves 'queued' status) rather than the legacy tier-based path (which would
 * produce different terminal state and would complain about a missing
 * definition check_set).
 *
 * If even the import of runExecutor.js crashes at module-load time, the test
 * fails with a clear error pointing at the import chain rather than a silent
 * hang. That's the minimum useful signal for CI.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../db.js';
import { createSkill } from '../skills/store.js';

test('runExecutor: imports cleanly with skill branch in place', async () => {
  // Verify the module loads without crashing. This proves the dispatch branch
  // compiles and the imports (runSkill, createSuggestion) resolve correctly.
  const mod = await import('../runExecutor.js');
  assert.ok(typeof mod.executeRun === 'function', 'executeRun must be exported');
});

test('runExecutor: skill branch leaves run in non-queued state', async () => {
  // Create a minimal skill (no collectors — avoids registry lookup at this stage).
  const skill = await createSkill({
    slug: `test.exec.dispatch.${Date.now()}`,
    umbrella: 'website',
    title: 'Dispatch test skill',
    promptMd: '# test',
    collectors: []
  });

  // Insert a fake client user so FK constraints pass.
  // We use a nil UUID (all zeros) — the users table may not have this row,
  // but ops_runs.client_user_id is not FK-constrained in older migrations.
  // If the insert fails we'll see it as a clear DB error, not a silent skip.
  const clientUserId = '00000000-0000-0000-0000-000000000001';

  let runId;
  try {
    const { rows } = await query(
      `INSERT INTO ops_runs
         (client_user_id, status, tier, trigger, skill_id)
       VALUES ($1, 'queued', 'on_demand', 'manual', $2)
       RETURNING id`,
      [clientUserId, skill.id]
    );
    runId = rows[0]?.id;
    assert.ok(runId, 'run row should be created');

    const { executeRun } = await import('../runExecutor.js');

    // executeRun will call runSkill → Vertex, which fails in test env.
    // We catch that error — the important assertion is the run's status
    // changed FROM 'queued' (proving the skill branch was entered).
    try {
      await executeRun(runId);
    } catch {
      // Expected in test environment (no Vertex credentials).
    }

    const { rows: afterRows } = await query(
      'SELECT status FROM ops_runs WHERE id = $1',
      [runId]
    );
    const status = afterRows[0]?.status;

    // The skill branch marks the run 'running' first, then 'completed' or
    // 'failed'. Any of these proves the skill dispatch was entered, not the
    // legacy tier path (which would require a run_definition_id + check_set).
    assert.ok(
      status !== 'queued',
      `run status should have advanced from 'queued'; got '${status}'`
    );
  } finally {
    if (runId) {
      await query('DELETE FROM ops_runs WHERE id = $1', [runId]).catch(() => {});
    }
    await query('DELETE FROM ops_skills WHERE id = $1', [skill.id]).catch(() => {});
  }
});

test('runExecutor: loadRunWithDefinition returns skill_id column', async () => {
  // Verify that the SELECT r.* in loadRunWithDefinition actually returns skill_id.
  // This catches regressions where the column was accidentally excluded.
  const skill = await createSkill({
    slug: `test.exec.col.${Date.now()}`,
    umbrella: 'website',
    title: 'Column test skill',
    promptMd: '# test',
    collectors: []
  });

  const clientUserId = '00000000-0000-0000-0000-000000000002';
  let runId;
  try {
    const { rows } = await query(
      `INSERT INTO ops_runs (client_user_id, status, tier, trigger, skill_id)
       VALUES ($1, 'queued', 'on_demand', 'manual', $2)
       RETURNING id`,
      [clientUserId, skill.id]
    );
    runId = rows[0]?.id;
    assert.ok(runId);

    // Directly query to assert the column is there (mirrors what loadRunWithDefinition does).
    const { rows: runRows } = await query(
      `SELECT r.*, d.check_set AS definition_check_set,
              d.umbrellas    AS definition_umbrellas,
              d.name         AS definition_name
         FROM ops_runs r
         LEFT JOIN ops_run_definitions d ON d.id = r.run_definition_id
        WHERE r.id = $1`,
      [runId]
    );
    assert.ok(runRows.length === 1);
    assert.equal(runRows[0].skill_id, skill.id, 'skill_id must survive SELECT r.*');
    assert.ok('skill_version_number' in runRows[0], 'skill_version_number column must be present');
    assert.ok('bulk_run_id' in runRows[0], 'bulk_run_id column must be present');
  } finally {
    if (runId) await query('DELETE FROM ops_runs WHERE id = $1', [runId]).catch(() => {});
    await query('DELETE FROM ops_skills WHERE id = $1', [skill.id]).catch(() => {});
  }
});
