# F1 — Connection / Capability / Asset Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Insert the connection/capability/asset foundation underneath the shipped check spine — `ops_service_connections` + `ops_platform_inventory` + `ops_client_assets`, a connector registry implementing the locked §5 contract, an `umbrella → (service_category, provider)` back-compat shim in the check registry, and a capability gate in the run executor that skips (never errors) checks whose required capabilities aren't satisfied.

**Architecture:** New tables are added via the existing idempotent ops migration runner. A new `server/services/ops/connections/` package holds the connector contract + registry, a `connectionStore` that owns the status lifecycle over `ops_service_connections`, a pure `capabilityMatrix`, and a `credentialResolver` that bridges connections to the existing `client_platform_credentials` store. The shipped `checks/registry.js` is reframed to accept `serviceCategory`/`provider`/`requiredCapabilities` while still accepting the legacy `umbrella` field (deriving category+provider from it), so every existing umbrella check registers byte-for-byte unchanged. `runExecutor.js` loads the client's connections once and consults a pure gate before dispatching each check.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, `pg` via `server/db.js` (`query`), existing `services/security/encryption.js` for at-rest secrets. No new npm dependencies.

## Global Constraints

- **No new npm dependencies.** Use only what `package.json` already declares.
- **Credentials are env-var / Postgres, NOT Secret Manager** (spec §3.1). `ops_service_connections.credential_ref` references `client_platform_credentials(id)`; agency-level sources resolve from `process.env` at read time. `@google-cloud/secret-manager` is not a dependency.
- **`umbrella → service_category + provider` via a back-compat shim; NEVER break existing umbrella checks** (spec §4). Existing umbrella checks must register UNCHANGED — back-compat is a hard requirement, proven by test.
- **Connector contract = spec §5 locked interface:** `{ id, serviceCategory, provider, connectionTypes[], async verifyConnection(ctx), async discoverInventory(ctx), async collectSnapshot(ctx), async listCapabilities(ctx), actions?, checks? }`. The five-layer law (Connection → Inventory → Snapshot → Checks → Actions) is enforced by contract order; no connector jumps from connection straight to AI recommendations.
- **No LLM math; no direct LLM mutation; PHI sanitized (`payloadSanitizer.js`); HIPAA gate preserved** (`client_type='medical'`). F1 adds no LLM calls and no provider mutations.
- **New migration → create `server/sql/migrate_ops_<name>.sql` AND append its filename to the array in `server/migrations.js`** (`MIGRATIONS_BEFORE_SEED`, after `'migrate_ops_blog_ssh.sql'`).
- **DB tests use `DATABASE_URL=postgresql://bif@localhost:5432/anchor`**; suite `yarn test:ops`; tests live in `server/services/ops/__tests__/*.test.js` using `node:test` + `node:assert/strict`; prefer pure, dependency-injected logic so most tests need no DB/network.
- **Status lifecycle (locked, spec §6):** `missing → configured → verified → degraded → failed → disabled`. `ops_service_connections` owns this lifecycle.
- **Capability vocabulary (locked, spec §4):** `read, crawl, inspect_html, list_pages, create_draft, publish, clear_cache, create_backup, run_wp_cli, mutate, ...` (open set — stored as free-text strings, not enum-constrained).

---

## Scope

**In scope (this plan — F1):**
- Three migrations + registration: `ops_service_connections`, `ops_platform_inventory`, `ops_client_assets`.
- `server/services/ops/connections/`: `types/contract.js`, `registry.js`, `connectionStore.js`, `capabilityMatrix.js`, `credentialResolver.js`, `umbrellaMap.js`.
- Reframe `checks/registry.js` to accept `serviceCategory`/`provider`/`requiredCapabilities` + the `umbrella` back-compat shim.
- Capability gate in `runExecutor.js`.

**Deferred to later phases (declared, not gaps):**
- `discoverInventory`/`collectSnapshot` *implementations* per provider → F2/F3 (F1 ships the contract + empty registry only).
- `ops_daily_snapshots`, `ops_metric_baselines`, `ops_agent_memory`, recommendation/notification/chat tables → F3+.
- Concrete connector modules (kinsta, wordpress, google_ads, …) → F2+. F1 ships zero registered connectors; it ships the registry they will populate.
- UI for connections/assets → later phase.

## File Structure

| File | Responsibility |
|---|---|
| `server/sql/migrate_ops_service_connections.sql` | Create `ops_service_connections` (idempotent). |
| `server/sql/migrate_ops_platform_inventory.sql` | Create `ops_platform_inventory` (idempotent). |
| `server/sql/migrate_ops_client_assets.sql` | Create `ops_client_assets` (idempotent). |
| `server/migrations.js` | Register the three migrations (append to `MIGRATIONS_BEFORE_SEED`). |
| `server/services/ops/connections/umbrellaMap.js` | Pure `umbrella ↔ (service_category, provider)` derivation (spec §4). |
| `server/services/ops/connections/types/contract.js` | Connector contract constants + `validateConnector`. |
| `server/services/ops/connections/registry.js` | `registerConnector` / `getConnector` / lookups (uses `validateConnector`). |
| `server/services/ops/connections/connectionStore.js` | CRUD + status-lifecycle over `ops_service_connections`. |
| `server/services/ops/connections/capabilityMatrix.js` | Pure capability availability + gate evaluation. |
| `server/services/ops/connections/credentialResolver.js` | Bridge a connection to its credential (env / stored / agency). |
| `server/services/ops/checks/registry.js` | Reframe: accept `serviceCategory`/`provider`/`requiredCapabilities` + `umbrella` shim. |
| `server/services/ops/runExecutor.js` | Load client connections; capability-gate each check (skip with reason). |
| `server/services/ops/__tests__/connectionsMigration.test.js` | DB: the three tables exist after migrate. |
| `server/services/ops/__tests__/connectionStore.test.js` | DB: connection CRUD + lifecycle round-trip; pure transition logic. |
| `server/services/ops/__tests__/connectionsContractRegistry.test.js` | Pure: contract validation + connector registry. |
| `server/services/ops/__tests__/capabilityMatrix.test.js` | Pure: availability + gate. |
| `server/services/ops/__tests__/credentialResolver.test.js` | Pure + DI: credential classification/resolution. |
| `server/services/ops/__tests__/checksRegistryBackCompat.test.js` | Pure: umbrella back-compat + new contract registration. |
| `server/services/ops/__tests__/runExecutorCapabilityGate.test.js` | Pure gate + executor module smoke. |

---

### Task 1: Migrations — connections, inventory, assets

**Files:**
- Create: `server/sql/migrate_ops_service_connections.sql`
- Create: `server/sql/migrate_ops_platform_inventory.sql`
- Create: `server/sql/migrate_ops_client_assets.sql`
- Modify: `server/migrations.js` (append three filenames to `MIGRATIONS_BEFORE_SEED`)
- Test: `server/services/ops/__tests__/connectionsMigration.test.js`

**Interfaces:**
- Produces (DB tables consumed by later tasks):
  - `ops_service_connections(id, client_user_id, service_category, provider, connection_type, credential_ref, status, capabilities_json, detail, metadata, last_verified_at, created_at, updated_at)`, `UNIQUE (client_user_id, service_category, provider)`.
  - `ops_platform_inventory(id, client_user_id, connection_id, service_category, provider, object_type, external_id, name, attributes_json, discovered_at, last_seen_at)`, `UNIQUE (connection_id, object_type, external_id)`.
  - `ops_client_assets(id, client_user_id, asset_type, provider, url, label, connection_id, status, attributes_json, created_at, updated_at)`, `UNIQUE (client_user_id, asset_type, url)`.

- [ ] **Step 1: Write the `ops_service_connections` migration**

Create `server/sql/migrate_ops_service_connections.sql`:

```sql
-- F1 — ops_service_connections (north-star §2.1, spec §6).
-- Formalizes client_platform_credentials linkage and OWNS the status lifecycle:
--   missing → configured → verified → degraded → failed → disabled
-- Idempotent. Re-running must be safe.
CREATE TABLE IF NOT EXISTS ops_service_connections (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id   uuid NOT NULL,
  service_category text NOT NULL,
  provider         text NOT NULL,
  connection_type  text,
  credential_ref   uuid REFERENCES client_platform_credentials(id) ON DELETE SET NULL,
  status           text NOT NULL DEFAULT 'missing'
                     CHECK (status IN ('missing','configured','verified','degraded','failed','disabled')),
  capabilities_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  detail           text,
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_verified_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_user_id, service_category, provider)
);

CREATE INDEX IF NOT EXISTS idx_ops_service_connections_client
  ON ops_service_connections (client_user_id);
CREATE INDEX IF NOT EXISTS idx_ops_service_connections_cat_prov
  ON ops_service_connections (service_category, provider);
```

- [ ] **Step 2: Write the `ops_platform_inventory` migration**

Create `server/sql/migrate_ops_platform_inventory.sql`:

```sql
-- F1 — ops_platform_inventory (north-star §2.3, spec §6).
-- External objects discovered for a connection (pages, campaigns, properties…).
-- Populated by connector discoverInventory() in F2; F1 ships the table only.
-- Idempotent.
CREATE TABLE IF NOT EXISTS ops_platform_inventory (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id   uuid NOT NULL,
  connection_id    uuid REFERENCES ops_service_connections(id) ON DELETE CASCADE,
  service_category text NOT NULL,
  provider         text NOT NULL,
  object_type      text NOT NULL,
  external_id      text NOT NULL,
  name             text,
  attributes_json  jsonb NOT NULL DEFAULT '{}'::jsonb,
  discovered_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, object_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_platform_inventory_client
  ON ops_platform_inventory (client_user_id, service_category);
CREATE INDEX IF NOT EXISTS idx_ops_platform_inventory_connection
  ON ops_platform_inventory (connection_id);
```

- [ ] **Step 3: Write the `ops_client_assets` migration**

Create `server/sql/migrate_ops_client_assets.sql`:

```sql
-- F1 — ops_client_assets (expandability §6).
-- A client's web presence modeled as discrete assets (a site is NOT one WP
-- install): website, landing_page, blog, repo, deployment, … Each MAY link to
-- the connection that manages it. Idempotent.
CREATE TABLE IF NOT EXISTS ops_client_assets (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id  uuid NOT NULL,
  asset_type      text NOT NULL,
  provider        text,
  url             text,
  label           text,
  connection_id   uuid REFERENCES ops_service_connections(id) ON DELETE SET NULL,
  status          text NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','archived')),
  attributes_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_user_id, asset_type, url)
);

CREATE INDEX IF NOT EXISTS idx_ops_client_assets_client
  ON ops_client_assets (client_user_id);
CREATE INDEX IF NOT EXISTS idx_ops_client_assets_connection
  ON ops_client_assets (connection_id);
```

- [ ] **Step 4: Register the migrations**

In `server/migrations.js`, edit the `MIGRATIONS_BEFORE_SEED` array — replace the final entry line `  'migrate_ops_blog_ssh.sql'` with:

```js
  'migrate_ops_blog_ssh.sql',
  'migrate_ops_service_connections.sql',
  'migrate_ops_platform_inventory.sql',
  'migrate_ops_client_assets.sql'
```

(Order matters: `ops_service_connections` first because the other two FK-reference it; it in turn FK-references `client_platform_credentials`, created earlier by `migrate_ops_foundation.sql`.)

- [ ] **Step 5: Run the migrations locally**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn db:migrate`
Expected: completes without error; the three new files log `[migrations] applied ...`; re-running is a no-op (idempotent `IF NOT EXISTS`).

- [ ] **Step 6: Write the table-presence test**

Create `server/services/ops/__tests__/connectionsMigration.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../db.js';

const TABLES = ['ops_service_connections', 'ops_platform_inventory', 'ops_client_assets'];

test('F1 migration created all three tables', async () => {
  const { rows } = await query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [TABLES]
  );
  const have = new Set(rows.map((r) => r.table_name));
  for (const t of TABLES) assert.ok(have.has(t), `${t} exists`);
});

test('ops_service_connections enforces the locked status vocabulary', async () => {
  const { rows } = await query(
    `SELECT cc.check_clause
       FROM information_schema.check_constraints cc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = cc.constraint_name
      WHERE ccu.table_name = 'ops_service_connections'
        AND ccu.column_name = 'status'`
  );
  const clause = rows.map((r) => r.check_clause).join(' ');
  for (const s of ['missing', 'configured', 'verified', 'degraded', 'failed', 'disabled']) {
    assert.ok(clause.includes(s), `status CHECK includes ${s}`);
  }
});
```

- [ ] **Step 7: Run the test**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/connectionsMigration.test.js`
Expected: PASS (2 tests).

- [ ] **Step 8: Commit**

```bash
git add server/sql/migrate_ops_service_connections.sql server/sql/migrate_ops_platform_inventory.sql server/sql/migrate_ops_client_assets.sql server/migrations.js server/services/ops/__tests__/connectionsMigration.test.js
git commit -m "feat(ops/connections): ops_service_connections + platform_inventory + client_assets tables"
```

---

### Task 2: Umbrella ↔ category/provider map (pure shim core)

**Files:**
- Create: `server/services/ops/connections/umbrellaMap.js`
- Test: folded into Task 6's `checksRegistryBackCompat.test.js` (the map is exercised there); this task adds a focused pure test too.
- Test: `server/services/ops/__tests__/capabilityMatrix.test.js` will NOT cover this — add the focused assertions inline below.

**Interfaces:**
- Produces:
  - `UMBRELLA_TO_CATEGORY_PROVIDER: Record<'website'|'google_ads'|'meta'|'ctm', { serviceCategory, provider }>` — the PRIMARY classification per spec §4.
  - `deriveFromUmbrella(umbrella): { serviceCategory, provider }` — throws on unknown umbrella.
  - `umbrellaFromCategoryProvider(serviceCategory, provider): string|null` — reverse lookup for legacy persistence; `null` when no legacy umbrella matches.
  - `SECONDARY_UMBRELLA_CATEGORIES: Record<string, Array<{ serviceCategory, provider }>>` — documents that `website` spans `hosting/kinsta` + `cms/wordpress` too (for F2 inventory; not used by the gate).

**Decision (stated):** `website` maps to MANY (`website/public_http`, `hosting/kinsta`, `cms/wordpress`). For a single check's PRIMARY classification we pick the simplest public-facing pair `website/public_http`; the others are recorded in `SECONDARY_UMBRELLA_CATEGORIES` for F2 connectors. This is consistent with spec §4 ("`website → {website/public_http, hosting/kinsta, cms/wordpress}`") while keeping each check single-classified.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/umbrellaMap.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveFromUmbrella,
  umbrellaFromCategoryProvider,
  UMBRELLA_TO_CATEGORY_PROVIDER,
  SECONDARY_UMBRELLA_CATEGORIES
} from '../connections/umbrellaMap.js';

test('deriveFromUmbrella maps the four shipped umbrellas (spec §4)', () => {
  assert.deepEqual(deriveFromUmbrella('website'), { serviceCategory: 'website', provider: 'public_http' });
  assert.deepEqual(deriveFromUmbrella('google_ads'), { serviceCategory: 'paid_ads', provider: 'google_ads' });
  assert.deepEqual(deriveFromUmbrella('meta'), { serviceCategory: 'paid_ads', provider: 'meta' });
  assert.deepEqual(deriveFromUmbrella('ctm'), { serviceCategory: 'call_tracking', provider: 'ctm' });
});

test('deriveFromUmbrella throws on an unknown umbrella', () => {
  assert.throws(() => deriveFromUmbrella('tiktok'), /unknown umbrella/i);
});

test('umbrellaFromCategoryProvider reverses the primary map', () => {
  assert.equal(umbrellaFromCategoryProvider('paid_ads', 'google_ads'), 'google_ads');
  assert.equal(umbrellaFromCategoryProvider('call_tracking', 'ctm'), 'ctm');
  assert.equal(umbrellaFromCategoryProvider('website', 'public_http'), 'website');
  assert.equal(umbrellaFromCategoryProvider('analytics', 'ga4'), null);
});

test('website declares secondary categories for F2 (hosting + cms)', () => {
  const sec = SECONDARY_UMBRELLA_CATEGORIES.website;
  assert.deepEqual(sec, [
    { serviceCategory: 'hosting', provider: 'kinsta' },
    { serviceCategory: 'cms', provider: 'wordpress' }
  ]);
  assert.ok(UMBRELLA_TO_CATEGORY_PROVIDER.website);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/umbrellaMap.test.js`
Expected: FAIL — cannot resolve `../connections/umbrellaMap.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/connections/umbrellaMap.js`:

```js
/**
 * Back-compat shim core (spec §4): the shipped registry keys checks by
 * `umbrella`. This maps each legacy umbrella to its PRIMARY (service_category,
 * provider) and back. `website` legitimately spans three categories; the
 * primary public-facing pair is used for single-check classification and the
 * rest are recorded as secondary for F2 connector inventory.
 */
export const UMBRELLA_TO_CATEGORY_PROVIDER = {
  website:    { serviceCategory: 'website', provider: 'public_http' },
  google_ads: { serviceCategory: 'paid_ads', provider: 'google_ads' },
  meta:       { serviceCategory: 'paid_ads', provider: 'meta' },
  ctm:        { serviceCategory: 'call_tracking', provider: 'ctm' }
};

export const SECONDARY_UMBRELLA_CATEGORIES = {
  website: [
    { serviceCategory: 'hosting', provider: 'kinsta' },
    { serviceCategory: 'cms', provider: 'wordpress' }
  ]
};

export function deriveFromUmbrella(umbrella) {
  const hit = UMBRELLA_TO_CATEGORY_PROVIDER[umbrella];
  if (!hit) throw new Error(`umbrellaMap: unknown umbrella "${umbrella}"`);
  return { ...hit };
}

export function umbrellaFromCategoryProvider(serviceCategory, provider) {
  for (const [umbrella, cp] of Object.entries(UMBRELLA_TO_CATEGORY_PROVIDER)) {
    if (cp.serviceCategory === serviceCategory && cp.provider === provider) return umbrella;
  }
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/umbrellaMap.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/umbrellaMap.js server/services/ops/__tests__/umbrellaMap.test.js
git commit -m "feat(ops/connections): umbrella ↔ (service_category, provider) shim map"
```

---

### Task 3: Connector contract + registry (locked §5 interface)

**Files:**
- Create: `server/services/ops/connections/types/contract.js`
- Create: `server/services/ops/connections/registry.js`
- Test: `server/services/ops/__tests__/connectionsContractRegistry.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces (from `types/contract.js`):
  - `CONNECTION_TYPES: string[]` = `['service_account','oauth','api_key','webhook','ssh']`.
  - `validateConnector(connector): { valid: boolean, errors: string[] }` — enforces the locked §5 shape: required string `id`/`serviceCategory`/`provider`; non-empty `connectionTypes` array whose members are in `CONNECTION_TYPES`; `verifyConnection` + `listCapabilities` are functions; if present, `discoverInventory`/`collectSnapshot` are functions; if present, `actions` is an object and `checks` is an array. **Order law:** `verifyConnection` is mandatory and `listCapabilities` is mandatory — a connector cannot ship "actions only".
  - `assertValidConnector(connector): void` — throws `Error` joining `errors` when invalid.
- Produces (from `registry.js`):
  - `registerConnector(connector): void` — validates then stores keyed by `id`.
  - `getConnector(id): connector|null`.
  - `getConnectorByCategoryProvider(serviceCategory, provider): connector|null`.
  - `listConnectors(): connector[]`.
  - `_resetConnectorsForTests(): void`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/connectionsContractRegistry.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateConnector, assertValidConnector, CONNECTION_TYPES } from '../connections/types/contract.js';
import {
  registerConnector, getConnector, getConnectorByCategoryProvider, listConnectors, _resetConnectorsForTests
} from '../connections/registry.js';

const goodConnector = () => ({
  id: 'wordpress',
  serviceCategory: 'cms',
  provider: 'wordpress',
  connectionTypes: ['ssh', 'api_key'],
  async verifyConnection() { return { status: 'verified', detail: '', capabilities: [] }; },
  async discoverInventory() { return []; },
  async collectSnapshot() { return []; },
  async listCapabilities() { return ['read', 'run_wp_cli']; },
  actions: {},
  checks: []
});

test('CONNECTION_TYPES are the locked set', () => {
  assert.deepEqual(CONNECTION_TYPES, ['service_account', 'oauth', 'api_key', 'webhook', 'ssh']);
});

test('a fully-formed connector validates', () => {
  const r = validateConnector(goodConnector());
  assert.equal(r.valid, true);
  assert.deepEqual(r.errors, []);
});

test('missing verifyConnection fails the order law', () => {
  const c = goodConnector();
  delete c.verifyConnection;
  const r = validateConnector(c);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /verifyConnection/.test(e)));
});

test('missing listCapabilities fails (no actions-only connectors)', () => {
  const c = goodConnector();
  delete c.listCapabilities;
  assert.equal(validateConnector(c).valid, false);
});

test('an unknown connectionType is rejected', () => {
  const c = goodConnector();
  c.connectionTypes = ['carrier_pigeon'];
  const r = validateConnector(c);
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => /connectionType/.test(e)));
});

test('assertValidConnector throws with joined errors', () => {
  assert.throws(() => assertValidConnector({ id: 'x' }), /serviceCategory|provider|connectionTypes/);
});

test('registry registers, fetches by id and by category/provider', () => {
  _resetConnectorsForTests();
  registerConnector(goodConnector());
  assert.equal(getConnector('wordpress').provider, 'wordpress');
  assert.equal(getConnectorByCategoryProvider('cms', 'wordpress').id, 'wordpress');
  assert.equal(getConnectorByCategoryProvider('cms', 'ghost'), null);
  assert.equal(listConnectors().length, 1);
});

test('registry rejects an invalid connector at registration', () => {
  _resetConnectorsForTests();
  assert.throws(() => registerConnector({ id: 'bad' }), /serviceCategory|provider/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/connectionsContractRegistry.test.js`
Expected: FAIL — cannot resolve `../connections/types/contract.js`.

- [ ] **Step 3: Write the contract module**

Create `server/services/ops/connections/types/contract.js`:

```js
/**
 * Connector contract (spec §5, LOCKED). Every integration — current and future —
 * implements this one shape. The five-layer law (Connection → Inventory →
 * Snapshot → Checks → Actions) is enforced by REQUIRING verifyConnection and
 * listCapabilities: a connector cannot ship actions/recommendations without a
 * verifiable connection and a capability map first.
 */
export const CONNECTION_TYPES = ['service_account', 'oauth', 'api_key', 'webhook', 'ssh'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isFn = (v) => typeof v === 'function';

export function validateConnector(connector = {}) {
  const errors = [];

  for (const field of ['id', 'serviceCategory', 'provider']) {
    if (!isNonEmptyString(connector[field])) errors.push(`connector.${field} must be a non-empty string`);
  }

  if (!Array.isArray(connector.connectionTypes) || connector.connectionTypes.length === 0) {
    errors.push('connector.connectionTypes must be a non-empty array');
  } else {
    for (const t of connector.connectionTypes) {
      if (!CONNECTION_TYPES.includes(t)) errors.push(`connector.connectionTypes: unknown connectionType "${t}"`);
    }
  }

  // Order law — mandatory first two layers.
  if (!isFn(connector.verifyConnection)) errors.push('connector.verifyConnection must be a function');
  if (!isFn(connector.listCapabilities)) errors.push('connector.listCapabilities must be a function');

  // Optional later-layer methods, validated only if present.
  if (connector.discoverInventory !== undefined && !isFn(connector.discoverInventory)) {
    errors.push('connector.discoverInventory, if present, must be a function');
  }
  if (connector.collectSnapshot !== undefined && !isFn(connector.collectSnapshot)) {
    errors.push('connector.collectSnapshot, if present, must be a function');
  }
  if (connector.actions !== undefined && (typeof connector.actions !== 'object' || connector.actions === null)) {
    errors.push('connector.actions, if present, must be an object');
  }
  if (connector.checks !== undefined && !Array.isArray(connector.checks)) {
    errors.push('connector.checks, if present, must be an array');
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidConnector(connector) {
  const { valid, errors } = validateConnector(connector);
  if (!valid) throw new Error(`invalid connector: ${errors.join('; ')}`);
}
```

- [ ] **Step 4: Write the registry module**

Create `server/services/ops/connections/registry.js`:

```js
/**
 * Connector registry (spec §5). Connectors register themselves at module load
 * via registerConnector(); the executor/orchestrator discover them by id or by
 * (serviceCategory, provider). F1 ships an EMPTY registry — concrete connectors
 * arrive in F2+.
 */
import { assertValidConnector } from './types/contract.js';

const CONNECTORS = new Map();

export function registerConnector(connector) {
  assertValidConnector(connector);
  if (CONNECTORS.has(connector.id)) {
    console.warn(`[ops/connections] connector already registered: ${connector.id} — overwriting`);
  }
  CONNECTORS.set(connector.id, connector);
}

export function getConnector(id) {
  return CONNECTORS.get(id) || null;
}

export function getConnectorByCategoryProvider(serviceCategory, provider) {
  for (const c of CONNECTORS.values()) {
    if (c.serviceCategory === serviceCategory && c.provider === provider) return c;
  }
  return null;
}

export function listConnectors() {
  return Array.from(CONNECTORS.values());
}

// Test-only escape hatch.
export function _resetConnectorsForTests() {
  CONNECTORS.clear();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/connectionsContractRegistry.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/connections/types/contract.js server/services/ops/connections/registry.js server/services/ops/__tests__/connectionsContractRegistry.test.js
git commit -m "feat(ops/connections): connector contract + registry (locked §5 interface)"
```

---

### Task 4: Capability matrix + gate (pure)

**Files:**
- Create: `server/services/ops/connections/capabilityMatrix.js`
- Test: `server/services/ops/__tests__/capabilityMatrix.test.js`

**Interfaces:**
- Consumes: connection rows shaped like `connectionStore` output — `{ status, capabilities: string[] }` (Task 5 guarantees `capabilities` is always an array).
- Produces:
  - `USABLE_CONNECTION_STATUSES: Set<string>` = `{'verified','degraded'}` — only these contribute capabilities.
  - `availableCapabilities(connections): Set<string>` — union of `capabilities` across usable connections.
  - `evaluateGate(requiredCapabilities, connections): { satisfied: boolean, missing: string[], available: string[] }` — `satisfied` is true when `requiredCapabilities` is empty (legacy/un-gated) OR every required capability is in `availableCapabilities`.

**Decision (stated):** Only connections in `verified` or `degraded` status grant capabilities. `degraded` still grants because the connection is working, just imperfectly. `configured`/`missing`/`failed`/`disabled` grant nothing — a not-yet-verified connection must not satisfy a gate.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/capabilityMatrix.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { USABLE_CONNECTION_STATUSES, availableCapabilities, evaluateGate } from '../connections/capabilityMatrix.js';

const conn = (status, capabilities) => ({ status, capabilities });

test('usable statuses are exactly verified + degraded', () => {
  assert.deepEqual([...USABLE_CONNECTION_STATUSES].sort(), ['degraded', 'verified']);
});

test('availableCapabilities unions only usable connections', () => {
  const caps = availableCapabilities([
    conn('verified', ['read', 'crawl']),
    conn('degraded', ['list_pages']),
    conn('failed', ['publish']),       // ignored
    conn('configured', ['mutate'])     // ignored
  ]);
  assert.deepEqual([...caps].sort(), ['crawl', 'list_pages', 'read']);
});

test('empty requiredCapabilities is always satisfied (legacy/un-gated)', () => {
  const g = evaluateGate([], []);
  assert.equal(g.satisfied, true);
  assert.deepEqual(g.missing, []);
});

test('gate satisfied when every required capability is available', () => {
  const g = evaluateGate(['read', 'crawl'], [conn('verified', ['read', 'crawl', 'inspect_html'])]);
  assert.equal(g.satisfied, true);
  assert.deepEqual(g.missing, []);
});

test('gate reports the missing capabilities and is not satisfied', () => {
  const g = evaluateGate(['read', 'publish'], [conn('verified', ['read'])]);
  assert.equal(g.satisfied, false);
  assert.deepEqual(g.missing, ['publish']);
});

test('a failed connection does not satisfy the gate', () => {
  const g = evaluateGate(['read'], [conn('failed', ['read'])]);
  assert.equal(g.satisfied, false);
  assert.deepEqual(g.missing, ['read']);
});

test('no connections at all → all required are missing', () => {
  const g = evaluateGate(['read'], []);
  assert.equal(g.satisfied, false);
  assert.deepEqual(g.missing, ['read']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/capabilityMatrix.test.js`
Expected: FAIL — cannot resolve `../connections/capabilityMatrix.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/connections/capabilityMatrix.js`:

```js
/**
 * Pure capability availability + gate evaluation (spec §4 capability gate).
 * A check whose requiredCapabilities aren't satisfied by the client's
 * connections is SKIPPED by the executor (never errored). Only verified or
 * degraded connections grant capabilities.
 */
export const USABLE_CONNECTION_STATUSES = new Set(['verified', 'degraded']);

export function availableCapabilities(connections = []) {
  const caps = new Set();
  for (const c of connections) {
    if (!c || !USABLE_CONNECTION_STATUSES.has(c.status)) continue;
    for (const cap of c.capabilities || []) caps.add(cap);
  }
  return caps;
}

export function evaluateGate(requiredCapabilities = [], connections = []) {
  const required = Array.isArray(requiredCapabilities) ? requiredCapabilities : [];
  const available = availableCapabilities(connections);
  const missing = required.filter((cap) => !available.has(cap));
  return { satisfied: missing.length === 0, missing, available: [...available] };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/capabilityMatrix.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/capabilityMatrix.js server/services/ops/__tests__/capabilityMatrix.test.js
git commit -m "feat(ops/connections): pure capability matrix + gate evaluation"
```

---

### Task 5: Connection store — CRUD + status lifecycle

**Files:**
- Create: `server/services/ops/connections/connectionStore.js`
- Test: `server/services/ops/__tests__/connectionStore.test.js`

**Interfaces:**
- Consumes: `query` from `server/db.js`; `ops_service_connections` (Task 1).
- Produces:
  - `STATUS_LIFECYCLE: Record<string, string[]>` — allowed next-statuses per current status (locked §6 order, plus disable/recover edges).
  - `canTransitionStatus(from, to): boolean` — pure; `true` for a self-transition or an allowed edge; `false` otherwise; `true` from a falsy `from` (first set).
  - `upsertConnection({ clientUserId, serviceCategory, provider, connectionType, credentialRef, status, capabilities, detail, metadata }): Promise<conn>` — insert or update on `(client_user_id, service_category, provider)`; defaults `status` to `'missing'`. Returns the serialized row.
  - `setConnectionStatus(id, status, { detail, capabilities, lastVerifiedAt }): Promise<conn>` — validates the transition against the row's current status (throws on illegal transition); updates `status_*` columns.
  - `getConnection(clientUserId, serviceCategory, provider): Promise<conn|null>`.
  - `listConnectionsForClient(clientUserId): Promise<conn[]>`.
  - Serialized `conn` shape: `{ id, client_user_id, service_category, provider, connection_type, credential_ref, status, capabilities: string[], detail, metadata, last_verified_at, created_at, updated_at }` (note `capabilities` parsed from `capabilities_json`).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/connectionStore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  upsertConnection, setConnectionStatus, getConnection, listConnectionsForClient,
  canTransitionStatus, STATUS_LIFECYCLE
} from '../connections/connectionStore.js';

test('canTransitionStatus enforces the locked lifecycle (pure)', () => {
  assert.equal(canTransitionStatus('missing', 'configured'), true);
  assert.equal(canTransitionStatus('configured', 'verified'), true);
  assert.equal(canTransitionStatus('verified', 'degraded'), true);
  assert.equal(canTransitionStatus('degraded', 'failed'), true);
  assert.equal(canTransitionStatus('failed', 'disabled'), true);
  assert.equal(canTransitionStatus('verified', 'verified'), true); // self-transition ok
  assert.equal(canTransitionStatus(null, 'configured'), true);     // first set ok
  assert.equal(canTransitionStatus('missing', 'verified'), false); // cannot skip configured
  assert.ok(STATUS_LIFECYCLE.verified.includes('degraded'));
});

test('upsert → status transition → list round-trips (DB)', async () => {
  const clientUserId = randomUUID();
  const created = await upsertConnection({
    clientUserId,
    serviceCategory: 'cms',
    provider: 'wordpress',
    connectionType: 'ssh',
    status: 'configured',
    capabilities: ['read'],
    detail: 'seeded'
  });
  assert.ok(created.id);
  assert.equal(created.status, 'configured');
  assert.deepEqual(created.capabilities, ['read']);

  const verified = await setConnectionStatus(created.id, 'verified', {
    detail: 'ping ok',
    capabilities: ['read', 'run_wp_cli'],
    lastVerifiedAt: new Date()
  });
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.capabilities, ['read', 'run_wp_cli']);
  assert.ok(verified.last_verified_at);

  const fetched = await getConnection(clientUserId, 'cms', 'wordpress');
  assert.equal(fetched.id, created.id);

  const list = await listConnectionsForClient(clientUserId);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].capabilities, ['read', 'run_wp_cli']);
});

test('upsert is idempotent on (client, category, provider) (DB)', async () => {
  const clientUserId = randomUUID();
  const a = await upsertConnection({ clientUserId, serviceCategory: 'paid_ads', provider: 'meta', status: 'configured' });
  const b = await upsertConnection({ clientUserId, serviceCategory: 'paid_ads', provider: 'meta', status: 'configured', detail: 'again' });
  assert.equal(a.id, b.id, 'same row updated, not duplicated');
  assert.equal(b.detail, 'again');
});

test('setConnectionStatus rejects an illegal transition (DB)', async () => {
  const clientUserId = randomUUID();
  const c = await upsertConnection({ clientUserId, serviceCategory: 'hosting', provider: 'kinsta', status: 'missing' });
  await assert.rejects(
    () => setConnectionStatus(c.id, 'verified', {}), // missing → verified is illegal
    /illegal status transition/i
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/connectionStore.test.js`
Expected: FAIL — cannot resolve `../connections/connectionStore.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/connections/connectionStore.js`:

```js
/**
 * CRUD + status lifecycle over ops_service_connections (spec §6). This store
 * OWNS the connection status lifecycle:
 *   missing → configured → verified → degraded → failed → disabled
 * with disable/recover edges. Capabilities are stored as a JSON array.
 */
import { query } from '../../../db.js';

export const STATUS_LIFECYCLE = {
  missing:    ['configured', 'disabled'],
  configured: ['verified', 'failed', 'missing', 'disabled'],
  verified:   ['degraded', 'failed', 'configured', 'disabled'],
  degraded:   ['verified', 'failed', 'disabled'],
  failed:     ['configured', 'verified', 'disabled'],
  disabled:   ['configured', 'missing']
};

export function canTransitionStatus(from, to) {
  if (!from) return true;            // first set
  if (from === to) return true;      // idempotent re-set
  return (STATUS_LIFECYCLE[from] || []).includes(to);
}

function serialize(row) {
  if (!row) return null;
  return {
    id: row.id,
    client_user_id: row.client_user_id,
    service_category: row.service_category,
    provider: row.provider,
    connection_type: row.connection_type,
    credential_ref: row.credential_ref,
    status: row.status,
    capabilities: Array.isArray(row.capabilities_json) ? row.capabilities_json : [],
    detail: row.detail,
    metadata: row.metadata || {},
    last_verified_at: row.last_verified_at,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

export async function upsertConnection({
  clientUserId,
  serviceCategory,
  provider,
  connectionType = null,
  credentialRef = null,
  status = 'missing',
  capabilities = [],
  detail = null,
  metadata = {}
} = {}) {
  if (!clientUserId) throw new Error('connectionStore: clientUserId required');
  if (!serviceCategory) throw new Error('connectionStore: serviceCategory required');
  if (!provider) throw new Error('connectionStore: provider required');

  const { rows } = await query(
    `
    INSERT INTO ops_service_connections
      (client_user_id, service_category, provider, connection_type, credential_ref,
       status, capabilities_json, detail, metadata, updated_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, now())
    ON CONFLICT (client_user_id, service_category, provider) DO UPDATE
      SET connection_type   = EXCLUDED.connection_type,
          credential_ref    = COALESCE(EXCLUDED.credential_ref, ops_service_connections.credential_ref),
          status            = EXCLUDED.status,
          capabilities_json = EXCLUDED.capabilities_json,
          detail            = EXCLUDED.detail,
          metadata          = EXCLUDED.metadata,
          updated_at        = now()
    RETURNING *
    `,
    [
      clientUserId, serviceCategory, provider, connectionType, credentialRef,
      status, JSON.stringify(capabilities), detail, JSON.stringify(metadata)
    ]
  );
  return serialize(rows[0]);
}

export async function setConnectionStatus(id, status, { detail = null, capabilities = null, lastVerifiedAt = null } = {}) {
  if (!id) throw new Error('connectionStore: id required');
  const cur = await query('SELECT status FROM ops_service_connections WHERE id = $1', [id]);
  const from = cur.rows[0]?.status;
  if (from === undefined) throw new Error('connectionStore: connection not found');
  if (!canTransitionStatus(from, status)) {
    throw new Error(`connectionStore: illegal status transition ${from} → ${status}`);
  }

  const { rows } = await query(
    `
    UPDATE ops_service_connections
       SET status            = $2,
           detail            = COALESCE($3, detail),
           capabilities_json = COALESCE($4::jsonb, capabilities_json),
           last_verified_at  = COALESCE($5, last_verified_at),
           updated_at        = now()
     WHERE id = $1
     RETURNING *
    `,
    [id, status, detail, capabilities == null ? null : JSON.stringify(capabilities), lastVerifiedAt]
  );
  return serialize(rows[0]);
}

export async function getConnection(clientUserId, serviceCategory, provider) {
  const { rows } = await query(
    `SELECT * FROM ops_service_connections
      WHERE client_user_id = $1 AND service_category = $2 AND provider = $3
      LIMIT 1`,
    [clientUserId, serviceCategory, provider]
  );
  return serialize(rows[0]);
}

export async function listConnectionsForClient(clientUserId) {
  const { rows } = await query(
    `SELECT * FROM ops_service_connections
      WHERE client_user_id = $1
      ORDER BY service_category, provider`,
    [clientUserId]
  );
  return rows.map(serialize);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/connectionStore.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/connectionStore.js server/services/ops/__tests__/connectionStore.test.js
git commit -m "feat(ops/connections): connection store — CRUD + owned status lifecycle"
```

---

### Task 6: Credential resolver + checks/registry back-compat reframe

**Files:**
- Create: `server/services/ops/connections/credentialResolver.js`
- Modify: `server/services/ops/checks/registry.js`
- Test: `server/services/ops/__tests__/credentialResolver.test.js`
- Test: `server/services/ops/__tests__/checksRegistryBackCompat.test.js`

**Interfaces:**
- Produces (`credentialResolver.js`):
  - `classifyCredentialResolution(connection, credentialRow): { strategy, source, reason? }` — pure. `strategy ∈ {'stored','agency_env','env','missing'}`. `stored` = `credentialRow.credentials_source==='self_serve_oauth'` with an encrypted payload; `agency_env` = a credential row with an agency source (caller reads `process.env`); `env` = no `credential_ref` at all (pure env-var connection); `missing` = `credential_ref` set but row not found.
  - `async resolveCredentialForConnection(connection, { queryFn, decryptSecret }): Promise<{ strategy, source, secret?, reason? }>` — DB-backed wrapper; injects `queryFn` (defaults to `query`) and `decryptSecret` (defaults to `decrypt` from `services/security/encryption.js`). Never logs/returns secrets except in the `secret` field for `stored`.
- Modifies (`checks/registry.js`): `registerCheck(checkId, definition)` now also accepts `serviceCategory`, `provider`, `requiredCapabilities`; derives `(serviceCategory, provider)` from `umbrella` when given; stored registration gains `serviceCategory`, `provider`, `requiredCapabilities` fields while keeping `umbrella` (back-compat). New exported lookups: `listChecksForServiceCategory(serviceCategory)`, `listChecksForProvider(provider)`.

- [ ] **Step 1: Write the failing credentialResolver test**

Create `server/services/ops/__tests__/credentialResolver.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyCredentialResolution, resolveCredentialForConnection } from '../connections/credentialResolver.js';

test('no credential_ref → pure env strategy', () => {
  const r = classifyCredentialResolution({ credential_ref: null }, null);
  assert.equal(r.strategy, 'env');
  assert.equal(r.source, 'env_var');
});

test('credential_ref set but row missing → missing', () => {
  const r = classifyCredentialResolution({ credential_ref: 'abc' }, null);
  assert.equal(r.strategy, 'missing');
});

test('self_serve_oauth with encrypted payload → stored', () => {
  const r = classifyCredentialResolution(
    { credential_ref: 'abc' },
    { credentials_source: 'self_serve_oauth', credentials_encrypted: 'cipher' }
  );
  assert.equal(r.strategy, 'stored');
  assert.equal(r.source, 'self_serve_oauth');
});

test('agency source → agency_env (caller reads process.env)', () => {
  const r = classifyCredentialResolution(
    { credential_ref: 'abc' },
    { credentials_source: 'agency_mcc', credentials_encrypted: null }
  );
  assert.equal(r.strategy, 'agency_env');
  assert.equal(r.source, 'agency_mcc');
});

test('resolveCredentialForConnection decrypts only the stored strategy (DI, no DB/crypto)', async () => {
  const queryFn = async () => ({ rows: [{ credentials_source: 'self_serve_oauth', credentials_encrypted: 'cipher' }] });
  const decryptSecret = (c) => (c === 'cipher' ? '{"token":"t"}' : null);
  const out = await resolveCredentialForConnection({ credential_ref: 'abc' }, { queryFn, decryptSecret });
  assert.equal(out.strategy, 'stored');
  assert.equal(out.secret, '{"token":"t"}');
});

test('resolveCredentialForConnection returns env strategy without touching the DB', async () => {
  let called = false;
  const queryFn = async () => { called = true; return { rows: [] }; };
  const out = await resolveCredentialForConnection({ credential_ref: null }, { queryFn, decryptSecret: () => null });
  assert.equal(out.strategy, 'env');
  assert.equal(called, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/credentialResolver.test.js`
Expected: FAIL — cannot resolve `../connections/credentialResolver.js`.

- [ ] **Step 3: Write credentialResolver**

Create `server/services/ops/connections/credentialResolver.js`:

```js
/**
 * Bridge a connection to its credential (spec §3.1: env-var / Postgres, NOT
 * Secret Manager). ops_service_connections.credential_ref points at a
 * client_platform_credentials row. Pure classification is separated from the
 * DB/crypto wrapper so the decision logic is exhaustively testable.
 */
import { query } from '../../../db.js';
import { decrypt } from '../../security/encryption.js';

export function classifyCredentialResolution(connection, credentialRow) {
  if (!connection || !connection.credential_ref) {
    return { strategy: 'env', source: 'env_var' };
  }
  if (!credentialRow) {
    return { strategy: 'missing', source: null, reason: 'credential_ref not found' };
  }
  if (credentialRow.credentials_source === 'self_serve_oauth' && credentialRow.credentials_encrypted) {
    return { strategy: 'stored', source: 'self_serve_oauth' };
  }
  // agency_mcc / agency_sysuser / env_var rows resolve from process.env.
  return { strategy: 'agency_env', source: credentialRow.credentials_source };
}

export async function resolveCredentialForConnection(connection, { queryFn = query, decryptSecret = decrypt } = {}) {
  if (!connection || !connection.credential_ref) {
    return { strategy: 'env', source: 'env_var' };
  }
  const { rows } = await queryFn(
    'SELECT credentials_source, credentials_encrypted FROM client_platform_credentials WHERE id = $1',
    [connection.credential_ref]
  );
  const row = rows[0] || null;
  const classified = classifyCredentialResolution(connection, row);
  if (classified.strategy === 'stored') {
    return { ...classified, secret: decryptSecret(row.credentials_encrypted) };
  }
  return classified;
}
```

- [ ] **Step 4: Run credentialResolver test**

Run: `node --test server/services/ops/__tests__/credentialResolver.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing back-compat registry test**

Create `server/services/ops/__tests__/checksRegistryBackCompat.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  registerCheck, getCheck, listChecksForUmbrella,
  listChecksForServiceCategory, listChecksForProvider, _resetRegistryForTests
} from '../checks/registry.js';

const handler = async () => ({ status: 'pass' });

test('LEGACY umbrella check registers UNCHANGED and derives category/provider', () => {
  _resetRegistryForTests();
  // Byte-for-byte the shape existing checks use today — no new fields.
  registerCheck('web.ssl.expiry', { umbrella: 'website', tier: 'daily_essential', costEstimate: 0, requires: [], handler });
  const def = getCheck('web.ssl.expiry');
  assert.equal(def.umbrella, 'website');                 // preserved
  assert.equal(def.serviceCategory, 'website');          // derived
  assert.equal(def.provider, 'public_http');             // derived
  assert.deepEqual(def.requiredCapabilities, []);        // default → never gated
  assert.equal(listChecksForUmbrella('website').length, 1);
  assert.equal(listChecksForServiceCategory('website').length, 1);
});

test('all four shipped umbrellas still register and derive', () => {
  _resetRegistryForTests();
  registerCheck('a', { umbrella: 'google_ads', tier: 'daily_essential', handler });
  registerCheck('b', { umbrella: 'meta', tier: 'daily_essential', handler });
  registerCheck('c', { umbrella: 'ctm', tier: 'daily_essential', handler });
  assert.equal(getCheck('a').serviceCategory, 'paid_ads');
  assert.equal(getCheck('a').provider, 'google_ads');
  assert.equal(getCheck('b').provider, 'meta');
  assert.equal(getCheck('c').serviceCategory, 'call_tracking');
});

test('NEW contract: serviceCategory + provider + requiredCapabilities (no umbrella)', () => {
  _resetRegistryForTests();
  registerCheck('ga4.sessions', {
    serviceCategory: 'analytics', provider: 'ga4', requiredCapabilities: ['read'],
    tier: 'daily_essential', handler
  });
  const def = getCheck('ga4.sessions');
  assert.equal(def.serviceCategory, 'analytics');
  assert.equal(def.provider, 'ga4');
  assert.deepEqual(def.requiredCapabilities, ['read']);
  // legacy umbrella column is back-filled for ops_check_results.umbrella (NOT NULL)
  assert.ok(typeof def.umbrella === 'string' && def.umbrella.length > 0);
  assert.equal(listChecksForProvider('ga4').length, 1);
});

test('a check with neither umbrella nor (serviceCategory, provider) is rejected', () => {
  _resetRegistryForTests();
  assert.throws(
    () => registerCheck('bad', { tier: 'daily_essential', handler }),
    /umbrella.*or.*serviceCategory|serviceCategory.*provider/i
  );
});

test('an explicit serviceCategory overrides the umbrella derivation', () => {
  _resetRegistryForTests();
  registerCheck('web.host.kinsta', {
    umbrella: 'website', serviceCategory: 'hosting', provider: 'kinsta',
    tier: 'daily_essential', handler
  });
  const def = getCheck('web.host.kinsta');
  assert.equal(def.umbrella, 'website');     // legacy field preserved
  assert.equal(def.serviceCategory, 'hosting'); // explicit wins
  assert.equal(def.provider, 'kinsta');
});
```

- [ ] **Step 6: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/checksRegistryBackCompat.test.js`
Expected: FAIL — `serviceCategory`/`provider`/`requiredCapabilities` not present on registrations; new lookups undefined.

- [ ] **Step 7: Reframe `checks/registry.js`**

Replace the entire contents of `server/services/ops/checks/registry.js` with:

```js
/**
 * Operations check registry — F1 reframe.
 *
 * A check is classified by (serviceCategory, provider) and MAY declare
 * requiredCapabilities. The LEGACY `umbrella` field is still accepted: when
 * present, (serviceCategory, provider) are DERIVED from it (spec §4 shim), so
 * every shipped umbrella check registers UNCHANGED.
 *
 * Each registration carries:
 *   - umbrella           'website' | 'google_ads' | 'meta' | 'ctm' (legacy; optional for new checks)
 *   - serviceCategory    e.g. 'website' | 'paid_ads' | 'analytics' (derived from umbrella if omitted)
 *   - provider           e.g. 'public_http' | 'google_ads' | 'ga4' (derived from umbrella if omitted)
 *   - requiredCapabilities  string[] — gate; empty (default) → never gated (legacy behavior)
 *   - tier               'daily_essential' | 'weekly_deep' | 'monthly_audit' | 'on_demand'
 *   - handler            async (ctx) => { status, severity?, payload?, cost_cents? }
 *   - costEstimate       integer cents (rough upper bound, used by budget gate)
 *   - requires           array of platform keys for credential resolution
 */
import { deriveFromUmbrella, umbrellaFromCategoryProvider } from '../connections/umbrellaMap.js';

const REGISTRY = new Map();

const VALID_UMBRELLAS = new Set(['website', 'google_ads', 'meta', 'ctm']);
const VALID_TIERS = new Set(['daily_essential', 'weekly_deep', 'monthly_audit', 'on_demand']);

export function registerCheck(checkId, definition = {}) {
  if (typeof checkId !== 'string' || !checkId) {
    throw new Error('registerCheck: checkId must be a non-empty string');
  }
  if (REGISTRY.has(checkId)) {
    // Re-registration is permitted (e.g. hot-reload in dev) but warn loudly.
    console.warn(`[ops/registry] check_id already registered: ${checkId} — overwriting`);
  }
  const {
    umbrella,
    serviceCategory: explicitCategory,
    provider: explicitProvider,
    requiredCapabilities = [],
    tier,
    handler,
    costEstimate = 0,
    requires = []
  } = definition;

  // --- resolve classification (umbrella shim OR explicit contract) ---
  let serviceCategory = explicitCategory;
  let provider = explicitProvider;

  if (umbrella !== undefined) {
    if (!VALID_UMBRELLAS.has(umbrella)) {
      throw new Error(`registerCheck(${checkId}): invalid umbrella "${umbrella}"`);
    }
    const derived = deriveFromUmbrella(umbrella);
    serviceCategory = serviceCategory || derived.serviceCategory;
    provider = provider || derived.provider;
  }

  if (!serviceCategory || !provider) {
    throw new Error(
      `registerCheck(${checkId}): must provide umbrella OR both serviceCategory and provider`
    );
  }

  // Back-fill a legacy umbrella for ops_check_results.umbrella (NOT NULL). Prefer
  // the explicit umbrella; else reverse-derive; else fall back to serviceCategory.
  const resolvedUmbrella = umbrella || umbrellaFromCategoryProvider(serviceCategory, provider) || serviceCategory;

  if (!VALID_TIERS.has(tier)) {
    throw new Error(`registerCheck(${checkId}): invalid tier "${tier}"`);
  }
  if (typeof handler !== 'function') {
    throw new Error(`registerCheck(${checkId}): handler must be a function`);
  }
  if (!Array.isArray(requires)) {
    throw new Error(`registerCheck(${checkId}): requires must be an array`);
  }
  if (!Array.isArray(requiredCapabilities)) {
    throw new Error(`registerCheck(${checkId}): requiredCapabilities must be an array`);
  }

  REGISTRY.set(checkId, {
    checkId,
    umbrella: resolvedUmbrella,
    serviceCategory,
    provider,
    requiredCapabilities,
    tier,
    handler,
    costEstimate: Number.isFinite(costEstimate) ? costEstimate : 0,
    requires
  });
}

export function getCheck(checkId) {
  return REGISTRY.get(checkId) || null;
}

export function listChecksForUmbrella(umbrella) {
  return Array.from(REGISTRY.values()).filter((c) => c.umbrella === umbrella);
}

export function listChecksForServiceCategory(serviceCategory) {
  return Array.from(REGISTRY.values()).filter((c) => c.serviceCategory === serviceCategory);
}

export function listChecksForProvider(provider) {
  return Array.from(REGISTRY.values()).filter((c) => c.provider === provider);
}

export function listChecksForTier(tier) {
  return Array.from(REGISTRY.values()).filter((c) => c.tier === tier);
}

export function listAllChecks() {
  return Array.from(REGISTRY.values());
}

// Test-only escape hatch.
export function _resetRegistryForTests() {
  REGISTRY.clear();
}
```

- [ ] **Step 8: Run the back-compat test**

Run: `node --test server/services/ops/__tests__/checksRegistryBackCompat.test.js`
Expected: PASS (5 tests).

- [ ] **Step 9: Prove the real shipped checks still register (regression)**

Run: `node -e "import('./server/services/ops/checks/website/index.js').then(()=>import('./server/services/ops/checks/registry.js')).then(m=>{const n=m.listAllChecks().length; if(n<1){console.error('no checks registered');process.exit(1)} console.log('website checks registered:',n); for(const c of m.listAllChecks()){if(!c.serviceCategory||!c.provider){console.error('missing classification:',c.checkId);process.exit(1)}} console.log('all classified OK')}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `website checks registered: N` (N ≥ 1) then `all classified OK` — proves every existing `umbrella:'website'` check registered unchanged and got a derived `serviceCategory`/`provider`.

- [ ] **Step 10: Commit**

```bash
git add server/services/ops/connections/credentialResolver.js server/services/ops/checks/registry.js server/services/ops/__tests__/credentialResolver.test.js server/services/ops/__tests__/checksRegistryBackCompat.test.js
git commit -m "feat(ops): credential resolver + checks registry umbrella→category/provider shim"
```

---

### Task 7: Capability gate in the run executor

**Files:**
- Modify: `server/services/ops/runExecutor.js`
- Test: `server/services/ops/__tests__/runExecutorCapabilityGate.test.js`

**Interfaces:**
- Consumes: `evaluateGate` (Task 4), `listConnectionsForClient` (Task 5), `persistCheckResult` (existing, in `runExecutor.js`).
- Produces:
  - A new exported pure helper `gateCheck(def, connections): { skip: boolean, reason?: string, missing?: string[] }` — `skip:false` when `def.requiredCapabilities` is empty/absent; otherwise delegates to `evaluateGate`. Exported as `_gateCheckForTests`.
  - Behavior change: in the legacy `executeRun` loop, after a check `def` is resolved and BEFORE the timeout/dispatch block, a gated-and-unsatisfied check is persisted as a `skipped` `ops_check_results` row (`payload.reason = 'capability_gate'`, `payload.missing_capabilities = [...]`) and the loop `continue`s. Skips do NOT set `hadError` (run can still be `completed`).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/runExecutorCapabilityGate.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { _gateCheckForTests as gateCheck } from '../runExecutor.js';

const conn = (status, capabilities) => ({ status, capabilities });

test('un-gated check (no requiredCapabilities) never skips', () => {
  assert.deepEqual(gateCheck({ requiredCapabilities: [] }, []), { skip: false });
  assert.deepEqual(gateCheck({}, []), { skip: false });
});

test('gated check with satisfied capabilities does not skip', () => {
  const r = gateCheck({ requiredCapabilities: ['read'] }, [conn('verified', ['read'])]);
  assert.equal(r.skip, false);
});

test('gated check with unsatisfied capabilities skips with a reason', () => {
  const r = gateCheck({ requiredCapabilities: ['publish'] }, [conn('verified', ['read'])]);
  assert.equal(r.skip, true);
  assert.equal(r.reason, 'capability_gate');
  assert.deepEqual(r.missing, ['publish']);
});

test('gated check with no connections at all skips (never errors)', () => {
  const r = gateCheck({ requiredCapabilities: ['read'] }, []);
  assert.equal(r.skip, true);
  assert.deepEqual(r.missing, ['read']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/runExecutorCapabilityGate.test.js`
Expected: FAIL — `_gateCheckForTests` is not exported from `runExecutor.js`.

- [ ] **Step 3: Add imports to `runExecutor.js`**

In `server/services/ops/runExecutor.js`, immediately after the existing line `import { getCheck } from './checks/registry.js';` add:

```js
import { evaluateGate } from './connections/capabilityMatrix.js';
import { listConnectionsForClient } from './connections/connectionStore.js';
```

- [ ] **Step 4: Add the pure gate helper**

In `server/services/ops/runExecutor.js`, immediately after the `tierBudget` function (the block ending `return TIER_BUDGET_CENTS[tier] ?? 250;\n}`), add:

```js
/**
 * Pure capability gate (spec §4). A check that declares requiredCapabilities the
 * client's connections don't satisfy is SKIPPED with a reason — never errored.
 * Checks with no requiredCapabilities (every legacy umbrella check) never skip.
 * Exported for tests via _gateCheckForTests.
 */
function gateCheck(def, connections) {
  const required = Array.isArray(def?.requiredCapabilities) ? def.requiredCapabilities : [];
  if (required.length === 0) return { skip: false };
  const { satisfied, missing } = evaluateGate(required, connections);
  if (satisfied) return { skip: false };
  return { skip: true, reason: 'capability_gate', missing };
}

export { gateCheck as _gateCheckForTests };

/**
 * Load the client's service connections for the capability gate. A failure here
 * must NEVER fail the run: on error we return [] so gated checks degrade to
 * 'skipped' (safe) rather than throwing.
 */
async function loadClientConnections(clientUserId) {
  if (!clientUserId) return [];
  try {
    return await listConnectionsForClient(clientUserId);
  } catch (err) {
    console.warn(`[ops/executor] connection load failed for gate: ${err?.message || err}`);
    return [];
  }
}
```

- [ ] **Step 5: Load connections once, before the check loop**

In `executeRun`, find the line `const credentials = await resolveCredentialsForUmbrellas(run.client_user_id, umbrellas);` and add immediately after it:

```js
  const clientConnections = await loadClientConnections(run.client_user_id);
```

- [ ] **Step 6: Insert the gate inside the loop**

In `executeRun`, inside the `for (const entry of checkSet)` loop, find the block that ends the unknown-check guard:

```js
      if (id) checkResultIds.push(id);
      hadError = true;
      continue;
    }

    // Per-check abort: the signal in ctx is now combined (timeout + run cancel)
```

Insert the gate between the closing `}` of the `if (!def)` guard and the `// Per-check abort` comment, so it reads:

```js
      if (id) checkResultIds.push(id);
      hadError = true;
      continue;
    }

    // Capability gate (spec §4): skip — never error — a check whose required
    // capabilities aren't satisfied by this client's connections. A skip does
    // NOT set hadError, so a run of fully-gated checks still finishes 'completed'.
    const gate = gateCheck(def, clientConnections);
    if (gate.skip) {
      const skipId = await persistCheckResult(runId, run.client_user_id, def.umbrella, entry.check_id, {
        status: 'skipped',
        severity: null,
        payload: { reason: gate.reason, missing_capabilities: gate.missing }
      });
      if (skipId) checkResultIds.push(skipId);
      continue;
    }

    // Per-check abort: the signal in ctx is now combined (timeout + run cancel)
```

- [ ] **Step 7: Run the gate test**

Run: `node --test server/services/ops/__tests__/runExecutorCapabilityGate.test.js`
Expected: PASS (4 tests).

- [ ] **Step 8: Smoke-check the executor module graph**

Run: `node --check server/services/ops/runExecutor.js && node -e "import('./server/services/ops/runExecutor.js').then(m=>{if(typeof m.executeRun!=='function'){console.error('executeRun missing');process.exit(1)} if(typeof m._gateCheckForTests!=='function'){console.error('gate helper missing');process.exit(1)} console.log('runExecutor loaded with gate')}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `runExecutor loaded with gate` — proves the new imports + edits load cleanly (catches typos / circular-import regressions).

- [ ] **Step 9: Commit**

```bash
git add server/services/ops/runExecutor.js server/services/ops/__tests__/runExecutorCapabilityGate.test.js
git commit -m "feat(ops/executor): capability gate — skip (never error) unsatisfied checks"
```

---

### Task 8: Full-suite regression + connections barrel

**Files:**
- Create: `server/services/ops/connections/index.js`
- Test: (none new — runs the whole `test:ops` suite)

**Interfaces:**
- Produces (`connections/index.js`): a barrel re-exporting the public surface so future phases import from one place. Re-exports `registerConnector`/`getConnector`/`getConnectorByCategoryProvider`/`listConnectors`, `validateConnector`/`CONNECTION_TYPES`, `upsertConnection`/`getConnection`/`listConnectionsForClient`/`setConnectionStatus`/`canTransitionStatus`/`STATUS_LIFECYCLE`, `evaluateGate`/`availableCapabilities`, `resolveCredentialForConnection`/`classifyCredentialResolution`, `deriveFromUmbrella`/`umbrellaFromCategoryProvider`.

- [ ] **Step 1: Write the barrel**

Create `server/services/ops/connections/index.js`:

```js
/**
 * Public surface of the connection/capability/asset foundation (F1).
 * Future phases (F2+) import connectors + stores from here.
 */
export { registerConnector, getConnector, getConnectorByCategoryProvider, listConnectors } from './registry.js';
export { validateConnector, assertValidConnector, CONNECTION_TYPES } from './types/contract.js';
export {
  upsertConnection, getConnection, listConnectionsForClient, setConnectionStatus,
  canTransitionStatus, STATUS_LIFECYCLE
} from './connectionStore.js';
export { evaluateGate, availableCapabilities, USABLE_CONNECTION_STATUSES } from './capabilityMatrix.js';
export { resolveCredentialForConnection, classifyCredentialResolution } from './credentialResolver.js';
export {
  deriveFromUmbrella, umbrellaFromCategoryProvider,
  UMBRELLA_TO_CATEGORY_PROVIDER, SECONDARY_UMBRELLA_CATEGORIES
} from './umbrellaMap.js';
```

- [ ] **Step 2: Smoke-check the barrel**

Run: `node -e "import('./server/services/ops/connections/index.js').then(m=>{const need=['registerConnector','validateConnector','upsertConnection','evaluateGate','resolveCredentialForConnection','deriveFromUmbrella']; for(const k of need){if(typeof m[k]!=='function'){console.error('missing export',k);process.exit(1)}} console.log('connections barrel OK')}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `connections barrel OK`.

- [ ] **Step 3: Run the full ops suite for regressions**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops`
Expected: all prior tests PASS plus the seven new F1 test files (`connectionsMigration`, `umbrellaMap`, `connectionsContractRegistry`, `capabilityMatrix`, `connectionStore`, `credentialResolver`, `checksRegistryBackCompat`, `runExecutorCapabilityGate`). No existing test regresses — back-compat proven.

- [ ] **Step 4: Commit**

```bash
git add server/services/ops/connections/index.js
git commit -m "feat(ops/connections): public barrel for the F1 connection foundation"
```

---

## Self-Review

**Spec coverage (F1 deliverables 1–4):**
- **(1) Migrations + registration** — `ops_service_connections` (status lifecycle owner, `credential_ref` FK to `client_platform_credentials`), `ops_platform_inventory`, `ops_client_assets`; all three appended to `MIGRATIONS_BEFORE_SEED` → Task 1. ✅ Fields cover spec §6 + north-star §2.1/§2.3 + expandability §6 (assets as discrete objects, optional connection linkage).
- **(2) Connector registry + contract** under `connections/` — `types/contract.js` (locked §5 interface + order law), `registry.js`, `connectionStore.js`, `capabilityMatrix.js`, `credentialResolver.js` → Tasks 3–6. ✅ (`umbrellaMap.js` and `index.js` are supporting modules, Tasks 2 + 8.)
- **(3) Reframe `checks/registry.js`** — accepts `serviceCategory`/`provider`/`requiredCapabilities`, still accepts `umbrella`, derives `(serviceCategory, provider)` per §4 mapping; existing umbrella checks register UNCHANGED, proven by `checksRegistryBackCompat.test.js` Step-9 live-import regression → Task 6. ✅
- **(4) Capability gate in `runExecutor.js`** — unsatisfied required capabilities → `skipped` row with reason, never errored; skip doesn't set `hadError` → Task 7. ✅

**Global constraints honored:** No new deps (only existing `query`, `decrypt`). Credentials env-var/Postgres via `credential_ref` + `credentialResolver` — no Secret Manager. Back-compat shim never breaks umbrella checks (Step-9 proof). Connector contract is the §5 shape verbatim. No LLM math / mutation / PHI handling added (F1 is structural). Each migration has its SQL file AND a `migrations.js` array entry. DB tests use the mandated `DATABASE_URL` + `test:ops`; pure logic (umbrellaMap, contract, capabilityMatrix, credentialResolver classify, gateCheck) is DI/pure and needs no DB.

**Placeholder scan:** No TBD/TODO. The one "decision (stated)" notes (website primary classification, usable-status set) are concrete choices with rationale, not deferrals.

**Type consistency:** `evaluateGate(required, connections) → { satisfied, missing, available }` is produced in Task 4 and consumed identically in Tasks 6-test and 7. Connection serialized shape (`{ status, capabilities[] , ... }`) from Task 5 is exactly what `capabilityMatrix`/`gateCheck` consume. `deriveFromUmbrella → { serviceCategory, provider }` (Task 2) is consumed in `checks/registry.js` (Task 6) under the same property names. `registerCheck` stored fields (`umbrella`, `serviceCategory`, `provider`, `requiredCapabilities`) match what Task 7's `gateCheck` reads (`def.requiredCapabilities`, `def.umbrella`). Status vocabulary (`missing|configured|verified|degraded|failed|disabled`) is identical across the migration CHECK, `STATUS_LIFECYCLE`, and `USABLE_CONNECTION_STATUSES`.
