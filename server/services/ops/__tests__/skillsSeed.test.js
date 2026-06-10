import test from 'node:test';
import assert from 'node:assert/strict';
import { syncSeedSkills } from '../skills/seed.js';
import { getSkillBySlug } from '../skills/store.js';
import { query } from '../../../db.js';

test('syncSeedSkills creates each canonical seed if missing', async () => {
  // Clean any prior seeded rows for a deterministic check.
  // Detach FK dependents first — ops_runs.skill_id has no ON DELETE CASCADE,
  // so an old run referencing a seed would block the DELETE here.
  const seedSlugs = ['website.daily_essentials','google_ads.daily_essentials','meta.daily_essentials','ctm.daily_essentials'];
  await query(
    `UPDATE ops_runs SET skill_id = NULL WHERE skill_id IN (SELECT id FROM ops_skills WHERE slug = ANY($1::text[]))`,
    [seedSlugs]
  );
  await query(`DELETE FROM ops_skills WHERE slug = ANY($1::text[])`, [seedSlugs]);
  const r1 = await syncSeedSkills();
  assert.ok(r1.created >= 4);
  for (const slug of seedSlugs) {
    const s = await getSkillBySlug(slug);
    assert.ok(s, `expected seed ${slug} to exist`);
  }
  // Second pass: nothing new created.
  const r2 = await syncSeedSkills();
  assert.equal(r2.created, 0);
});
