import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../db.js';
import { createSkill, getSkill, saveNewVersion, listVersions, createSuggestion, approveSuggestion } from '../skills/store.js';

const SLUG = `test.skill.${Date.now()}`;

test('skills store: create + new version + history', async () => {
  const skill = await createSkill({
    slug: SLUG,
    umbrella: 'website',
    title: 'Test',
    promptMd: '# v1',
    collectors: []
  });
  assert.ok(skill.id);
  assert.equal(skill.current_version, 1);

  const next = await saveNewVersion(skill.id, { promptMd: '# v2', collectors: [], editedByUserId: null, editReason: 'manual edit' });
  assert.equal(next, 2);

  const reloaded = await getSkill(skill.id);
  assert.equal(reloaded.current_version, 2);
  assert.equal(reloaded.prompt_md, '# v2');

  const versions = await listVersions(skill.id);
  assert.equal(versions.length, 2);

  await query('DELETE FROM ops_skills WHERE id = $1', [skill.id]);
});

test('skills store: suggestion approve creates a recipe (not a new skill version)', async () => {
  const skill = await createSkill({
    slug: SLUG + '.b',
    umbrella: 'website',
    title: 'Test B',
    promptMd: '# v1',
    collectors: []
  });
  const sug = await createSuggestion({
    skillId: skill.id,
    runId: null,
    proposedTitle: 'Agent Recipe B',
    proposedPromptMd: '## Recipe from agent\nDo X then Y.',
    proposedCollectors: [],
    rationale: 'agent learned X'
  });
  const result = await approveSuggestion(sug.id, null, 'looks good');

  // approveSuggestion should return a recipeId, NOT a skillId
  assert.ok(result.recipeId, 'should return a recipeId');
  assert.ok(!result.skillId, 'should NOT return a skillId');

  // The skill version should NOT have been bumped
  const after = await getSkill(skill.id);
  assert.equal(after.current_version, 1, 'skill version should remain at 1 — approval creates a recipe, not a new version');
  assert.equal(after.prompt_md, '# v1', 'skill prompt_md should be unchanged');

  // The suggestion should reference the new recipe
  const { rows: sugRows } = await query('SELECT * FROM ops_skill_suggestions WHERE id = $1', [sug.id]);
  assert.equal(sugRows[0].status, 'approved');
  assert.equal(sugRows[0].created_recipe_id, result.recipeId, 'suggestion.created_recipe_id should match the new recipe id');

  // cleanup
  await query('DELETE FROM ops_recipes WHERE id = $1', [result.recipeId]);
  await query('DELETE FROM ops_skills WHERE id = $1', [skill.id]);
});
