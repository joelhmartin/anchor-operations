/**
 * repo/github connector — read-only GitHub repository inspection.
 *
 * Credentials:
 *   GITHUB_TOKEN — personal access token with repo + read:org scopes.
 *   GITHUB_ORG   — optional; lists org repos when set, user repos otherwise.
 *
 * API: https://api.github.com (REST v3). No SDK — plain fetch.
 * ctx shape: { env?, fetch? }
 */

import { registerConnector } from '../registry.js';

const GH_BASE = 'https://api.github.com';

function getToken(env) {
  return (env.GITHUB_TOKEN || '').trim() || null;
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'User-Agent': 'anchor-ops/1.0',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
}

// Extract the next-page URL from a GitHub Link header, or null if no next page.
function getLinkNext(res) {
  const link = typeof res.headers?.get === 'function' ? res.headers.get('link') : '';
  if (!link) return null;
  const m = link.match(/<([^>]+)>;\s*rel="next"/);
  return m ? m[1] : null;
}

export async function verifyConnection(ctx = {}) {
  const { env = process.env, fetch: fetchFn = globalThis.fetch } = ctx;
  const token = getToken(env);
  if (!token) return { status: 'missing', detail: 'GITHUB_TOKEN not set or blank', capabilities: [] };
  try {
    const res = await fetchFn(`${GH_BASE}/user`, { headers: ghHeaders(token) });
    if (!res.ok) {
      return { status: 'failed', detail: `GitHub API ${res.status}`, capabilities: [] };
    }
    const user = await res.json();

    // When GITHUB_ORG is configured, verify org endpoint is reachable (inventory will use it).
    const org = (env.GITHUB_ORG || '').trim();
    if (org) {
      const orgRes = await fetchFn(`${GH_BASE}/orgs/${org}/repos?per_page=1`, { headers: ghHeaders(token) });
      if (!orgRes.ok) {
        return {
          status: 'failed',
          detail: `GitHub token valid but org '${org}' is not accessible (HTTP ${orgRes.status}) — check read:org scope`,
          capabilities: []
        };
      }
    }

    const caps = await listCapabilities(ctx);
    return {
      status: 'verified',
      detail: `Authenticated as @${user.login} (${user.name || user.login})`,
      capabilities: Object.keys(caps).filter((k) => caps[k])
    };
  } catch (err) {
    return { status: 'failed', detail: err.message, capabilities: [] };
  }
}

export async function listCapabilities(_ctx = {}) {
  return {
    'repo.list': true,
    'repo.inspect': true
  };
}

export async function discoverInventory(ctx = {}) {
  const { env = process.env, fetch: fetchFn = globalThis.fetch } = ctx;
  const token = getToken(env);
  const org = (env.GITHUB_ORG || '').trim();
  const firstUrl = org
    ? `${GH_BASE}/orgs/${org}/repos?per_page=50&sort=updated`
    : `${GH_BASE}/user/repos?per_page=50&sort=updated&affiliation=owner,organization_member`;

  const repos = [];
  let nextUrl = firstUrl;
  while (nextUrl) {
    const res = await fetchFn(nextUrl, { headers: ghHeaders(token) });
    if (!res.ok) throw new Error(`GitHub repos API ${res.status}`);
    const page = await res.json();
    repos.push(...page);
    nextUrl = getLinkNext(res);
  }

  return repos.map((r) => ({
    provider: 'github',
    serviceCategory: 'repo',
    object_type: 'repo',
    external_id: String(r.id),
    name: r.full_name,
    metadata: {
      defaultBranch: r.default_branch,
      private: r.private,
      language: r.language || null,
      updatedAt: r.updated_at,
      url: r.html_url
    }
  }));
}

export async function collectSnapshot(_ctx = {}) {
  return [];
}

const connector = {
  id: 'repo/github',
  serviceCategory: 'repo',
  provider: 'github',
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
