import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../db.js';
import { createRecipe, listRecipes, getRecipe, updateRecipe, archiveRecipe } from '../skills/recipes.js';

const SLUG = `test.recipe.${Date.now()}`;

test('recipes store: createRecipe / listRecipes / archiveRecipe', async () => {
  const recipe = await createRecipe({
    slug: SLUG,
    umbrella: 'website',
    title: 'Test Recipe',
    recipeMd: '## How to check something\nDo X then Y.',
    source: 'user'
  });
  assert.ok(recipe.id, 'recipe should have an id');
  assert.equal(recipe.slug, SLUG);
  assert.equal(recipe.umbrella, 'website');
  assert.equal(recipe.source, 'user');
  assert.ok(!recipe.archived_at, 'should not be archived');

  // listRecipes returns the new recipe
  const all = await listRecipes({ umbrella: 'website' });
  assert.ok(all.some((r) => r.id === recipe.id), 'listRecipes should include the new recipe');

  // getRecipe by id
  const fetched = await getRecipe(recipe.id);
  assert.equal(fetched.id, recipe.id);

  // updateRecipe
  const updated = await updateRecipe(recipe.id, { title: 'Updated Title', recipeMd: '## Updated\nNew content.' });
  assert.equal(updated.title, 'Updated Title');

  // archiveRecipe
  await archiveRecipe(recipe.id);
  const archived = await getRecipe(recipe.id);
  assert.ok(archived.archived_at, 'should be archived after archiveRecipe');

  // listRecipes excludes archived by default
  const active = await listRecipes({ umbrella: 'website' });
  assert.ok(!active.some((r) => r.id === recipe.id), 'archived recipe should not appear in default list');

  // listRecipes includes archived when asked
  const withArchived = await listRecipes({ umbrella: 'website', includeArchived: true });
  assert.ok(withArchived.some((r) => r.id === recipe.id), 'archived recipe should appear when includeArchived=true');

  // cleanup
  await query('DELETE FROM ops_recipes WHERE id = $1', [recipe.id]);
});

test('recipes store: createRecipe rejects invalid umbrella', async () => {
  await assert.rejects(
    () => createRecipe({ slug: `bad.${Date.now()}`, umbrella: 'badplatform', title: 'X', recipeMd: '# x', source: 'user' }),
    /invalid umbrella/
  );
});
