/**
 * gtm.container_health check handler (north-star §13.4).
 *
 * RECONCILE (F9): Enabled here because F1's checks/registry.js accepts
 * serviceCategory+provider without a legacy umbrella field. This unblocks
 * the check that the original F9 plan deferred pending F1.
 *
 * Verifies that the GTM container is accessible and has published tags.
 * Credential: GTM_SERVICE_ACCOUNT_KEY (same as the connector).
 * ctx shape: { clientUserId, env?, fetch?, getAccessToken?, config? }
 *   All non-clientUserId fields are injectable for tests.
 *   ctx.config: { gtmContainerId?, gtmAccountPath? } — per-check settings from runExecutor.
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
    config = {}
  } = ctx;
  // Per-check target IDs come from ctx.config (set by runExecutor), not from ctx directly.
  let { gtmContainerId, gtmAccountPath } = config;

  // Resolve env: injected ctx.env wins, else fall back to process.env (agency credentials).
  let env = ctxEnv ?? process.env;
  if (!env.GTM_SERVICE_ACCOUNT_KEY) {
    const cred = await getCredential(clientUserId, 'gtm').catch(() => null);
    // self_serve_oauth credentials are decrypted via resolveSecret(); agency sources use process.env (already checked above).
    const secret = cred?.resolveSecret?.() ?? '';
    if (!secret) {
      return { status: 'skipped', severity: null, payload: { reason: 'no GTM credential configured for this client (platform: gtm)' } };
    }
    env = { ...env, GTM_SERVICE_ACCOUNT_KEY: secret };
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
    if (!gtmAccountPath || !gtmContainerId) {
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
      gtmAccountPath = accounts[0].path;

      const conRes = await fetchFn(`${GTM_BASE}/${gtmAccountPath}/containers`, { headers });
      if (!conRes.ok) {
        return { status: 'skipped', severity: null, payload: { reason: `GTM containers API ${conRes.status}` } };
      }
      const conData = await conRes.json();
      const containers = conData.container || [];
      if (!containers.length) {
        return { status: 'warn', severity: 'low', payload: { message: 'No GTM containers found in first account' } };
      }
      gtmContainerId = containers[0].containerId;
      gtmAccountPath = `accounts/${containers[0].accountId || accounts[0].accountId}`;
    }

    // Fetch published workspace / live tags via versions endpoint.
    const liveRes = await fetchFn(
      `${GTM_BASE}/${gtmAccountPath}/containers/${gtmContainerId}/versions:live`,
      { headers }
    );
    if (!liveRes.ok) {
      return {
        status: 'warn',
        severity: 'medium',
        payload: { containerId: gtmContainerId, message: `Could not fetch live version (HTTP ${liveRes.status}) — container may have no published version` }
      };
    }
    const liveData = await liveRes.json();
    const tagCount = (liveData.tag || []).length;
    const triggerCount = (liveData.trigger || []).length;

    if (tagCount === 0) {
      return {
        status: 'warn',
        severity: 'medium',
        payload: { containerId: gtmContainerId, tagCount, triggerCount, message: 'GTM container has no published tags' }
      };
    }

    return {
      status: 'pass',
      severity: null,
      payload: { containerId: gtmContainerId, tagCount, triggerCount, message: `GTM container healthy — ${tagCount} tag(s), ${triggerCount} trigger(s) published` }
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
