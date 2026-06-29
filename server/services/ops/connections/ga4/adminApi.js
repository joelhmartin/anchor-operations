import { GoogleAuth } from 'google-auth-library';

const ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
const SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

export async function getAdminAccessToken({ env = process.env } = {}) {
  const keyJson = env.GA4_SERVICE_ACCOUNT_KEY;
  const authOpts = keyJson
    ? { credentials: JSON.parse(keyJson), scopes: SCOPES }
    : { scopes: SCOPES };
  const auth = new GoogleAuth(authOpts);
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('GA4 Admin: could not obtain access token — check GA4_SERVICE_ACCOUNT_KEY or ADC configuration');
  return token;
}

async function adminGet(path, { token, fetchFn = globalThis.fetch } = {}) {
  const res = await fetchFn(`${ADMIN_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`GA4 Admin ${res.status} for ${path}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

export async function listAccountSummaries({ token, fetchFn = globalThis.fetch } = {}) {
  const data = await adminGet('/accountSummaries', { token, fetchFn });
  return data.accountSummaries || [];
}

export async function listDataStreams(propertyId, { token, fetchFn = globalThis.fetch } = {}) {
  const data = await adminGet(`/properties/${propertyId}/dataStreams`, { token, fetchFn });
  return data.dataStreams || [];
}

export async function listKeyEvents(propertyId, { token, fetchFn = globalThis.fetch } = {}) {
  const data = await adminGet(`/properties/${propertyId}/keyEvents`, { token, fetchFn });
  return data.keyEvents || [];
}
