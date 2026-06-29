/**
 * deployment/vercel connector — project + deployment listing.
 *
 * Credentials:
 *   VERCEL_API_TOKEN — personal or team API token (Vercel Settings → Tokens).
 *   VERCEL_TEAM_ID   — optional; team-scopes all API calls when set.
 *
 * API: https://api.vercel.com (REST). No SDK — plain fetch.
 * ctx shape: { env?, fetch? }
 */

import { registerConnector } from '../registry.js';

const VERCEL_BASE = 'https://api.vercel.com';

function getToken(env) {
  return (env.VERCEL_API_TOKEN || '').trim() || null;
}

function teamParam(env) {
  const id = (env.VERCEL_TEAM_ID || '').trim();
  return id ? `teamId=${id}` : null;
}

function vercelHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json'
  };
}

function withTeam(base, env) {
  const tp = teamParam(env);
  return tp ? `${base}?${tp}` : base;
}

export async function verifyConnection(ctx = {}) {
  const { env = process.env, fetch: fetchFn = globalThis.fetch } = ctx;
  const token = getToken(env);
  if (!token) return { status: 'missing', detail: 'VERCEL_API_TOKEN not set or blank', capabilities: {} };
  try {
    const url = withTeam(`${VERCEL_BASE}/v2/user`, env);
    const res = await fetchFn(url, { headers: vercelHeaders(token) });
    if (!res.ok) return { status: 'failed', detail: `Vercel API ${res.status}`, capabilities: {} };
    const data = await res.json();
    const u = data.user || data;
    return {
      status: 'verified',
      detail: `Authenticated as ${u.name || u.username || 'unknown'}`,
      capabilities: await listCapabilities(ctx)
    };
  } catch (err) {
    return { status: 'failed', detail: err.message, capabilities: {} };
  }
}

export async function listCapabilities(_ctx = {}) {
  return {
    'project.list': true,
    'deployment.list': true,
    'deployment.inspect': true
  };
}

export async function discoverInventory(ctx = {}) {
  const { env = process.env, fetch: fetchFn = globalThis.fetch } = ctx;
  const token = getToken(env);
  const tp = teamParam(env);
  const projectsUrl = tp
    ? `${VERCEL_BASE}/v9/projects?limit=50&${tp}`
    : `${VERCEL_BASE}/v9/projects?limit=50`;
  const res = await fetchFn(projectsUrl, { headers: vercelHeaders(token) });
  if (!res.ok) throw new Error(`Vercel projects API ${res.status}`);
  const data = await res.json();
  return (data.projects || []).map((p) => ({
    provider: 'vercel',
    serviceCategory: 'deployment',
    externalId: p.id,
    name: p.name,
    meta: {
      framework: p.framework || null,
      latestDeploymentUrl: p.latestDeployments?.[0]?.url || null,
      productionUrl: p.targets?.production?.alias?.[0] || null,
      updatedAt: p.updatedAt || null
    }
  }));
}

export async function collectSnapshot(_ctx = {}) {
  return [];
}

const connector = {
  id: 'deployment/vercel',
  serviceCategory: 'deployment',
  provider: 'vercel',
  connectionTypes: ['api_key'],
  verifyConnection,
  listCapabilities,
  discoverInventory,
  collectSnapshot,
  actions: {},
  checks: []
};

registerConnector(connector);
export default connector;
