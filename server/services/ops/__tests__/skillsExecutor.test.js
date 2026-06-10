import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../db.js';
import { createSkill } from '../skills/store.js';

test('runSkill: errors on unknown collector', async () => {
  const skill = await createSkill({
    slug: `test.exec.${Date.now()}`,
    umbrella: 'website',
    title: 'Test exec',
    promptMd: '# x',
    collectors: []
  });
  try {
    // Manually overwrite collectors_json with an unknown ID to trigger the error.
    await query(`UPDATE ops_skills SET collectors_json = '["this.does.not.exist"]'::jsonb WHERE id = $1`, [skill.id]);
    const { runSkill } = await import('../skills/executor.js');
    await assert.rejects(
      () =>
        runSkill({
          skillId: skill.id,
          runId: null,
          clientUserId: '00000000-0000-0000-0000-000000000000',
          umbrellaContext: {}
        }),
      /unknown collector/
    );
  } finally {
    await query('DELETE FROM ops_skills WHERE id = $1', [skill.id]);
  }
});
