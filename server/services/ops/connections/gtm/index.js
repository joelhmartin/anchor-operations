/**
 * measurement/gtm connector — Google Tag Manager container/tags/triggers inventory.
 *
 * RECONCILE (F9 build): gtm.container_health check is re-enabled here because
 * F1's checks/registry.js accepts serviceCategory+provider without requiring a
 * legacy umbrella. Registration happens via checks/gtm/index.js side-effect import
 * from runExecutor.js (same pattern as GA4).
 *
 * Credentials:
 *   GTM_SERVICE_ACCOUNT_KEY — JSON string of a GCP service account key.
 *     Required scopes: https://www.googleapis.com/auth/tagmanager.readonly.
 *
 * API: https://tagmanager.googleapis.com/tagmanager/v2 (REST). No SDK — plain fetch.
 * Auth: google-auth-library (already a dep) for access token acquisition only.
 * ctx shape: { env?, fetch?, getAccessToken? }
 *   getAccessToken(env): Promise<string> — injectable for tests.
 */

import { registerConnector } from '../registry.js';

const GTM_BASE = 'https://tagmanager.googleapis.com/tagmanager/v2';

function hasKey(env) {
  return Boolean((env.GTM_SERVICE_ACCOUNT_KEY || '').trim());
}

async function defaultGetAccessToken(env) {
  const { GoogleAuth } = await import('google-auth-library');
  const keyJson = (env.GTM_SERVICE_ACCOUNT_KEY || '').trim();
  if (!keyJson) throw new Error('GTM_SERVICE_ACCOUNT_KEY not set');
  const auth = new GoogleAuth({
    credentials: JSON.parse(keyJson),
    scopes: ['https://www.googleapis.com/auth/tagmanager.readonly']
  });
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  if (!token) throw new Error('Failed to acquire GTM access token');
  return token;
}

export async function verifyConnection(ctx = {}) {
  const {
    env = process.env,
    fetch: fetchFn = globalThis.fetch,
    getAccessToken = defaultGetAccessToken
  } = ctx;
  if (!hasKey(env)) {
    return { status: 'missing', detail: 'GTM_SERVICE_ACCOUNT_KEY not set or blank', capabilities: [] };
  }
  try {
    const token = await getAccessToken(env);
    const res = await fetchFn(`${GTM_BASE}/accounts`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      return { status: 'failed', detail: `GTM API ${res.status}`, capabilities: [] };
    }
    const data = await res.json();
    const count = (data.account || []).length;
    const caps = await listCapabilities(ctx);
    return {
      status: 'verified',
      detail: `GTM access confirmed — ${count} account(s) visible`,
      capabilities: Object.keys(caps).filter((k) => caps[k])
    };
  } catch (err) {
    return { status: 'failed', detail: err.message, capabilities: [] };
  }
}

export async function listCapabilities(_ctx = {}) {
  return {
    'container.list': true,
    'tags.list': true,
    'triggers.list': true,
    'variables.list': true
  };
}

export async function discoverInventory(ctx = {}) {
  const {
    env = process.env,
    fetch: fetchFn = globalThis.fetch,
    getAccessToken = defaultGetAccessToken
  } = ctx;
  const token = await getAccessToken(env);
  const headers = { Authorization: `Bearer ${token}` };

  const accRes = await fetchFn(`${GTM_BASE}/accounts`, { headers });
  if (!accRes.ok) throw new Error(`GTM accounts API ${accRes.status}`);
  const accData = await accRes.json();
  const accounts = accData.account || [];

  const rows = [];
  for (const account of accounts) {
    const conRes = await fetchFn(`${GTM_BASE}/${account.path}/containers`, { headers });
    if (!conRes.ok) continue;
    const conData = await conRes.json();
    for (const container of (conData.container || [])) {
      rows.push({
        provider: 'gtm',
        serviceCategory: 'measurement',
        object_type: 'container',
        external_id: container.containerId,
        name: container.name,
        metadata: {
          accountId: account.accountId,
          accountName: account.name,
          publicId: container.publicId || null,
          usageContext: container.usageContext || []
        }
      });
    }
  }
  return rows;
}

export async function collectSnapshot(_ctx = {}) {
  return [];
}

const connector = {
  id: 'measurement/gtm',
  serviceCategory: 'measurement',
  provider: 'gtm',
  connectionTypes: ['service_account'],
  verifyConnection,
  listCapabilities,
  discoverInventory,
  collectSnapshot,
  actions: {},
  // RECONCILE: re-enabled now that F1's checks/registry accepts serviceCategory+provider.
  checks: ['gtm.container_health']
};

registerConnector(connector);
export default connector;
