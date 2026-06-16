import { getDeviceId } from './deviceId';
import { getAccessToken } from './tokenStore';

const API_BASE = import.meta.env.VITE_APP_API_BASE || '/api';
// Dashboard origin for cross-app SSO (empty = standalone / dev login only).
const MAIN_APP_URL = (import.meta.env.VITE_MAIN_APP_URL || '').replace(/\/$/, '');

async function request(path, options = {}) {
  const token = getAccessToken();
  const deviceId = getDeviceId();
  const actingClientId = typeof window !== 'undefined' ? window.sessionStorage?.getItem('actingClientId') : null;
  const selectedClientAccountId = typeof window !== 'undefined' ? window.sessionStorage?.getItem('selectedClientAccountId') : null;
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(deviceId ? { 'X-Device-Id': deviceId } : {}),
      ...(actingClientId ? { 'x-acting-user': actingClientId } : {}),
      ...(selectedClientAccountId ? { 'x-client-account': selectedClientAccountId } : {}),
      ...(options.headers || {})
    },
    credentials: 'include',
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const contentType = res.headers.get('content-type');
  const data = contentType && contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    const message = data?.message || 'Request failed';
    throw new Error(message);
  }

  return data;
}

export function fetchCurrentUser() {
  return request('/auth/me');
}

export function login(payload) {
  return request('/auth/login', { method: 'POST', body: payload });
}

export async function refreshSession() {
  // SSO: when a dashboard origin is configured, get the access token from the
  // dashboard. tasks.anchorcorps.com and dashboard.anchorcorps.com are the same
  // site, so the browser sends the dashboard's login cookie on this request — no
  // second login needed. Falls back to the local endpoint when standalone.
  if (MAIN_APP_URL) {
    const res = await fetch(`${MAIN_APP_URL}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include'
    });
    if (!res.ok) {
      const data = await res.json().catch(() => null);
      throw new Error(data?.message || 'SSO refresh failed');
    }
    return res.json();
  }
  return request('/auth/refresh', { method: 'POST' });
}

export function verifyMfa(payload) {
  return request('/auth/mfa/verify', { method: 'POST', body: payload });
}

export function resendMfa(challengeId) {
  return request('/auth/mfa/resend', { method: 'POST', body: { challengeId } });
}

export function resendEmailVerification(email) {
  return request('/auth/resend-verification', { method: 'POST', body: { email } });
}

export function logout() {
  return request('/auth/logout', { method: 'POST' });
}

export function impersonate(userId) {
  return request('/auth/impersonate', { method: 'POST', body: { user_id: userId } });
}

export function requestPasswordReset(email) {
  return request('/auth/forgot-password', { method: 'POST', body: { email } });
}

export function resetPassword(payload) {
  return request('/auth/reset-password', { method: 'POST', body: payload });
}
