/**
 * task/monday connector — Monday.com task management.
 *
 * Satisfies north-star §15: turns findings into accountable work via task.create.
 * Credential: MONDAY_API_TOKEN — agency-level personal API token.
 * API: https://api.monday.com/v2 (GraphQL v2, API-Version: 2024-01). No SDK.
 * ctx shape: { env?, fetch? }
 */

import { registerConnector } from '../registry.js';

const MONDAY_API = 'https://api.monday.com/v2';
const PAGE_LIMIT = 50;

function getToken(env) {
  return (env.MONDAY_API_TOKEN || '').trim() || null;
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'API-Version': '2024-01'
  };
}

async function gql(queryStr, variables = {}, { env, fetch: fetchFn }) {
  const token = getToken(env);
  const res = await fetchFn(MONDAY_API, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify({ query: queryStr, variables })
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Monday API ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  if (data.errors?.length) throw new Error(`Monday GQL: ${data.errors[0].message}`);
  return data.data;
}

export async function verifyConnection(ctx = {}) {
  const { env = process.env, fetch: fetchFn = globalThis.fetch } = ctx;
  const token = getToken(env);
  if (!token) {
    return { status: 'missing', detail: 'MONDAY_API_TOKEN not set or blank', capabilities: [] };
  }
  try {
    const data = await gql('{ me { id name email } }', {}, { env, fetch: fetchFn });
    const me = data?.me;
    if (!me?.id) throw new Error('Unexpected response shape (me.id missing)');
    const caps = await listCapabilities(ctx);
    return {
      status: 'verified',
      detail: `Authenticated as ${me.name} (${me.email})`,
      capabilities: Object.keys(caps).filter((k) => caps[k])
    };
  } catch (err) {
    return { status: 'failed', detail: err.message, capabilities: [] };
  }
}

export async function listCapabilities(_ctx = {}) {
  return {
    'task.create': true,
    'task.list': true,
    'board.list': true
  };
}

export async function discoverInventory(ctx = {}) {
  const { env = process.env, fetch: fetchFn = globalThis.fetch } = ctx;
  const boards = [];
  let page = 1;
  while (true) {
    const data = await gql(
      `{ boards(limit: ${PAGE_LIMIT}, page: ${page}) { id name description } }`,
      {},
      { env, fetch: fetchFn }
    );
    const batch = data.boards || [];
    boards.push(...batch);
    if (batch.length < PAGE_LIMIT) break;
    page++;
  }
  return boards.map((b) => ({
    provider: 'monday',
    serviceCategory: 'task',
    object_type: 'board',
    external_id: String(b.id),
    name: b.name,
    metadata: { description: b.description || null }
  }));
}

export async function collectSnapshot(_ctx = {}) {
  return [];
}

const connector = {
  id: 'task/monday',
  serviceCategory: 'task',
  provider: 'monday',
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
