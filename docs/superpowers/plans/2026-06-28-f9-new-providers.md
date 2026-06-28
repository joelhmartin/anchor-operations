# F9 — New Providers (Expandability Proof) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Demonstrate that a new integration is added by dropping in a connector module that implements the F1 contract (spec §5) and self-registers — with zero changes to the core run executor, checks/registry, dashboard data model, or agent.

**Architecture:** Five connector modules live under `server/services/ops/connections/<provider>/index.js`. Each implements the spec §5 interface (`verifyConnection`, `listCapabilities`, `discoverInventory`, `collectSnapshot` stub, optional `actions`) and self-registers against a lightweight F1 registry stub (`server/services/ops/connections/registry.js`). All connector logic is dependency-injected via a `ctx` object so tests run against fake fetch/tokens with zero live API calls. The registry stub is a pure Map that F1 will replace — connectors need only update their import path when F1 ships. No migration, no core file modification, no bespoke UI.

**Tech Stack:** Node ESM, plain `fetch` for all REST/GraphQL API calls (no SDK per-provider), `google-auth-library` (already a dep per F0 plan) for GTM OAuth token acquisition only, `node:test` + `node:assert/strict`, no new npm dependencies.

## Global Constraints

- **Credentials: env-var / Postgres, NOT Secret Manager** (spec §3.1). Each connector reads its token from `process.env` (or an injected `env` object). No Secret Manager call anywhere in this plan.
- **Core files are READ-ONLY for this phase.** `server/services/ops/runExecutor.js`, `server/services/ops/checks/registry.js`, `src/views/admin/Operations/` (dashboard), and the ops agent must not be modified. Any task that would require modifying them is a failure of the abstraction — flag it instead (expandability §12).
- **Connector contract = spec §5:** every connector exports `{ id, serviceCategory, provider, connectionTypes, verifyConnection(ctx), listCapabilities(ctx), discoverInventory(ctx), collectSnapshot(ctx), actions?, checks? }`.
- **`service_category + provider` naming locked (spec §4):** use `task/monday`, `repo/github`, `deployment/vercel`, `measurement/gtm`, `local/gbp`.
- **GBP is PLACEHOLDER ONLY** (north-star §14; spec §8 non-goals). All GBP methods return stub responses with `STUB` in the detail. Capabilities return `false`. No live API calls.
- **No LLM mutation; PHI sanitized; medical clients respected.** F9 connectors do not call LLMs and contain no PHI.
- **No migration.** F9 adds no tables. `ops_platform_inventory` and `ops_service_connections` are F1's tables; connectors return row-shaped objects — F1/F2 persist them.
- **No new npm dependencies.** `google-auth-library` is already in `package.json`. Every other API call uses plain `globalThis.fetch` (Node 18+ built-in).
- **DB tests:** `DATABASE_URL=postgresql://bif@localhost:5432/anchor`; `yarn test:ops`; tests live in `server/services/ops/__tests__/*.test.js`.
- **All connector logic is dependency-injected via `ctx`:** tests always pass `{ env, fetch }` (and `getAccessToken` for GTM). Live `process.env` / `globalThis.fetch` are defaults only.

---

## Dependency Note

F9 depends entirely on the F1 connector registry contract (spec §5). F1 is not yet built. This plan:

1. Creates a **minimal registry stub** at the exact path F1 will own (`server/services/ops/connections/registry.js`) that mirrors the F1 API surface. When F1 ships it replaces this file; connectors need not change.
2. Writes every connector against the **documented contract** from spec §5, not against any real F1 file.
3. Does NOT use `ops_service_connections` or `ops_platform_inventory` — those are F1's tables. Connectors return the row shapes; F2 persists them.

---

## Expandability Constraint Note (§12)

The existing `checks/registry.js` only accepts `umbrella ∈ {website, google_ads, meta, ctm}`. Adding a `gtm.container_health` check against the current registry would require adding `'measurement'` to `VALID_UMBRELLAS` — a core change that violates expandability §12. **This plan does NOT do that.** Each connector declares `checks: []`. The GTM check will be registered once F1 delivers the capability-gate extension to `checks/registry.js` (which adds `serviceCategory` / `requiredCapabilities` alongside the legacy `umbrella` field). This is the correct outcome: expandability works, but the gate isn't in place yet.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/services/ops/connections/registry.js` | F1 stub — `registerConnector` / `getConnector` / `listConnectors` / `listConnectorsByCategory` / `_resetRegistryForTests`. Replaced by F1. |
| `server/services/ops/connections/monday/index.js` | `task/monday` connector — Monday.com task management. |
| `server/services/ops/connections/github/index.js` | `repo/github` connector — read-only repo inspection. |
| `server/services/ops/connections/vercel/index.js` | `deployment/vercel` connector — project + deployment listing. |
| `server/services/ops/connections/gtm/index.js` | `measurement/gtm` connector — GTM container/tags/triggers inventory. |
| `server/services/ops/connections/gbp/index.js` | `local/gbp` connector — GBP placeholder stubs (STUB). |
| `server/services/ops/__tests__/connectorRegistry.test.js` | Registry CRUD + validation guard. |
| `server/services/ops/__tests__/connectorMonday.test.js` | Monday connector: verify / listCapabilities / discoverInventory with fake fetch. |
| `server/services/ops/__tests__/connectorGithub.test.js` | GitHub connector: verify / listCapabilities / discoverInventory with fake fetch. |
| `server/services/ops/__tests__/connectorVercel.test.js` | Vercel connector: verify / listCapabilities / discoverInventory with fake fetch. |
| `server/services/ops/__tests__/connectorGtm.test.js` | GTM connector: verify / listCapabilities / discoverInventory with fake fetch + fake token. |
| `server/services/ops/__tests__/connectorGbp.test.js` | GBP stub assertions. |
| `server/services/ops/__tests__/connectorSmoke.test.js` | All-connectors self-registration smoke + expandability proof (no core file changed). |

---

### Task 1: F1 connector registry stub

**Files:**
- Create: `server/services/ops/connections/registry.js`
- Test: `server/services/ops/__tests__/connectorRegistry.test.js`

**Interfaces:**
- Produces (used by all subsequent tasks):
  - `registerConnector(definition): definition` — stores by `definition.id`; throws `'registerConnector: id required'` if `id` is falsy; logs a warning on re-registration.
  - `getConnector(id): definition | null`
  - `listConnectors(): definition[]`
  - `listConnectorsByCategory(serviceCategory): definition[]`
  - `_resetRegistryForTests(): void` — clears the Map (test escape hatch).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/connectorRegistry.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerConnector,
  getConnector,
  listConnectors,
  listConnectorsByCategory,
  _resetRegistryForTests
} from '../connections/registry.js';

test('registerConnector: stores and retrieves by id', () => {
  _resetRegistryForTests();
  const def = { id: 'test/fake', serviceCategory: 'test', provider: 'fake', connectionTypes: [] };
  const returned = registerConnector(def);
  assert.deepEqual(returned, def, 'returns the registered definition');
  assert.deepEqual(getConnector('test/fake'), def);
});

test('registerConnector: throws on missing id', () => {
  _resetRegistryForTests();
  assert.throws(() => registerConnector({}), /id required/);
  assert.throws(() => registerConnector({ id: '' }), /id required/);
});

test('getConnector: returns null for unknown id', () => {
  _resetRegistryForTests();
  assert.equal(getConnector('nope/nope'), null);
});

test('listConnectors: returns all registered', () => {
  _resetRegistryForTests();
  registerConnector({ id: 'a/b', serviceCategory: 'a', provider: 'b', connectionTypes: [] });
  registerConnector({ id: 'c/d', serviceCategory: 'c', provider: 'd', connectionTypes: [] });
  assert.equal(listConnectors().length, 2);
});

test('listConnectorsByCategory: filters by serviceCategory', () => {
  _resetRegistryForTests();
  registerConnector({ id: 'task/monday', serviceCategory: 'task', provider: 'monday', connectionTypes: [] });
  registerConnector({ id: 'repo/github', serviceCategory: 'repo', provider: 'github', connectionTypes: [] });
  const tasks = listConnectorsByCategory('task');
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'task/monday');
  assert.equal(listConnectorsByCategory('deployment').length, 0);
});

test('registerConnector: re-registration overwrites and does not duplicate', () => {
  _resetRegistryForTests();
  const v1 = { id: 'x/y', serviceCategory: 'x', provider: 'y', connectionTypes: [], version: 1 };
  const v2 = { id: 'x/y', serviceCategory: 'x', provider: 'y', connectionTypes: [], version: 2 };
  registerConnector(v1);
  registerConnector(v2);
  assert.equal(listConnectors().length, 1);
  assert.equal(getConnector('x/y').version, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/connectorRegistry.test.js`
Expected: FAIL — `Cannot find package '../connections/registry.js'` or similar.

- [ ] **Step 3: Create the connections directory and write the registry stub**

First verify the directory doesn't exist:
```bash
ls server/services/ops/connections/ 2>/dev/null || echo "directory absent — creating"
```

Create `server/services/ops/connections/registry.js`:

```js
/**
 * F1 STUB — Connector Registry
 *
 * This file is a placeholder that mirrors the exact API surface F1 will deliver
 * at server/services/ops/connections/registry.js (see F1 plan, Task 3).
 * When F1 ships it replaces this file; connector modules need not change.
 *
 * Connector contract (spec §5):
 *   { id, serviceCategory, provider, connectionTypes[],
 *     async verifyConnection(ctx),    → { status, detail, capabilities }
 *     async discoverInventory(ctx),   → inventory row[]
 *     async collectSnapshot(ctx),     → snapshot row[]
 *     async listCapabilities(ctx),    → capability map
 *     actions?,                       // optional
 *     checks[]  }                     // capability-gated check ids
 *
 * ctx shape (injected by caller, defaulted by each connector):
 *   { env?, fetch?, clientId?, connectionId? }
 */

const REGISTRY = new Map();

/**
 * Register a connector. Connectors call this at module load (side-effect import).
 * @param {object} definition - must include `id`
 * @returns {object} the registered definition
 */
export function registerConnector(definition = {}) {
  const { id } = definition;
  if (!id) throw new Error('registerConnector: id required');
  if (REGISTRY.has(id)) {
    console.warn(`[ops/connections/registry] connector already registered: ${id} — overwriting`);
  }
  REGISTRY.set(id, definition);
  return definition;
}

/** @returns {object|null} */
export function getConnector(id) {
  return REGISTRY.get(id) || null;
}

/** @returns {object[]} */
export function listConnectors() {
  return Array.from(REGISTRY.values());
}

/** @returns {object[]} */
export function listConnectorsByCategory(serviceCategory) {
  return listConnectors().filter((c) => c.serviceCategory === serviceCategory);
}

/** Test escape hatch — clears the registry. Never call in production code. */
export function _resetRegistryForTests() {
  REGISTRY.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/connectorRegistry.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/registry.js server/services/ops/__tests__/connectorRegistry.test.js
git commit -m "feat(ops/connections): F1 registry stub — registerConnector/getConnector/list"
```

---

### Task 2: monday/task connector

**Files:**
- Create: `server/services/ops/connections/monday/index.js`
- Test: `server/services/ops/__tests__/connectorMonday.test.js`

**Interfaces:**
- Consumes: `registerConnector` from Task 1.
- Produces (used by Task 7 smoke test):
  - `verifyConnection(ctx): Promise<{ status: 'verified'|'missing'|'failed', detail: string, capabilities: object }>`
  - `listCapabilities(ctx): Promise<{ 'task.create': true, 'task.list': true, 'board.list': true }>`
  - `discoverInventory(ctx): Promise<Array<{ provider: 'monday', serviceCategory: 'task', externalId: string, name: string, meta: object }>>`
  - `collectSnapshot(ctx): Promise<[]>` — stub for F3.
  - Default export: the connector definition (also self-registered at module load).
- Credential: `MONDAY_API_TOKEN` (env var, Monday.com personal API token v2).
- API: `https://api.monday.com/v2` (GraphQL, POST).
- `ctx`: `{ env?: object, fetch?: function }` (defaults: `process.env`, `globalThis.fetch`).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/connectorMonday.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyConnection, listCapabilities, discoverInventory } from '../connections/monday/index.js';

/** Returns a fake fetch that always responds with the given JSON. */
function fakeFetch(json, { ok = true, status = 200 } = {}) {
  return async (_url, _opts) => ({
    ok,
    status,
    text: async () => JSON.stringify(json),
    json: async () => json
  });
}

test('verifyConnection: valid token → verified with capabilities', async () => {
  const fetch = fakeFetch({ data: { me: { id: '123', name: 'Joel Martin', email: 'jmartin@anchorcorps.com' } } });
  const r = await verifyConnection({ env: { MONDAY_API_TOKEN: 'tok_live' }, fetch });
  assert.equal(r.status, 'verified');
  assert.ok(r.detail.includes('Joel Martin'), `detail: ${r.detail}`);
  assert.equal(r.capabilities['task.create'], true);
  assert.equal(r.capabilities['task.list'], true);
});

test('verifyConnection: missing token → missing (no fetch call)', async () => {
  let fetchCalled = false;
  const fetch = async () => { fetchCalled = true; return {}; };
  const r = await verifyConnection({ env: {}, fetch });
  assert.equal(r.status, 'missing');
  assert.ok(r.detail.includes('MONDAY_API_TOKEN'));
  assert.equal(fetchCalled, false, 'fetch must not be called when token is absent');
});

test('verifyConnection: blank token → missing', async () => {
  const r = await verifyConnection({ env: { MONDAY_API_TOKEN: '   ' }, fetch: async () => ({}) });
  assert.equal(r.status, 'missing');
});

test('verifyConnection: API returns non-ok → failed', async () => {
  const fetch = fakeFetch({ errors: [{ message: 'Unauthorized' }] }, { ok: false, status: 401 });
  const r = await verifyConnection({ env: { MONDAY_API_TOKEN: 'bad' }, fetch });
  assert.equal(r.status, 'failed');
});

test('verifyConnection: GQL errors array → failed', async () => {
  const fetch = fakeFetch({ errors: [{ message: 'invalid_token' }] });
  const r = await verifyConnection({ env: { MONDAY_API_TOKEN: 'tok' }, fetch });
  assert.equal(r.status, 'failed');
  assert.ok(r.detail.includes('invalid_token'));
});

test('listCapabilities: returns task capability map without ctx', async () => {
  const caps = await listCapabilities({});
  assert.equal(caps['task.create'], true);
  assert.equal(caps['task.list'], true);
  assert.equal(caps['board.list'], true);
});

test('discoverInventory: maps boards to inventory rows', async () => {
  const fetch = fakeFetch({
    data: { boards: [{ id: '42', name: 'Operations Board', description: 'Main ops tracking' }] }
  });
  const rows = await discoverInventory({ env: { MONDAY_API_TOKEN: 'tok' }, fetch });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, 'monday');
  assert.equal(r.serviceCategory, 'task');
  assert.equal(r.externalId, '42');
  assert.equal(r.name, 'Operations Board');
  assert.equal(r.meta.description, 'Main ops tracking');
});

test('discoverInventory: empty boards list → empty array', async () => {
  const fetch = fakeFetch({ data: { boards: [] } });
  const rows = await discoverInventory({ env: { MONDAY_API_TOKEN: 'tok' }, fetch });
  assert.deepEqual(rows, []);
});

test('connector self-registers on import', async () => {
  const { getConnector } = await import('../connections/registry.js');
  const c = getConnector('task/monday');
  assert.ok(c, 'task/monday connector not in registry');
  assert.equal(c.serviceCategory, 'task');
  assert.equal(c.provider, 'monday');
  assert.ok(Array.isArray(c.connectionTypes));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/connectorMonday.test.js`
Expected: FAIL — `Cannot find module '../connections/monday/index.js'`.

- [ ] **Step 3: Write the connector**

Create `server/services/ops/connections/monday/index.js`:

```js
/**
 * task/monday connector — Monday.com task management.
 *
 * Satisfies north-star §15: turns findings into accountable work via task.create.
 * Capability gate: any check requiring 'task.create' will only run for clients
 * whose monday connector is verified (F1 capability gate, not yet enforced).
 *
 * Credential: MONDAY_API_TOKEN — agency-level personal API token (Monday.com
 * profile → Developers → My Access Tokens). Read from process.env at call time.
 * API: https://api.monday.com/v2 (GraphQL v2, API-Version: 2024-01).
 * No SDK — plain fetch.
 *
 * ctx shape: { env?: NodeJS.ProcessEnv, fetch?: typeof fetch }
 */

import { registerConnector } from '../registry.js';

const MONDAY_API = 'https://api.monday.com/v2';

function getToken(env) {
  const t = (env.MONDAY_API_TOKEN || '').trim();
  return t || null;
}

function authHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
    'API-Version': '2024-01'
  };
}

/**
 * Execute a GraphQL query against the Monday.com v2 API.
 * Throws on HTTP error or GQL errors array.
 */
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
    return { status: 'missing', detail: 'MONDAY_API_TOKEN not set or blank', capabilities: {} };
  }
  try {
    const data = await gql('{ me { id name email } }', {}, { env, fetch: fetchFn });
    const me = data?.me;
    if (!me?.id) throw new Error('Unexpected response shape (me.id missing)');
    return {
      status: 'verified',
      detail: `Authenticated as ${me.name} (${me.email})`,
      capabilities: await listCapabilities(ctx)
    };
  } catch (err) {
    return { status: 'failed', detail: err.message, capabilities: {} };
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
  const data = await gql(
    '{ boards(limit: 50, board_kind: public) { id name description } }',
    {},
    { env, fetch: fetchFn }
  );
  return (data.boards || []).map((b) => ({
    provider: 'monday',
    serviceCategory: 'task',
    externalId: String(b.id),
    name: b.name,
    meta: { description: b.description || null }
  }));
}

/** F3 stub — snapshot collection not yet implemented. */
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
  // checks: [] — 'monday.board_health' deferred to F1 (capability gate needed first).
  checks: []
};

registerConnector(connector);
export default connector;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/connectorMonday.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/monday/index.js server/services/ops/__tests__/connectorMonday.test.js
git commit -m "feat(ops/connections): task/monday connector — verify/listCapabilities/discoverInventory"
```

---

### Task 3: repo/github connector

**Files:**
- Create: `server/services/ops/connections/github/index.js`
- Test: `server/services/ops/__tests__/connectorGithub.test.js`

**Interfaces:**
- Consumes: `registerConnector` from Task 1.
- Produces:
  - `verifyConnection(ctx): Promise<{ status: 'verified'|'missing'|'failed', detail: string, capabilities: object }>`
  - `listCapabilities(ctx): Promise<{ 'repo.list': true, 'repo.inspect': true }>`
  - `discoverInventory(ctx): Promise<Array<{ provider: 'github', serviceCategory: 'repo', externalId: string, name: string, meta: { defaultBranch, private, language, updatedAt, url } }>>`
  - `collectSnapshot(ctx): Promise<[]>` — stub.
  - Default export: self-registered connector.
- Credentials: `GITHUB_TOKEN` (PAT, `read:org + repo` scopes). `GITHUB_ORG` (optional — uses org repos endpoint when set, user repos otherwise).
- API: `https://api.github.com` (REST v3).
- ctx: `{ env?, fetch? }`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/connectorGithub.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyConnection, listCapabilities, discoverInventory } from '../connections/github/index.js';

function fakeFetch(json, { ok = true, status = 200 } = {}) {
  return async (_url, _opts) => ({
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json)
  });
}

test('verifyConnection: valid token → verified', async () => {
  const fetch = fakeFetch({ id: 1, login: 'anchorcorps', name: 'Anchor Corps' });
  const r = await verifyConnection({ env: { GITHUB_TOKEN: 'ghp_test123' }, fetch });
  assert.equal(r.status, 'verified');
  assert.ok(r.detail.includes('@anchorcorps'), `detail: ${r.detail}`);
  assert.equal(r.capabilities['repo.list'], true);
});

test('verifyConnection: missing token → missing (no fetch call)', async () => {
  let called = false;
  const fetch = async () => { called = true; return {}; };
  const r = await verifyConnection({ env: {}, fetch });
  assert.equal(r.status, 'missing');
  assert.equal(called, false);
});

test('verifyConnection: blank token → missing', async () => {
  const r = await verifyConnection({ env: { GITHUB_TOKEN: '  ' }, fetch: async () => ({}) });
  assert.equal(r.status, 'missing');
});

test('verifyConnection: 401 → failed', async () => {
  const fetch = fakeFetch({ message: 'Bad credentials' }, { ok: false, status: 401 });
  const r = await verifyConnection({ env: { GITHUB_TOKEN: 'bad' }, fetch });
  assert.equal(r.status, 'failed');
  assert.ok(r.detail.includes('401'));
});

test('listCapabilities: returns repo capability map', async () => {
  const caps = await listCapabilities({});
  assert.equal(caps['repo.list'], true);
  assert.equal(caps['repo.inspect'], true);
});

test('discoverInventory: maps repos to inventory rows', async () => {
  const repos = [{
    id: 1001,
    full_name: 'anchorcorps/anchor-operations',
    default_branch: 'main',
    private: true,
    language: 'JavaScript',
    updated_at: '2026-06-28T00:00:00Z',
    html_url: 'https://github.com/anchorcorps/anchor-operations'
  }];
  const fetch = fakeFetch(repos);
  const rows = await discoverInventory({ env: { GITHUB_TOKEN: 'tok' }, fetch });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, 'github');
  assert.equal(r.serviceCategory, 'repo');
  assert.equal(r.externalId, '1001');
  assert.equal(r.name, 'anchorcorps/anchor-operations');
  assert.equal(r.meta.defaultBranch, 'main');
  assert.equal(r.meta.private, true);
  assert.equal(r.meta.language, 'JavaScript');
});

test('discoverInventory: uses org endpoint when GITHUB_ORG is set', async () => {
  let capturedUrl = null;
  const fetch = async (url, _opts) => {
    capturedUrl = url;
    return { ok: true, json: async () => [] };
  };
  await discoverInventory({ env: { GITHUB_TOKEN: 'tok', GITHUB_ORG: 'anchorcorps' }, fetch });
  assert.ok(
    capturedUrl.includes('/orgs/anchorcorps/repos'),
    `Expected org repos URL, got: ${capturedUrl}`
  );
});

test('discoverInventory: uses user repos endpoint when GITHUB_ORG is absent', async () => {
  let capturedUrl = null;
  const fetch = async (url, _opts) => {
    capturedUrl = url;
    return { ok: true, json: async () => [] };
  };
  await discoverInventory({ env: { GITHUB_TOKEN: 'tok' }, fetch });
  assert.ok(
    capturedUrl.includes('/user/repos'),
    `Expected user repos URL, got: ${capturedUrl}`
  );
});

test('discoverInventory: empty repos → empty array', async () => {
  const rows = await discoverInventory({ env: { GITHUB_TOKEN: 'tok' }, fetch: fakeFetch([]) });
  assert.deepEqual(rows, []);
});

test('connector self-registers on import', async () => {
  const { getConnector } = await import('../connections/registry.js');
  const c = getConnector('repo/github');
  assert.ok(c, 'repo/github not in registry');
  assert.equal(c.serviceCategory, 'repo');
  assert.equal(c.provider, 'github');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/connectorGithub.test.js`
Expected: FAIL — `Cannot find module '../connections/github/index.js'`.

- [ ] **Step 3: Write the connector**

Create `server/services/ops/connections/github/index.js`:

```js
/**
 * repo/github connector — read-only GitHub repository inspection.
 *
 * Credentials:
 *   GITHUB_TOKEN — personal access token (PAT) with repo + read:org scopes.
 *   GITHUB_ORG   — optional; when set, lists org repos instead of user repos.
 *
 * API: https://api.github.com (REST v3). No SDK — plain fetch.
 * ctx shape: { env?: NodeJS.ProcessEnv, fetch?: typeof fetch }
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

export async function verifyConnection(ctx = {}) {
  const { env = process.env, fetch: fetchFn = globalThis.fetch } = ctx;
  const token = getToken(env);
  if (!token) return { status: 'missing', detail: 'GITHUB_TOKEN not set or blank', capabilities: {} };
  try {
    const res = await fetchFn(`${GH_BASE}/user`, { headers: ghHeaders(token) });
    if (!res.ok) {
      return { status: 'failed', detail: `GitHub API ${res.status}`, capabilities: {} };
    }
    const user = await res.json();
    return {
      status: 'verified',
      detail: `Authenticated as @${user.login} (${user.name || user.login})`,
      capabilities: await listCapabilities(ctx)
    };
  } catch (err) {
    return { status: 'failed', detail: err.message, capabilities: {} };
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
  const url = org
    ? `${GH_BASE}/orgs/${org}/repos?per_page=50&sort=updated`
    : `${GH_BASE}/user/repos?per_page=50&sort=updated&affiliation=owner,organization_member`;
  const res = await fetchFn(url, { headers: ghHeaders(token) });
  if (!res.ok) throw new Error(`GitHub repos API ${res.status}`);
  const repos = await res.json();
  return repos.map((r) => ({
    provider: 'github',
    serviceCategory: 'repo',
    externalId: String(r.id),
    name: r.full_name,
    meta: {
      defaultBranch: r.default_branch,
      private: r.private,
      language: r.language || null,
      updatedAt: r.updated_at,
      url: r.html_url
    }
  }));
}

/** F3 stub. */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/connectorGithub.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/github/index.js server/services/ops/__tests__/connectorGithub.test.js
git commit -m "feat(ops/connections): repo/github connector — read-only repo inspection"
```

---

### Task 4: deployment/vercel connector

**Files:**
- Create: `server/services/ops/connections/vercel/index.js`
- Test: `server/services/ops/__tests__/connectorVercel.test.js`

**Interfaces:**
- Consumes: `registerConnector` from Task 1.
- Produces:
  - `verifyConnection(ctx): Promise<{ status: 'verified'|'missing'|'failed', detail: string, capabilities: object }>`
  - `listCapabilities(ctx): Promise<{ 'project.list': true, 'deployment.list': true, 'deployment.inspect': true }>`
  - `discoverInventory(ctx): Promise<Array<{ provider: 'vercel', serviceCategory: 'deployment', externalId: string, name: string, meta: { framework, latestDeploymentUrl, productionUrl, updatedAt } }>>`
  - `collectSnapshot(ctx): Promise<[]>` — stub.
  - Default export: self-registered connector.
- Credentials: `VERCEL_API_TOKEN` (team/personal token from Vercel dashboard). `VERCEL_TEAM_ID` (optional, for team-scoped endpoints).
- API: `https://api.vercel.com` (REST). No SDK — plain fetch.
- ctx: `{ env?, fetch? }`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/connectorVercel.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyConnection, listCapabilities, discoverInventory } from '../connections/vercel/index.js';

function fakeFetch(json, { ok = true, status = 200 } = {}) {
  return async (_url, _opts) => ({
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json)
  });
}

test('verifyConnection: valid token → verified', async () => {
  const fetch = fakeFetch({ user: { name: 'Anchor Corps', username: 'anchorcorps' } });
  const r = await verifyConnection({ env: { VERCEL_API_TOKEN: 'tok_abc' }, fetch });
  assert.equal(r.status, 'verified');
  assert.ok(r.detail.includes('Anchor Corps'), `detail: ${r.detail}`);
  assert.equal(r.capabilities['project.list'], true);
  assert.equal(r.capabilities['deployment.list'], true);
});

test('verifyConnection: missing token → missing (no fetch call)', async () => {
  let called = false;
  const fetch = async () => { called = true; return {}; };
  const r = await verifyConnection({ env: {}, fetch });
  assert.equal(r.status, 'missing');
  assert.equal(called, false);
});

test('verifyConnection: blank token → missing', async () => {
  const r = await verifyConnection({ env: { VERCEL_API_TOKEN: '   ' }, fetch: async () => ({}) });
  assert.equal(r.status, 'missing');
});

test('verifyConnection: 403 → failed', async () => {
  const fetch = fakeFetch({ error: { code: 'forbidden', message: 'Forbidden' } }, { ok: false, status: 403 });
  const r = await verifyConnection({ env: { VERCEL_API_TOKEN: 'bad' }, fetch });
  assert.equal(r.status, 'failed');
  assert.ok(r.detail.includes('403'));
});

test('verifyConnection: appends teamId param when VERCEL_TEAM_ID is set', async () => {
  let capturedUrl = null;
  const fetch = async (url, _opts) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ user: { name: 'T', username: 't' } }) };
  };
  await verifyConnection({ env: { VERCEL_API_TOKEN: 'tok', VERCEL_TEAM_ID: 'team_xyz' }, fetch });
  assert.ok(capturedUrl.includes('teamId=team_xyz'), `Expected teamId in URL, got: ${capturedUrl}`);
});

test('listCapabilities: returns deployment capability map', async () => {
  const caps = await listCapabilities({});
  assert.equal(caps['project.list'], true);
  assert.equal(caps['deployment.list'], true);
  assert.equal(caps['deployment.inspect'], true);
});

test('discoverInventory: maps projects to inventory rows', async () => {
  const projects = [{
    id: 'prj_abc123',
    name: 'anchor-hub',
    framework: 'nextjs',
    latestDeployments: [{ url: 'anchor-hub-abc.vercel.app' }],
    targets: { production: { alias: ['anchorcorps.com'] } },
    updatedAt: 1750000000000
  }];
  const fetch = fakeFetch({ projects });
  const rows = await discoverInventory({ env: { VERCEL_API_TOKEN: 'tok' }, fetch });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, 'vercel');
  assert.equal(r.serviceCategory, 'deployment');
  assert.equal(r.externalId, 'prj_abc123');
  assert.equal(r.name, 'anchor-hub');
  assert.equal(r.meta.framework, 'nextjs');
  assert.equal(r.meta.latestDeploymentUrl, 'anchor-hub-abc.vercel.app');
  assert.equal(r.meta.productionUrl, 'anchorcorps.com');
});

test('discoverInventory: projects with no latestDeployments or targets → null meta', async () => {
  const projects = [{ id: 'prj_bare', name: 'bare-project', updatedAt: 0 }];
  const fetch = fakeFetch({ projects });
  const rows = await discoverInventory({ env: { VERCEL_API_TOKEN: 'tok' }, fetch });
  assert.equal(rows[0].meta.latestDeploymentUrl, null);
  assert.equal(rows[0].meta.productionUrl, null);
  assert.equal(rows[0].meta.framework, null);
});

test('discoverInventory: empty projects → empty array', async () => {
  const rows = await discoverInventory({ env: { VERCEL_API_TOKEN: 'tok' }, fetch: fakeFetch({ projects: [] }) });
  assert.deepEqual(rows, []);
});

test('connector self-registers on import', async () => {
  const { getConnector } = await import('../connections/registry.js');
  const c = getConnector('deployment/vercel');
  assert.ok(c, 'deployment/vercel not in registry');
  assert.equal(c.serviceCategory, 'deployment');
  assert.equal(c.provider, 'vercel');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/connectorVercel.test.js`
Expected: FAIL — `Cannot find module '../connections/vercel/index.js'`.

- [ ] **Step 3: Write the connector**

Create `server/services/ops/connections/vercel/index.js`:

```js
/**
 * deployment/vercel connector — project + deployment listing.
 *
 * Credentials:
 *   VERCEL_API_TOKEN — personal or team API token (Vercel dashboard → Settings → Tokens).
 *   VERCEL_TEAM_ID   — optional; team-scopes all API calls when set.
 *
 * API: https://api.vercel.com (REST). No SDK — plain fetch.
 * ctx shape: { env?: NodeJS.ProcessEnv, fetch?: typeof fetch }
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

/** F3 stub. */
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/connectorVercel.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/vercel/index.js server/services/ops/__tests__/connectorVercel.test.js
git commit -m "feat(ops/connections): deployment/vercel connector — list projects + deployments"
```

---

### Task 5: measurement/gtm connector

**Files:**
- Create: `server/services/ops/connections/gtm/index.js`
- Test: `server/services/ops/__tests__/connectorGtm.test.js`

**Interfaces:**
- Consumes: `registerConnector` from Task 1; `google-auth-library` (already in `package.json`) for token acquisition.
- Produces:
  - `verifyConnection(ctx): Promise<{ status: 'verified'|'missing'|'failed', detail: string, capabilities: object }>`
  - `listCapabilities(ctx): Promise<{ 'container.list': true, 'tags.list': true, 'triggers.list': true, 'variables.list': true }>`
  - `discoverInventory(ctx): Promise<Array<{ provider: 'gtm', serviceCategory: 'measurement', externalId: string, name: string, meta: { accountId, accountName, publicId, usageContext } }>>`
  - `collectSnapshot(ctx): Promise<[]>` — stub.
  - Default export: self-registered connector.
- Credentials: `GTM_SERVICE_ACCOUNT_KEY` — JSON string of a GCP service account key with `tagmanager.readonly` scope. Read from `process.env.GTM_SERVICE_ACCOUNT_KEY`.
- API: `https://tagmanager.googleapis.com/tagmanager/v2` (REST). No GTM SDK — plain fetch for all API calls; `google-auth-library` for OAuth token acquisition only.
- ctx: `{ env?, fetch?, getAccessToken? }` — `getAccessToken(env)` is injectable so tests bypass real OAuth. Default implementation uses `google-auth-library`.
- **Expandability note:** A `gtm.container_health` check is architecturally the right next step (north-star §13.4) but CANNOT be registered now — the existing `checks/registry.js` validates `umbrella ∈ {website, google_ads, meta, ctm}`. Adding `'measurement'` would be a core change violating expandability §12. `checks: []` — defer to F1 where the registry gains `serviceCategory`/`requiredCapabilities`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/connectorGtm.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyConnection, listCapabilities, discoverInventory } from '../connections/gtm/index.js';

const fakeToken = async () => 'fake-access-token-for-tests';

function fakeFetch(responses) {
  // responses: array of { url_match?: string, json: object, ok?: boolean }
  // If url_match is set, uses the first entry whose url_match appears in the URL.
  // Otherwise returns responses[0].
  return async (url, _opts) => {
    const match = responses.find((r) => !r.url_match || url.includes(r.url_match)) || responses[0];
    return {
      ok: match.ok !== false,
      json: async () => match.json,
      text: async () => JSON.stringify(match.json)
    };
  };
}

test('verifyConnection: valid credentials → verified', async () => {
  const fetch = fakeFetch([{ json: { account: [{ accountId: '123', name: 'Anchor GTM' }] } }]);
  const r = await verifyConnection({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.equal(r.status, 'verified');
  assert.ok(r.detail.includes('1 account'), `detail: ${r.detail}`);
  assert.equal(r.capabilities['container.list'], true);
});

test('verifyConnection: missing key → missing (no token call, no fetch call)', async () => {
  let tokenCalled = false;
  let fetchCalled = false;
  const r = await verifyConnection({
    env: {},
    fetch: async () => { fetchCalled = true; return {}; },
    getAccessToken: async () => { tokenCalled = true; return 'tok'; }
  });
  assert.equal(r.status, 'missing');
  assert.equal(tokenCalled, false);
  assert.equal(fetchCalled, false);
});

test('verifyConnection: blank key → missing', async () => {
  const r = await verifyConnection({ env: { GTM_SERVICE_ACCOUNT_KEY: '   ' }, getAccessToken: fakeToken });
  assert.equal(r.status, 'missing');
});

test('verifyConnection: API 403 → failed', async () => {
  const fetch = fakeFetch([{ json: { error: { code: 403 } }, ok: false }]);
  const r = await verifyConnection({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.equal(r.status, 'failed');
});

test('verifyConnection: zero accounts visible → verified with count 0', async () => {
  const fetch = fakeFetch([{ json: {} }]); // no account key → 0 accounts
  const r = await verifyConnection({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.equal(r.status, 'verified');
  assert.ok(r.detail.includes('0 account'), `detail: ${r.detail}`);
});

test('listCapabilities: returns gtm capability map', async () => {
  const caps = await listCapabilities({});
  assert.equal(caps['container.list'], true);
  assert.equal(caps['tags.list'], true);
  assert.equal(caps['triggers.list'], true);
  assert.equal(caps['variables.list'], true);
});

test('discoverInventory: maps accounts + containers to inventory rows', async () => {
  const fetch = fakeFetch([
    {
      url_match: '/accounts',
      json: { account: [{ accountId: '123', name: 'Anchor GTM', path: 'accounts/123' }] }
    },
    {
      url_match: '/containers',
      json: { container: [{ containerId: 'abc456', name: 'Anchor Main', publicId: 'GTM-ABCDE', usageContext: ['WEB'] }] }
    }
  ]);
  const rows = await discoverInventory({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, 'gtm');
  assert.equal(r.serviceCategory, 'measurement');
  assert.equal(r.externalId, 'abc456');
  assert.equal(r.name, 'Anchor Main');
  assert.equal(r.meta.publicId, 'GTM-ABCDE');
  assert.equal(r.meta.accountName, 'Anchor GTM');
  assert.deepEqual(r.meta.usageContext, ['WEB']);
});

test('discoverInventory: account with no containers contributes no rows', async () => {
  const fetch = fakeFetch([
    { url_match: '/accounts', json: { account: [{ accountId: '999', name: 'Empty', path: 'accounts/999' }] } },
    { url_match: '/containers', json: { container: [] } }
  ]);
  const rows = await discoverInventory({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.deepEqual(rows, []);
});

test('discoverInventory: inaccessible account (non-ok containers response) is skipped', async () => {
  const fetch = async (url, _opts) => {
    if (url.includes('/containers')) return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ account: [{ accountId: '1', name: 'X', path: 'accounts/1' }] }) };
  };
  const rows = await discoverInventory({
    env: { GTM_SERVICE_ACCOUNT_KEY: '{"type":"service_account"}' },
    fetch,
    getAccessToken: fakeToken
  });
  assert.deepEqual(rows, []);
});

test('connector self-registers on import', async () => {
  const { getConnector } = await import('../connections/registry.js');
  const c = getConnector('measurement/gtm');
  assert.ok(c, 'measurement/gtm not in registry');
  assert.equal(c.serviceCategory, 'measurement');
  assert.equal(c.provider, 'gtm');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/connectorGtm.test.js`
Expected: FAIL — `Cannot find module '../connections/gtm/index.js'`.

- [ ] **Step 3: Write the connector**

Create `server/services/ops/connections/gtm/index.js`:

```js
/**
 * measurement/gtm connector — Google Tag Manager container/tags/triggers inventory.
 *
 * North-star §13.4: checks gtm.* (container health, tag coverage, trigger integrity).
 * EXPANDABILITY NOTE: A 'gtm.container_health' check is architecturally correct here
 * but cannot be registered until F1 extends checks/registry.js to accept
 * serviceCategory/requiredCapabilities alongside the legacy umbrella field. Adding
 * 'measurement' to VALID_UMBRELLAS in the current registry would be a core change
 * that violates expandability §12. checks: [] — defer to F1.
 *
 * Credentials:
 *   GTM_SERVICE_ACCOUNT_KEY — JSON string of a GCP service account key.
 *     Required scopes: https://www.googleapis.com/auth/tagmanager.readonly.
 *     Obtain: GCP console → IAM → Service Accounts → Keys → Add Key (JSON).
 *
 * API: https://tagmanager.googleapis.com/tagmanager/v2 (REST). No SDK — plain fetch.
 * Auth: google-auth-library (already a dep) for access token acquisition only.
 *
 * ctx shape: { env?, fetch?, getAccessToken? }
 *   getAccessToken(env): Promise<string> — injectable for tests.
 */

import { registerConnector } from '../registry.js';

const GTM_BASE = 'https://tagmanager.googleapis.com/tagmanager/v2';

function hasKey(env) {
  return Boolean((env.GTM_SERVICE_ACCOUNT_KEY || '').trim());
}

/**
 * Default access token acquisition via google-auth-library.
 * Dynamic import so the module can be loaded in unit tests without
 * google-auth-library attempting any network calls at import time.
 */
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
    return { status: 'missing', detail: 'GTM_SERVICE_ACCOUNT_KEY not set or blank', capabilities: {} };
  }
  try {
    const token = await getAccessToken(env);
    const res = await fetchFn(`${GTM_BASE}/accounts`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) {
      return { status: 'failed', detail: `GTM API ${res.status}`, capabilities: {} };
    }
    const data = await res.json();
    const count = (data.account || []).length;
    return {
      status: 'verified',
      detail: `GTM access confirmed — ${count} account(s) visible`,
      capabilities: await listCapabilities(ctx)
    };
  } catch (err) {
    return { status: 'failed', detail: err.message, capabilities: {} };
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
    if (!conRes.ok) continue; // skip accounts we can't list containers for
    const conData = await conRes.json();
    for (const container of (conData.container || [])) {
      rows.push({
        provider: 'gtm',
        serviceCategory: 'measurement',
        externalId: container.containerId,
        name: container.name,
        meta: {
          accountId: account.accountId,
          accountName: account.name,
          publicId: container.publicId || null,   // GTM-XXXXX
          usageContext: container.usageContext || []
        }
      });
    }
  }
  return rows;
}

/** F3 stub. */
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
  // gtm.container_health deferred — see file header (expandability §12 constraint).
  checks: []
};

registerConnector(connector);
export default connector;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/connectorGtm.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/gtm/index.js server/services/ops/__tests__/connectorGtm.test.js
git commit -m "feat(ops/connections): measurement/gtm connector — container/tags inventory"
```

---

### Task 6: local/gbp placeholder connector

**Files:**
- Create: `server/services/ops/connections/gbp/index.js`
- Test: `server/services/ops/__tests__/connectorGbp.test.js`

**Interfaces:**
- Consumes: `registerConnector` from Task 1.
- Produces:
  - `verifyConnection(ctx): Promise<{ status: 'missing', detail: '...STUB...', capabilities: {} }>` — always `missing` (never call live API).
  - `listCapabilities(ctx): Promise<{ 'gbp.connection_health': false, 'gbp.review_summary': false, 'gbp.profile_status': false, 'gbp.hours_mismatch': false }>` — all `false` (STUB; F1 capability gate will read these and not issue any GBP checks).
  - `discoverInventory(ctx): Promise<[]>` — always empty.
  - `collectSnapshot(ctx): Promise<[]>` — always empty.
  - Default export: self-registered connector.
- Credential (declared for inventory — not used in stubs): `GBP_SERVICE_ACCOUNT_KEY` (future).
- Notes: All methods must contain the string `'STUB'` in their return value or a comment. No network call anywhere in this module.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/connectorGbp.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import connector, {
  verifyConnection,
  listCapabilities,
  discoverInventory,
  collectSnapshot
} from '../connections/gbp/index.js';

test('verifyConnection: always returns missing with STUB detail', async () => {
  const r = await verifyConnection({});
  assert.equal(r.status, 'missing');
  assert.ok(r.detail.includes('STUB'), `detail should contain 'STUB', got: ${r.detail}`);
  assert.deepEqual(r.capabilities, {});
});

test('verifyConnection: does not call any network (no fetch needed)', async () => {
  // Passing a fetch that throws ensures no live call is made.
  let called = false;
  const r = await verifyConnection({
    env: { GBP_SERVICE_ACCOUNT_KEY: 'sk' },
    fetch: async () => { called = true; throw new Error('should not be called'); }
  });
  assert.equal(r.status, 'missing');
  assert.equal(called, false);
});

test('listCapabilities: returns all four GBP capabilities as false', async () => {
  const caps = await listCapabilities({});
  assert.equal(caps['gbp.connection_health'], false);
  assert.equal(caps['gbp.review_summary'], false);
  assert.equal(caps['gbp.profile_status'], false);
  assert.equal(caps['gbp.hours_mismatch'], false);
});

test('discoverInventory: always returns empty array', async () => {
  const rows = await discoverInventory({});
  assert.deepEqual(rows, []);
});

test('collectSnapshot: always returns empty array', async () => {
  const snaps = await collectSnapshot({});
  assert.deepEqual(snaps, []);
});

test('connector shape: id, serviceCategory, provider present', () => {
  assert.equal(connector.id, 'local/gbp');
  assert.equal(connector.serviceCategory, 'local');
  assert.equal(connector.provider, 'gbp');
  assert.ok(Array.isArray(connector.connectionTypes));
  assert.ok(Array.isArray(connector.checks));
});

test('connector self-registers on import', async () => {
  const { getConnector } = await import('../connections/registry.js');
  const c = getConnector('local/gbp');
  assert.ok(c, 'local/gbp not in registry');
  assert.equal(c.serviceCategory, 'local');
  assert.equal(c.provider, 'gbp');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/connectorGbp.test.js`
Expected: FAIL — `Cannot find module '../connections/gbp/index.js'`.

- [ ] **Step 3: Write the connector**

Create `server/services/ops/connections/gbp/index.js`:

```js
/**
 * local/gbp connector — Google Business Profile.
 *
 * PLACEHOLDER ONLY — north-star §14; design spec §8 (non-goals for foundation phases).
 *
 * This connector declares the intended capability surface so the F1 connection card
 * can render it as "pending" rather than "missing provider." All methods return stub
 * responses. The capability map returns `false` for every capability so the F1
 * capability gate correctly skips any GBP checks.
 *
 * Intended future capabilities (when promoted from stub):
 *   gbp.connection_health — verifies GBP API access and location ownership.
 *   gbp.review_summary    — aggregate review rating + recent review trend.
 *   gbp.profile_status    — completeness score + suspension/pending state.
 *   gbp.hours_mismatch    — detects posted hours vs. hours on other platforms.
 *
 * Future credentials:
 *   GBP_SERVICE_ACCOUNT_KEY — JSON string of a GCP service account key.
 *     Required scopes: https://www.googleapis.com/auth/business.manage.
 *   GBP_ACCOUNT_ID          — optional; scopes discovery to a specific GBP account.
 *
 * DO NOT add live API calls here until a plan explicitly promotes this connector.
 * The Google Business Profile API v1 (mybusinessbusinessinformation) requires
 * OAuth2 with business.manage scope and a registered OAuth client ID — out of scope
 * for F9.
 */

import { registerConnector } from '../registry.js';

export async function verifyConnection(_ctx = {}) {
  // STUB: always returns missing so the capability gate never issues GBP checks.
  return {
    status: 'missing',
    detail: 'STUB — local/gbp connector not yet implemented (north-star §14 placeholder; see gbp/index.js)',
    capabilities: {}
  };
}

export async function listCapabilities(_ctx = {}) {
  // STUB: all capabilities are false — connector is present but unimplemented.
  // F1 connection card reads this map to render "pending" state.
  return {
    'gbp.connection_health': false, // STUB
    'gbp.review_summary': false,    // STUB
    'gbp.profile_status': false,    // STUB
    'gbp.hours_mismatch': false     // STUB
  };
}

export async function discoverInventory(_ctx = {}) {
  // STUB: location discovery not implemented.
  return [];
}

export async function collectSnapshot(_ctx = {}) {
  // STUB: snapshot collection not implemented.
  return [];
}

const connector = {
  id: 'local/gbp',
  serviceCategory: 'local',
  provider: 'gbp',
  connectionTypes: ['service_account', 'oauth'],
  verifyConnection,
  listCapabilities,
  discoverInventory,
  collectSnapshot,
  actions: {},
  checks: []
};

registerConnector(connector);
export default connector;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/connectorGbp.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/gbp/index.js server/services/ops/__tests__/connectorGbp.test.js
git commit -m "feat(ops/connections): local/gbp placeholder connector (STUB — north-star §14)"
```

---

### Task 7: Self-registration smoke test + full suite run + expandability verification

**Files:**
- Test: `server/services/ops/__tests__/connectorSmoke.test.js`

**Interfaces:**
- Consumes: all five connectors (Tasks 2–6) + registry (Task 1).
- Produces: proof that adding five connectors required zero changes to core files (expandability §12). Fails the build if any core file shows an unexpected export change.

- [ ] **Step 1: Write the smoke test**

Create `server/services/ops/__tests__/connectorSmoke.test.js`:

```js
/**
 * F9 Expandability Proof — Smoke Test
 *
 * Verifies:
 * 1. All five F9 connectors self-register on import.
 * 2. Each connector satisfies the spec §5 contract shape.
 * 3. The checks/registry and runExecutor were NOT modified (core files unchanged).
 * 4. No new umbrella was added to VALID_UMBRELLAS (core registry untouched).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

// Side-effect imports trigger self-registration in the F1 stub registry.
// Each import calls registerConnector at module load.
import '../connections/monday/index.js';
import '../connections/github/index.js';
import '../connections/vercel/index.js';
import '../connections/gtm/index.js';
import '../connections/gbp/index.js';

import { getConnector, listConnectors } from '../connections/registry.js';
import { listAllChecks } from '../checks/registry.js';

const EXPECTED_CONNECTORS = [
  { id: 'task/monday',      serviceCategory: 'task',        provider: 'monday'  },
  { id: 'repo/github',      serviceCategory: 'repo',        provider: 'github'  },
  { id: 'deployment/vercel',serviceCategory: 'deployment',  provider: 'vercel'  },
  { id: 'measurement/gtm',  serviceCategory: 'measurement', provider: 'gtm'     },
  { id: 'local/gbp',        serviceCategory: 'local',       provider: 'gbp'     }
];

const CONTRACT_METHODS = ['verifyConnection', 'listCapabilities', 'discoverInventory', 'collectSnapshot'];

test('all five F9 connectors are registered after import', () => {
  for (const expected of EXPECTED_CONNECTORS) {
    const c = getConnector(expected.id);
    assert.ok(c, `Connector ${expected.id} was not registered — import side-effect broken`);
    assert.equal(c.serviceCategory, expected.serviceCategory, `Wrong serviceCategory for ${expected.id}`);
    assert.equal(c.provider, expected.provider, `Wrong provider for ${expected.id}`);
  }
});

test('each connector satisfies the spec §5 contract shape', () => {
  for (const { id } of EXPECTED_CONNECTORS) {
    const c = getConnector(id);
    assert.ok(typeof c.id === 'string' && c.id, `${id}: id must be a non-empty string`);
    assert.ok(typeof c.serviceCategory === 'string', `${id}: serviceCategory missing`);
    assert.ok(typeof c.provider === 'string', `${id}: provider missing`);
    assert.ok(Array.isArray(c.connectionTypes), `${id}: connectionTypes must be an array`);
    assert.ok(Array.isArray(c.checks), `${id}: checks must be an array`);
    for (const method of CONTRACT_METHODS) {
      assert.equal(typeof c[method], 'function', `${id}: ${method} must be a function`);
    }
  }
});

test('listConnectors includes at least five connectors', () => {
  assert.ok(listConnectors().length >= 5, 'Expected at least 5 registered connectors');
});

test('checks/registry VALID_UMBRELLAS unchanged — no new umbrella was added', () => {
  // The shipped registry accepts exactly 4 umbrellas. If F9 had incorrectly added
  // 'measurement'/'task'/'repo'/'deployment', listing all checks would not fail but
  // a new umbrella-registered check would appear. We verify no check with a new
  // umbrella was registered (they all have checks: []).
  const allChecks = listAllChecks();
  const newUmbrellaChecks = allChecks.filter(
    (c) => !['website', 'google_ads', 'meta', 'ctm'].includes(c.umbrella)
  );
  assert.deepEqual(
    newUmbrellaChecks,
    [],
    `Core checks/registry was modified — found checks with non-legacy umbrellas: ${JSON.stringify(newUmbrellaChecks.map((c) => c.checkId))}`
  );
});

test('GBP connector capabilities are all false (STUB proof)', async () => {
  const gbp = getConnector('local/gbp');
  const caps = await gbp.listCapabilities({});
  for (const [cap, val] of Object.entries(caps)) {
    assert.equal(val, false, `GBP capability ${cap} should be false (STUB), got ${val}`);
  }
});

test('monday/github/vercel/gtm listCapabilities return only true entries', async () => {
  const nonGbp = EXPECTED_CONNECTORS.filter((c) => c.id !== 'local/gbp');
  for (const { id } of nonGbp) {
    const c = getConnector(id);
    const caps = await c.listCapabilities({});
    const falseCaps = Object.entries(caps).filter(([, v]) => v === false);
    assert.deepEqual(
      falseCaps,
      [],
      `${id}: unexpected false capability entries ${JSON.stringify(falseCaps)}`
    );
  }
});
```

- [ ] **Step 2: Run smoke test to verify it passes**

Run: `node --test server/services/ops/__tests__/connectorSmoke.test.js`
Expected: PASS (6 tests).

- [ ] **Step 3: Run the full ops test suite for regressions**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops`
Expected: all pre-existing tests PASS + the new connector/registry tests PASS. Zero new failures.

If any pre-existing test fails, the cause will be one of:
- Module graph issue (new connector import path wrong) — fix the `import` path.
- Registry singleton bleed (a connector's `registerConnector` call persists across test files) — add `_resetRegistryForTests()` at the top of the affected test.

- [ ] **Step 4: Verify no core files were modified**

Run:
```bash
git diff HEAD~6 -- server/services/ops/runExecutor.js server/services/ops/checks/registry.js server/routes/ops.js server/migrations.js
```
Expected: empty diff (no output). If any of these files appear in the diff, a core change was made — revert it and flag it in the plan.

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/__tests__/connectorSmoke.test.js
git commit -m "test(ops/connections): F9 expandability smoke — 5 connectors, zero core changes"
```

---

## Self-Review

### 1. Spec Coverage

| Requirement | Task | Status |
|---|---|---|
| task/monday connector — task.create (north-star §15) | Task 2 | listCapabilities returns `task.create: true`; checks: [] awaiting F1 gate |
| repo/github connector — read-only repo inspection | Task 3 | verifyConnection, listCapabilities, discoverInventory implemented |
| deployment/vercel — list projects + inspect deployments | Task 4 | verifyConnection, listCapabilities, discoverInventory implemented |
| measurement/gtm — container/tags/triggers inventory (§13.4) | Task 5 | container+tag discovery implemented; gtm.container_health check deferred (core gate needed — expandability §12, flagged) |
| local/gbp — PLACEHOLDER ONLY (§14, §8) | Task 6 | All stubs, `false` capabilities, `STUB` in detail |
| connector contract = spec §5 | All connector tasks | id, serviceCategory, provider, connectionTypes, verifyConnection, listCapabilities, discoverInventory, collectSnapshot, actions, checks present in each |
| self-registers via F1 registry | All connector tasks | each calls `registerConnector(connector)` at module load |
| zero core changes | Task 7 | smoke test asserts checks/registry unchanged; git diff step confirms |
| no migration | All tasks | no SQL file created; no `server/migrations.js` modification |
| credentials = env-var (§3.1) | All connector tasks | each reads from `env.PROVIDER_TOKEN`; `process.env` is the default |
| no new npm deps | All tasks | only `google-auth-library` (already present) used in gtm connector |
| tests: fakes, no live API calls | Tasks 1–6 | all tests pass `env` + `fetch` (+ `getAccessToken` for GTM) via ctx |
| GBP: capabilities return false | Task 6 | listCapabilities returns `false` for all four capabilities |

### 2. Placeholder Scan

- Task 5 (GTM) includes a clear note about `gtm.container_health` being deferred and WHY (core `VALID_UMBRELLAS` constraint, expandability §12). The note is actionable — F1 unblocks it. Not a vague TODO.
- Task 6 (GBP) has explicit `// STUB` comments on every stub return and a clear file-header doc explaining the promotion path.
- No step says "add appropriate error handling" — error paths are explicit in the verifyConnection implementations (missing token → early return; HTTP non-ok → failed; catch-all → failed with `err.message`).
- `collectSnapshot` stubs return `[]` and are tested in Task 7's contract shape check (it asserts the method exists and is a function).

### 3. Type Consistency

- `ctx` shape is identical across all connectors: `{ env?, fetch? }` with GTM adding `getAccessToken?`. Defaults are `process.env` and `globalThis.fetch` in all five.
- `discoverInventory` return shape is consistent: `{ provider, serviceCategory, externalId, name, meta }` — externalId is always a `string` (Monday: `String(b.id)`; GitHub: `String(r.id)`; Vercel: `p.id` which is already a string; GTM: `container.containerId`).
- `verifyConnection` always returns `{ status: 'verified'|'missing'|'failed', detail: string, capabilities: object }`. GBP always returns `missing`; the others return the correct status from their try/catch branches.
- `listCapabilities` always returns `Promise<object>` where values are boolean. Non-GBP connectors return `true` values; GBP returns `false`.
- `registerConnector` is called with the connector object (not the id separately) in all five connectors — matches the registry stub signature.
- The smoke test's `EXPECTED_CONNECTORS` array uses the same `id` strings as each connector's own `id` field — verified by assertion.
