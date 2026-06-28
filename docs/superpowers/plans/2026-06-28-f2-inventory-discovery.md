# F2 — Inventory Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `discoverInventory(ctx)` for every existing provider (kinsta, wordpress, public_http, google_ads, meta, ctm), each conforming to the F1 connector contract (spec §5), so the platform can enumerate every external object a client owns into `ops_platform_inventory` (spec §2.3).

**Architecture:** Each provider is a connector module under `server/services/ops/connections/providers/` exporting a default object `{ id, serviceCategory, provider, async discoverInventory(ctx) }`. `discoverInventory` is a **dependency-injected, mostly-pure** function: it reads external clients from `ctx.clients` (falling back to the real, already-shipped client modules) and **returns** a normalized array of inventory rows — it never writes to the DB itself. A shared harness (`runInventoryDiscovery.js`) sanitizes the returned rows (defense-in-depth via `payloadSanitizer.js`) and persists them through `inventoryStore.js`. Every connector is unit-tested with injected fakes so no test touches a live Kinsta/Ads/Meta/CTM endpoint or SSH host.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, `pg` via `server/db.js` (`query`). Reuses the existing `kinstaApi.js`, `sshClient.js`, `website/_lib/httpFetch.js`, `google_ads/_client.js`, `meta/_client.js`, `meta/_hipaaGate.js`, and `services/ctm.js` clients. **No new npm dependencies.**

## Global Constraints

These apply to **every** task. Copied verbatim from the F2 brief and spec.

- **Credentials are env-var / Postgres, NOT Secret Manager** (spec §3.1). No connector reads a Secret Manager API; agency creds resolve from `process.env` inside the reused client modules, per-client links from Postgres.
- **Connector contract = spec §5 locked interface.** `discoverInventory(ctx)` returns `ops_platform_inventory` rows. The connector default export shape is `{ id, serviceCategory, provider, async discoverInventory(ctx) {...} }`. Other contract methods (`verifyConnection`, `collectSnapshot`, `listCapabilities`, `actions`, `checks`) are **owned by F1** and are intentionally NOT implemented here — F1 merges them onto these same module objects.
- **discoverInventory returns rows; it does NOT persist.** Each row has the shape `{ object_type, external_id, name, status, parent_external_id, url, metadata }`. Persistence happens once, in the shared harness.
- **No LLM mutation; PHI/PII never persisted.** Run every discovered row through `payloadSanitizer.js` (`sanitize`) before persistence. Connectors additionally avoid *collecting* PII at the source: WordPress users request `ID,roles` ONLY (never `user_email`/`display_name`/`user_login`); CTM tracking numbers persist the DB id + status only (never the phone digits); CTM webhooks/forms persist counts + config flags only (no submission content, no caller data).
- **HIPAA gate preserved.** The Meta connector calls `assertNonMedical(ctx)` (`meta/_hipaaGate.js`) BEFORE any Graph call; a `medical` (or indeterminate) client yields an **empty** Meta inventory, never a Graph request.
- **Dependency-inject external clients.** Connectors read clients from `ctx.clients?.<name>` with a fallback to the real imported module. Tests pass fakes via `ctx.clients`; production passes nothing and the real modules are used.
- **New migration → `server/sql/migrate_ops_<name>.sql` + append to the `server/migrations.js` array.**
- **DB tests:** `DATABASE_URL=postgresql://bif@localhost:5432/anchor`; suite `yarn test:ops`; `node:test` + `node:assert/strict`.
- **No new npm deps** (reuse existing kinsta/ads/meta/ctm clients).

## Connector contract (locked — spec §5)

The F1 connector registry will register modules of this exact shape. F2 delivers the `discoverInventory` leg only:

```js
export default {
  id: 'wordpress',
  serviceCategory: 'cms',
  provider: 'wordpress',
  async discoverInventory(ctx) {
    // returns Array<InventoryRow>
  }
};
```

**`ctx` shape** (provided by the F1 runner; documented here, resolved against real F1 code at execution):

```
ctx = {
  clientUserId,      // Anchor client user id (the client this discovery is for)
  connectionId,      // ops_service_connections.id (F1) — opaque to F2; used only for persistence scope
  connection,        // F1 connection row; F2 reads connection.metadata for per-client scope hints
  environmentId,     // (cms/wordpress) the kinsta_environments.id for the client's live env
  signal,            // AbortSignal threaded into safeHttpFetch
  clients            // OPTIONAL DI seam: { kinsta, wpcli, httpFetch, resolveUrl, withCustomer,
                     //   assertNonMedical, getAdAccountClient, listTrackingNumbers, query }
                     // Tests inject fakes here; production leaves it undefined → real modules used.
}
```

**`InventoryRow` shape** (returned by every `discoverInventory`, persisted to `ops_platform_inventory`):

```
{
  object_type:        string,          // 'site' | 'environment' | 'domain' | 'page' | 'plugin' | 'user' |
                                        // 'url' | 'form' | 'tracking_tag' | 'campaign' | 'ad_group' |
                                        // 'conversion_action' | 'ad_account' | 'pixel' |
                                        // 'tracking_number' | 'form_reactor' | 'webhook'
  external_id:        string,          // provider-native id (stringified)
  name:               string | null,
  status:             string | null,
  parent_external_id: string | null,   // links child→parent within the same connection
  url:                string | null,
  metadata:           object           // JSON-serializable, sanitized before persistence
}
```

> **F1 dependency note (binding):** `ops_platform_inventory`, the connector registry, and `ConnectionStore` are introduced by **F1** and are NOT built yet. This plan writes against the documented contract above. Task 1 ships a **defensive, idempotent** `ops_platform_inventory` migration so F2 can run and be tested standalone — if F1's migration already created the table, `CREATE TABLE IF NOT EXISTS` is a no-op; if F1's final schema differs, the executing routine reconciles the two. Do not fabricate imports from F1 files that do not exist.

## File Structure

| File | Responsibility |
|---|---|
| `server/sql/migrate_ops_platform_inventory.sql` | Defensive idempotent `ops_platform_inventory` table (spec §2.3). |
| `server/migrations.js` | Register the migration (append to array). |
| `server/services/ops/connections/inventoryRow.js` | Pure `inventoryRow(fields)` normalizer + defaults. |
| `server/services/ops/connections/inventoryStore.js` | `upsertInventory(scope, rows, queryFn)` + `listInventory(connectionId, queryFn)`. |
| `server/services/ops/connections/runInventoryDiscovery.js` | `discoverAndPersist(connector, ctx, deps)` — sanitize + persist harness. |
| `server/services/ops/connections/providers/kinsta.js` | hosting/kinsta — sites, environments, domains. |
| `server/services/ops/connections/providers/wordpress.js` | cms/wordpress — pages, plugins, users (PII-safe). |
| `server/services/ops/connections/providers/public_http.js` | website/public_http — crawled urls, forms, tracking tags. |
| `server/services/ops/connections/providers/google_ads.js` | paid_ads/google_ads — campaigns, ad groups, conversion actions. |
| `server/services/ops/connections/providers/meta.js` | paid_ads/meta — ad accounts, campaigns, pixels (HIPAA-gated). |
| `server/services/ops/connections/providers/ctm.js` | call_tracking/ctm — tracking numbers, form reactors, webhook (sanitized aggregates). |
| `server/services/ops/connections/providers/index.js` | Array of all F2 connectors (F1 import surface). |
| `server/services/ops/__tests__/inventoryStore.test.js` | DB round-trip: migration + upsert idempotency. |
| `server/services/ops/__tests__/inventoryHarness.test.js` | Pure: sanitize + scope + persist via fakes. |
| `server/services/ops/__tests__/inventoryKinsta.test.js` | Faked-client connector test. |
| `server/services/ops/__tests__/inventoryWordpress.test.js` | Faked-wpcli connector test (PII-safe). |
| `server/services/ops/__tests__/inventoryPublicHttp.test.js` | Faked-fetch connector test. |
| `server/services/ops/__tests__/inventoryGoogleAds.test.js` | Faked-customer connector test. |
| `server/services/ops/__tests__/inventoryMeta.test.js` | Faked-graph connector test + HIPAA gate. |
| `server/services/ops/__tests__/inventoryCtm.test.js` | Faked-client connector test (no PII). |

---

### Task 1: Migration + inventory store

**Files:**
- Create: `server/sql/migrate_ops_platform_inventory.sql`
- Modify: `server/migrations.js` (append filename to the `MIGRATIONS_AFTER_SEED` array, after `'migrate_ops_run_definition_model.sql'`)
- Create: `server/services/ops/connections/inventoryStore.js`
- Test: `server/services/ops/__tests__/inventoryStore.test.js`

**Interfaces:**
- Produces:
  - `upsertInventory(scope, rows, queryFn = query): Promise<{ written: number }>` — `scope = { connectionId, clientUserId?, serviceCategory, provider }`; upserts each row on conflict `(connection_id, object_type, external_id)`, refreshing `last_seen_at`.
  - `listInventory(connectionId, queryFn = query): Promise<row[]>` — rows for one connection, ordered by `object_type, external_id`.
  - Table columns: `id, connection_id, client_user_id, service_category, provider, object_type, external_id, name, status, parent_external_id, url, metadata, first_seen_at, last_seen_at`.

- [ ] **Step 1: Write the migration SQL**

Create `server/sql/migrate_ops_platform_inventory.sql`:

```sql
-- ops_platform_inventory (spec §2.3). OWNED BY F1; F2 ships a defensive,
-- idempotent definition so inventory discovery can run + be tested standalone.
-- If F1's migration already created the table, IF NOT EXISTS is a no-op.
-- client_user_id is intentionally untyped-FK (text) so this stands alone
-- regardless of the users.id type; F1 reconciles the final FK/type.
CREATE TABLE IF NOT EXISTS ops_platform_inventory (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id      uuid NOT NULL,
  client_user_id     text,
  service_category   text NOT NULL,
  provider           text NOT NULL,
  object_type        text NOT NULL,
  external_id        text NOT NULL,
  name               text,
  status             text,
  parent_external_id text,
  url                text,
  metadata           jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at      timestamptz NOT NULL DEFAULT now(),
  last_seen_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (connection_id, object_type, external_id)
);

CREATE INDEX IF NOT EXISTS ops_platform_inventory_client_idx
  ON ops_platform_inventory (client_user_id);
CREATE INDEX IF NOT EXISTS ops_platform_inventory_provider_idx
  ON ops_platform_inventory (service_category, provider);
```

- [ ] **Step 2: Register the migration**

In `server/migrations.js`, append to the `MIGRATIONS_AFTER_SEED` array (currently ends `'migrate_ops_run_definition_model.sql'`):

```js
const MIGRATIONS_AFTER_SEED = ['migrate_ops_recipes.sql', 'migrate_ops_skill_model.sql', 'migrate_ops_run_definition_model.sql', 'migrate_ops_platform_inventory.sql'];
```

- [ ] **Step 3: Run the migration locally**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn db:migrate`
Expected: completes without error; re-running is a no-op (idempotent `IF NOT EXISTS`).

- [ ] **Step 4: Write the inventory store**

Create `server/services/ops/connections/inventoryStore.js`:

```js
/**
 * Persistence for discovered inventory (ops_platform_inventory, spec §2.3).
 * Upsert keyed on (connection_id, object_type, external_id) so re-running
 * discovery refreshes existing rows and bumps last_seen_at rather than
 * duplicating. queryFn is injectable for tests.
 */
import { query } from '../../../db.js';

export async function upsertInventory(scope = {}, rows = [], queryFn = query) {
  const { connectionId, clientUserId = null, serviceCategory, provider } = scope;
  if (!connectionId) throw new Error('upsertInventory: connectionId required');
  if (!serviceCategory || !provider) throw new Error('upsertInventory: serviceCategory + provider required');

  let written = 0;
  for (const r of rows) {
    await queryFn(
      `INSERT INTO ops_platform_inventory
         (connection_id, client_user_id, service_category, provider,
          object_type, external_id, name, status, parent_external_id, url, metadata,
          first_seen_at, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb, now(), now())
       ON CONFLICT (connection_id, object_type, external_id)
       DO UPDATE SET
         name = EXCLUDED.name,
         status = EXCLUDED.status,
         parent_external_id = EXCLUDED.parent_external_id,
         url = EXCLUDED.url,
         metadata = EXCLUDED.metadata,
         last_seen_at = now()`,
      [
        connectionId,
        clientUserId == null ? null : String(clientUserId),
        serviceCategory,
        provider,
        r.object_type,
        r.external_id,
        r.name ?? null,
        r.status ?? null,
        r.parent_external_id ?? null,
        r.url ?? null,
        JSON.stringify(r.metadata || {})
      ]
    );
    written += 1;
  }
  return { written };
}

export async function listInventory(connectionId, queryFn = query) {
  const { rows } = await queryFn(
    `SELECT * FROM ops_platform_inventory
      WHERE connection_id = $1
      ORDER BY object_type, external_id`,
    [connectionId]
  );
  return rows;
}
```

- [ ] **Step 5: Write the store round-trip test**

Create `server/services/ops/__tests__/inventoryStore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { upsertInventory, listInventory } from '../connections/inventoryStore.js';

test('inventory store: insert → re-upsert is idempotent, refreshes fields', async () => {
  const connectionId = randomUUID();
  const scope = { connectionId, clientUserId: null, serviceCategory: 'hosting', provider: 'kinsta' };

  const first = await upsertInventory(scope, [
    { object_type: 'site', external_id: 'site-1', name: 'Acme', status: 'active', parent_external_id: null, url: 'https://acme.com', metadata: { company: 'co1' } },
    { object_type: 'environment', external_id: 'env-1', name: 'Live', status: 'live', parent_external_id: 'site-1', url: null, metadata: {} }
  ]);
  assert.equal(first.written, 2);

  // Re-run with one changed field — must update in place, not duplicate.
  const second = await upsertInventory(scope, [
    { object_type: 'site', external_id: 'site-1', name: 'Acme Renamed', status: 'active', parent_external_id: null, url: 'https://acme.com', metadata: { company: 'co1' } }
  ]);
  assert.equal(second.written, 1);

  const rows = await listInventory(connectionId);
  assert.equal(rows.length, 2, 'still two rows — upsert did not duplicate');
  const site = rows.find((r) => r.object_type === 'site');
  assert.equal(site.name, 'Acme Renamed', 'name was updated in place');
  assert.deepEqual(site.metadata, { company: 'co1' });
  const env = rows.find((r) => r.object_type === 'environment');
  assert.equal(env.parent_external_id, 'site-1');
});

test('upsertInventory rejects a scope with no connectionId', async () => {
  await assert.rejects(() => upsertInventory({ serviceCategory: 'hosting', provider: 'kinsta' }, []), /connectionId required/);
});
```

- [ ] **Step 6: Run the test**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/inventoryStore.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add server/sql/migrate_ops_platform_inventory.sql server/migrations.js server/services/ops/connections/inventoryStore.js server/services/ops/__tests__/inventoryStore.test.js
git commit -m "feat(ops/connections): ops_platform_inventory table + inventory store (F2)"
```

---

### Task 2: Row normalizer + discovery harness

**Files:**
- Create: `server/services/ops/connections/inventoryRow.js`
- Create: `server/services/ops/connections/runInventoryDiscovery.js`
- Test: `server/services/ops/__tests__/inventoryHarness.test.js`

**Interfaces:**
- Consumes: `upsertInventory` (Task 1); `sanitize` from `../payloadSanitizer.js`.
- Produces:
  - `inventoryRow(fields): InventoryRow` — validates `object_type` + `external_id` (throws if missing), stringifies ids, applies defaults (`name=null, status=null, parent_external_id=null, url=null, metadata={}`).
  - `discoverAndPersist(connector, ctx, deps = {}): Promise<{ provider, discovered, written, rows }>` — calls `connector.discoverInventory(ctx)`, sanitizes each row's `name` + `metadata` via `payloadSanitizer`, builds the persistence scope from `ctx` + `connector`, persists via `deps.upsert ?? upsertInventory`, returns a summary.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/inventoryHarness.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryRow } from '../connections/inventoryRow.js';
import { discoverAndPersist } from '../connections/runInventoryDiscovery.js';

test('inventoryRow applies defaults and stringifies ids', () => {
  const r = inventoryRow({ object_type: 'campaign', external_id: 12345, name: 'Brand' });
  assert.equal(r.external_id, '12345');
  assert.equal(r.name, 'Brand');
  assert.equal(r.status, null);
  assert.equal(r.parent_external_id, null);
  assert.equal(r.url, null);
  assert.deepEqual(r.metadata, {});
});

test('inventoryRow throws when object_type or external_id is missing', () => {
  assert.throws(() => inventoryRow({ external_id: 'x' }), /object_type required/);
  assert.throws(() => inventoryRow({ object_type: 'x' }), /external_id required/);
});

test('discoverAndPersist sanitizes rows, builds scope, and persists', async () => {
  const captured = {};
  const fakeConnector = {
    serviceCategory: 'call_tracking',
    provider: 'ctm',
    discoverInventory: async () => ([
      // a name carrying an email must be redacted before persistence
      inventoryRow({ object_type: 'form_reactor', external_id: 'f1', name: 'Contact bob@acme.com', metadata: { note: 'reply to bob@acme.com' } })
    ])
  };
  const out = await discoverAndPersist(fakeConnector, { connectionId: 'conn-1', clientUserId: 42 }, {
    upsert: async (scope, rows) => { captured.scope = scope; captured.rows = rows; return { written: rows.length }; }
  });

  assert.equal(out.provider, 'ctm');
  assert.equal(out.discovered, 1);
  assert.equal(out.written, 1);
  assert.deepEqual(captured.scope, { connectionId: 'conn-1', clientUserId: 42, serviceCategory: 'call_tracking', provider: 'ctm' });
  // sanitization fired on name AND metadata
  assert.ok(!JSON.stringify(captured.rows).includes('bob@acme.com'), 'email redacted everywhere');
  assert.ok(captured.rows[0].name.includes('[REDACTED]'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/inventoryHarness.test.js`
Expected: FAIL — cannot resolve `../connections/inventoryRow.js`.

- [ ] **Step 3: Write the normalizer**

Create `server/services/ops/connections/inventoryRow.js`:

```js
/**
 * Canonical ops_platform_inventory row builder. Validates required keys,
 * stringifies external ids, and fills the optional fields with null/{} so
 * every connector emits an identical shape (spec §2.3).
 */
export function inventoryRow(fields = {}) {
  const {
    object_type,
    external_id,
    name = null,
    status = null,
    parent_external_id = null,
    url = null,
    metadata = {}
  } = fields;

  if (!object_type) throw new Error('inventoryRow: object_type required');
  if (external_id == null || external_id === '') throw new Error('inventoryRow: external_id required');

  return {
    object_type: String(object_type),
    external_id: String(external_id),
    name: name == null ? null : String(name),
    status: status == null ? null : String(status),
    parent_external_id: parent_external_id == null ? null : String(parent_external_id),
    url: url == null ? null : String(url),
    metadata: metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}
  };
}
```

- [ ] **Step 4: Write the harness**

Create `server/services/ops/connections/runInventoryDiscovery.js`:

```js
/**
 * Inventory discovery harness (spec §5 — Connection → Inventory leg).
 *
 * Calls a connector's discoverInventory(ctx), applies the PHI/PII sanitizer
 * to every row (defense in depth — connectors already avoid collecting PII,
 * this is the belt to that suspenders), and persists the rows once via the
 * inventory store. Connectors themselves never write to the DB.
 */
import { sanitize } from '../payloadSanitizer.js';
import { upsertInventory } from './inventoryStore.js';

export async function discoverAndPersist(connector, ctx = {}, deps = {}) {
  const { upsert = upsertInventory } = deps;

  const raw = await connector.discoverInventory(ctx);
  const rows = (Array.isArray(raw) ? raw : []).map((r) => ({
    ...r,
    name: typeof r.name === 'string' ? sanitize(r.name) : r.name,
    metadata: sanitize(r.metadata || {})
  }));

  const scope = {
    connectionId: ctx.connectionId,
    clientUserId: ctx.clientUserId ?? null,
    serviceCategory: connector.serviceCategory,
    provider: connector.provider
  };

  const { written } = await upsert(scope, rows);
  return { provider: connector.provider, discovered: rows.length, written, rows };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/inventoryHarness.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/connections/inventoryRow.js server/services/ops/connections/runInventoryDiscovery.js server/services/ops/__tests__/inventoryHarness.test.js
git commit -m "feat(ops/connections): inventory row normalizer + sanitizing discovery harness (F2)"
```

---

### Task 3: hosting/kinsta connector

**Files:**
- Create: `server/services/ops/connections/providers/kinsta.js`
- Test: `server/services/ops/__tests__/inventoryKinsta.test.js`

**Interfaces:**
- Consumes: `inventoryRow` (Task 2); `kinstaApi` (`listAllSites`, `pickKinstaEnvironmentSummary`) via `ctx.clients?.kinsta` fallback to the real module.
- Produces: default connector `{ id:'kinsta', serviceCategory:'hosting', provider:'kinsta', discoverInventory(ctx) }` emitting `site` → `environment` (parent=site) → `domain` (parent=env) rows.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/inventoryKinsta.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import kinsta from '../connections/providers/kinsta.js';

const fakeKinsta = {
  listAllSites: async () => ([
    {
      id: 'site-1',
      display_name: 'Acme',
      company: 'co1',
      status: 'active',
      primaryDomain: { name: 'acme.com' },
      environments: [
        { id: 'env-1', name: 'Live', domains: [{ name: 'acme.com', type: 'live' }, { name: 'www.acme.com', type: 'alias' }] }
      ]
    }
  ]),
  pickKinstaEnvironmentSummary: (env) => ({
    environment_name: env.name,
    is_live: env.name === 'Live',
    primary_domain: 'acme.com',
    ssh_host: '1.2.3.4'
  })
};

test('kinsta connector emits site → environment → domain rows', async () => {
  const rows = await kinsta.discoverInventory({ clients: { kinsta: fakeKinsta } });

  const site = rows.find((r) => r.object_type === 'site');
  assert.equal(site.external_id, 'site-1');
  assert.equal(site.name, 'Acme');
  assert.equal(site.url, 'https://acme.com');

  const env = rows.find((r) => r.object_type === 'environment');
  assert.equal(env.external_id, 'env-1');
  assert.equal(env.parent_external_id, 'site-1');
  assert.equal(env.status, 'live');

  const domains = rows.filter((r) => r.object_type === 'domain');
  assert.equal(domains.length, 2);
  assert.ok(domains.every((d) => d.parent_external_id === 'env-1'));
  assert.ok(domains.some((d) => d.external_id === 'www.acme.com'));
});

test('kinsta connector honors per-connection site scope', async () => {
  const rows = await kinsta.discoverInventory({
    clients: { kinsta: fakeKinsta },
    connection: { metadata: { kinstaSiteIds: ['other-site'] } }
  });
  assert.equal(rows.length, 0, 'site-1 is filtered out by the scope');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/inventoryKinsta.test.js`
Expected: FAIL — cannot resolve `../connections/providers/kinsta.js`.

- [ ] **Step 3: Write the connector**

Create `server/services/ops/connections/providers/kinsta.js`:

```js
/**
 * hosting/kinsta connector — discoverInventory (F2).
 * Enumerates a client's Kinsta sites, their environments, and domains.
 * Reuses the shipped kinstaApi client; per-client scope (which sites this
 * connection grants) comes from connection.metadata.kinstaSiteIds when F1
 * provides it, else all agency sites are returned.
 */
import * as kinstaApi from '../../operations-website/kinstaApi.js';
import { inventoryRow } from '../inventoryRow.js';

export default {
  id: 'kinsta',
  serviceCategory: 'hosting',
  provider: 'kinsta',

  async discoverInventory(ctx = {}) {
    const kinsta = ctx.clients?.kinsta || kinstaApi;
    const scopeIds = ctx.connection?.metadata?.kinstaSiteIds || null;

    const sites = await kinsta.listAllSites().catch(() => []);
    const rows = [];

    for (const site of sites) {
      if (scopeIds && !scopeIds.includes(site.id)) continue;

      const primaryDomain = site.primaryDomain?.name || site.primary_domain?.name || null;
      rows.push(inventoryRow({
        object_type: 'site',
        external_id: site.id,
        name: site.display_name || site.name || site.id,
        status: site.status || 'active',
        url: primaryDomain ? `https://${primaryDomain}` : null,
        metadata: { company: site.company || null }
      }));

      for (const env of site.environments || []) {
        const summary = kinsta.pickKinstaEnvironmentSummary(env);
        rows.push(inventoryRow({
          object_type: 'environment',
          external_id: env.id,
          parent_external_id: site.id,
          name: summary.environment_name,
          status: summary.is_live ? 'live' : 'staging',
          url: summary.primary_domain ? `https://${summary.primary_domain}` : null,
          metadata: { is_live: summary.is_live, ssh_host: summary.ssh_host || null }
        }));

        const domains = (env.domains && env.domains.length)
          ? env.domains
          : (summary.primary_domain ? [{ name: summary.primary_domain, type: 'live' }] : []);
        for (const d of domains) {
          if (!d?.name) continue;
          rows.push(inventoryRow({
            object_type: 'domain',
            external_id: d.name,
            parent_external_id: env.id,
            name: d.name,
            status: d.type || 'live',
            url: `https://${d.name}`,
            metadata: {}
          }));
        }
      }
    }

    return rows;
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/inventoryKinsta.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/providers/kinsta.js server/services/ops/__tests__/inventoryKinsta.test.js
git commit -m "feat(ops/connections): hosting/kinsta discoverInventory (F2)"
```

---

### Task 4: cms/wordpress connector

**Files:**
- Create: `server/services/ops/connections/providers/wordpress.js`
- Test: `server/services/ops/__tests__/inventoryWordpress.test.js`

**Interfaces:**
- Consumes: `inventoryRow` (Task 2); `wpcli(environmentId, args, opts)` from `sshClient.js` via `ctx.clients?.wpcli`.
- Produces: default connector `{ id:'wordpress', serviceCategory:'cms', provider:'wordpress', discoverInventory(ctx) }` emitting `page`, `plugin`, and **PII-safe** `user` rows (ID + roles only). Reads `ctx.environmentId` (fallback `ctx.connection?.metadata?.environmentId`); returns `[]` when no env id.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/inventoryWordpress.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import wordpress from '../connections/providers/wordpress.js';

test('wordpress connector emits page/plugin/user rows and never collects user PII', async () => {
  const calls = [];
  const fakeWp = async (envId, args) => {
    calls.push(args);
    if (args.includes('post list')) return { exitCode: 0, stdout: JSON.stringify([{ ID: 10, post_title: 'Home', post_status: 'publish' }]) };
    if (args.includes('plugin list')) return { exitCode: 0, stdout: JSON.stringify([{ name: 'akismet', status: 'active', version: '5.0' }]) };
    if (args.includes('user list')) return { exitCode: 0, stdout: JSON.stringify([{ ID: 1, roles: ['administrator'] }]) };
    return { exitCode: 1, stdout: '' };
  };

  const rows = await wordpress.discoverInventory({ environmentId: 'env-1', clients: { wpcli: fakeWp } });

  const page = rows.find((r) => r.object_type === 'page');
  assert.equal(page.external_id, '10');
  assert.equal(page.name, 'Home');
  assert.equal(page.status, 'publish');

  const plugin = rows.find((r) => r.object_type === 'plugin');
  assert.equal(plugin.external_id, 'akismet');
  assert.deepEqual(plugin.metadata, { version: '5.0' });

  const user = rows.find((r) => r.object_type === 'user');
  assert.equal(user.external_id, '1');
  assert.equal(user.name, null, 'PII-safe: no username/email persisted as the user name');
  assert.deepEqual(user.metadata, { roles: ['administrator'] });

  // The user-list command must request ID + roles ONLY — never PII fields.
  const userCall = calls.find((a) => a.includes('user list'));
  assert.ok(!/user_email|display_name|user_login|user_pass/.test(userCall), 'no PII fields requested from WP-CLI');
});

test('wordpress connector returns [] when no environment id is available', async () => {
  const rows = await wordpress.discoverInventory({ clients: { wpcli: async () => ({ exitCode: 0, stdout: '[]' }) } });
  assert.deepEqual(rows, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/inventoryWordpress.test.js`
Expected: FAIL — cannot resolve `../connections/providers/wordpress.js`.

- [ ] **Step 3: Write the connector**

Create `server/services/ops/connections/providers/wordpress.js`:

```js
/**
 * cms/wordpress connector — discoverInventory (F2).
 * Runs read-only WP-CLI over the shipped SSH client to enumerate pages,
 * plugins, and users. PII-safe by construction: the user query requests
 * `ID,roles` ONLY — it never asks WP-CLI for user_email / display_name /
 * user_login, so no patient/staff PII is ever fetched or persisted.
 */
import { wpcli } from '../../operations-website/sshClient.js';
import { inventoryRow } from '../inventoryRow.js';

function parseJson(result) {
  if (!result || result.exitCode !== 0) return [];
  try {
    const v = JSON.parse(result.stdout);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default {
  id: 'wordpress',
  serviceCategory: 'cms',
  provider: 'wordpress',

  async discoverInventory(ctx = {}) {
    const runWp = ctx.clients?.wpcli || wpcli;
    const envId = ctx.environmentId || ctx.connection?.metadata?.environmentId || null;
    if (!envId) return [];

    const opts = { triggeredBy: 'inventory' };
    const [pagesRes, pluginsRes, usersRes] = await Promise.all([
      runWp(envId, 'post list --post_type=page --fields=ID,post_title,post_status --format=json', opts).catch(() => null),
      runWp(envId, 'plugin list --fields=name,status,version --format=json', opts).catch(() => null),
      // PII-safe: ID + roles ONLY.
      runWp(envId, 'user list --fields=ID,roles --format=json', opts).catch(() => null)
    ]);

    const rows = [];

    for (const p of parseJson(pagesRes)) {
      rows.push(inventoryRow({
        object_type: 'page',
        external_id: p.ID,
        name: p.post_title || `page-${p.ID}`,
        status: p.post_status || null,
        metadata: {}
      }));
    }

    for (const pl of parseJson(pluginsRes)) {
      rows.push(inventoryRow({
        object_type: 'plugin',
        external_id: pl.name,
        name: pl.name,
        status: pl.status || null,
        metadata: { version: pl.version || null }
      }));
    }

    for (const u of parseJson(usersRes)) {
      const roles = Array.isArray(u.roles) ? u.roles : (u.roles ? String(u.roles).split(',').map((s) => s.trim()) : []);
      rows.push(inventoryRow({
        object_type: 'user',
        external_id: u.ID,
        name: null, // PII-safe: never persist username/email
        status: null,
        metadata: { roles }
      }));
    }

    return rows;
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/inventoryWordpress.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/providers/wordpress.js server/services/ops/__tests__/inventoryWordpress.test.js
git commit -m "feat(ops/connections): cms/wordpress discoverInventory — pages/plugins/users (PII-safe) (F2)"
```

---

### Task 5: website/public_http connector

**Files:**
- Create: `server/services/ops/connections/providers/public_http.js`
- Test: `server/services/ops/__tests__/inventoryPublicHttp.test.js`

**Interfaces:**
- Consumes: `inventoryRow` (Task 2); `resolveClientWebsiteUrl(query, clientUserId)` + `safeHttpFetch(url, opts)` from `website/_lib/httpFetch.js` via `ctx.clients?.resolveUrl` / `ctx.clients?.httpFetch`.
- Produces: default connector `{ id:'public_http', serviceCategory:'website', provider:'public_http', discoverInventory(ctx) }` emitting `url` (homepage + internal links), `form`, and `tracking_tag` rows. Returns `[]` when no website URL resolves or the fetch fails.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/inventoryPublicHttp.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import publicHttp from '../connections/providers/public_http.js';

const HTML = `
<html><head>
<script>(function(){'GTM-ABC123';})();</script>
<script>gtag('config','G-ABCDEF1');</script>
<script>fbq('init', '1234567890');</script>
</head><body>
<a href="/about">About</a>
<a href="https://acme.com/contact">Contact</a>
<a href="mailto:hi@acme.com">Email</a>
<form id="lead" action="/submit"></form>
</body></html>`;

test('public_http connector emits url/form/tracking_tag rows', async () => {
  const rows = await publicHttp.discoverInventory({
    clientUserId: 7,
    clients: {
      resolveUrl: async () => 'https://acme.com',
      httpFetch: async () => ({ status: 200, body: HTML })
    }
  });

  const urls = rows.filter((r) => r.object_type === 'url');
  assert.ok(urls.some((u) => u.external_id === 'https://acme.com'), 'homepage url present');
  assert.ok(urls.some((u) => u.external_id === 'https://acme.com/about'), 'relative link resolved');
  assert.ok(urls.some((u) => u.external_id === 'https://acme.com/contact'), 'absolute internal link present');
  assert.ok(!urls.some((u) => /mailto:/.test(u.external_id)), 'mailto links excluded');

  const form = rows.find((r) => r.object_type === 'form');
  assert.equal(form.external_id, 'lead');
  assert.equal(form.metadata.action, '/submit');

  const tags = rows.filter((r) => r.object_type === 'tracking_tag');
  assert.ok(tags.some((t) => t.metadata.id === 'GTM-ABC123'));
  assert.ok(tags.some((t) => t.metadata.id === 'G-ABCDEF1'));
  assert.ok(tags.some((t) => t.name === 'meta_pixel' && t.metadata.id === '1234567890'));
});

test('public_http connector returns [] when no website url resolves', async () => {
  const rows = await publicHttp.discoverInventory({ clientUserId: 7, clients: { resolveUrl: async () => null, httpFetch: async () => ({}) } });
  assert.deepEqual(rows, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/inventoryPublicHttp.test.js`
Expected: FAIL — cannot resolve `../connections/providers/public_http.js`.

- [ ] **Step 3: Write the connector**

Create `server/services/ops/connections/providers/public_http.js`:

```js
/**
 * website/public_http connector — discoverInventory (F2).
 * Fetches the client's homepage through the SSRF-guarded fetch helper and
 * extracts crawled URLs (homepage + internal links), forms, and tracking
 * tags (GTM / GA4 / Meta Pixel). No PII — public markup only.
 */
import { query } from '../../../../db.js';
import { resolveClientWebsiteUrl, safeHttpFetch } from '../../checks/website/_lib/httpFetch.js';
import { inventoryRow } from '../inventoryRow.js';

function extractLinks(html, baseUrl) {
  const set = new Set();
  const re = /<a\b[^>]*\bhref=["']([^"'#]+)/gi;
  let m;
  while ((m = re.exec(html)) && set.size < 100) {
    const href = m[1].trim();
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol === 'http:' || u.protocol === 'https:') set.add(u.origin + u.pathname);
    } catch { /* ignore malformed href */ }
  }
  return [...set];
}

function countForms(html) {
  const tags = html.match(/<form\b[^>]*>/gi) || [];
  return tags.map((tag, i) => ({
    id: (tag.match(/\bid=["']([^"']*)["']/i) || [])[1] || `form-${i}`,
    action: (tag.match(/\baction=["']([^"']*)["']/i) || [])[1] || ''
  }));
}

function detectTags(html) {
  const out = [];
  const gtm = html.match(/GTM-[A-Z0-9]+/);
  const ga4 = html.match(/G-[A-Z0-9]{6,}/);
  const fbq = html.match(/fbq\(['"]init['"],\s*['"](\d+)['"]/);
  if (gtm) out.push({ kind: 'gtm', id: gtm[0] });
  if (ga4) out.push({ kind: 'ga4', id: ga4[0] });
  if (fbq) out.push({ kind: 'meta_pixel', id: fbq[1] });
  return out;
}

export default {
  id: 'public_http',
  serviceCategory: 'website',
  provider: 'public_http',

  async discoverInventory(ctx = {}) {
    const resolveUrl = ctx.clients?.resolveUrl || ((cid) => resolveClientWebsiteUrl(query, cid));
    const fetchUrl = ctx.clients?.httpFetch || ((u, o) => safeHttpFetch(u, o));

    const websiteUrl = ctx.connection?.metadata?.websiteUrl || await resolveUrl(ctx.clientUserId);
    if (!websiteUrl) return [];

    let res;
    try {
      res = await fetchUrl(websiteUrl, { timeoutMs: 12_000, maxBytes: 750_000, signal: ctx.signal });
    } catch {
      return [];
    }

    const html = (res?.body || '').slice(0, 400_000);
    const rows = [];

    rows.push(inventoryRow({
      object_type: 'url',
      external_id: websiteUrl,
      name: websiteUrl,
      status: String(res?.status ?? 'fetched'),
      url: websiteUrl,
      metadata: { homepage: true }
    }));

    for (const link of extractLinks(html, websiteUrl)) {
      if (link === websiteUrl) continue;
      rows.push(inventoryRow({ object_type: 'url', external_id: link, name: link, url: link, metadata: {} }));
    }

    for (const f of countForms(html)) {
      rows.push(inventoryRow({ object_type: 'form', external_id: f.id, name: f.id, metadata: { action: f.action } }));
    }

    for (const t of detectTags(html)) {
      rows.push(inventoryRow({
        object_type: 'tracking_tag',
        external_id: `${t.kind}:${t.id}`,
        name: t.kind,
        status: 'present',
        metadata: { id: t.id }
      }));
    }

    return rows;
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/inventoryPublicHttp.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/providers/public_http.js server/services/ops/__tests__/inventoryPublicHttp.test.js
git commit -m "feat(ops/connections): website/public_http discoverInventory — urls/forms/tags (F2)"
```

---

### Task 6: paid_ads/google_ads connector

**Files:**
- Create: `server/services/ops/connections/providers/google_ads.js`
- Test: `server/services/ops/__tests__/inventoryGoogleAds.test.js`

**Interfaces:**
- Consumes: `inventoryRow` (Task 2); `withCustomerCached(ctx)` from `google_ads/_client.js` via `ctx.clients?.withCustomer`. The resolved `customer` exposes `customer.query(gaql)` (gRPC GAQL).
- Produces: default connector `{ id:'google_ads', serviceCategory:'paid_ads', provider:'google_ads', discoverInventory(ctx) }` emitting `campaign`, `ad_group` (parent=campaign), and `conversion_action` rows. Returns `[]` when the resolver reports `skipped` (no creds / no linked customer).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/inventoryGoogleAds.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import googleAds from '../connections/providers/google_ads.js';

const fakeCustomer = {
  query: async (gaql) => {
    if (/FROM campaign\b/.test(gaql)) return [{ campaign: { id: 111, name: 'Brand', status: 2 } }];
    if (/FROM ad_group\b/.test(gaql)) return [{ ad_group: { id: 222, name: 'Exact', status: 2, campaign: 'customers/9/campaigns/111' } }];
    if (/FROM conversion_action\b/.test(gaql)) return [{ conversion_action: { id: 333, name: 'Call', status: 2 } }];
    return [];
  }
};

test('google_ads connector emits campaign/ad_group/conversion_action rows', async () => {
  const rows = await googleAds.discoverInventory({ clients: { withCustomer: async () => ({ customer: fakeCustomer, customerId: '9' }) } });

  const campaign = rows.find((r) => r.object_type === 'campaign');
  assert.equal(campaign.external_id, '111');
  assert.equal(campaign.name, 'Brand');

  const adGroup = rows.find((r) => r.object_type === 'ad_group');
  assert.equal(adGroup.external_id, '222');
  assert.equal(adGroup.parent_external_id, '111', 'ad group links to its campaign id');

  const conv = rows.find((r) => r.object_type === 'conversion_action');
  assert.equal(conv.external_id, '333');
  assert.equal(conv.name, 'Call');
});

test('google_ads connector returns [] when the client is not linked/credentialed', async () => {
  const rows = await googleAds.discoverInventory({ clients: { withCustomer: async () => ({ skipped: true, reason: 'no Google Ads customer_id linked for client' }) } });
  assert.deepEqual(rows, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/inventoryGoogleAds.test.js`
Expected: FAIL — cannot resolve `../connections/providers/google_ads.js`.

- [ ] **Step 3: Write the connector**

Create `server/services/ops/connections/providers/google_ads.js`:

```js
/**
 * paid_ads/google_ads connector — discoverInventory (F2).
 * Read-only GAQL (gRPC, per the shipped _client) enumerating campaigns,
 * ad groups, and conversion actions. Reuses withCustomerCached for the
 * agency-MCC auth path; returns [] for unlinked/uncredentialed clients.
 */
import { withCustomerCached } from '../../checks/google_ads/_client.js';
import { inventoryRow } from '../inventoryRow.js';

const lastSegment = (resourceName) => String(resourceName || '').split('/').pop() || null;

export default {
  id: 'google_ads',
  serviceCategory: 'paid_ads',
  provider: 'google_ads',

  async discoverInventory(ctx = {}) {
    const resolve = ctx.clients?.withCustomer || withCustomerCached;
    const resolved = await resolve(ctx);
    if (resolved.skipped) return [];

    const { customer } = resolved;
    const rows = [];

    const campaigns = await customer.query(
      'SELECT campaign.id, campaign.name, campaign.status FROM campaign'
    ).catch(() => []);
    for (const r of campaigns) {
      const c = r.campaign || r;
      rows.push(inventoryRow({
        object_type: 'campaign',
        external_id: c.id,
        name: c.name,
        status: String(c.status ?? ''),
        metadata: {}
      }));
    }

    const adGroups = await customer.query(
      'SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.campaign FROM ad_group'
    ).catch(() => []);
    for (const r of adGroups) {
      const g = r.ad_group || r;
      rows.push(inventoryRow({
        object_type: 'ad_group',
        external_id: g.id,
        parent_external_id: lastSegment(g.campaign),
        name: g.name,
        status: String(g.status ?? ''),
        metadata: {}
      }));
    }

    const convs = await customer.query(
      'SELECT conversion_action.id, conversion_action.name, conversion_action.status FROM conversion_action'
    ).catch(() => []);
    for (const r of convs) {
      const ca = r.conversion_action || r;
      rows.push(inventoryRow({
        object_type: 'conversion_action',
        external_id: ca.id,
        name: ca.name,
        status: String(ca.status ?? ''),
        metadata: {}
      }));
    }

    return rows;
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/inventoryGoogleAds.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/providers/google_ads.js server/services/ops/__tests__/inventoryGoogleAds.test.js
git commit -m "feat(ops/connections): paid_ads/google_ads discoverInventory (F2)"
```

---

### Task 7: paid_ads/meta connector (HIPAA-gated)

**Files:**
- Create: `server/services/ops/connections/providers/meta.js`
- Test: `server/services/ops/__tests__/inventoryMeta.test.js`

**Interfaces:**
- Consumes: `inventoryRow` (Task 2); `assertNonMedical(ctx)` from `meta/_hipaaGate.js` via `ctx.clients?.assertNonMedical`; `getAdAccountClient(ctx)` from `meta/_client.js` via `ctx.clients?.getAdAccountClient`. The resolved client exposes `{ ok, adAccountId, graph(subpath) }`.
- Produces: default connector `{ id:'meta', serviceCategory:'paid_ads', provider:'meta', discoverInventory(ctx) }` emitting `ad_account`, `campaign` (parent=ad_account), and `pixel` rows. **The HIPAA gate runs first**: a `medical`/indeterminate client yields `[]` with no Graph call. Returns `[]` when the client resolver reports `ok:false`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/inventoryMeta.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import meta from '../connections/providers/meta.js';

function fakeGraph() {
  return async (subpath) => {
    if (/^act_99\?/.test(subpath)) return { id: 'act_99', name: 'Acme Ads', account_status: 1 };
    if (/campaigns/.test(subpath)) return { data: [{ id: 'c1', name: 'Promo', status: 'ACTIVE' }] };
    if (/adspixels/.test(subpath)) return { data: [{ id: 'px1', name: 'Site Pixel' }] };
    return {};
  };
}

test('meta connector emits ad_account/campaign/pixel rows for a non-medical client', async () => {
  let graphCalled = false;
  const rows = await meta.discoverInventory({
    clients: {
      assertNonMedical: async () => ({ skipped: false }),
      getAdAccountClient: async () => ({ ok: true, adAccountId: 'act_99', graph: (p) => { graphCalled = true; return fakeGraph()(p); } })
    }
  });

  assert.ok(graphCalled, 'graph was queried for a non-medical client');
  const acct = rows.find((r) => r.object_type === 'ad_account');
  assert.equal(acct.external_id, 'act_99');
  const campaign = rows.find((r) => r.object_type === 'campaign');
  assert.equal(campaign.external_id, 'c1');
  assert.equal(campaign.parent_external_id, 'act_99');
  const pixel = rows.find((r) => r.object_type === 'pixel');
  assert.equal(pixel.external_id, 'px1');
});

test('meta connector returns [] and issues NO graph call for a medical client (HIPAA gate)', async () => {
  let graphCalled = false;
  const rows = await meta.discoverInventory({
    clients: {
      assertNonMedical: async () => ({ skipped: true, outcome: { status: 'skipped', payload: { reason: 'hipaa_no_meta' } } }),
      getAdAccountClient: async () => { graphCalled = true; return { ok: true, adAccountId: 'act_99', graph: fakeGraph() }; }
    }
  });
  assert.deepEqual(rows, []);
  assert.equal(graphCalled, false, 'no Meta client constructed and no Graph call for a medical client');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/inventoryMeta.test.js`
Expected: FAIL — cannot resolve `../connections/providers/meta.js`.

- [ ] **Step 3: Write the connector**

Create `server/services/ops/connections/providers/meta.js`:

```js
/**
 * paid_ads/meta connector — discoverInventory (F2).
 *
 * HIPAA gate FIRST: Meta signs no BAA, so a `medical` (or indeterminate)
 * client yields an EMPTY inventory with no Graph call ever issued. Only
 * after the gate passes do we construct the ad-account client and read
 * ad accounts, campaigns, and pixels (read-only).
 */
import { assertNonMedical } from '../../checks/meta/_hipaaGate.js';
import { getAdAccountClient } from '../../checks/meta/_client.js';
import { inventoryRow } from '../inventoryRow.js';

export default {
  id: 'meta',
  serviceCategory: 'paid_ads',
  provider: 'meta',

  async discoverInventory(ctx = {}) {
    const gate = ctx.clients?.assertNonMedical || assertNonMedical;
    const getClient = ctx.clients?.getAdAccountClient || getAdAccountClient;

    // HIPAA gate — must run before any Meta API work.
    const g = await gate(ctx);
    if (g.skipped) return [];

    const client = await getClient(ctx);
    if (!client.ok) return [];

    const acct = client.adAccountId;
    const rows = [];

    const account = await client.graph(`${acct}?fields=id,name,account_status`).catch(() => null);
    if (account) {
      rows.push(inventoryRow({
        object_type: 'ad_account',
        external_id: account.id || acct,
        name: account.name || acct,
        status: String(account.account_status ?? ''),
        metadata: {}
      }));
    }

    const campaigns = await client.graph(`${acct}/campaigns?fields=id,name,status&limit=200`).catch(() => null);
    for (const c of campaigns?.data || []) {
      rows.push(inventoryRow({
        object_type: 'campaign',
        external_id: c.id,
        parent_external_id: acct,
        name: c.name,
        status: String(c.status ?? ''),
        metadata: {}
      }));
    }

    const pixels = await client.graph(`${acct}/adspixels?fields=id,name&limit=100`).catch(() => null);
    for (const p of pixels?.data || []) {
      rows.push(inventoryRow({
        object_type: 'pixel',
        external_id: p.id,
        parent_external_id: acct,
        name: p.name,
        metadata: {}
      }));
    }

    return rows;
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/inventoryMeta.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/providers/meta.js server/services/ops/__tests__/inventoryMeta.test.js
git commit -m "feat(ops/connections): paid_ads/meta discoverInventory — HIPAA-gated (F2)"
```

---

### Task 8: call_tracking/ctm connector (sanitized aggregates)

**Files:**
- Create: `server/services/ops/connections/providers/ctm.js`
- Test: `server/services/ops/__tests__/inventoryCtm.test.js`

**Interfaces:**
- Consumes: `inventoryRow` (Task 2); `listTrackingNumbers({ clientUserId })` from `services/ctm.js` via `ctx.clients?.listTrackingNumbers`; `query` from `db.js` via `ctx.clients?.query` for `ctm_forms` + `call_logs` aggregates.
- Produces: default connector `{ id:'ctm', serviceCategory:'call_tracking', provider:'ctm', discoverInventory(ctx) }` emitting `tracking_number` (DB id + status only — **never the phone digits**), `form_reactor` (config flag only), and one `webhook` aggregate (counts + last-call timestamp only — **no caller PII**). Returns `[]` when no `clientUserId`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/inventoryCtm.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import ctm from '../connections/providers/ctm.js';

test('ctm connector emits tracking_number/form_reactor/webhook rows with NO PII', async () => {
  const fakeNumbers = async () => ([
    { id: 'num-1', formatted_number: '+1 (555) 867-5309', phone_number: '+15558675309', status: 'active' }
  ]);
  const fakeQuery = async (sql) => {
    if (/FROM ctm_forms/.test(sql)) return { rows: [{ id: 'form-1', name: 'Contact Us', autoresponder_enabled: true }] };
    if (/FROM call_logs/.test(sql)) return { rows: [{ last_at: '2026-06-27T10:00:00Z', calls_30d: 12 }] };
    return { rows: [] };
  };

  const rows = await ctm.discoverInventory({ clientUserId: 5, clients: { listTrackingNumbers: fakeNumbers, query: fakeQuery } });

  const num = rows.find((r) => r.object_type === 'tracking_number');
  assert.equal(num.external_id, 'num-1');
  assert.equal(num.name, null, 'PII-safe: phone number is never persisted as a name');
  assert.equal(num.status, 'active');

  const form = rows.find((r) => r.object_type === 'form_reactor');
  assert.equal(form.external_id, 'form-1');
  assert.deepEqual(form.metadata, { autoresponder_enabled: true });

  const webhook = rows.find((r) => r.object_type === 'webhook');
  assert.equal(webhook.status, 'active');
  assert.equal(webhook.metadata.calls_30d, 12);

  // Hard PII guard: no phone digits anywhere in the emitted inventory.
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes('5558675309'), 'no raw phone digits leaked');
  assert.ok(!serialized.includes('867-5309'), 'no formatted phone leaked');
});

test('ctm connector returns [] when there is no client', async () => {
  const rows = await ctm.discoverInventory({ clients: { listTrackingNumbers: async () => [], query: async () => ({ rows: [] }) } });
  assert.deepEqual(rows, []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/inventoryCtm.test.js`
Expected: FAIL — cannot resolve `../connections/providers/ctm.js`.

- [ ] **Step 3: Write the connector**

Create `server/services/ops/connections/providers/ctm.js`:

```js
/**
 * call_tracking/ctm connector — discoverInventory (F2).
 *
 * Sanitized aggregates ONLY — no PII ever leaves CTM here:
 *   - tracking_number: persists the DB id + active/inactive status. The phone
 *     digits are NEVER persisted (no name, no metadata number).
 *   - form_reactor: persists the form id/name + autoresponder flag only — no
 *     submission content.
 *   - webhook: a single aggregate row (last call timestamp + 30-day count) —
 *     no caller identity, number, or transcript.
 */
import { query } from '../../../../db.js';
import { listTrackingNumbers } from '../../../ctm.js';
import { inventoryRow } from '../inventoryRow.js';

export default {
  id: 'ctm',
  serviceCategory: 'call_tracking',
  provider: 'ctm',

  async discoverInventory(ctx = {}) {
    const clientUserId = ctx.clientUserId;
    if (!clientUserId) return [];

    const listNumbers = ctx.clients?.listTrackingNumbers || listTrackingNumbers;
    const dbQuery = ctx.clients?.query || query;

    const rows = [];

    // Tracking numbers — id + status only. NEVER the phone digits.
    const numbers = await listNumbers({ clientUserId }).catch(() => []);
    for (const n of numbers) {
      rows.push(inventoryRow({
        object_type: 'tracking_number',
        external_id: n.id,
        name: null,
        status: n.status || null,
        metadata: {}
      }));
    }

    // Form reactors — config flag only, no submission content.
    const formsRes = await dbQuery(
      `SELECT id, name, autoresponder_enabled
         FROM ctm_forms
        WHERE org_id = $1 AND status != 'archived'`,
      [clientUserId]
    ).catch(() => ({ rows: [] }));
    for (const f of formsRes.rows) {
      rows.push(inventoryRow({
        object_type: 'form_reactor',
        external_id: f.id,
        name: f.name || `form-${f.id}`,
        metadata: { autoresponder_enabled: Boolean(f.autoresponder_enabled) }
      }));
    }

    // Webhook delivery — single aggregate, no caller PII.
    const aggRes = await dbQuery(
      `SELECT MAX(created_at) AS last_at,
              COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS calls_30d
         FROM call_logs
        WHERE owner_user_id = $1`,
      [clientUserId]
    ).catch(() => ({ rows: [{}] }));
    const agg = aggRes.rows[0] || {};
    rows.push(inventoryRow({
      object_type: 'webhook',
      external_id: `ctm-webhook-${clientUserId}`,
      name: 'CTM call webhook',
      status: agg.last_at ? 'active' : 'idle',
      metadata: { last_call_at: agg.last_at || null, calls_30d: Number(agg.calls_30d || 0) }
    }));

    return rows;
  }
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/inventoryCtm.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/providers/ctm.js server/services/ops/__tests__/inventoryCtm.test.js
git commit -m "feat(ops/connections): call_tracking/ctm discoverInventory — sanitized aggregates (F2)"
```

---

### Task 9: Provider index + full-suite regression

**Files:**
- Create: `server/services/ops/connections/providers/index.js`

**Interfaces:**
- Consumes: all six connector default exports (Tasks 3–8).
- Produces: `INVENTORY_CONNECTORS: Array<{ id, serviceCategory, provider, discoverInventory }>` — the import surface F1's connector registry consumes; `default` is the same array.

- [ ] **Step 1: Write the provider index**

Create `server/services/ops/connections/providers/index.js`:

```js
/**
 * F2 inventory connectors. F1's connection registry imports this array and
 * merges the remaining contract methods (verifyConnection / collectSnapshot /
 * listCapabilities / actions / checks) onto each module.
 */
import kinsta from './kinsta.js';
import wordpress from './wordpress.js';
import publicHttp from './public_http.js';
import googleAds from './google_ads.js';
import meta from './meta.js';
import ctm from './ctm.js';

export const INVENTORY_CONNECTORS = [kinsta, wordpress, publicHttp, googleAds, meta, ctm];

export default INVENTORY_CONNECTORS;
```

- [ ] **Step 2: Verify the index loads and every connector conforms to the contract**

Run:
```bash
node -e "import('./server/services/ops/connections/providers/index.js').then(({ INVENTORY_CONNECTORS: cs }) => { const bad = cs.filter(c => !c.id || !c.serviceCategory || !c.provider || typeof c.discoverInventory !== 'function'); if (bad.length) { console.error('non-conforming connectors:', bad.map(c => c.provider)); process.exit(1); } console.log('all', cs.length, 'connectors conform'); }).catch(e => { console.error(e); process.exit(1); });"
```
Expected: prints `all 6 connectors conform`.

- [ ] **Step 3: Run the full ops suite for regressions**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops`
Expected: all prior ops tests + the 8 new F2 test files PASS.

- [ ] **Step 4: Commit**

```bash
git add server/services/ops/connections/providers/index.js
git commit -m "feat(ops/connections): F2 inventory connector index + suite green"
```

---

## Self-Review

**Spec coverage (F2 scope):**
- §5 connector contract — `discoverInventory(ctx)` returning `ops_platform_inventory` rows, default export `{ id, serviceCategory, provider, discoverInventory }` → every provider task (3–8) + index (9). ✅
- §2.3 `ops_platform_inventory` rows persisted → Task 1 (table + store) + Task 2 (harness persists). ✅
- hosting/kinsta — sites, environments, domains → Task 3. ✅
- cms/wordpress — pages, plugins, users via WP-CLI over SSH → Task 4. ✅
- website/public_http — crawled urls, forms, tracking tags → Task 5. ✅
- paid_ads/google_ads — campaigns, ad groups, conversion actions → Task 6. ✅
- paid_ads/meta — ad accounts, campaigns, pixels, HIPAA-gated for medical clients → Task 7. ✅
- call_tracking/ctm — tracking numbers, form reactors, webhooks, sanitized aggregates / no PII → Task 8. ✅
- Global: no LLM mutation (read-only discovery only); PHI/PII never persisted (`payloadSanitizer` in harness Task 2 + source-level avoidance in Tasks 4/8); HIPAA gate preserved (Task 7) → all satisfied. ✅
- Global: new migration → `server/sql/migrate_ops_platform_inventory.sql` + appended to `migrations.js` (Task 1). ✅
- Global: DB tests use `DATABASE_URL=postgresql://bif@localhost:5432/anchor`, `yarn test:ops`, `node:test`/`node:assert/strict`, dependency-injected fakes (every connector test uses `ctx.clients`) → all tasks. ✅
- Global: no new npm deps — only reused `kinstaApi`/`sshClient`/`httpFetch`/`google_ads._client`/`meta._client`/`meta._hipaaGate`/`services/ctm` → confirmed in imports. ✅

**F1-dependency honesty:** `ops_platform_inventory`, the registry, and `ConnectionStore` are F1-owned and unbuilt. F2 ships a defensive idempotent migration (Task 1, clearly annotated) and writes connectors against the documented contract/ctx/row shapes only — no imports from non-existent F1 files. The provider modules export partial connector objects F1 will finish merging. Reconciliation of the final wiring/schema is left to the executing routine, as instructed. ✅

**Placeholder scan:** No TBD/TODO. Every code step shows complete code; every test step shows complete assertions; every run step shows the exact command + expected output. ✅

**Type consistency:** `inventoryRow(fields)` (Task 2) is the single row factory used by all six connectors; its output keys (`object_type, external_id, name, status, parent_external_id, url, metadata`) match the store's `INSERT` columns (Task 1) and the harness's sanitize map (Task 2). `discoverAndPersist` builds `scope = { connectionId, clientUserId, serviceCategory, provider }`, exactly what `upsertInventory(scope, …)` consumes. `ctx.clients?.<name>` injection seam is used identically across Tasks 3–8 and asserted by each test. The Meta resolver shape `{ ok, adAccountId, graph }` matches the real `getAdAccountClient`; the Ads resolver shape `{ skipped } | { customer, customerId }` matches `withCustomerCached`. ✅
