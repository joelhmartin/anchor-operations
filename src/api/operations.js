import client from './client';

export const fetchOperationsSites = (params = {}) =>
  client.get('/operations/sites', { params }).then((res) => res.data.sites || []);

export const fetchOperationsSite = (siteId) =>
  client.get(`/operations/sites/${siteId}`).then((res) => res.data);

export const syncOperationsSites = () =>
  client.post('/operations/sites/sync').then((res) => res.data);

export const fetchSiteWorkspace = (siteId) =>
  client.get(`/operations/sites/${siteId}/workspace`).then((res) => res.data);

export const saveSiteWorkspace = (siteId, body) =>
  client.put(`/operations/sites/${siteId}/workspace`, body).then((res) => res.data);

export const triggerSiteScan = (siteId) =>
  client.post(`/operations/sites/${siteId}/scan`).then((res) => res.data);

export const linkSiteToClient = (siteId, body) =>
  client.post(`/operations/sites/${siteId}/clients`, body).then((res) => res.data);

export const unlinkSiteClient = (siteId, linkId) =>
  client.delete(`/operations/sites/${siteId}/clients/${linkId}`).then((res) => res.data);

export const fetchEnvironment = (envId) =>
  client.get(`/operations/environments/${envId}`).then((res) => res.data);

export const refreshEnvCredentials = (envId) =>
  client.post(`/operations/environments/${envId}/credentials/refresh`).then((res) => res.data);

export const setEnvReadOnly = (envId, readOnly) =>
  client.put(`/operations/environments/${envId}/read-only`, { read_only: readOnly }).then((res) => res.data);

export const execEnvCommand = (envId, body) =>
  client.post(`/operations/environments/${envId}/exec`, body).then((res) => res.data);

export const fetchEnvCommands = (envId, params = {}) =>
  client.get(`/operations/environments/${envId}/commands`, { params }).then((res) => res.data);

export const fetchClientSites = (clientId) =>
  client.get(`/operations/clients/${clientId}/sites`).then((res) => res.data.sites || []);

export const fetchBulkActions = () =>
  client.get('/operations/bulk/actions').then((res) => res.data.actions || []);

export const fetchBulkJobs = (params = {}) =>
  client.get('/operations/bulk', { params }).then((res) => res.data.jobs || []);

export const createBulkJob = (body) =>
  client.post('/operations/bulk', body).then((res) => res.data);

export const fetchBulkJob = (jobId) =>
  client.get(`/operations/bulk/${jobId}`).then((res) => res.data);

export const cancelBulkJob = (jobId) =>
  client.post(`/operations/bulk/${jobId}/cancel`).then((res) => res.data);

export const runDriftCheck = (siteId, body = {}) =>
  client.post(`/operations/sites/${siteId}/drift-check`, body).then((res) => res.data);

export const fetchSiteFindings = (siteId, params = {}) =>
  client.get(`/operations/sites/${siteId}/findings`, { params }).then((res) => res.data.findings || []);

export const fetchAllFindings = (params = {}) =>
  client.get('/operations/findings', { params }).then((res) => res.data.findings || []);

export const fetchFindingCounts = () =>
  client.get('/operations/findings/counts').then((res) => res.data.counts || []);

export const acknowledgeFinding = (findingId) =>
  client.post(`/operations/findings/${findingId}/acknowledge`).then((res) => res.data);

export const resolveFinding = (findingId) =>
  client.post(`/operations/findings/${findingId}/resolve`).then((res) => res.data);
