/**
 * Skills store — CRUD + version history + suggestions.
 *
 * Versions are append-only. Saving a new prompt/collectors creates a new row
 * in ops_skill_versions and bumps ops_skills.current_version.
 */
import { query } from '../../../db.js';
import { activeOnly } from '../../queryHelpers.js';
import { listAllChecks } from '../checks/registry.js';
import { createRecipe } from './recipes.js';

const VALID_UMBRELLAS = new Set(['website', 'google_ads', 'meta', 'ctm']);

function validateCollectors(collectors) {
  if (!Array.isArray(collectors)) throw new Error('collectors must be an array');
  const known = new Set(listAllChecks().map((c) => c.checkId));
  const missing = collectors.filter((c) => !known.has(c));
  return { ok: missing.length === 0, missing };
}

export async function listSkills({ umbrella, includeArchived = false } = {}) {
  const where = [];
  const params = [];
  if (umbrella) { params.push(umbrella); where.push(`umbrella = $${params.length}`); }
  if (!includeArchived) where.push(activeOnly());
  const sql = `SELECT * FROM ops_skills ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY umbrella, slug`;
  const { rows } = await query(sql, params);
  return rows;
}

export async function getSkill(id) {
  const { rows } = await query('SELECT * FROM ops_skills WHERE id = $1', [id]);
  return rows[0] || null;
}

export async function getSkillBySlug(slug) {
  const { rows } = await query('SELECT * FROM ops_skills WHERE slug = $1', [slug]);
  return rows[0] || null;
}

export async function listVersions(skillId) {
  const { rows } = await query(
    'SELECT * FROM ops_skill_versions WHERE skill_id = $1 ORDER BY version_number DESC',
    [skillId]
  );
  return rows;
}

export async function createSkill({ slug, umbrella, title, promptMd, collectors, costEstimateCents = 0, model = null, createdBy }) {
  if (!VALID_UMBRELLAS.has(umbrella)) throw new Error(`invalid umbrella: ${umbrella}`);
  const v = validateCollectors(collectors);
  if (!v.ok) throw new Error(`unknown collectors: ${v.missing.join(', ')}`);
  const { rows } = await query(`
    INSERT INTO ops_skills (slug, umbrella, title, prompt_md, collectors_json, cost_estimate_cents, created_by, current_version, model)
    VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,1,$8)
    RETURNING *
  `, [slug, umbrella, title, promptMd, JSON.stringify(collectors), costEstimateCents, createdBy, model || null]);
  const skill = rows[0];
  await query(`
    INSERT INTO ops_skill_versions (skill_id, version_number, prompt_md, collectors_json, edited_by_user_id, model)
    VALUES ($1,1,$2,$3::jsonb,$4,$5)
  `, [skill.id, promptMd, JSON.stringify(collectors), createdBy, model || null]);
  return skill;
}

export async function saveNewVersion(skillId, { promptMd, collectors, model, editedByUserId, editedByAgent = false, editReason = null, approvedFromSuggestionId = null }) {
  const v = validateCollectors(collectors);
  if (!v.ok) throw new Error(`unknown collectors: ${v.missing.join(', ')}`);
  const { rows: skillRows } = await query('SELECT current_version, model FROM ops_skills WHERE id = $1 FOR UPDATE', [skillId]);
  if (!skillRows[0]) throw new Error('skill not found');
  const next = Number(skillRows[0].current_version) + 1;
  // If model not supplied in the patch, carry forward the existing one.
  const effectiveModel = model === undefined ? skillRows[0].model : (model || null);
  await query(`
    INSERT INTO ops_skill_versions (skill_id, version_number, prompt_md, collectors_json, edited_by_user_id, edited_by_agent, edit_reason, approved_from_suggestion_id, model)
    VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9)
  `, [skillId, next, promptMd, JSON.stringify(collectors), editedByUserId, editedByAgent, editReason, approvedFromSuggestionId, effectiveModel]);
  await query(`
    UPDATE ops_skills
       SET prompt_md = $2, collectors_json = $3::jsonb, current_version = $4, model = $5, updated_at = now()
     WHERE id = $1
  `, [skillId, promptMd, JSON.stringify(collectors), next, effectiveModel]);
  return next;
}

export async function archiveSkill(id) {
  await query('UPDATE ops_skills SET archived_at = now() WHERE id = $1', [id]);
}

// Suggestions ---

export async function listPendingSuggestions(skillId = null) {
  const params = [];
  let sql = `SELECT * FROM ops_skill_suggestions WHERE status = 'pending'`;
  if (skillId) { params.push(skillId); sql += ` AND skill_id = $${params.length}`; }
  sql += ' ORDER BY created_at DESC';
  const { rows } = await query(sql, params);
  return rows;
}

export async function createSuggestion({ skillId, runId, proposedSlug, proposedUmbrella, proposedTitle, proposedPromptMd, proposedCollectors, rationale }) {
  const { rows } = await query(`
    INSERT INTO ops_skill_suggestions (skill_id, run_id, proposed_slug, proposed_umbrella, proposed_title, proposed_prompt_md, proposed_collectors_json, rationale)
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
    RETURNING *
  `, [skillId, runId, proposedSlug, proposedUmbrella, proposedTitle, proposedPromptMd, JSON.stringify(proposedCollectors), rationale]);
  return rows[0];
}

export async function approveSuggestion(suggestionId, reviewerUserId, reviewerNote = null) {
  const { rows } = await query('SELECT * FROM ops_skill_suggestions WHERE id = $1 FOR UPDATE', [suggestionId]);
  const sug = rows[0];
  if (!sug) throw new Error('suggestion not found');
  if (sug.status !== 'pending') throw new Error('suggestion not pending');

  // Resolve umbrella: prefer the suggestion's proposed_umbrella, else the parent skill's umbrella.
  let umbrella = sug.proposed_umbrella;
  if (!umbrella && sug.skill_id) {
    const { rows: sk } = await query('SELECT umbrella FROM ops_skills WHERE id = $1', [sug.skill_id]);
    umbrella = sk[0]?.umbrella;
  }
  if (!umbrella) throw new Error('cannot determine umbrella for suggestion');

  // Generate a slug for the recipe — base on the title or proposed_slug, suffix with a short id.
  const baseSlug = (sug.proposed_slug || sug.proposed_title || `agent-recipe-${Date.now()}`)
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const finalSlug = `${baseSlug}-${suggestionId.slice(0, 8)}`;

  const recipe = await createRecipe({
    slug: finalSlug,
    umbrella,
    title: sug.proposed_title || baseSlug || 'agent recipe',
    recipeMd: sug.proposed_prompt_md,
    source: 'agent',
    proposedFromRunId: sug.run_id,
    approvedByUserId: reviewerUserId
  });

  await query(`
    UPDATE ops_skill_suggestions
       SET status='approved', reviewed_by_user_id=$2, reviewed_at=now(), reviewer_note=$3, created_recipe_id=$4
     WHERE id=$1
  `, [suggestionId, reviewerUserId, reviewerNote, recipe.id]);

  return { suggestionId, recipeId: recipe.id };
}

export async function rejectSuggestion(suggestionId, reviewerUserId, reviewerNote = null) {
  await query(`
    UPDATE ops_skill_suggestions
       SET status='rejected', reviewed_by_user_id=$2, reviewed_at=now(), reviewer_note=$3
     WHERE id=$1 AND status='pending'
  `, [suggestionId, reviewerUserId, reviewerNote]);
}
