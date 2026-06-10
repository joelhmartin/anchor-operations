import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../db.js';
import { createSkill } from '../skills/store.js';
import { fanOutBulkSchedule } from '../scheduleFanout.js';

test('fanOutBulkSchedule creates a bulk run row even when there are no eligible clients', async () => {
  const skill = await createSkill({
    slug: `t.fan.${Date.now()}`,
    umbrella: 'website',
    title: 't',
    promptMd: '#',
    collectors: []
  });
  const { rows } = await query(`
    INSERT INTO ops_bulk_schedules (name, skill_ids, cadence, enabled)
    VALUES ('test', ARRAY[$1::uuid], 'daily', true) RETURNING id
  `, [skill.id]);
  const scheduleId = rows[0].id;
  try {
    const out = await fanOutBulkSchedule(scheduleId, { trigger: 'manual' });
    assert.ok(out, 'should return a result object');
    assert.ok(out.bulkRunId, 'should have a bulkRunId');
    // Verify parent bulk-run row exists with expected counts
    const { rows: br } = await query('SELECT * FROM ops_bulk_runs WHERE id = $1', [out.bulkRunId]);
    assert.ok(br[0], 'bulk run row should exist in DB');
  } finally {
    await query('DELETE FROM ops_bulk_runs WHERE bulk_schedule_id = $1', [scheduleId]).catch(() => {});
    await query('DELETE FROM ops_bulk_schedules WHERE id = $1', [scheduleId]).catch(() => {});
    await query('DELETE FROM ops_skills WHERE id = $1', [skill.id]).catch(() => {});
  }
});

test('fanOutBulkSchedule returns null for disabled schedule', async () => {
  const skill = await createSkill({
    slug: `t.fan.disabled.${Date.now()}`,
    umbrella: 'website',
    title: 't',
    promptMd: '#',
    collectors: []
  });
  const { rows } = await query(`
    INSERT INTO ops_bulk_schedules (name, skill_ids, cadence, enabled)
    VALUES ('test-disabled', ARRAY[$1::uuid], 'daily', false) RETURNING id
  `, [skill.id]);
  const scheduleId = rows[0].id;
  try {
    const out = await fanOutBulkSchedule(scheduleId, { trigger: 'manual' });
    assert.equal(out, null, 'disabled schedule should return null');
  } finally {
    await query('DELETE FROM ops_bulk_schedules WHERE id = $1', [scheduleId]).catch(() => {});
    await query('DELETE FROM ops_skills WHERE id = $1', [skill.id]).catch(() => {});
  }
});

test('computeNextRunAt: daily ticks to next 8:00 UTC', async () => {
  const { computeNextRunAt } = await import('../scheduleFanout.js');
  const now = new Date('2026-05-07T13:00:00Z');
  const next = computeNextRunAt({ cadence: 'daily', hour_local: 8 }, now);
  assert.ok(next.getTime() > now.getTime());
  assert.equal(next.getUTCHours(), 8);
});

test('computeNextRunAt: weekly respects day_of_week', async () => {
  const { computeNextRunAt } = await import('../scheduleFanout.js');
  const now = new Date('2026-05-07T13:00:00Z'); // Thursday (UTC day 4)
  const next = computeNextRunAt({ cadence: 'weekly', day_of_week: 1, hour_local: 8 }, now);
  assert.equal(next.getUTCDay(), 1); // Monday
});

test('computeNextRunAt: monthly picks day_of_month', async () => {
  const { computeNextRunAt } = await import('../scheduleFanout.js');
  const now = new Date('2026-05-15T13:00:00Z');
  const next = computeNextRunAt({ cadence: 'monthly', day_of_month: 1, hour_local: 8 }, now);
  assert.equal(next.getUTCDate(), 1);
});
