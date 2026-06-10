import client from './client';

export function fetchProfile() {
  return client.get('/hub/profile').then((res) => res.data.user);
}

export function updateProfile(payload) {
  return client.put('/hub/profile', payload).then((res) => res.data.user);
}

// The "/me" variants always target the logged-in user, ignoring the active client account.
// Use these in Profile Settings so group/invited members edit their own account, not the client owner's.
export function fetchMyProfile() {
  return client.get('/hub/profile/me').then((res) => res.data.user);
}

export function updateMyProfile(payload) {
  return client.put('/hub/profile/me', payload).then((res) => res.data.user);
}

export function uploadMyAvatar(file) {
  const formData = new FormData();
  formData.append('avatar', file);
  return client
    .post('/hub/profile/me/avatar', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    .then((res) => res.data);
}

export function updateNotificationSettings(payload) {
  return client.put('/hub/profile/notifications', payload).then((res) => res.data);
}

export function uploadAvatar(file) {
  const formData = new FormData();
  formData.append('avatar', file);
  return client
    .post('/hub/profile/avatar', formData, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
    .then((res) => res.data);
}
