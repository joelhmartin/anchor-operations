import client from './client';

export function fetchBrand() {
  return client.get('/hub/brand').then((res) => res.data.brand);
}

export function saveBrand({ fields = {}, logoFiles = [], styleGuideFiles = [], deletions = [] }) {
  const formData = new FormData();
  logoFiles.forEach((file) => formData.append('logos', file));
  styleGuideFiles.forEach((file) => formData.append('style_guide', file));
  formData.append('deletions', JSON.stringify(deletions));
  Object.entries(fields).forEach(([key, value]) => {
    if (value !== undefined && value !== null) {
      formData.append(key, value);
    }
  });

  return client
    .put('/hub/brand', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    .then((res) => res.data.brand);
}

export function uploadDisplayLogo(file) {
  const formData = new FormData();
  formData.append('logo', file);
  return client
    .post('/hub/brand/display-logo', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    .then((res) => res.data.display_logo);
}

export function deleteDisplayLogo() {
  return client.delete('/hub/brand/display-logo').then((res) => res.data.display_logo);
}
