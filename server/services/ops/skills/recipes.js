/**
 * Recipes — agent-grown reusable techniques per umbrella.
 * Used as additional context when running any directive of that umbrella.
 */
import { query } from '../../../db.js';
import { activeOnly } from '../../queryHelpers.js';

const VALID_UMBRELLAS = new Set(['website', 'google_ads', 'meta', 'ctm']);
const VALID_SOURCES = new Set(['user', 'agent']);

export async function listRecipes({ umbrella, includeArchived = false } = {}) {
  const where = [];
  const params = [];
  if (umbrella) { params.push(umbrella); where.push(`umbrella = $${params.length}`); }
  if (!includeArchived) where.push(activeOnly());
  const sql = `SELECT * FROM ops_recipes ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY umbrella, slug`;
  const { rows } = await query(sql, params);
  return rows;
}

export async function getRecipe(id) {
  const { rows } = await query('SELECT * FROM ops_recipes WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function createRecipe({ slug, umbrella, title, recipeMd, source = 'user', proposedFromRunId = null, approvedByUserId = null }) {
  if (!VALID_UMBRELLAS.has(umbrella)) throw new Error(`invalid umbrella: ${umbrella}`);
  if (!VALID_SOURCES.has(source)) throw new Error(`invalid source: ${source}`);
  const { rows } = await query(`
    INSERT INTO ops_recipes (slug, umbrella, title, recipe_md, source, proposed_from_run_id, approved_by_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
  `, [slug, umbrella, title, recipeMd, source, proposedFromRunId, approvedByUserId]);
  return rows[0];
}

export async function updateRecipe(id, { title, recipeMd }) {
  const sets = [];
  const params = [id];
  if (title !== undefined) { params.push(title); sets.push(`title = $${params.length}`); }
  if (recipeMd !== undefined) { params.push(recipeMd); sets.push(`recipe_md = $${params.length}`); }
  if (sets.length === 0) throw new Error('no fields to update');
  sets.push('updated_at = now()');
  const { rows } = await query(`UPDATE ops_recipes SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return rows[0] || null;
}

export async function archiveRecipe(id) {
  await query('UPDATE ops_recipes SET archived_at = now() WHERE id = $1', [id]);
}
