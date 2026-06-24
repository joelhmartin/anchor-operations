import client from './client';

export function listPages() {
  return client.get('/social/pages').then((r) => r.data);
}

export function listLinks() {
  return client.get('/social/links').then((r) => r.data);
}

export function createLink(clientId, fbPageId) {
  return client.post('/social/links', { clientId, fbPageId }).then((r) => r.data);
}

export function updateLink(id, body) {
  return client.patch(`/social/links/${id}`, body).then((r) => r.data);
}

export function archiveLink(id) {
  return client.delete(`/social/links/${id}`).then((r) => r.data);
}

export function checkLinkHealth(id) {
  return client.post(`/social/links/${id}/health-check`).then((r) => r.data);
}

export function uploadMedia(file, clientId) {
  const fd = new FormData();
  fd.append('file', file);
  if (clientId) fd.append('clientId', clientId);
  return client.post('/social/media', fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data);
}

export function listPosts(params = {}) {
  return client.get('/social/posts', { params }).then((r) => r.data);
}

export function createPost(body) {
  const idempotencyKey =
    body.idempotencyKey ||
    (typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2));
  return client.post('/social/posts', { ...body, idempotencyKey }, { headers: { 'Idempotency-Key': idempotencyKey } }).then((r) => r.data);
}

export function cancelPost(id) {
  return client.post(`/social/posts/${id}/cancel`).then((r) => r.data);
}

// ─── Client-page publishing (per-client, drives drawer toggle + ComposeDialog) ───

export function getClientPages(clientId) {
  return client.get(`/social/client-pages/${clientId}`).then((r) => r.data);
}

export function setPagePublishing(clientId, fbPageId, enabled) {
  return client
    .post(`/social/client-pages/${clientId}/${fbPageId}/publishing`, { enabled })
    .then((r) => r.data);
}

export function syncClientPages(clientId) {
  return client.post(`/social/client-pages/${clientId}/sync`).then((r) => r.data);
}
