# F6 — GA4 Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement a full `analytics/ga4` connector conforming to the north-star spec §5 connector contract — `verifyConnection`, `discoverInventory`, `collectSnapshot`, `listCapabilities`, and ten capability-gated checks — so the system gains the missing analytics leg for cross-platform reasoning.

**Architecture:** The connector lives entirely under `server/services/ops/connections/ga4/`. Credentials resolve from `GA4_SERVICE_ACCOUNT_KEY` (JSON string in env) or ADC. The `@google-analytics/data` `BetaAnalyticsDataClient` handles Data API report calls; the GA4 Admin API (account/property/stream/key-event discovery) is called via plain `fetch` authenticated with a `google-auth-library` token (already a dep). All check logic is split into **pure functions** (`checks/_logic.js`) and **thin handler wrappers** (`checks/index.js`) that inject report data and baseline values. Checks whose required data (baseline, `propertyId`, `adsClicks`) is absent return `status: 'skipped'` with a reason — they never throw.

**Tech Stack:** Node ESM, `@google-analytics/data@^4.9.0` (new dep — see Global Constraints), `google-auth-library` (existing dep), `node:test` + `node:assert/strict`, native `fetch` (Node 18+), `pg` via `server/db.js`.

## Global Constraints

- **NEW npm dependency: `@google-analytics/data@^4.9.0`.** The executing routine MUST run `yarn add @google-analytics/data@^4.9.0` as Task 1 Step 1 before any import or test. Pin the version explicitly.
- **Credentials are env-var / Postgres, NOT Secret Manager** (spec §3.1). GA4 credentials resolve from `GA4_SERVICE_ACCOUNT_KEY` (JSON string) or ADC (`GOOGLE_APPLICATION_CREDENTIALS` file path / Cloud Run metadata). Never log or echo credential values — log variable names and presence booleans only.
- **Connector contract = spec §5 exactly:** `{ id, serviceCategory, provider, connectionTypes, verifyConnection, discoverInventory, collectSnapshot, listCapabilities, checks }`. Five-layer law: Connection → Inventory → Snapshot → Checks → Actions.
- **Do NOT call `registerCheck` from `server/services/ops/checks/registry.js`.** That registry enforces `umbrella ∈ {website, google_ads, meta, ctm}` and would throw for 'analytics'. Export checks as the `GA4_CHECKS` array (each entry: `{ id, tier, requiredCapabilities, handler }`) inside the connector object. F1's updated registry will wire these in when it ships.
- **No new SQL migration.** Tables `ops_service_connections`, `ops_platform_inventory`, `ops_daily_snapshots`, `ops_metric_baselines` are owned by F1 and F3. The `getBaseline` helper in check handlers catches the case where `ops_metric_baselines` does not yet exist (returns `null` → check status `'skipped'`).
- **No LLM math. No PHI.** Analytics data carries no health information; no LLM inference in check logic.
- **Check logic is PURE/injectable.** Pure functions in `checks/_logic.js` accept plain data objects and return `{ status, severity?, ...fields }` — zero I/O. Handlers in `checks/index.js` fetch one targeted report, then call the appropriate pure function. Tests inject `ctx.ga4Client` (fake `BetaAnalyticsDataClient`) + `ctx.ga4PropertyId` + `ctx.ga4Baseline` — no live GA4 calls.
- **DB tests:** `DATABASE_URL=postgresql://bif@localhost:5432/anchor`; suite: `yarn test:ops`; individual file: `node --test server/services/ops/__tests__/ga4<Name>.test.js`.
- **Node 18+ native fetch.** Use `globalThis.fetch` for Admin API REST calls. No `node-fetch`.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/services/ops/connections/ga4/client.js` | `buildGa4Client({ env, ga4Client })` — constructs `BetaAnalyticsDataClient`; resolves credentials from `GA4_SERVICE_ACCOUNT_KEY` or ADC; accepts injectable client for tests. |
| `server/services/ops/connections/ga4/adminApi.js` | GA4 Admin API REST wrapper: `getAdminAccessToken({ env })`, `listAccountSummaries({ token, fetchFn })`, `listDataStreams(propertyId, { token, fetchFn })`, `listKeyEvents(propertyId, { token, fetchFn })`. Injectable `fetchFn` enables test isolation. |
| `server/services/ops/connections/ga4/_reportParser.js` | Pure `parseRows(response, metricNames)` and `aggregateFirstRow(response, metricNames)`. Shared by `snapshot.js` and `checks/index.js`. |
| `server/services/ops/connections/ga4/inventory.js` | `discoverInventory(ctx)` — uses Admin API to build `ops_platform_inventory`-shaped rows for accounts, properties, data streams, and key events. |
| `server/services/ops/connections/ga4/snapshot.js` | `collectSnapshot(ctx)` — runs five targeted Data API reports; normalizes each to `{ metric_name, metric_value, dimensions, metadata }` rows (the `ops_daily_snapshots` shape). |
| `server/services/ops/connections/ga4/checks/_logic.js` | Pure check functions: `checkDrop`, `checkKeyEventMissing`, `checkFormEventNotFiring`, `checkAdsClicksVsSessionsGap`, `checkSourceMediumAnomaly`. No I/O. |
| `server/services/ops/connections/ga4/checks/index.js` | `GA4_CHECKS` array (10 entries). Each: `{ id, tier, requiredCapabilities, handler }`. Handlers resolve ga4 context, fetch one report, call a pure function, wrap result in `{ status, severity, payload }`. Exports `GA4_CHECKS`. |
| `server/services/ops/connections/ga4/index.js` | Default connector export. Assembles `{ id: 'ga4', serviceCategory: 'analytics', provider: 'ga4', connectionTypes: ['service_account'], verifyConnection, discoverInventory, collectSnapshot, listCapabilities, checks: GA4_CHECKS }`. |
| `server/services/ops/__tests__/ga4Client.test.js` | Tests for `buildGa4Client`. |
| `server/services/ops/__tests__/ga4AdminApi.test.js` | Tests for Admin API helpers with fake `fetchFn` + injected token. |
| `server/services/ops/__tests__/ga4Inventory.test.js` | Tests for `discoverInventory` with fake `fetchFn` + injected token. |
| `server/services/ops/__tests__/ga4Snapshot.test.js` | Tests for `collectSnapshot` with fake `BetaAnalyticsDataClient`. |
| `server/services/ops/__tests__/ga4CheckLogic.test.js` | Exhaustive tests for all pure check functions in `_logic.js`. |
| `server/services/ops/__tests__/ga4CheckHandlers.test.js` | Tests for all 10 check handlers using injectable `ctx.ga4Client`, `ctx.ga4PropertyId`, `ctx.ga4Baseline`. |

---

### Task 1: Install dependency + client factory

**Files:**
- Create: `server/services/ops/connections/ga4/client.js`
- Test: `server/services/ops/__tests__/ga4Client.test.js`

**Interfaces:**
- Produces:
  - `buildGa4Client({ env?, ga4Client? }): BetaAnalyticsDataClient` — if `ga4Client` is provided, returns it unchanged; if `env.GA4_SERVICE_ACCOUNT_KEY` is set, parses it and constructs with `{ credentials }`; otherwise constructs with no options (ADC). Throws `Error('GA4: GA4_SERVICE_ACCOUNT_KEY is not valid JSON — ...')` on malformed JSON.

- [ ] **Step 1: Add the npm dependency**

```bash
yarn add @google-analytics/data@^4.9.0
```

Expected: `@google-analytics/data` appears in `package.json` dependencies. Re-run is idempotent.

- [ ] **Step 2: Write the failing test**

Create `server/services/ops/__tests__/ga4Client.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGa4Client } from '../connections/ga4/client.js';

test('buildGa4Client returns injected client unchanged', () => {
  const fake = { runReport: async () => [[]] };
  assert.strictEqual(buildGa4Client({ ga4Client: fake }), fake);
});

test('buildGa4Client throws on malformed GA4_SERVICE_ACCOUNT_KEY', () => {
  assert.throws(
    () => buildGa4Client({ env: { GA4_SERVICE_ACCOUNT_KEY: 'not-json' } }),
    /GA4_SERVICE_ACCOUNT_KEY is not valid JSON/
  );
});

test('buildGa4Client with empty env falls back to ADC (constructs without throw)', () => {
  // BetaAnalyticsDataClient defers auth to first API call, so construction is safe.
  assert.doesNotThrow(() => buildGa4Client({ env: {} }));
});

test('buildGa4Client with valid JSON key string constructs without throw', () => {
  const key = JSON.stringify({ type: 'service_account', project_id: 'p', private_key: 'k', client_email: 'e@p.iam.gserviceaccount.com' });
  assert.doesNotThrow(() => buildGa4Client({ env: { GA4_SERVICE_ACCOUNT_KEY: key } }));
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/ga4Client.test.js
```

Expected: FAIL — `Cannot find module '../connections/ga4/client.js'`.

- [ ] **Step 4: Write `client.js`**

Create `server/services/ops/connections/ga4/client.js`:

```js
/**
 * GA4 Data API client factory.
 * Credential resolution order:
 *   1. Injectable ga4Client (tests).
 *   2. GA4_SERVICE_ACCOUNT_KEY env var — JSON string of a service-account key.
 *   3. ADC — GOOGLE_APPLICATION_CREDENTIALS file path or Cloud Run metadata.
 *
 * Never logs credential values; checks name + presence only.
 */
import { BetaAnalyticsDataClient } from '@google-analytics/data';

export function buildGa4Client({ env = process.env, ga4Client = null } = {}) {
  if (ga4Client) return ga4Client;

  const keyJson = env.GA4_SERVICE_ACCOUNT_KEY;
  if (keyJson) {
    let credentials;
    try {
      credentials = JSON.parse(keyJson);
    } catch (e) {
      throw new Error(`GA4: GA4_SERVICE_ACCOUNT_KEY is not valid JSON — ${e.message}`);
    }
    return new BetaAnalyticsDataClient({ credentials });
  }

  // Fall back to ADC: GOOGLE_APPLICATION_CREDENTIALS file path or Cloud Run
  // workload identity. BetaAnalyticsDataClient with no options uses ADC automatically.
  return new BetaAnalyticsDataClient();
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/ga4Client.test.js
```

Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json yarn.lock server/services/ops/connections/ga4/client.js server/services/ops/__tests__/ga4Client.test.js
git commit -m "feat(ops/ga4): add @google-analytics/data dep + GA4 client factory"
```

---

### Task 2: Admin API REST wrapper

**Files:**
- Create: `server/services/ops/connections/ga4/adminApi.js`
- Test: `server/services/ops/__tests__/ga4AdminApi.test.js`

**Interfaces:**
- Produces:
  - `getAdminAccessToken({ env? }): Promise<string>` — uses `google-auth-library` `GoogleAuth` with `GA4_SERVICE_ACCOUNT_KEY` creds or ADC; returns bearer token string. Throws if token is null.
  - `listAccountSummaries({ token, fetchFn? }): Promise<AccountSummary[]>` — GET `/v1beta/accountSummaries`; returns `data.accountSummaries || []`.
  - `listDataStreams(propertyId, { token, fetchFn? }): Promise<DataStream[]>` — GET `/v1beta/properties/{propertyId}/dataStreams`; returns `data.dataStreams || []`.
  - `listKeyEvents(propertyId, { token, fetchFn? }): Promise<KeyEvent[]>` — GET `/v1beta/properties/{propertyId}/keyEvents`; returns `data.keyEvents || []`.
  - All three list functions throw `Error('GA4 Admin {status} for {path}: ...')` on non-OK HTTP response.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/ga4AdminApi.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { listAccountSummaries, listDataStreams, listKeyEvents } from '../connections/ga4/adminApi.js';

// Fake fetchFn builder — returns the given JSON body with status 200.
function fakeFetch(body) {
  return async (_url, _opts) => ({
    ok: true,
    json: async () => body,
    text: async () => JSON.stringify(body)
  });
}

function failFetch(status) {
  return async () => ({ ok: false, status, text: async () => 'Forbidden' });
}

const TOKEN = 'fake-token';

test('listAccountSummaries returns accountSummaries array', async () => {
  const fetchFn = fakeFetch({
    accountSummaries: [
      { account: 'accounts/123', displayName: 'Acme', propertySummaries: [] }
    ]
  });
  const accounts = await listAccountSummaries({ token: TOKEN, fetchFn });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].account, 'accounts/123');
});

test('listAccountSummaries returns empty array when key absent', async () => {
  const fetchFn = fakeFetch({});
  const accounts = await listAccountSummaries({ token: TOKEN, fetchFn });
  assert.deepEqual(accounts, []);
});

test('listDataStreams returns dataStreams array', async () => {
  const fetchFn = fakeFetch({
    dataStreams: [
      { name: 'properties/456/dataStreams/789', displayName: 'Web', type: 'WEB_DATA_STREAM', webStreamData: { measurementId: 'G-ABCD1234' } }
    ]
  });
  const streams = await listDataStreams('456', { token: TOKEN, fetchFn });
  assert.equal(streams.length, 1);
  assert.equal(streams[0].webStreamData.measurementId, 'G-ABCD1234');
});

test('listKeyEvents returns keyEvents array', async () => {
  const fetchFn = fakeFetch({
    keyEvents: [
      { name: 'properties/456/keyEvents/1', eventName: 'generate_lead', countingMethod: 'ONCE_PER_EVENT' }
    ]
  });
  const events = await listKeyEvents('456', { token: TOKEN, fetchFn });
  assert.equal(events[0].eventName, 'generate_lead');
});

test('listAccountSummaries throws on non-OK response', async () => {
  await assert.rejects(
    () => listAccountSummaries({ token: TOKEN, fetchFn: failFetch(403) }),
    /GA4 Admin 403/
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/ga4AdminApi.test.js
```

Expected: FAIL — `Cannot find module '../connections/ga4/adminApi.js'`.

- [ ] **Step 3: Write `adminApi.js`**

Create `server/services/ops/connections/ga4/adminApi.js`:

```js
/**
 * GA4 Admin API v1beta REST wrapper.
 * Authenticates via GA4_SERVICE_ACCOUNT_KEY or ADC using google-auth-library.
 * All list functions accept an injectable fetchFn so tests need no network.
 */
import { GoogleAuth } from 'google-auth-library';

const ADMIN_BASE = 'https://analyticsadmin.googleapis.com/v1beta';
const SCOPES = ['https://www.googleapis.com/auth/analytics.readonly'];

export async function getAdminAccessToken({ env = process.env } = {}) {
  const keyJson = env.GA4_SERVICE_ACCOUNT_KEY;
  const authOpts = keyJson
    ? { credentials: JSON.parse(keyJson), scopes: SCOPES }
    : { scopes: SCOPES }; // ADC fallback
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
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/ga4AdminApi.test.js
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/ga4/adminApi.js server/services/ops/__tests__/ga4AdminApi.test.js
git commit -m "feat(ops/ga4): Admin API REST wrapper (account summaries, data streams, key events)"
```

---

### Task 3: Report parser + `discoverInventory`

**Files:**
- Create: `server/services/ops/connections/ga4/_reportParser.js`
- Create: `server/services/ops/connections/ga4/inventory.js`
- Test: `server/services/ops/__tests__/ga4Inventory.test.js`

**Interfaces:**
- Consumes: `listAccountSummaries`, `listDataStreams`, `listKeyEvents`, `getAdminAccessToken` (all injectable via `ctx`).
- Produces:
  - `parseRows(response, metricNames): Array<{ dimensions: Record<string,string>, metrics: Record<string,number> }>` — exported from `_reportParser.js`. Handles `null`/empty `response.rows` by returning `[]`. `metricNames` must match the order requested in the report.
  - `aggregateFirstRow(response, metricNames): Record<string,number>` — returns `rows[0].metrics` or all-zero record if no rows.
  - `discoverInventory(ctx): Promise<InventoryRow[]>` where `InventoryRow = { object_type, external_id, display_name, metadata: object, discovered_at: string }`. `ctx` accepts `{ env?, token?, fetchFn? }` for full injection.
  - Inventory row `object_type` values: `'ga4_account'`, `'ga4_property'`, `'ga4_data_stream'`, `'ga4_key_event'`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/ga4Inventory.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRows, aggregateFirstRow } from '../connections/ga4/_reportParser.js';
import { discoverInventory } from '../connections/ga4/inventory.js';

// --- parseRows ---

test('parseRows: empty response returns []', () => {
  assert.deepEqual(parseRows(null, ['sessions']), []);
  assert.deepEqual(parseRows({ rows: null }, ['sessions']), []);
  assert.deepEqual(parseRows({ rows: [] }, ['sessions']), []);
});

test('parseRows: parses dimension and metric values correctly', () => {
  const response = {
    dimensionHeaders: [{ name: 'sessionDefaultChannelGrouping' }],
    metricHeaders: [{ name: 'sessions' }, { name: 'keyEvents' }],
    rows: [
      { dimensionValues: [{ value: 'Organic Search' }], metricValues: [{ value: '1234' }, { value: '56' }] }
    ]
  };
  const rows = parseRows(response, ['sessions', 'keyEvents']);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].dimensions, { sessionDefaultChannelGrouping: 'Organic Search' });
  assert.equal(rows[0].metrics.sessions, 1234);
  assert.equal(rows[0].metrics.keyEvents, 56);
});

test('aggregateFirstRow: returns all-zero record when no rows', () => {
  const result = aggregateFirstRow({ rows: [] }, ['sessions', 'totalUsers']);
  assert.deepEqual(result, { sessions: 0, totalUsers: 0 });
});

test('aggregateFirstRow: returns first row metrics', () => {
  const response = {
    dimensionHeaders: [],
    metricHeaders: [{ name: 'sessions' }],
    rows: [{ dimensionValues: [], metricValues: [{ value: '999' }] }]
  };
  assert.equal(aggregateFirstRow(response, ['sessions']).sessions, 999);
});

// --- discoverInventory ---

function makeAdminFetch(responses) {
  // responses: { [urlSubstring]: object }
  return async (url) => {
    const key = Object.keys(responses).find((k) => url.includes(k));
    const body = key ? responses[key] : {};
    return { ok: true, json: async () => body, text: async () => '' };
  };
}

test('discoverInventory builds rows for account, property, data stream, and key event', async () => {
  const fetchFn = makeAdminFetch({
    accountSummaries: {
      accountSummaries: [{
        account: 'accounts/111',
        displayName: 'Acme Inc',
        propertySummaries: [{
          property: 'properties/222',
          displayName: 'Acme Website',
          propertyType: 'PROPERTY_TYPE_ORDINARY'
        }]
      }]
    },
    'properties/222/dataStreams': {
      dataStreams: [{
        name: 'properties/222/dataStreams/333',
        displayName: 'Web Stream',
        type: 'WEB_DATA_STREAM',
        webStreamData: { measurementId: 'G-ACME1234' }
      }]
    },
    'properties/222/keyEvents': {
      keyEvents: [{
        name: 'properties/222/keyEvents/444',
        eventName: 'generate_lead',
        countingMethod: 'ONCE_PER_EVENT'
      }]
    }
  });

  const rows = await discoverInventory({ token: 'fake', fetchFn });

  const byType = (t) => rows.filter((r) => r.object_type === t);
  assert.equal(byType('ga4_account').length, 1);
  assert.equal(byType('ga4_property').length, 1);
  assert.equal(byType('ga4_data_stream').length, 1);
  assert.equal(byType('ga4_key_event').length, 1);

  const prop = byType('ga4_property')[0];
  assert.equal(prop.external_id, 'properties/222');
  assert.equal(prop.display_name, 'Acme Website');

  const stream = byType('ga4_data_stream')[0];
  assert.equal(stream.metadata.measurement_id, 'G-ACME1234');

  const ke = byType('ga4_key_event')[0];
  assert.equal(ke.display_name, 'generate_lead');
  assert.equal(ke.metadata.event_name, 'generate_lead');

  // All rows have discovered_at as an ISO string
  assert.ok(rows.every((r) => typeof r.discovered_at === 'string'));
});

test('discoverInventory handles Admin API errors on sub-resources gracefully', async () => {
  // dataStreams fails for this property — should still return account + property rows
  const fetchFn = makeAdminFetch({
    accountSummaries: {
      accountSummaries: [{
        account: 'accounts/111',
        displayName: 'Acme',
        propertySummaries: [{ property: 'properties/222', displayName: 'Acme Web', propertyType: 'PROPERTY_TYPE_ORDINARY' }]
      }]
    },
    // dataStreams and keyEvents return 500 — caught internally
  });
  const badFetch = async (url) => {
    if (url.includes('accountSummaries')) return (await fetchFn(url));
    return { ok: false, status: 500, text: async () => 'error' };
  };

  const rows = await discoverInventory({ token: 'fake', fetchFn: badFetch });
  // account + property rows still present despite sub-resource failures
  assert.ok(rows.some((r) => r.object_type === 'ga4_account'));
  assert.ok(rows.some((r) => r.object_type === 'ga4_property'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/ga4Inventory.test.js
```

Expected: FAIL — `Cannot find module '../connections/ga4/_reportParser.js'`.

- [ ] **Step 3: Write `_reportParser.js`**

Create `server/services/ops/connections/ga4/_reportParser.js`:

```js
/**
 * Pure GA4 Data API response parser. Shared by snapshot.js and checks/index.js.
 * metricNames must match the order declared in the report request.
 */

export function parseRows(response, metricNames) {
  if (!response || !response.rows || !response.rows.length) return [];
  const dimHeaders = (response.dimensionHeaders || []).map((h) => h.name);
  return response.rows.map((row) => {
    const dimensions = {};
    (row.dimensionValues || []).forEach((dv, i) => { dimensions[dimHeaders[i]] = dv.value; });
    const metrics = {};
    metricNames.forEach((name, i) => {
      metrics[name] = Number((row.metricValues || [])[i]?.value ?? 0);
    });
    return { dimensions, metrics };
  });
}

export function aggregateFirstRow(response, metricNames) {
  const rows = parseRows(response, metricNames);
  return rows[0]?.metrics ?? Object.fromEntries(metricNames.map((n) => [n, 0]));
}
```

- [ ] **Step 4: Write `inventory.js`**

Create `server/services/ops/connections/ga4/inventory.js`:

```js
/**
 * GA4 discoverInventory — maps Admin API resources to ops_platform_inventory rows.
 * ctx: { env?, token?, fetchFn? }
 *   token    — pre-fetched bearer token (for tests; omit to fetch from credentials)
 *   fetchFn  — injectable fetch (for tests; defaults to globalThis.fetch)
 */
import { getAdminAccessToken, listAccountSummaries, listDataStreams, listKeyEvents } from './adminApi.js';

export async function discoverInventory(ctx = {}) {
  const { env = process.env, fetchFn = globalThis.fetch } = ctx;
  const token = ctx.token ?? await getAdminAccessToken({ env });

  const accounts = await listAccountSummaries({ token, fetchFn });
  const now = new Date().toISOString();
  const rows = [];

  for (const account of accounts) {
    rows.push({
      object_type: 'ga4_account',
      external_id: account.account,
      display_name: account.displayName || account.account,
      metadata: { account_id: account.account },
      discovered_at: now
    });

    for (const ps of account.propertySummaries || []) {
      const propertyId = ps.property;              // 'properties/123456789'
      const numericId = propertyId.split('/').pop();

      rows.push({
        object_type: 'ga4_property',
        external_id: propertyId,
        display_name: ps.displayName || propertyId,
        metadata: {
          property_id: propertyId,
          property_type: ps.propertyType || null,
          account_id: account.account
        },
        discovered_at: now
      });

      // Sub-resource failures are caught individually so a 403 on one property
      // does not abort the entire account walk.
      const streams = await listDataStreams(numericId, { token, fetchFn }).catch(() => []);
      for (const stream of streams) {
        rows.push({
          object_type: 'ga4_data_stream',
          external_id: stream.name,
          display_name: stream.displayName || stream.name,
          metadata: {
            property_id: propertyId,
            stream_type: stream.type || null,
            measurement_id: stream.webStreamData?.measurementId || null
          },
          discovered_at: now
        });
      }

      const keyEvents = await listKeyEvents(numericId, { token, fetchFn }).catch(() => []);
      for (const ke of keyEvents) {
        rows.push({
          object_type: 'ga4_key_event',
          external_id: ke.name,
          display_name: ke.eventName,
          metadata: {
            property_id: propertyId,
            event_name: ke.eventName,
            counting_method: ke.countingMethod || null
          },
          discovered_at: now
        });
      }
    }
  }

  return rows;
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/ga4Inventory.test.js
```

Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/connections/ga4/_reportParser.js server/services/ops/connections/ga4/inventory.js server/services/ops/__tests__/ga4Inventory.test.js
git commit -m "feat(ops/ga4): report parser + discoverInventory (Admin API walk)"
```

---

### Task 4: `collectSnapshot`

**Files:**
- Create: `server/services/ops/connections/ga4/snapshot.js`
- Test: `server/services/ops/__tests__/ga4Snapshot.test.js`

**Interfaces:**
- Consumes: `buildGa4Client` (injectable), `parseRows`, `aggregateFirstRow`.
- Produces:
  - `collectSnapshot(ctx): Promise<SnapshotRow[]>` where `SnapshotRow = { metric_name: string, metric_value: number, dimensions: Record<string,string>, metadata: object }`.
  - `ctx`: `{ env?, propertyId: string, ga4Client?, dateRange? }`. `propertyId` is required (throws `Error('GA4 collectSnapshot: propertyId is required')` if absent).
  - Normalized `metric_name` values: `'sessions'`, `'users'`, `'engagement_rate'`, `'key_events'`, `'conversion_rate'`, `'event_count'`.
  - Runs five reports: overall, by channel, by source/medium (top 50), by landing page (top 20), by event name (filtered to `['generate_lead','form_submit','click','phone_call_click','contact']`).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/ga4Snapshot.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSnapshot } from '../connections/ga4/snapshot.js';

// A fake BetaAnalyticsDataClient whose runReport returns minimal but valid data.
// Returns the same shape for every call; different calls are distinguished by
// which dimensions/metrics are present in the request.
function makeFakeClient(overrides = {}) {
  return {
    runReport: async (req) => {
      const dims = (req.dimensions || []).map((d) => d.name);
      const mets = (req.metrics || []).map((m) => m.name);

      // Build one synthetic row per report type
      const dimValues = dims.map((d) => {
        const MAP = {
          sessionDefaultChannelGrouping: 'Organic Search',
          sessionSourceMedium: 'google / organic',
          landingPage: '/',
          eventName: 'generate_lead'
        };
        return { value: MAP[d] || 'unknown' };
      });
      const metValues = mets.map((m) => {
        const MAP = {
          sessions: '1234', totalUsers: '900', engagementRate: '0.62',
          keyEvents: '80', sessionKeyEventRate: '0.065', eventCount: '45'
        };
        return { value: MAP[m] || '0' };
      });

      return [{
        dimensionHeaders: dims.map((n) => ({ name: n })),
        metricHeaders: mets.map((n) => ({ name: n })),
        rows: dimValues.length === 0 && metValues.length === 0 ? [] :
          [{ dimensionValues: dimValues, metricValues: metValues }],
        ...(overrides[mets.join(',')] || {})
      }];
    }
  };
}

test('collectSnapshot throws when propertyId is missing', async () => {
  await assert.rejects(
    () => collectSnapshot({ ga4Client: makeFakeClient(), env: {} }),
    /propertyId is required/
  );
});

test('collectSnapshot returns rows with the five normalized overall metrics', async () => {
  const rows = await collectSnapshot({
    ga4Client: makeFakeClient(),
    propertyId: '123456789',
    env: {}
  });

  const overallMetrics = rows
    .filter((r) => Object.keys(r.dimensions).length === 0)
    .map((r) => r.metric_name);

  assert.ok(overallMetrics.includes('sessions'), 'sessions present');
  assert.ok(overallMetrics.includes('users'), 'users present');
  assert.ok(overallMetrics.includes('engagement_rate'), 'engagement_rate present');
  assert.ok(overallMetrics.includes('key_events'), 'key_events present');
  assert.ok(overallMetrics.includes('conversion_rate'), 'conversion_rate present');
});

test('collectSnapshot returns channel-dimension rows', async () => {
  const rows = await collectSnapshot({ ga4Client: makeFakeClient(), propertyId: '123456789', env: {} });
  const channelRows = rows.filter((r) => r.dimensions.channel != null);
  assert.ok(channelRows.length > 0, 'at least one channel row returned');
  assert.ok(channelRows.every((r) => typeof r.metric_value === 'number'), 'metric_value is a number');
});

test('collectSnapshot returns source_medium-dimension rows', async () => {
  const rows = await collectSnapshot({ ga4Client: makeFakeClient(), propertyId: '123456789', env: {} });
  const smRows = rows.filter((r) => r.dimensions.source_medium != null);
  assert.ok(smRows.length > 0);
  assert.equal(smRows[0].dimensions.source_medium, 'google / organic');
});

test('collectSnapshot returns landing_page-dimension rows', async () => {
  const rows = await collectSnapshot({ ga4Client: makeFakeClient(), propertyId: '123456789', env: {} });
  const lpRows = rows.filter((r) => r.dimensions.landing_page != null);
  assert.ok(lpRows.length > 0);
});

test('collectSnapshot returns event_count rows for event dimension', async () => {
  const rows = await collectSnapshot({ ga4Client: makeFakeClient(), propertyId: '123456789', env: {} });
  const eventRows = rows.filter((r) => r.dimensions.event_name != null && r.metric_name === 'event_count');
  assert.ok(eventRows.length > 0);
  assert.equal(eventRows[0].dimensions.event_name, 'generate_lead');
});

test('collectSnapshot all rows have required shape', async () => {
  const rows = await collectSnapshot({ ga4Client: makeFakeClient(), propertyId: '123456789', env: {} });
  assert.ok(rows.length > 0);
  for (const row of rows) {
    assert.ok('metric_name' in row, 'metric_name');
    assert.ok('metric_value' in row, 'metric_value');
    assert.ok('dimensions' in row, 'dimensions');
    assert.ok('metadata' in row, 'metadata');
    assert.equal(typeof row.metric_value, 'number');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/ga4Snapshot.test.js
```

Expected: FAIL — `Cannot find module '../connections/ga4/snapshot.js'`.

- [ ] **Step 3: Write `snapshot.js`**

Create `server/services/ops/connections/ga4/snapshot.js`:

```js
/**
 * GA4 collectSnapshot — runs five Data API reports and normalizes to the
 * ops_daily_snapshots row shape: { metric_name, metric_value, dimensions, metadata }.
 *
 * Normalized metric_name values (north-star spec §F6):
 *   sessions, users, engagement_rate, key_events, conversion_rate, event_count
 *
 * ctx: { env?, propertyId: string, ga4Client?, dateRange? }
 */
import { buildGa4Client } from './client.js';
import { parseRows, aggregateFirstRow } from './_reportParser.js';

export async function collectSnapshot(ctx = {}) {
  const {
    env = process.env,
    propertyId,
    ga4Client: injectedClient = null,
    dateRange = { startDate: '7daysAgo', endDate: 'yesterday' }
  } = ctx;

  if (!propertyId) throw new Error('GA4 collectSnapshot: propertyId is required');

  const client = buildGa4Client({ env, ga4Client: injectedClient });
  const property = `properties/${propertyId}`;
  const periodKey = `${dateRange.startDate}:${dateRange.endDate}`;
  const rows = [];

  // Report 1: overall metrics (no dimensions)
  const [overallResp] = await client.runReport({
    property,
    dateRanges: [dateRange],
    metrics: [
      { name: 'sessions' },
      { name: 'totalUsers' },
      { name: 'engagementRate' },
      { name: 'keyEvents' },
      { name: 'sessionKeyEventRate' }
    ]
  });

  const overall = aggregateFirstRow(overallResp, ['sessions', 'totalUsers', 'engagementRate', 'keyEvents', 'sessionKeyEventRate']);
  const NORMALIZED = [
    ['sessions',        'sessions'],
    ['users',           'totalUsers'],
    ['engagement_rate', 'engagementRate'],
    ['key_events',      'keyEvents'],
    ['conversion_rate', 'sessionKeyEventRate']
  ];
  for (const [metricName, rawKey] of NORMALIZED) {
    rows.push({ metric_name: metricName, metric_value: overall[rawKey] ?? 0, dimensions: {}, metadata: { period: periodKey } });
  }

  // Report 2: sessions + key_events by channel
  const [channelResp] = await client.runReport({
    property,
    dateRanges: [dateRange],
    dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
    metrics: [{ name: 'sessions' }, { name: 'keyEvents' }]
  });
  for (const r of parseRows(channelResp, ['sessions', 'keyEvents'])) {
    const channel = r.dimensions.sessionDefaultChannelGrouping;
    rows.push({ metric_name: 'sessions',   metric_value: r.metrics.sessions,   dimensions: { channel }, metadata: { period: periodKey } });
    rows.push({ metric_name: 'key_events', metric_value: r.metrics.keyEvents,  dimensions: { channel }, metadata: { period: periodKey } });
  }

  // Report 3: sessions by source/medium (top 50)
  const [smResp] = await client.runReport({
    property,
    dateRanges: [dateRange],
    dimensions: [{ name: 'sessionSourceMedium' }],
    metrics: [{ name: 'sessions' }],
    limit: 50
  });
  for (const r of parseRows(smResp, ['sessions'])) {
    rows.push({
      metric_name: 'sessions',
      metric_value: r.metrics.sessions,
      dimensions: { source_medium: r.dimensions.sessionSourceMedium },
      metadata: { period: periodKey }
    });
  }

  // Report 4: sessions + conversion_rate by landing page (top 20)
  const [lpResp] = await client.runReport({
    property,
    dateRanges: [dateRange],
    dimensions: [{ name: 'landingPage' }],
    metrics: [{ name: 'sessions' }, { name: 'sessionKeyEventRate' }],
    limit: 20
  });
  for (const r of parseRows(lpResp, ['sessions', 'sessionKeyEventRate'])) {
    const landing_page = r.dimensions.landingPage;
    rows.push({ metric_name: 'sessions',        metric_value: r.metrics.sessions,             dimensions: { landing_page }, metadata: { period: periodKey } });
    rows.push({ metric_name: 'conversion_rate', metric_value: r.metrics.sessionKeyEventRate,  dimensions: { landing_page }, metadata: { period: periodKey } });
  }

  // Report 5: event_count by event name (form submits, phone clicks, CTAs)
  const [eventResp] = await client.runReport({
    property,
    dateRanges: [dateRange],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: ['generate_lead', 'form_submit', 'click', 'phone_call_click', 'contact'] }
      }
    }
  });
  for (const r of parseRows(eventResp, ['eventCount'])) {
    rows.push({
      metric_name: 'event_count',
      metric_value: r.metrics.eventCount,
      dimensions: { event_name: r.dimensions.eventName },
      metadata: { period: periodKey }
    });
  }

  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/ga4Snapshot.test.js
```

Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/ga4/snapshot.js server/services/ops/__tests__/ga4Snapshot.test.js
git commit -m "feat(ops/ga4): collectSnapshot — five Data API reports normalized to snapshot rows"
```

---

### Task 5: Check pure-logic functions

**Files:**
- Create: `server/services/ops/connections/ga4/checks/_logic.js`
- Test: `server/services/ops/__tests__/ga4CheckLogic.test.js`

**Interfaces:**
- Produces (all pure — no I/O):
  - `checkDrop({ current, baseline, thresholdPct?, metricName? }): Result` — returns `status: 'skipped'` when `baseline` is `null` or `0`; `status: 'fail'` when `(baseline - current) / baseline >= thresholdPct` (default 0.20); else `status: 'pass'`. All results include `{ drop_pct, current, baseline, metric }`.
  - `checkKeyEventMissing({ keyEventCounts, expectedKeyEventNames }): Result` — `keyEventCounts` is `Record<eventName, number>`; returns `status: 'fail'` with `missing_key_events: string[]` if any expected event has count `=== 0`; else `status: 'pass'`.
  - `checkFormEventNotFiring({ eventCounts, formEventNames? }): Result` — `formEventNames` defaults to `['generate_lead', 'form_submit']`; `status: 'fail'` when ALL form events are zero; else `status: 'pass'` with `firing` and `not_firing` arrays.
  - `checkAdsClicksVsSessionsGap({ adsClicks, ga4PaidSessions, thresholdPct? }): Result` — `status: 'skipped'` when `adsClicks == null` or `=== 0`; `status: 'fail'` when `(adsClicks - ga4PaidSessions) / adsClicks >= thresholdPct` (default 0.30); else `status: 'pass'`.
  - `checkSourceMediumAnomaly({ currentBySourceMedium, baselineBySourceMedium, thresholdPct? }): Result` — `status: 'skipped'` when baseline is empty; `status: 'fail'` with `anomalies` array when any source/medium changes by more than `thresholdPct` (default 0.30) in absolute value; else `status: 'pass'`.
  - All `severity` values: `'error'` (key event completely absent), `'warning'` (drops, gaps, anomalies), absent for `pass`/`skipped`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/ga4CheckLogic.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkDrop,
  checkKeyEventMissing,
  checkFormEventNotFiring,
  checkAdsClicksVsSessionsGap,
  checkSourceMediumAnomaly
} from '../connections/ga4/checks/_logic.js';

// --- checkDrop ---

test('checkDrop: skipped when baseline is null', () => {
  const r = checkDrop({ current: 800, baseline: null, metricName: 'sessions' });
  assert.equal(r.status, 'skipped');
  assert.ok(/baseline/.test(r.reason));
});

test('checkDrop: skipped when baseline is 0', () => {
  assert.equal(checkDrop({ current: 0, baseline: 0 }).status, 'skipped');
});

test('checkDrop: fail when drop >= 20%', () => {
  const r = checkDrop({ current: 750, baseline: 1000, thresholdPct: 0.2, metricName: 'sessions' });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.equal(r.drop_pct, 25); // (1000-750)/1000 = 25%
  assert.equal(r.current, 750);
  assert.equal(r.baseline, 1000);
});

test('checkDrop: pass when drop < 20%', () => {
  const r = checkDrop({ current: 900, baseline: 1000, thresholdPct: 0.2 });
  assert.equal(r.status, 'pass');
  assert.equal(r.drop_pct, 10);
});

test('checkDrop: pass when traffic increased', () => {
  const r = checkDrop({ current: 1200, baseline: 1000, thresholdPct: 0.2 });
  assert.equal(r.status, 'pass');
  assert.ok(r.drop_pct < 0, 'negative drop means growth');
});

// --- checkKeyEventMissing ---

test('checkKeyEventMissing: pass when all expected events have counts', () => {
  const r = checkKeyEventMissing({
    keyEventCounts: { generate_lead: 5, purchase: 2 },
    expectedKeyEventNames: ['generate_lead', 'purchase']
  });
  assert.equal(r.status, 'pass');
});

test('checkKeyEventMissing: fail when a key event has 0 count', () => {
  const r = checkKeyEventMissing({
    keyEventCounts: { generate_lead: 0, purchase: 3 },
    expectedKeyEventNames: ['generate_lead', 'purchase']
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'error');
  assert.deepEqual(r.missing_key_events, ['generate_lead']);
});

test('checkKeyEventMissing: treats absent key as 0', () => {
  const r = checkKeyEventMissing({
    keyEventCounts: {},
    expectedKeyEventNames: ['generate_lead']
  });
  assert.equal(r.status, 'fail');
  assert.deepEqual(r.missing_key_events, ['generate_lead']);
});

// --- checkFormEventNotFiring ---

test('checkFormEventNotFiring: pass when at least one form event fires', () => {
  const r = checkFormEventNotFiring({ eventCounts: { generate_lead: 3, form_submit: 0 } });
  assert.equal(r.status, 'pass');
  assert.deepEqual(r.firing, ['generate_lead']);
  assert.deepEqual(r.not_firing, ['form_submit']);
});

test('checkFormEventNotFiring: fail when all form events are zero', () => {
  const r = checkFormEventNotFiring({ eventCounts: { generate_lead: 0, form_submit: 0 } });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.deepEqual(r.not_firing, ['generate_lead', 'form_submit']);
});

test('checkFormEventNotFiring: custom formEventNames accepted', () => {
  const r = checkFormEventNotFiring({
    eventCounts: { contact_form: 5 },
    formEventNames: ['contact_form', 'newsletter_signup']
  });
  assert.equal(r.status, 'pass');
});

// --- checkAdsClicksVsSessionsGap ---

test('checkAdsClicksVsSessionsGap: skipped when adsClicks is null', () => {
  const r = checkAdsClicksVsSessionsGap({ adsClicks: null, ga4PaidSessions: 100 });
  assert.equal(r.status, 'skipped');
  assert.ok(/adsClicks/.test(r.reason));
});

test('checkAdsClicksVsSessionsGap: skipped when adsClicks is 0', () => {
  assert.equal(checkAdsClicksVsSessionsGap({ adsClicks: 0, ga4PaidSessions: 0 }).status, 'skipped');
});

test('checkAdsClicksVsSessionsGap: fail when gap >= 30%', () => {
  // 1000 clicks, only 600 paid sessions → 40% gap
  const r = checkAdsClicksVsSessionsGap({ adsClicks: 1000, ga4PaidSessions: 600, thresholdPct: 0.3 });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.equal(r.gap_pct, 40);
});

test('checkAdsClicksVsSessionsGap: pass when gap < 30%', () => {
  const r = checkAdsClicksVsSessionsGap({ adsClicks: 1000, ga4PaidSessions: 800 });
  assert.equal(r.status, 'pass');
  assert.equal(r.gap_pct, 20);
});

// --- checkSourceMediumAnomaly ---

test('checkSourceMediumAnomaly: skipped when baseline is empty', () => {
  const r = checkSourceMediumAnomaly({ currentBySourceMedium: {}, baselineBySourceMedium: {} });
  assert.equal(r.status, 'skipped');
});

test('checkSourceMediumAnomaly: pass when changes are within threshold', () => {
  const r = checkSourceMediumAnomaly({
    currentBySourceMedium: { 'google / organic': 900 },
    baselineBySourceMedium: { 'google / organic': 1000 },
    thresholdPct: 0.3
  });
  assert.equal(r.status, 'pass');
  assert.equal(r.sources_checked, 1);
});

test('checkSourceMediumAnomaly: fail when a source/medium changes > 30%', () => {
  const r = checkSourceMediumAnomaly({
    currentBySourceMedium: { 'google / cpc': 200, 'google / organic': 950 },
    baselineBySourceMedium: { 'google / cpc': 1000, 'google / organic': 1000 },
    thresholdPct: 0.3
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.equal(r.anomalies.length, 1);
  assert.equal(r.anomalies[0].source_medium, 'google / cpc');
  assert.equal(r.anomalies[0].change_pct, -80); // dropped 80%
});

test('checkSourceMediumAnomaly: spike (increase) also flags as anomaly', () => {
  const r = checkSourceMediumAnomaly({
    currentBySourceMedium: { 'direct / none': 5000 },
    baselineBySourceMedium: { 'direct / none': 100 },
    thresholdPct: 0.3
  });
  assert.equal(r.status, 'fail');
  assert.ok(r.anomalies[0].change_pct > 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/ga4CheckLogic.test.js
```

Expected: FAIL — `Cannot find module '../connections/ga4/checks/_logic.js'`.

- [ ] **Step 3: Write `checks/_logic.js`**

Create `server/services/ops/connections/ga4/checks/_logic.js`:

```js
/**
 * Pure GA4 check logic. Zero I/O — accepts plain data, returns check result.
 * All functions return { status, severity?, ...fields }.
 * severity: 'error' (event completely absent) | 'warning' (drops/gaps) | absent for pass/skipped.
 */

/** Round a fraction to two decimal places as a percentage. e.g. 0.256 → 25.6 → 26 */
function roundPct(fraction) {
  return Math.round(fraction * 10000) / 100;
}

/**
 * Generic drop check — compares current vs baseline value.
 * @param {{ current: number, baseline: number|null, thresholdPct?: number, metricName?: string }}
 */
export function checkDrop({ current, baseline, thresholdPct = 0.2, metricName = 'metric' }) {
  if (baseline == null) {
    return { status: 'skipped', reason: `no baseline for ${metricName}` };
  }
  if (baseline === 0) {
    return { status: 'skipped', reason: `baseline is zero for ${metricName}` };
  }
  const dropFraction = (baseline - current) / baseline;
  const drop_pct = roundPct(dropFraction);
  if (dropFraction >= thresholdPct) {
    return { status: 'fail', severity: 'warning', metric: metricName, current, baseline, drop_pct };
  }
  return { status: 'pass', metric: metricName, current, baseline, drop_pct };
}

/**
 * Key event missing — any expected event with count === 0 is a hard failure.
 * @param {{ keyEventCounts: Record<string,number>, expectedKeyEventNames: string[] }}
 */
export function checkKeyEventMissing({ keyEventCounts, expectedKeyEventNames }) {
  const missing = expectedKeyEventNames.filter((e) => (keyEventCounts[e] ?? 0) === 0);
  if (missing.length) {
    return { status: 'fail', severity: 'error', missing_key_events: missing };
  }
  return { status: 'pass', checked_key_events: expectedKeyEventNames };
}

/**
 * Form event not firing — fails only when ALL form events are zero.
 * @param {{ eventCounts: Record<string,number>, formEventNames?: string[] }}
 */
export function checkFormEventNotFiring({
  eventCounts,
  formEventNames = ['generate_lead', 'form_submit']
}) {
  const firing    = formEventNames.filter((e) => (eventCounts[e] ?? 0) > 0);
  const not_firing = formEventNames.filter((e) => (eventCounts[e] ?? 0) === 0);
  if (firing.length === 0) {
    return { status: 'fail', severity: 'warning', expected: formEventNames, not_firing };
  }
  return { status: 'pass', firing, not_firing };
}

/**
 * Ads clicks vs GA4 paid sessions gap.
 * Skipped when adsClicks is not provided (cross-connector data).
 * @param {{ adsClicks: number|null, ga4PaidSessions: number, thresholdPct?: number }}
 */
export function checkAdsClicksVsSessionsGap({ adsClicks, ga4PaidSessions, thresholdPct = 0.3 }) {
  if (adsClicks == null) {
    return {
      status: 'skipped',
      reason: 'adsClicks not provided — populate ctx.adsClicks from the Google Ads connector or correlator'
    };
  }
  if (adsClicks === 0) {
    return { status: 'skipped', reason: 'zero ad clicks in period' };
  }
  const gapFraction = (adsClicks - ga4PaidSessions) / adsClicks;
  const gap_pct = roundPct(gapFraction);
  if (gapFraction >= thresholdPct) {
    return { status: 'fail', severity: 'warning', ads_clicks: adsClicks, ga4_paid_sessions: ga4PaidSessions, gap_pct };
  }
  return { status: 'pass', ads_clicks: adsClicks, ga4_paid_sessions: ga4PaidSessions, gap_pct };
}

/**
 * Source/medium anomaly — flags sources that changed by more than thresholdPct in either direction.
 * @param {{ currentBySourceMedium: Record<string,number>, baselineBySourceMedium: Record<string,number>, thresholdPct?: number }}
 */
export function checkSourceMediumAnomaly({
  currentBySourceMedium,
  baselineBySourceMedium,
  thresholdPct = 0.3
}) {
  if (!baselineBySourceMedium || Object.keys(baselineBySourceMedium).length === 0) {
    return { status: 'skipped', reason: 'no source/medium baseline' };
  }
  const anomalies = [];
  for (const [sm, baselineVal] of Object.entries(baselineBySourceMedium)) {
    if (baselineVal === 0) continue;
    const current = currentBySourceMedium[sm] ?? 0;
    const changeFraction = (current - baselineVal) / baselineVal;
    if (Math.abs(changeFraction) >= thresholdPct) {
      anomalies.push({
        source_medium: sm,
        change_pct: roundPct(changeFraction),
        current,
        baseline: baselineVal
      });
    }
  }
  if (anomalies.length) {
    return { status: 'fail', severity: 'warning', anomalies };
  }
  return { status: 'pass', sources_checked: Object.keys(baselineBySourceMedium).length };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/ga4CheckLogic.test.js
```

Expected: PASS (18 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/ga4/checks/_logic.js server/services/ops/__tests__/ga4CheckLogic.test.js
git commit -m "feat(ops/ga4): pure check-logic functions (drop, key-event, form, ads-gap, source-medium)"
```

---

### Task 6: Check handlers + `GA4_CHECKS` array

**Files:**
- Create: `server/services/ops/connections/ga4/checks/index.js`
- Test: `server/services/ops/__tests__/ga4CheckHandlers.test.js`

**Interfaces:**
- Consumes: `buildGa4Client`, `getCredential` (from `credentialStore.js`), `query` (from `db.js`), `parseRows`, `aggregateFirstRow`, all five pure-logic functions.
- Produces:
  - `GA4_CHECKS: Array<{ id, tier, requiredCapabilities: string[], handler: async (ctx) => CheckResult }>` where `CheckResult = { status, severity?: string, payload: object }`.
  - Handler `ctx` shape for injection in tests: `{ ga4Client, ga4PropertyId, ga4Baseline? }` (bypasses credential/DB lookup when both are present). For production: `{ clientUserId, env?, serviceConnectionId? }`.
  - `ga4Baseline`: optional `Record<metricName, number>` injected in tests; production handlers fall back to `ops_metric_baselines` table (returns `null` → `skipped` if table absent).
  - The 10 check IDs: `ga4.connection_health`, `ga4.traffic_drop`, `ga4.paid_search_sessions_drop`, `ga4.organic_sessions_drop`, `ga4.key_event_drop`, `ga4.key_event_missing`, `ga4.landing_page_conversion_drop`, `ga4.ads_clicks_vs_sessions_gap`, `ga4.form_event_not_firing`, `ga4.source_medium_anomaly`.
  - `ga4.connection_health` is `tier: 'daily_essential'`; all others are `tier: 'weekly_deep'`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/ga4CheckHandlers.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { GA4_CHECKS } from '../connections/ga4/checks/index.js';

// Helper: find a check by ID
function getCheck(id) {
  const c = GA4_CHECKS.find((c) => c.id === id);
  if (!c) throw new Error(`Check not found: ${id}`);
  return c;
}

// Base fake BetaAnalyticsDataClient — runReport returns empty rows by default.
// Individual tests override for the specific metric they need.
function makeClient(overrideRows = []) {
  return {
    runReport: async () => [{
      dimensionHeaders: [],
      metricHeaders: [],
      rows: overrideRows,
      ...({})
    }]
  };
}

// Fake client that returns different rows based on which metrics are requested
function makeClientByMetrics(metricMap) {
  return {
    runReport: async (req) => {
      const key = (req.metrics || []).map((m) => m.name).join(',');
      const dims = (req.dimensions || []).map((d) => d.name);
      const rows = metricMap[key] || metricMap['default'] || [];
      return [{
        dimensionHeaders: dims.map((n) => ({ name: n })),
        metricHeaders: (req.metrics || []).map((m) => ({ name: m.name })),
        rows
      }];
    }
  };
}

const BASE_CTX = { clientUserId: 'test-client', ga4PropertyId: '123456789' };

// --- ga4.connection_health ---

test('ga4.connection_health: pass when runReport succeeds', async () => {
  const check = getCheck('ga4.connection_health');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]) };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'pass');
  assert.ok(result.payload.property_id === '123456789');
});

test('ga4.connection_health: fail when runReport throws', async () => {
  const check = getCheck('ga4.connection_health');
  const ctx = { ...BASE_CTX, ga4Client: { runReport: async () => { throw new Error('permission denied'); } } };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.ok(/permission denied/.test(result.payload.error));
});

test('ga4.connection_health: skipped when no propertyId', async () => {
  const check = getCheck('ga4.connection_health');
  const result = await check.handler({ clientUserId: 'test-client' }); // no ga4PropertyId, no DB
  assert.equal(result.status, 'skipped');
});

// --- ga4.traffic_drop ---

test('ga4.traffic_drop: fail when sessions dropped > 20%', async () => {
  const check = getCheck('ga4.traffic_drop');
  // overall report: sessions=800, others=0
  const client = makeClientByMetrics({
    'sessions,totalUsers,engagementRate,keyEvents,sessionKeyEventRate': [{
      dimensionValues: [], metricValues: [{ value: '800' }, { value: '0' }, { value: '0' }, { value: '0' }, { value: '0' }]
    }],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, ga4Baseline: { sessions: 1000 } };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(result.payload.drop_pct, 20);
});

test('ga4.traffic_drop: skipped when no baseline', async () => {
  const check = getCheck('ga4.traffic_drop');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]), ga4Baseline: {} };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'skipped');
});

// --- ga4.paid_search_sessions_drop ---

test('ga4.paid_search_sessions_drop: fail when paid sessions dropped > 20%', async () => {
  const check = getCheck('ga4.paid_search_sessions_drop');
  const client = makeClientByMetrics({
    'sessions,keyEvents': [{
      dimensionValues: [{ value: 'Paid Search' }],
      metricValues: [{ value: '400' }, { value: '20' }]
    }],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, ga4Baseline: { paid_search_sessions: 600 } };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
});

// --- ga4.organic_sessions_drop ---

test('ga4.organic_sessions_drop: pass when organic sessions within threshold', async () => {
  const check = getCheck('ga4.organic_sessions_drop');
  const client = makeClientByMetrics({
    'sessions,keyEvents': [{
      dimensionValues: [{ value: 'Organic Search' }],
      metricValues: [{ value: '900' }, { value: '40' }]
    }],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, ga4Baseline: { organic_sessions: 1000 } };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'pass');
});

// --- ga4.key_event_drop ---

test('ga4.key_event_drop: fail when key events dropped > 20%', async () => {
  const check = getCheck('ga4.key_event_drop');
  const client = makeClientByMetrics({
    'sessions,totalUsers,engagementRate,keyEvents,sessionKeyEventRate': [{
      dimensionValues: [], metricValues: [{ value: '1000' }, { value: '0' }, { value: '0' }, { value: '40' }, { value: '0' }]
    }],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, ga4Baseline: { key_events: 100 } };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(result.payload.drop_pct, 60);
});

// --- ga4.key_event_missing ---

test('ga4.key_event_missing: fail when a configured key event has 0 count', async () => {
  const check = getCheck('ga4.key_event_missing');
  const client = makeClientByMetrics({
    'eventCount': [
      { dimensionValues: [{ value: 'purchase' }], metricValues: [{ value: '10' }] }
      // generate_lead absent → treated as 0
    ],
    default: []
  });
  // expectedKeyEventNames injected via ctx.ga4ExpectedKeyEvents
  const ctx = { ...BASE_CTX, ga4Client: client, ga4ExpectedKeyEvents: ['generate_lead', 'purchase'] };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.deepEqual(result.payload.missing_key_events, ['generate_lead']);
});

test('ga4.key_event_missing: skipped when no expectedKeyEvents configured', async () => {
  const check = getCheck('ga4.key_event_missing');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]) };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'skipped');
});

// --- ga4.landing_page_conversion_drop ---

test('ga4.landing_page_conversion_drop: fail when top landing page conversion dropped', async () => {
  const check = getCheck('ga4.landing_page_conversion_drop');
  const client = makeClientByMetrics({
    'sessions,sessionKeyEventRate': [{
      dimensionValues: [{ value: '/' }],
      metricValues: [{ value: '1000' }, { value: '0.02' }]  // 2% conversion rate
    }],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, ga4Baseline: { landing_page_conversion_rate: 0.05 } }; // was 5%
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
});

// --- ga4.ads_clicks_vs_sessions_gap ---

test('ga4.ads_clicks_vs_sessions_gap: skipped when ctx.adsClicks is absent', async () => {
  const check = getCheck('ga4.ads_clicks_vs_sessions_gap');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]) };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'skipped');
  assert.ok(/adsClicks/.test(result.payload.reason));
});

test('ga4.ads_clicks_vs_sessions_gap: fail when gap >= 30%', async () => {
  const check = getCheck('ga4.ads_clicks_vs_sessions_gap');
  // byChannel: Paid Search has 500 sessions
  const client = makeClientByMetrics({
    'sessions,keyEvents': [
      { dimensionValues: [{ value: 'Paid Search' }], metricValues: [{ value: '500' }, { value: '20' }] }
    ],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client, adsClicks: 1000 };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(result.payload.gap_pct, 50);
});

// --- ga4.form_event_not_firing ---

test('ga4.form_event_not_firing: fail when all form events are zero', async () => {
  const check = getCheck('ga4.form_event_not_firing');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]) };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(result.severity, 'warning');
});

test('ga4.form_event_not_firing: pass when generate_lead is firing', async () => {
  const check = getCheck('ga4.form_event_not_firing');
  const client = makeClientByMetrics({
    'eventCount': [
      { dimensionValues: [{ value: 'generate_lead' }], metricValues: [{ value: '8' }] }
    ],
    default: []
  });
  const ctx = { ...BASE_CTX, ga4Client: client };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'pass');
});

// --- ga4.source_medium_anomaly ---

test('ga4.source_medium_anomaly: skipped when no baseline', async () => {
  const check = getCheck('ga4.source_medium_anomaly');
  const ctx = { ...BASE_CTX, ga4Client: makeClient([]), ga4Baseline: {} };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'skipped');
});

test('ga4.source_medium_anomaly: fail when a source/medium drops > 30%', async () => {
  const check = getCheck('ga4.source_medium_anomaly');
  const client = makeClientByMetrics({
    'sessions': [
      { dimensionValues: [{ value: 'google / cpc' }], metricValues: [{ value: '200' }] }
    ],
    default: []
  });
  const ctx = {
    ...BASE_CTX,
    ga4Client: client,
    ga4Baseline: { 'source_medium:google / cpc': 1000 }
  };
  const result = await check.handler(ctx);
  assert.equal(result.status, 'fail');
  assert.equal(result.anomalies[0].source_medium, 'google / cpc');
});

// --- GA4_CHECKS structural contract ---

test('GA4_CHECKS has exactly 10 entries with required shape', () => {
  assert.equal(GA4_CHECKS.length, 10);
  const VALID_TIERS = new Set(['daily_essential', 'weekly_deep']);
  for (const check of GA4_CHECKS) {
    assert.ok(typeof check.id === 'string' && check.id.startsWith('ga4.'), `id format: ${check.id}`);
    assert.ok(VALID_TIERS.has(check.tier), `tier: ${check.tier}`);
    assert.ok(Array.isArray(check.requiredCapabilities), `requiredCapabilities array`);
    assert.ok(typeof check.handler === 'function', `handler function`);
  }
});

test('ga4.connection_health has tier daily_essential', () => {
  const c = getCheck('ga4.connection_health');
  assert.equal(c.tier, 'daily_essential');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/ga4CheckHandlers.test.js
```

Expected: FAIL — `Cannot find module '../connections/ga4/checks/index.js'`.

- [ ] **Step 3: Write `checks/index.js`**

Create `server/services/ops/connections/ga4/checks/index.js`:

```js
/**
 * GA4 check handlers. Exported as GA4_CHECKS array (not registered in
 * checks/registry.js — that registry enforces umbrella∈{website,google_ads,meta,ctm}).
 * F1's updated registry will call registerConnector(ga4Connector) which wires these in.
 *
 * Each handler:
 *   1. Resolves ga4 context (client + propertyId) — returns skipped if unavailable.
 *   2. Fetches one targeted Data API report.
 *   3. Calls the matching pure function from _logic.js.
 *   4. Returns { status, severity, payload }.
 *
 * Injectable ctx fields for tests:
 *   ctx.ga4Client        — fake BetaAnalyticsDataClient
 *   ctx.ga4PropertyId    — numeric GA4 property ID string
 *   ctx.ga4Baseline      — Record<metricName, number> (skips ops_metric_baselines lookup)
 *   ctx.ga4ExpectedKeyEvents — string[] (skips client_platform_credentials lookup)
 *   ctx.adsClicks        — number (cross-connector; null → skipped)
 */
import { query } from '../../../../db.js';
import { getCredential } from '../../../credentialStore.js';
import { buildGa4Client } from '../client.js';
import { parseRows, aggregateFirstRow } from '../_reportParser.js';
import {
  checkDrop,
  checkKeyEventMissing,
  checkFormEventNotFiring,
  checkAdsClicksVsSessionsGap,
  checkSourceMediumAnomaly
} from './_logic.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function getGa4Context(ctx) {
  // Test fast-path: both client and propertyId injected directly.
  if (ctx.ga4Client && ctx.ga4PropertyId) {
    return { kind: 'ok', client: ctx.ga4Client, propertyId: String(ctx.ga4PropertyId) };
  }
  // Production path: look up credential row (platform: 'ga4', account_id = property ID).
  const cred = await getCredential(ctx.clientUserId, 'ga4').catch(() => null);
  if (!cred) return { kind: 'skipped', reason: 'no GA4 credential configured for this client (platform: ga4)' };
  const propertyId = cred.account_id;
  if (!propertyId) return { kind: 'skipped', reason: 'GA4 credential row has no account_id (expected the numeric GA4 property ID)' };
  const env = ctx.env || process.env;
  const client = buildGa4Client({ env, ga4Client: null });
  return { kind: 'ok', client, propertyId };
}

async function getBaseline(ctx, metricKey) {
  // Test injection: ctx.ga4Baseline is a Record<metricKey, number>
  if (ctx.ga4Baseline != null && ctx.ga4Baseline[metricKey] !== undefined) {
    return ctx.ga4Baseline[metricKey];
  }
  // Production: query ops_metric_baselines (F3). Returns null if table absent.
  if (!ctx.serviceConnectionId) return null;
  try {
    const { rows } = await query(
      `SELECT metric_value FROM ops_metric_baselines
        WHERE service_connection_id = $1 AND metric_name = $2
        ORDER BY updated_at DESC LIMIT 1`,
      [ctx.serviceConnectionId, metricKey]
    );
    return rows[0]?.metric_value ?? null;
  } catch {
    return null; // ops_metric_baselines does not exist yet (F3 not shipped)
  }
}

function wrap(result, extra = {}) {
  return {
    status: result.status,
    severity: result.severity || null,
    payload: { ...result, ...extra }
  };
}

const DATE_RANGE = { startDate: '7daysAgo', endDate: 'yesterday' };
const DATE_RANGE_30 = { startDate: '30daysAgo', endDate: 'yesterday' };

// ---------------------------------------------------------------------------
// Check handlers
// ---------------------------------------------------------------------------

async function handleConnectionHealth(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  try {
    await c.client.runReport({
      property: `properties/${c.propertyId}`,
      dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
      metrics: [{ name: 'sessions' }],
      limit: 1
    });
    return { status: 'pass', severity: null, payload: { property_id: c.propertyId, detail: 'GA4 Data API reachable' } };
  } catch (err) {
    return { status: 'fail', severity: 'error', payload: { property_id: c.propertyId, error: err?.message || String(err) } };
  }
}

async function handleTrafficDrop(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagementRate' }, { name: 'keyEvents' }, { name: 'sessionKeyEventRate' }]
  });
  const agg = aggregateFirstRow(resp, ['sessions', 'totalUsers', 'engagementRate', 'keyEvents', 'sessionKeyEventRate']);
  const baseline = await getBaseline(ctx, 'sessions');
  return wrap(checkDrop({ current: agg.sessions, baseline, metricName: 'sessions' }), { property_id: c.propertyId });
}

async function handleChannelSessionsDrop(ctx, channelGroup, baselineKey) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
    metrics: [{ name: 'sessions' }, { name: 'keyEvents' }]
  });
  const rows = parseRows(resp, ['sessions', 'keyEvents']);
  const row = rows.find((r) => r.dimensions.sessionDefaultChannelGrouping === channelGroup);
  const current = row?.metrics.sessions ?? 0;
  const baseline = await getBaseline(ctx, baselineKey);
  return wrap(checkDrop({ current, baseline, metricName: baselineKey }), { property_id: c.propertyId, channel: channelGroup });
}

async function handleKeyEventDrop(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    metrics: [{ name: 'sessions' }, { name: 'totalUsers' }, { name: 'engagementRate' }, { name: 'keyEvents' }, { name: 'sessionKeyEventRate' }]
  });
  const agg = aggregateFirstRow(resp, ['sessions', 'totalUsers', 'engagementRate', 'keyEvents', 'sessionKeyEventRate']);
  const baseline = await getBaseline(ctx, 'key_events');
  return wrap(checkDrop({ current: agg.keyEvents, baseline, metricName: 'key_events' }), { property_id: c.propertyId });
}

async function handleKeyEventMissing(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  // Expected key event names: injected via ctx.ga4ExpectedKeyEvents, or skipped.
  const expectedKeyEventNames = ctx.ga4ExpectedKeyEvents || null;
  if (!expectedKeyEventNames || expectedKeyEventNames.length === 0) {
    return { status: 'skipped', severity: null, payload: { reason: 'no expected key events configured (set ctx.ga4ExpectedKeyEvents)' } };
  }
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE_30],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: { fieldName: 'eventName', inListFilter: { values: expectedKeyEventNames } }
    }
  });
  const rows = parseRows(resp, ['eventCount']);
  const keyEventCounts = Object.fromEntries(
    rows.map((r) => [r.dimensions.eventName, r.metrics.eventCount])
  );
  return wrap(checkKeyEventMissing({ keyEventCounts, expectedKeyEventNames }), { property_id: c.propertyId });
}

async function handleLandingPageConversionDrop(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    dimensions: [{ name: 'landingPage' }],
    metrics: [{ name: 'sessions' }, { name: 'sessionKeyEventRate' }],
    limit: 1  // top landing page by sessions
  });
  const rows = parseRows(resp, ['sessions', 'sessionKeyEventRate']);
  if (!rows.length) return { status: 'skipped', severity: null, payload: { reason: 'no landing page data returned' } };
  const topPage = rows[0];
  const current = topPage.metrics.sessionKeyEventRate;
  const baseline = await getBaseline(ctx, 'landing_page_conversion_rate');
  return wrap(
    checkDrop({ current, baseline, thresholdPct: 0.25, metricName: 'landing_page_conversion_rate' }),
    { property_id: c.propertyId, landing_page: topPage.dimensions.landingPage }
  );
}

async function handleAdsClicksVsSessionsGap(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    dimensions: [{ name: 'sessionDefaultChannelGrouping' }],
    metrics: [{ name: 'sessions' }, { name: 'keyEvents' }]
  });
  const rows = parseRows(resp, ['sessions', 'keyEvents']);
  const paidRow = rows.find((r) => r.dimensions.sessionDefaultChannelGrouping === 'Paid Search');
  const ga4PaidSessions = paidRow?.metrics.sessions ?? 0;
  const adsClicks = ctx.adsClicks ?? null; // cross-connector; caller injects
  return wrap(checkAdsClicksVsSessionsGap({ adsClicks, ga4PaidSessions }), { property_id: c.propertyId });
}

async function handleFormEventNotFiring(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const formEventNames = ctx.ga4FormEventNames || ['generate_lead', 'form_submit'];
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    dimensions: [{ name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: { fieldName: 'eventName', inListFilter: { values: formEventNames } }
    }
  });
  const rows = parseRows(resp, ['eventCount']);
  const eventCounts = Object.fromEntries(
    rows.map((r) => [r.dimensions.eventName, r.metrics.eventCount])
  );
  return wrap(checkFormEventNotFiring({ eventCounts, formEventNames }), { property_id: c.propertyId });
}

async function handleSourceMediumAnomaly(ctx) {
  const c = await getGa4Context(ctx);
  if (c.kind !== 'ok') return { status: 'skipped', severity: null, payload: { reason: c.reason } };
  const [resp] = await c.client.runReport({
    property: `properties/${c.propertyId}`,
    dateRanges: [DATE_RANGE],
    dimensions: [{ name: 'sessionSourceMedium' }],
    metrics: [{ name: 'sessions' }],
    limit: 50
  });
  const rows = parseRows(resp, ['sessions']);
  const currentBySourceMedium = Object.fromEntries(
    rows.map((r) => [r.dimensions.sessionSourceMedium, r.metrics.sessions])
  );
  // Baseline keyed as 'source_medium:<source / medium>'
  const baselineBySourceMedium = {};
  for (const sm of Object.keys(currentBySourceMedium)) {
    const val = await getBaseline(ctx, `source_medium:${sm}`);
    if (val != null) baselineBySourceMedium[sm] = val;
  }
  const result = checkSourceMediumAnomaly({ currentBySourceMedium, baselineBySourceMedium });
  return wrap(result, { property_id: c.propertyId });
}

// ---------------------------------------------------------------------------
// Exported checks array
// ---------------------------------------------------------------------------

export const GA4_CHECKS = [
  {
    id: 'ga4.connection_health',
    tier: 'daily_essential',
    requiredCapabilities: ['read'],
    handler: handleConnectionHealth
  },
  {
    id: 'ga4.traffic_drop',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleTrafficDrop
  },
  {
    id: 'ga4.paid_search_sessions_drop',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: (ctx) => handleChannelSessionsDrop(ctx, 'Paid Search', 'paid_search_sessions')
  },
  {
    id: 'ga4.organic_sessions_drop',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: (ctx) => handleChannelSessionsDrop(ctx, 'Organic Search', 'organic_sessions')
  },
  {
    id: 'ga4.key_event_drop',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleKeyEventDrop
  },
  {
    id: 'ga4.key_event_missing',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleKeyEventMissing
  },
  {
    id: 'ga4.landing_page_conversion_drop',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleLandingPageConversionDrop
  },
  {
    id: 'ga4.ads_clicks_vs_sessions_gap',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleAdsClicksVsSessionsGap
  },
  {
    id: 'ga4.form_event_not_firing',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleFormEventNotFiring
  },
  {
    id: 'ga4.source_medium_anomaly',
    tier: 'weekly_deep',
    requiredCapabilities: ['read'],
    handler: handleSourceMediumAnomaly
  }
];
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/ga4CheckHandlers.test.js
```

Expected: PASS (20 tests).

- [ ] **Step 5: Run full ops suite for regressions**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops
```

Expected: all prior tests PASS; the six new ga4 test files PASS. Zero regressions.

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/connections/ga4/checks/index.js server/services/ops/__tests__/ga4CheckHandlers.test.js
git commit -m "feat(ops/ga4): GA4_CHECKS array — 10 check handlers wired to pure logic"
```

---

### Task 7: Connector final assembly

**Files:**
- Create: `server/services/ops/connections/ga4/index.js`

**Interfaces:**
- Consumes: `buildGa4Client`, `discoverInventory`, `collectSnapshot`, `GA4_CHECKS`.
- Produces: default export conforming exactly to spec §5:
  ```
  {
    id: 'ga4',
    serviceCategory: 'analytics',
    provider: 'ga4',
    connectionTypes: ['service_account'],
    verifyConnection(ctx),     // → { status, detail, capabilities }
    discoverInventory(ctx),    // → inventory rows
    collectSnapshot(ctx),      // → snapshot rows
    listCapabilities(ctx),     // → capability map
    checks: GA4_CHECKS         // 10-entry array
  }
  ```
- `verifyConnection` returns `{ status: 'verified', detail, capabilities: ['read'] }` on success; `{ status: 'failed', detail: err.message, capabilities: [] }` on any throw.
- `listCapabilities` returns `{ read: true, mutate: false, crawl: false, inspect_html: false }`.

- [ ] **Step 1: Write `connections/ga4/index.js`**

Create `server/services/ops/connections/ga4/index.js`:

```js
/**
 * GA4 connector — analytics/ga4.
 * Implements the north-star §5 connector contract.
 *
 * Credential resolution: GA4_SERVICE_ACCOUNT_KEY (JSON string) or ADC.
 * No Secret Manager dependency (spec §3.1).
 *
 * Checks: GA4_CHECKS (10 entries). Not registered in checks/registry.js
 * (umbrella enforcement); F1's registerConnector() will wire them in.
 */
import { buildGa4Client } from './client.js';
import { discoverInventory } from './inventory.js';
import { collectSnapshot } from './snapshot.js';
import { GA4_CHECKS } from './checks/index.js';

async function verifyConnection(ctx = {}) {
  const { env = process.env, propertyId, ga4Client: injected = null } = ctx;
  if (!propertyId) {
    return { status: 'failed', detail: 'verifyConnection: propertyId is required in ctx', capabilities: [] };
  }
  try {
    const client = buildGa4Client({ env, ga4Client: injected });
    await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
      metrics: [{ name: 'sessions' }],
      limit: 1
    });
    return {
      status: 'verified',
      detail: `GA4 Data API reachable for property ${propertyId}`,
      capabilities: ['read']
    };
  } catch (err) {
    return {
      status: 'failed',
      detail: err?.message || String(err),
      capabilities: []
    };
  }
}

async function listCapabilities(_ctx = {}) {
  return {
    read: true,
    mutate: false,
    crawl: false,
    inspect_html: false
  };
}

export default {
  id: 'ga4',
  serviceCategory: 'analytics',
  provider: 'ga4',
  connectionTypes: ['service_account'],
  verifyConnection,
  discoverInventory,
  collectSnapshot,
  listCapabilities,
  checks: GA4_CHECKS
};
```

- [ ] **Step 2: Verify the module graph loads without errors**

```bash
node -e "import('./server/services/ops/connections/ga4/index.js').then((m) => { const c = m.default; console.log('connector id:', c.id, '| checks:', c.checks.length); }).catch((e) => { console.error(e); process.exit(1); })"
```

Expected output: `connector id: ga4 | checks: 10`

- [ ] **Step 3: Verify spec §5 shape**

```bash
node -e "
import('./server/services/ops/connections/ga4/index.js').then((m) => {
  const c = m.default;
  const required = ['id','serviceCategory','provider','connectionTypes','verifyConnection','discoverInventory','collectSnapshot','listCapabilities','checks'];
  const missing = required.filter((k) => !(k in c));
  if (missing.length) { console.error('MISSING KEYS:', missing); process.exit(1); }
  console.log('spec §5 shape: OK');
  console.log('checks:', c.checks.map((x) => x.id).join(', '));
}).catch((e) => { console.error(e); process.exit(1); })
"
```

Expected: `spec §5 shape: OK` followed by all 10 check IDs on one line.

- [ ] **Step 4: Full regression suite**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops
```

Expected: all tests PASS; zero regressions from the six new test files.

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/ga4/index.js
git commit -m "feat(ops/ga4): connector assembly — verifyConnection + listCapabilities + spec §5 export (F6 complete)"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Covered by |
|---|---|
| F6 connector: `verifyConnection` | Task 7 `index.js` |
| F6 connector: `discoverInventory` (account/property/stream/measurement_id/key_events) | Task 3 `inventory.js` |
| F6 connector: `collectSnapshot` (sessions, users, engagement_rate, key_events, conversion_rate; by channel/source-medium/landing_page/event) | Task 4 `snapshot.js` |
| F6 connector: `listCapabilities` | Task 7 `index.js` |
| Spec §5 connector contract shape | Task 7 default export |
| GA4 cred via `GA4_SERVICE_ACCOUNT_KEY` or ADC | Tasks 1 + 2 |
| `ga4.connection_health` | Task 6 |
| `ga4.traffic_drop` | Task 6 |
| `ga4.paid_search_sessions_drop` | Task 6 |
| `ga4.organic_sessions_drop` | Task 6 |
| `ga4.key_event_drop` | Task 6 |
| `ga4.key_event_missing` | Task 6 |
| `ga4.landing_page_conversion_drop` | Task 6 |
| `ga4.ads_clicks_vs_sessions_gap` | Task 6 |
| `ga4.form_event_not_firing` | Task 6 |
| `ga4.source_medium_anomaly` | Task 6 |
| No LLM math | enforced throughout — no AI inference |
| No Secret Manager | Global Constraints; only env-var / ADC |
| Check logic PURE/injectable | Tasks 5 + 6 (`_logic.js` + handler DI pattern) |
| Baselines gracefully absent (F3 not built) | `getBaseline` catches missing table; returns `null` → `status: 'skipped'` |
| F1 connector registry not called | Global Constraints — `GA4_CHECKS` exported, not registered via old `registerCheck` |

**Deferred (not gaps):**
- `ga4.ads_clicks_vs_sessions_gap` requires `ctx.adsClicks` from the Google Ads connector. Until a correlator or caller populates it, the check self-reports `skipped`. This is correct per the cross-connector reasoning note in spec §F6.
- `ga4.key_event_missing` requires `ctx.ga4ExpectedKeyEvents` to be populated by F1's inventory (key events discovered via Admin API). Until F1 ships, callers pass this explicitly or the check returns `skipped`.
- Storing snapshot/inventory rows to DB is F1/F3 responsibility. `collectSnapshot` + `discoverInventory` return the row shapes; persistence is wired by the connector executor in F1.

**Placeholder scan:** No TBD/TODO/implement-later present. The `getBaseline` DB path is fully implemented (catches missing table). The `getGa4Context` production path is fully implemented via `credentialStore.getCredential`. The only "skipped" returns are intentional run-time no-ops documented with reasons — not implementation gaps.

**Type consistency:**
- `parseRows` called the same way in `snapshot.js` and `checks/index.js` (both import from `_reportParser.js`).
- `aggregateFirstRow` returns `Record<rawMetricName, number>` — used consistently in `handleTrafficDrop` and `handleKeyEventDrop` with the correct raw names (`sessions`, `keyEvents`).
- `GA4_CHECKS` entries each carry `{ id, tier, requiredCapabilities, handler }` — the handler test asserts this shape for all 10 entries.
- `checkDrop` `thresholdPct` default is `0.2` (20%) for traffic/key-events; `handleLandingPageConversionDrop` explicitly passes `0.25` (25%) — intentional, more conservative for landing page conversion. Documented in handler.
- `wrap(result, extra)` always produces `{ status, severity, payload }` — consistent across all 10 handlers.
