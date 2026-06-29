/**
 * gtm.container_health check handler (north-star §13.4).
 *
 * RECONCILE (F9): Enabled here because F1's checks/registry.js accepts
 * serviceCategory+provider without a legacy umbrella field. This unblocks
 * the check that the original F9 plan deferred pending F1.
 *
 * Verifies that the GTM container is accessible and has published tags.
 * Credential: GTM_SERVICE_ACCOUNT_KEY (same as the connector).
 * ctx shape: { clientUserId, env?, fetch?, getAccessToken? }
 *   All non-clientUserId fields are injectable for tests.
 */

import { getCredential } from '../../credentialStore.js';

const GTM_BASE = 'https://tagmanager.googleapis.com/tagmanager/v2';

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

export async function handleContainerHealth(ctx) {
  const {
    clientUserId,
    env: ctxEnv,
    fetch: fetchFn = globalThis.fetch,
    getAccessToken,
    gtmContainerId,
    gtmAccountPath
  } = ctx;

  // Resolve env: injected ctx.env wins, else load credential from DB.
  let env = ctxEnv;
  if (!env || !env.GTM_SERVICE_ACCOUNT_KEY) {
    const cred = await getCredential(clientUserId, 'gtm').catch(() => null);
    if (!cred) {
      return { status: 'skipped', severity: null, payload: { reason: 'no GTM credential configured for this client (platform: gtm)' } };
    }
    env = { GTM_SERVICE_ACCOUNT_KEY: cred.secret_value };
  }

  const getToken = getAccessToken || defaultGetAccessToken;
  let token;
  try {
    token = await getToken(env);
  } catch (err) {
    return { status: 'skipped', severity: null, payload: { reason: `GTM token error: ${err.message}` } };
  }

  const headers = { Authorization: `Bearer ${token}` };

  try {
    // If injected container path provided (test or pre-resolved), use it directly.
    let accountPath = gtmAccountPath;
    let containerId = gtmContainerId;

    if (!accountPath || !containerId) {
      // Discover first visible account and container.
      const accRes = await fetchFn(`${GTM_BASE}/accounts`, { headers });
      if (!accRes.ok) {
        return { status: 'skipped', severity: null, payload: { reason: `GTM accounts API ${accRes.status}` } };
      }
      const accData = await accRes.json();
      const accounts = accData.account || [];
      if (!accounts.length) {
        return { status: 'warn', severity: 'low', payload: { message: 'No GTM accounts visible for this credential' } };
      }
      accountPath = accounts[0].path;

      const conRes = await fetchFn(`${GTM_BASE}/${accountPath}/containers`, { headers });
      if (!conRes.ok) {
        return { status: 'skipped', severity: null, payload: { reason: `GTM containers API ${conRes.status}` } };
      }
      const conData = await conRes.json();
      const containers = conData.container || [];
      if (!containers.length) {
        return { status: 'warn', severity: 'low', payload: { message: 'No GTM containers found in first account' } };
      }
      containerId = containers[0].containerId;
      accountPath = `accounts/${containers[0].accountId || accounts[0].accountId}`;
    }

    // Fetch published workspace / live tags via versions endpoint.
    const liveRes = await fetchFn(
      `${GTM_BASE}/${accountPath}/containers/${containerId}/versions:live`,
      { headers }
    );
    if (!liveRes.ok) {
      return {
        status: 'warn',
        severity: 'medium',
        payload: { containerId, message: `Could not fetch live version (HTTP ${liveRes.status}) — container may have no published version` }
      };
    }
    const liveData = await liveRes.json();
    const tagCount = (liveData.tag || []).length;
    const triggerCount = (liveData.trigger || []).length;

    if (tagCount === 0) {
      return {
        status: 'warn',
        severity: 'medium',
        payload: { containerId, tagCount, triggerCount, message: 'GTM container has no published tags' }
      };
    }

    return {
      status: 'pass',
      severity: null,
      payload: { containerId, tagCount, triggerCount, message: `GTM container healthy — ${tagCount} tag(s), ${triggerCount} trigger(s) published` }
    };
  } catch (err) {
    return { status: 'error', severity: 'high', payload: { message: err.message } };
  }
}

export const GTM_CHECKS = [
  {
    id: 'gtm.container_health',
    serviceCategory: 'measurement',
    provider: 'gtm',
    requiredCapabilities: ['container.list'],
    tier: 'weekly_deep',
    handler: handleContainerHealth,
    costEstimate: 10
  }
];
