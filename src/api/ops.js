/**
 * Frontend API client for the operations rebuild domain (`/api/ops/*`).
 *
 * Distinct from `src/api/operations.js`, which is the legacy Kinsta-specific
 * surface mounted at `/api/operations/*`. Both routers coexist during the
 * Phase 1-9 rebuild.
 */

import client from './client';

export const listOpsRuns = (params = {}) => client.get('/ops/runs', { params }).then((res) => res.data || []);

export const getOpsRun = (runId) => client.get(`/ops/runs/${runId}`).then((res) => res.data);

export const triggerOpsRun = (body) => client.post('/ops/runs', body).then((res) => res.data);

export const cancelOpsRun = (runId) => client.post(`/ops/runs/${runId}/cancel`).then((res) => res.data);

export const getOpsRunFindings = (runId) => client.get(`/ops/runs/${runId}/findings`).then((res) => res.data || []);

export const getOpsRunReport = (runId) => client.get(`/ops/runs/${runId}/report`).then((res) => res.data);

export const listOpsFindings = (params = {}) => client.get('/ops/findings', { params }).then((res) => res.data || []);

export const acknowledgeOpsFinding = (findingId) => client.post(`/ops/findings/${findingId}/acknowledge`).then((res) => res.data);

export const resolveOpsFinding = (findingId, body = {}) => client.post(`/ops/findings/${findingId}/resolve`, body).then((res) => res.data);

// ---------------- Command Center pivot — Discovery state machine ----------------

export const updateOpsFinding = (findingId, body) => client.put(`/ops/findings/${findingId}`, body).then((res) => res.data);

export const assignOpsFinding = (findingId, ownerUserId) =>
  client.post(`/ops/findings/${findingId}/assign`, { owner_user_id: ownerUserId }).then((res) => res.data);

export const ignoreOpsFinding = (findingId, reason) => client.post(`/ops/findings/${findingId}/ignore`, { reason }).then((res) => res.data);

export const bulkUpdateFindingStatus = (ids, status, note = null) =>
  client.post('/ops/findings/bulk-status', { ids, status, note }).then((res) => res.data);

export const getCommandCenter = () =>
  client.get('/ops/command-center').then((res) => res.data || { discoveries: [], kpis: {}, activity: [] });

export const listOpsRunDefinitions = () => client.get('/ops/run-definitions').then((res) => res.data || []);

export const listOpsClients = () => client.get('/ops/clients').then((res) => res.data.clients || []);

// Note: ops_runs does not embed check_results — they are persisted to
// ops_check_results and joined client-side via getOpsRun + a follow-up.
// We piggyback on the unified `/api/operations` infra later (Phase 6) for
// rendering reports.
export const listOpsCheckResults = (runId) =>
  client
    .get(`/ops/runs/${runId}/check-results`)
    .then((res) => res.data || [])
    .catch(() => []);

// ---------------- Phase 9: command center aggregates + admin ----------------

export const getOpsOverview = () => client.get('/ops/overview').then((res) => res.data || {});

export const getOpsCostSummary = (params = {}) => client.get('/ops/cost-summary', { params }).then((res) => res.data || []);

export const updateClientOpsCap = (clientUserId, opsMonthlyCapCents) =>
  client.put(`/ops/clients/${clientUserId}/cap`, { ops_monthly_cap_cents: opsMonthlyCapCents }).then((res) => res.data);

export const listClientOpsSubscriptions = (clientUserId) =>
  client.get(`/ops/clients/${clientUserId}/subscriptions`).then((res) => res.data || []);

export const updateClientOpsSubscriptions = (clientUserId, subscriptions) =>
  client.put(`/ops/clients/${clientUserId}/subscriptions`, { subscriptions }).then((res) => res.data || []);

export const listClientOpsCredentials = (clientUserId) =>
  client.get(`/ops/clients/${clientUserId}/credentials`).then((res) => res.data || []);

export const validateOpsCredential = (clientUserId, credentialId, body = {}) =>
  client.post(`/ops/clients/${clientUserId}/credentials/${credentialId}/validate`, body).then((res) => res.data);

export const deleteOpsCredential = (clientUserId, credentialId) =>
  client.delete(`/ops/clients/${clientUserId}/credentials/${credentialId}`).then((res) => res.data);

export const createOpsRunDefinition = (body) => client.post('/ops/run-definitions', body).then((res) => res.data);

export const updateOpsRunDefinition = (id, body) => client.put(`/ops/run-definitions/${id}`, body).then((res) => res.data);

// ---------------- Phase 7: AI chat ----------------

export const sendOpsChat = ({ clientUserId, prompt, history }) =>
  client.post('/ops/chat', { client_user_id: clientUserId, prompt, history }).then((res) => res.data);

export const approveOpsChatAction = (approvalId) => client.post('/ops/chat/approve', { approval_id: approvalId }).then((res) => res.data);

export const rejectOpsChatAction = (approvalId, reason = null) =>
  client.post('/ops/chat/reject', { approval_id: approvalId, reason }).then((res) => res.data);

export const listOpsChatThreads = (clientUserId) =>
  client.get('/ops/chat/threads', { params: clientUserId ? { clientUserId } : {} }).then((res) => res.data.threads || []);

export const getOpsChatThread = (threadId) =>
  client.get(`/ops/chat/threads/${threadId}`).then((res) => res.data);
