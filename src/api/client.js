import axios from 'axios';

import { getDeviceId } from './deviceId';
import { getAccessToken, setAccessToken } from './tokenStore';

const API_BASE = import.meta.env.VITE_APP_API_BASE || '/api';
// Cross-app SSO: refresh against the dashboard when configured (same-site cookie).
const MAIN_APP_URL = (import.meta.env.VITE_MAIN_APP_URL || '').replace(/\/$/, '');
const REFRESH_URL = MAIN_APP_URL ? `${MAIN_APP_URL}/api/auth/refresh` : `${API_BASE}/auth/refresh`;

const client = axios.create({
  baseURL: API_BASE,
  withCredentials: true,
  headers: {
    'Content-Type': 'application/json'
  }
});

// Track refresh state to prevent multiple simultaneous refresh attempts
// This is shared with auth.js via window to prevent race conditions
let isRefreshing = false;
let refreshSubscribers = [];
let refreshPromise = null;

/**
 * Subscribe to token refresh completion
 * @param {Function} callback - Called with new token when refresh completes
 */
function subscribeToRefresh(callback) {
  refreshSubscribers.push(callback);
}

/**
 * Notify all subscribers that refresh completed
 * @param {string|null} newToken - The new access token (null if refresh failed)
 */
function notifyRefreshSubscribers(newToken) {
  refreshSubscribers.forEach((callback) => callback(newToken));
  refreshSubscribers = [];
}

/**
 * Attempt to refresh the access token using the refresh token cookie
 * Uses a shared promise to prevent multiple simultaneous refresh attempts
 * @returns {Promise<string|null>} New access token or null if refresh failed
 */
async function refreshAccessToken() {
  // If a refresh is already in progress, wait for it
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const deviceId = getDeviceId();
      const response = await axios.post(
        REFRESH_URL,
        {},
        {
          withCredentials: true,
          headers: {
            'Content-Type': 'application/json',
            ...(deviceId ? { 'X-Device-Id': deviceId } : {})
          }
        }
      );

      const newToken = response.data?.accessToken;
      if (newToken) {
        setAccessToken(newToken);
        return newToken;
      }
      return null;
    } catch (error) {
      console.error('[auth] Token refresh failed:', error?.response?.status || error.message);
      return null;
    } finally {
      // Clear the promise after a short delay to prevent rapid re-attempts
      setTimeout(() => {
        refreshPromise = null;
      }, 100);
    }
  })();

  return refreshPromise;
}

// Request interceptor - add auth token, device ID, and acting user header
client.interceptors.request.use((config) => {
  // Add acting user header if in "Act as Client" mode
  if (typeof window !== 'undefined') {
    const acting = window.sessionStorage?.getItem('actingClientId');
    const selectedClientAccountId = window.sessionStorage?.getItem('selectedClientAccountId');
    if (acting) {
      config.headers = { ...(config.headers || {}), 'x-acting-user': acting };
    } else if (config.headers?.['x-acting-user']) {
      const headers = { ...config.headers };
      delete headers['x-acting-user'];
      config.headers = headers;
    }

    if (selectedClientAccountId) {
      config.headers = { ...(config.headers || {}), 'x-client-account': selectedClientAccountId };
    } else if (config.headers?.['x-client-account']) {
      const headers = { ...config.headers };
      delete headers['x-client-account'];
      config.headers = headers;
    }
  }

  // Add authorization header
  const token = getAccessToken();
  if (token) {
    config.headers = { ...(config.headers || {}), Authorization: `Bearer ${token}` };
  }

  // Add device ID header for trusted device tracking
  const deviceId = getDeviceId();
  if (deviceId) {
    config.headers = { ...(config.headers || {}), 'X-Device-Id': deviceId };
  }

  return config;
});

// Response interceptor - handle 401 errors and refresh token
client.interceptors.response.use(
  // Success - pass through
  (response) => response,

  // Error - check for 401 and attempt refresh
  async (error) => {
    const originalRequest = error.config;

    // Only handle 401 errors (unauthorized/token expired)
    if (error.response?.status !== 401) {
      return Promise.reject(error);
    }

    // Don't retry if this is already a retry or a refresh/login request
    if (originalRequest._retry || originalRequest.url?.includes('/auth/refresh') || originalRequest.url?.includes('/auth/login')) {
      return Promise.reject(error);
    }

    // If already refreshing, queue this request
    if (isRefreshing) {
      return new Promise((resolve, reject) => {
        subscribeToRefresh((newToken) => {
          if (newToken) {
            originalRequest.headers.Authorization = `Bearer ${newToken}`;
            originalRequest._retry = true;
            resolve(client(originalRequest));
          } else {
            reject(error);
          }
        });
      });
    }

    // Start refresh process
    isRefreshing = true;
    originalRequest._retry = true;

    try {
      const newToken = await refreshAccessToken();

      if (newToken) {
        // Notify queued requests
        notifyRefreshSubscribers(newToken);

        // Retry original request with new token
        originalRequest.headers.Authorization = `Bearer ${newToken}`;
        return client(originalRequest);
      } else {
        // Refresh failed - notify subscribers but DON'T redirect
        // AuthContext will handle the redirect after it detects no user
        // This prevents race conditions with multiple redirect attempts
        notifyRefreshSubscribers(null);
        return Promise.reject(error);
      }
    } catch (refreshError) {
      notifyRefreshSubscribers(null);
      return Promise.reject(refreshError);
    } finally {
      isRefreshing = false;
    }
  }
);

export default client;
