import client from './client';

export const listBlogPosts = (clientId) =>
  client.get('/ops/blog/posts', { params: clientId ? { clientId } : {} }).then((r) => r.data.posts || []);
export const listClientWpSites = (clientId) => client.get(`/ops/blog/sites/${clientId}`).then((r) => r.data.sites || []);
export const createBlogPost = (body) => client.post('/ops/blog/posts', body).then((r) => r.data.post);
export const updateBlogPost = (id, fields) => client.patch(`/ops/blog/posts/${id}`, fields).then((r) => r.data.post);
export const cancelBlogPost = (id) => client.post(`/ops/blog/posts/${id}/cancel`).then((r) => r.data.post);
export const deleteBlogPost = (id) => client.delete(`/ops/blog/posts/${id}`).then((r) => r.data);
export const uploadBlogMedia = (file) => {
  const fd = new FormData();
  fd.append('file', file);
  return client.post('/ops/blog/media', fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data);
};
