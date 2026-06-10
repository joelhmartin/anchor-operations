/**
 * Frontend API client for the ops bulk domain (`/api/ops/bulk/*` and `/api/ops/skills/*`).
 */

import client from './client';

// ── Schedules ──────────────────────────────────────────────────────────────────
export const listSchedules = () =>
  client.get('/ops/bulk/schedules').then((r) => r.data.schedules);

export const createSchedule = (body) =>
  client.post('/ops/bulk/schedules', body).then((r) => r.data.schedule);

export const updateSchedule = (id, body) =>
  client.put(`/ops/bulk/schedules/${id}`, body).then((r) => r.data.schedule);

export const deleteSchedule = (id) =>
  client.delete(`/ops/bulk/schedules/${id}`).then((r) => r.data);

export const runScheduleNow = (id) =>
  client.post(`/ops/bulk/schedules/${id}/run-now`).then((r) => r.data);

// ── Bulk Runs ──────────────────────────────────────────────────────────────────
export const listBulkRuns = (params = {}) =>
  client.get('/ops/bulk/runs', { params }).then((r) => r.data);

export const getBulkRun = (id) =>
  client.get(`/ops/bulk/runs/${id}`).then((r) => r.data);

export const getRunFindings = (id) =>
  client.get(`/ops/runs/${id}/findings`).then((r) => (Array.isArray(r.data) ? r.data : r.data.findings || []));

// ── Skills ─────────────────────────────────────────────────────────────────────
export const listSkills = (umbrella) =>
  client
    .get('/ops/skills', { params: umbrella ? { umbrella } : {} })
    .then((r) => r.data.skills);

export const getSkill = (id) =>
  client.get(`/ops/skills/${id}`).then((r) => r.data.skill);

export const listSkillVersions = (id) =>
  client.get(`/ops/skills/${id}/versions`).then((r) => r.data.versions);

export const saveSkillVersion = (id, body) =>
  client.put(`/ops/skills/${id}`, body).then((r) => r.data);

export const listPendingSuggestions = (id) =>
  client.get(`/ops/skills/${id}/suggestions`).then((r) => r.data.suggestions);

export const approveSuggestion = (skillId, sid, note) =>
  client
    .post(`/ops/skills/${skillId}/suggestions/${sid}/approve`, { note })
    .then((r) => r.data);

export const rejectSuggestion = (skillId, sid, note) =>
  client
    .post(`/ops/skills/${skillId}/suggestions/${sid}/reject`, { note })
    .then((r) => r.data);

export const createSkill = (body) =>
  client.post('/ops/skills', body).then((r) => r.data.skill);

// ── Recipes ────────────────────────────────────────────────────────────────────
export const listRecipes = (umbrella) =>
  client.get('/ops/recipes', { params: umbrella ? { umbrella } : {} }).then((r) => r.data.recipes);
export const getRecipe = (id) =>
  client.get(`/ops/recipes/${id}`).then((r) => r.data.recipe);
export const createRecipe = (body) =>
  client.post('/ops/recipes', body).then((r) => r.data.recipe);
export const updateRecipe = (id, body) =>
  client.put(`/ops/recipes/${id}`, body).then((r) => r.data.recipe);
export const archiveRecipe = (id) =>
  client.delete(`/ops/recipes/${id}`).then((r) => r.data);

// ── Checks ─────────────────────────────────────────────────────────────────────
export const listChecks = () =>
  client.get('/ops/checks').then((r) => r.data.checks);
