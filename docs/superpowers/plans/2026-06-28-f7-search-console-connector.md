# F7 — Search Console Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the single stub `checks/website/gsc.js` into a full `organic_search/search_console` connector conforming to the spec §5 contract — with service-account auth, inventory discovery, normalized snapshots, and 11 deterministic checks — while keeping all existing `web.gsc.*` check IDs working unchanged via a backward-compatible shim.

**Architecture:** A new `server/services/ops/connections/gsc/` package holds five focused modules (auth, propertyMatcher, inventory, snapshot, checks) plus a thin connector index. A `ops_gsc_site_inventory` table persists per-client property matches and match confidence until F1's `ops_platform_inventory` supersedes it. The existing `checks/website/gsc.js` becomes a 5-line shim that re-imports from the new package. Every module is dependency-injected so all logic is unit-testable with zero network/DB calls. Drop checks self-compute 2-period deltas (current 7d vs prior 7d) so they work without F3 baselines.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, `google-auth-library` (already in `package.json`), global `fetch` (Node 18+), `pg` via `server/db.js`. No new npm dependencies.

## Global Constraints

- **No new npm dependencies.** `google-auth-library` is already at `^10.6.2`. Use `GoogleAuth` from it. Do NOT add `googleapis`.
- **Credentials: env-var / Postgres, NOT Secret Manager** (spec §3.1). Auth priority: `GA4_SERVICE_ACCOUNT_KEY` (JSON string) → ADC (`GOOGLE_APPLICATION_CREDENTIALS` or `K_SERVICE`) → per-client OAuth from `client_platform_credentials`.
- **Connector contract = spec §5 locked interface.** The connector index exports `{ id, serviceCategory, provider, connectionTypes, verifyConnection, discoverInventory, collectSnapshot, listCapabilities, checks }`.
- **Do NOT break existing `web.gsc.*` checks.** The shim in `checks/website/gsc.js` must keep all four original check IDs registered and returning valid result shapes. Proven by a test.
- **No LLM math; no PHI.** Snapshots store numeric aggregates only. No per-person rows.
- **Property matching priority (north-star §6.4):** `exact_config → sc-domain: → url-prefix https www → url-prefix https → url-prefix http → manual`. Persist `match_type` + `match_confidence` in `ops_gsc_site_inventory`.
- **New migration:** `server/sql/migrate_ops_gsc_site_inventory.sql` + append `'migrate_ops_gsc_site_inventory.sql'` to `MIGRATIONS_BEFORE_SEED` in `server/migrations.js` (after `'migrate_ops_blog_ssh.sql'`).
- **DB tests:** `DATABASE_URL=postgresql://bif@localhost:5432/anchor`; run with `yarn test:ops`; `node:test` + `node:assert/strict`. Pure logic (property matching, check math) has zero DB/network; DB-touching tests use real Postgres.
- **`discoverInventory` returns** rows conforming to the F1 `ops_platform_inventory` row shape (spec §2.3) AND persists to `ops_gsc_site_inventory`. When F1 lands, the persistence layer additionally writes to `ops_platform_inventory`; no code changes needed in the connector.
- **`collectSnapshot` returns** rows conforming to the F3 `ops_daily_snapshots` row shape (spec §2.4) but does NOT persist — F3 owns persistence. The connector returns the array; the caller persists.
- **F1/F3 tables do not exist yet.** Write against their documented shapes only. Do NOT import from any unbuilt file. See §Dependency note below.

**Dependency note:** F1 (`ops_service_connections`, `ops_platform_inventory`, connector registry) and F3 (`ops_daily_snapshots`, baselines) are not built. This plan's connector is self-contained: it registers checks via the existing `checks/registry.js` with `umbrella: 'website'` (F1's shim will translate to `serviceCategory: 'organic_search'` when it arrives). `discoverInventory` and `collectSnapshot` return documented row shapes for callers to persist; no import of F1/F3 modules.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/sql/migrate_ops_gsc_site_inventory.sql` | Create `ops_gsc_site_inventory` — per-client GSC property match cache with confidence. |
| `server/migrations.js` | Append the migration filename. |
| `server/services/ops/connections/gsc/auth.js` | `resolveGscToken(opts)` — service-account primary, ADC fallback, per-client OAuth last. Injectable `_createAuth` for tests. |
| `server/services/ops/connections/gsc/propertyMatcher.js` | Pure `matchProperty(websiteUrl, siteList, exactConfig?)` + `propertyType(siteUrl)`. No DB/network. |
| `server/services/ops/connections/gsc/inventory.js` | `discoverInventory(opts)` — list sites, match property, persist to `ops_gsc_site_inventory`, return `ops_platform_inventory`-shaped rows. `getMatchedSite(clientUserId, opts)` — read cache or discover live. |
| `server/services/ops/connections/gsc/snapshot.js` | `collectSnapshot(opts)` — query Search Console analytics API for aggregate/page/query/device data; return `ops_daily_snapshots`-shaped rows. |
| `server/services/ops/connections/gsc/checks.js` | 11 check handler factories (`makeXxxCheck(deps)`) + default `registerCheck` calls for all 11 `gsc.*` IDs (umbrella: 'website'). |
| `server/services/ops/connections/gsc/index.js` | Connector object conforming to spec §5 contract. |
| `server/services/ops/checks/website/gsc.js` | **Rewritten shim** — imports handlers from `connections/gsc/checks.js`; re-registers the 4 original `web.gsc.*` IDs unchanged. |
| `server/services/ops/__tests__/gscAuth.test.js` | Injectable `_createAuth` tests for all auth paths. |
| `server/services/ops/__tests__/gscPropertyMatcher.test.js` | Pure property matching + priority order tests. |
| `server/services/ops/__tests__/gscInventory.test.js` | Fake `_listSites` + `_persistInventory` tests; DB round-trip for `ops_gsc_site_inventory`. |
| `server/services/ops/__tests__/gscSnapshot.test.js` | Fake `_queryAnalytics`; verifies all 4 dimension types + row shape. |
| `server/services/ops/__tests__/gscChecks.test.js` | All 11 check factories with injected fakes; pure logic only. |
| `server/services/ops/__tests__/gscConnectorShim.test.js` | Verifies 4 original `web.gsc.*` IDs still registered + return valid shapes. |

---

### Task 1: Migration — ops_gsc_site_inventory

**Files:**
- Create: `server/sql/migrate_ops_gsc_site_inventory.sql`
- Modify: `server/migrations.js`
- Test: `server/services/ops/__tests__/gscInventory.test.js` (DB portion — full test file written in Task 4)

**Interfaces:**
- Produces: `ops_gsc_site_inventory(id, client_user_id, site_url, permission_level, property_type, match_type, match_confidence, website_url, discovered_at)`, `UNIQUE(client_user_id, site_url)`.

- [ ] **Step 1: Write the migration SQL**

Create `server/sql/migrate_ops_gsc_site_inventory.sql`:

```sql
-- F7 — GSC property-to-client match cache (north-star §6.4).
-- One row per (client, GSC property). Upserted by discoverInventory().
-- Superseded by ops_platform_inventory when F1 lands; this table stays as-is
-- and both can be written to simultaneously.
CREATE TABLE IF NOT EXISTS ops_gsc_site_inventory (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id   uuid NOT NULL,
  site_url         text NOT NULL,
  permission_level text,
  property_type    text NOT NULL CHECK (property_type IN ('domain', 'url_prefix')),
  match_type       text NOT NULL CHECK (match_type IN (
                     'exact_config', 'sc_domain',
                     'url_prefix_https_www', 'url_prefix_https',
                     'url_prefix_http', 'manual')),
  match_confidence numeric(4,3) NOT NULL DEFAULT 0
                     CHECK (match_confidence >= 0 AND match_confidence <= 1),
  website_url      text,
  discovered_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (client_user_id, site_url)
);

CREATE INDEX IF NOT EXISTS idx_ops_gsc_inventory_client
  ON ops_gsc_site_inventory (client_user_id, match_confidence DESC);
```

- [ ] **Step 2: Register the migration**

In `server/migrations.js`, locate the `MIGRATIONS_BEFORE_SEED` array. After `'migrate_ops_blog_ssh.sql'` append:

```js
  'migrate_ops_blog_ssh.sql',
  'migrate_ops_gsc_site_inventory.sql',
```

- [ ] **Step 3: Run the migration locally**

```bash
yarn db:migrate
```

Expected: `[migrations] applied migrate_ops_gsc_site_inventory.sql` then `[migrations] all ops migrations completed`. Re-running is a no-op (idempotent).

- [ ] **Step 4: Commit**

```bash
git add server/sql/migrate_ops_gsc_site_inventory.sql server/migrations.js
git commit -m "feat(ops/gsc): ops_gsc_site_inventory — property match cache"
```

---

### Task 2: Auth helper — resolveGscToken

**Files:**
- Create: `server/services/ops/connections/gsc/auth.js`
- Test: `server/services/ops/__tests__/gscAuth.test.js`

**Interfaces:**
- Produces:
  - `resolveGscToken({ env?, oauthFallback?, _createAuth? }): Promise<string|null>` — returns a Bearer access token string, or `null` when no credentials are available.
  - `_createAuth` is injectable: `(googleAuthOpts) => { getAccessToken: async () => string|null }`. In production this is `(opts) => new GoogleAuth(opts)`.
  - Priority: `GA4_SERVICE_ACCOUNT_KEY` JSON string → ADC (when `GOOGLE_APPLICATION_CREDENTIALS` or `K_SERVICE` present) → `oauthFallback()` → `null`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/gscAuth.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGscToken } from '../connections/gsc/auth.js';

test('resolveGscToken: uses GA4_SERVICE_ACCOUNT_KEY when present', async () => {
  const fakeKey = JSON.stringify({ type: 'service_account', client_email: 'sa@p.iam.gserviceaccount.com' });
  let capturedOpts;
  const _createAuth = (opts) => {
    capturedOpts = opts;
    return { getAccessToken: async () => 'sa-token' };
  };
  const token = await resolveGscToken({ env: { GA4_SERVICE_ACCOUNT_KEY: fakeKey }, _createAuth });
  assert.equal(token, 'sa-token');
  assert.equal(capturedOpts.credentials.type, 'service_account');
  assert.deepEqual(capturedOpts.scopes, ['https://www.googleapis.com/auth/webmasters.readonly']);
});

test('resolveGscToken: falls through to ADC on K_SERVICE when SA key absent', async () => {
  let callCount = 0;
  const _createAuth = (opts) => {
    callCount += 1;
    // first call (SA key path) never reached; second call (ADC path) returns token
    return { getAccessToken: async () => (opts.credentials ? null : 'adc-token') };
  };
  const token = await resolveGscToken({ env: { K_SERVICE: 'anchor-ops' }, _createAuth });
  assert.equal(token, 'adc-token');
});

test('resolveGscToken: falls through to ADC on GOOGLE_APPLICATION_CREDENTIALS', async () => {
  const _createAuth = (opts) => ({ getAccessToken: async () => (opts.credentials ? null : 'adc-token-2') });
  const token = await resolveGscToken({
    env: { GOOGLE_APPLICATION_CREDENTIALS: '/var/secrets/sa.json' },
    _createAuth
  });
  assert.equal(token, 'adc-token-2');
});

test('resolveGscToken: uses oauthFallback when no service credentials', async () => {
  const token = await resolveGscToken({ env: {}, oauthFallback: async () => 'oauth-token' });
  assert.equal(token, 'oauth-token');
});

test('resolveGscToken: returns null when nothing is configured', async () => {
  const token = await resolveGscToken({ env: {}, _createAuth: () => ({ getAccessToken: async () => null }) });
  assert.equal(token, null);
});

test('resolveGscToken: falls through gracefully when SA key JSON is malformed', async () => {
  const token = await resolveGscToken({
    env: { GA4_SERVICE_ACCOUNT_KEY: 'not-json' },
    oauthFallback: async () => 'fallback-token'
  });
  assert.equal(token, 'fallback-token');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gscAuth.test.js
```

Expected: FAIL — `Cannot resolve '../connections/gsc/auth.js'`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/connections/gsc/auth.js`:

```js
/**
 * GSC authentication — resolves a Bearer token for Search Console REST calls.
 *
 * Auth priority (north-star §6, spec §3.1 env-var/Postgres model):
 *   1. GA4_SERVICE_ACCOUNT_KEY (JSON string in env) — service account
 *   2. ADC — GOOGLE_APPLICATION_CREDENTIALS file or Cloud Run metadata
 *   3. oauthFallback() — caller-supplied per-client OAuth token
 *   4. null (no credentials configured)
 *
 * _createAuth is injectable for tests: (googleAuthOpts) => { getAccessToken }
 * In production it defaults to (opts) => new GoogleAuth(opts).
 */
import { GoogleAuth } from 'google-auth-library';

const GSC_SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];

export async function resolveGscToken({
  env = process.env,
  oauthFallback = null,
  _createAuth = null
} = {}) {
  const makeAuth = _createAuth || ((opts) => new GoogleAuth(opts));

  // 1. Service account JSON from env
  const keyJson = env.GA4_SERVICE_ACCOUNT_KEY;
  if (keyJson) {
    try {
      const credentials = JSON.parse(keyJson);
      const token = await makeAuth({ credentials, scopes: GSC_SCOPES }).getAccessToken();
      if (token) return token;
    } catch {
      // malformed JSON or token fetch failed — fall through
    }
  }

  // 2. ADC (GOOGLE_APPLICATION_CREDENTIALS file or Cloud Run metadata server)
  if (env.GOOGLE_APPLICATION_CREDENTIALS || env.K_SERVICE) {
    try {
      const token = await makeAuth({ scopes: GSC_SCOPES }).getAccessToken();
      if (token) return token;
    } catch {
      // ADC not available — fall through
    }
  }

  // 3. Per-client OAuth token (caller provides)
  if (typeof oauthFallback === 'function') {
    return await oauthFallback();
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/gscAuth.test.js
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/gsc/auth.js server/services/ops/__tests__/gscAuth.test.js
git commit -m "feat(ops/gsc): resolveGscToken — service account / ADC / OAuth priority chain"
```

---

### Task 3: Property matcher (pure)

**Files:**
- Create: `server/services/ops/connections/gsc/propertyMatcher.js`
- Test: `server/services/ops/__tests__/gscPropertyMatcher.test.js`

**Interfaces:**
- Produces (all pure — no DB, no network):
  - `matchProperty(websiteUrl: string, siteList: Array<{siteUrl, permissionLevel}>, exactConfig?: string|null): { siteUrl: string|null, permissionLevel: string|null, matchType: string, confidence: number }` — returns the best-matching GSC property for `websiteUrl` according to the north-star §6.4 priority chain.
  - `propertyType(siteUrl: string): 'domain'|'url_prefix'` — `sc-domain:*` → `'domain'`; everything else → `'url_prefix'`.
  - `matchType` vocabulary (ordered): `'exact_config' | 'sc_domain' | 'url_prefix_https_www' | 'url_prefix_https' | 'url_prefix_http' | 'manual'`.
  - `confidence` values: `exact_config=1.0`, `sc_domain=0.95`, `url_prefix_https_www=0.9`, `url_prefix_https=0.85`, `url_prefix_http=0.7`, `manual=0`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/gscPropertyMatcher.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchProperty, propertyType } from '../connections/gsc/propertyMatcher.js';

const SITES = [
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  { siteUrl: 'https://www.example.com/', permissionLevel: 'siteFullUser' },
  { siteUrl: 'https://example.com/', permissionLevel: 'siteRestrictedUser' }
];

test('exact_config wins when exactConfig matches a site in the list', () => {
  const r = matchProperty('https://www.example.com', SITES, 'https://www.example.com/');
  assert.equal(r.matchType, 'exact_config');
  assert.equal(r.siteUrl, 'https://www.example.com/');
  assert.equal(r.confidence, 1.0);
});

test('exact_config falls through when configured URL is not in the site list', () => {
  const r = matchProperty('https://www.example.com', SITES, 'https://staging.example.com/');
  assert.equal(r.matchType, 'sc_domain');
});

test('sc-domain preferred over url-prefix variants', () => {
  const r = matchProperty('https://www.example.com', SITES);
  assert.equal(r.matchType, 'sc_domain');
  assert.equal(r.siteUrl, 'sc-domain:example.com');
  assert.equal(r.confidence, 0.95);
  assert.equal(r.permissionLevel, 'siteOwner');
});

test('url_prefix_https_www when no sc-domain present', () => {
  const sites = [{ siteUrl: 'https://www.example.com/', permissionLevel: 'siteOwner' }];
  const r = matchProperty('https://www.example.com', sites);
  assert.equal(r.matchType, 'url_prefix_https_www');
  assert.equal(r.siteUrl, 'https://www.example.com/');
  assert.equal(r.confidence, 0.9);
});

test('url_prefix_https (no www) when www variant absent', () => {
  const sites = [{ siteUrl: 'https://example.com/', permissionLevel: 'siteFullUser' }];
  const r = matchProperty('https://www.example.com', sites);
  assert.equal(r.matchType, 'url_prefix_https');
  assert.equal(r.confidence, 0.85);
});

test('url_prefix_http www variant', () => {
  const sites = [{ siteUrl: 'http://www.example.com/', permissionLevel: 'siteOwner' }];
  const r = matchProperty('https://www.example.com', sites);
  assert.equal(r.matchType, 'url_prefix_http');
  assert.equal(r.confidence, 0.7);
});

test('url_prefix_http naked domain', () => {
  const sites = [{ siteUrl: 'http://example.com/', permissionLevel: 'siteOwner' }];
  const r = matchProperty('https://example.com', sites);
  assert.equal(r.matchType, 'url_prefix_http');
  assert.equal(r.confidence, 0.7);
});

test('manual when no sites match', () => {
  const r = matchProperty('https://www.example.com', []);
  assert.equal(r.matchType, 'manual');
  assert.equal(r.siteUrl, null);
  assert.equal(r.confidence, 0);
});

test('invalid websiteUrl degrades to manual', () => {
  const r = matchProperty('not-a-url', SITES);
  assert.equal(r.matchType, 'manual');
});

test('propertyType classifies sc-domain and url-prefix', () => {
  assert.equal(propertyType('sc-domain:example.com'), 'domain');
  assert.equal(propertyType('https://www.example.com/'), 'url_prefix');
  assert.equal(propertyType('http://example.com/'), 'url_prefix');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gscPropertyMatcher.test.js
```

Expected: FAIL — `Cannot resolve '../connections/gsc/propertyMatcher.js'`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/connections/gsc/propertyMatcher.js`:

```js
/**
 * Pure GSC property matching (north-star §6.4).
 * Matches a client website URL against the list of GSC site properties
 * using a strict priority chain. No DB, no network.
 */

const CONFIDENCE = {
  exact_config:           1.0,
  sc_domain:              0.95,
  url_prefix_https_www:   0.9,
  url_prefix_https:       0.85,
  url_prefix_http:        0.7,
  manual:                 0
};

export function propertyType(siteUrl) {
  return typeof siteUrl === 'string' && siteUrl.startsWith('sc-domain:')
    ? 'domain'
    : 'url_prefix';
}

/**
 * @param {string} websiteUrl  - Client website URL (e.g. 'https://www.example.com')
 * @param {Array<{siteUrl: string, permissionLevel: string}>} siteList - From GSC sites.list API
 * @param {string|null} [exactConfig] - If client has a specific sc_site_url configured
 * @returns {{ siteUrl: string|null, permissionLevel: string|null, matchType: string, confidence: number }}
 */
export function matchProperty(websiteUrl, siteList = [], exactConfig = null) {
  const index = new Map(siteList.map((s) => [s.siteUrl, s]));

  const hit = (siteUrl, matchType) => {
    const entry = index.get(siteUrl);
    if (!entry) return null;
    return { siteUrl: entry.siteUrl, permissionLevel: entry.permissionLevel || null, matchType, confidence: CONFIDENCE[matchType] };
  };

  // 1. exact_config — client has told us exactly which property to use
  if (exactConfig) {
    const r = hit(exactConfig, 'exact_config');
    if (r) return r;
  }

  // Parse hostname
  let hostname;
  try {
    hostname = new URL(websiteUrl).hostname.toLowerCase();
  } catch {
    return { siteUrl: null, permissionLevel: null, matchType: 'manual', confidence: 0 };
  }
  const bare = hostname.replace(/^www\./, '');

  // 2. sc-domain (domain property)
  const r2 = hit(`sc-domain:${bare}`, 'sc_domain');
  if (r2) return r2;

  // 3. url-prefix https www
  const r3 = hit(`https://www.${bare}/`, 'url_prefix_https_www');
  if (r3) return r3;

  // 4. url-prefix https (no www)
  const r4 = hit(`https://${bare}/`, 'url_prefix_https');
  if (r4) return r4;

  // 5. url-prefix http www, then naked
  const r5a = hit(`http://www.${bare}/`, 'url_prefix_http');
  if (r5a) return r5a;
  const r5b = hit(`http://${bare}/`, 'url_prefix_http');
  if (r5b) return r5b;

  // 6. manual — no match found
  return { siteUrl: null, permissionLevel: null, matchType: 'manual', confidence: 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/gscPropertyMatcher.test.js
```

Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/gsc/propertyMatcher.js server/services/ops/__tests__/gscPropertyMatcher.test.js
git commit -m "feat(ops/gsc): pure property matcher — north-star §6.4 priority chain"
```

---

### Task 4: Inventory discovery

**Files:**
- Create: `server/services/ops/connections/gsc/inventory.js`
- Test: `server/services/ops/__tests__/gscInventory.test.js`

**Interfaces:**
- Consumes: `matchProperty` (Task 3), `propertyType` (Task 3), `resolveClientWebsiteUrl` (existing `checks/website/_lib/httpFetch.js`), `query` (`server/db.js`).
- Produces:
  - `async listSites(token, { signal?, _fetch? } = {}): Promise<Array<{siteUrl, permissionLevel}>>` — calls `GET https://www.googleapis.com/webmasters/v3/sites` with Bearer token.
  - `async discoverInventory({ clientUserId, websiteUrl, token, exactConfig?, _listSites?, _persistInventory?, _query? }): Promise<Array<ops_platform_inventory_row>>` — matches property, persists to `ops_gsc_site_inventory`, returns inventory row array.
  - `async getMatchedSite(clientUserId, { _query?, token?, _listSites?, websiteUrl? }): Promise<{site_url, match_type, match_confidence, permission_level, property_type}|null>` — reads cached row from `ops_gsc_site_inventory`; falls back to live discovery if token + listSites provided.
  - `ops_platform_inventory_row` shape: `{ client_user_id, connection_id: null, service_category: 'organic_search', provider: 'search_console', object_type: 'site', external_id, name, attributes_json: { permission_level, property_type, match_type, match_confidence, website_url } }`.

- [ ] **Step 1: Write the failing tests**

Create `server/services/ops/__tests__/gscInventory.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverInventory, getMatchedSite } from '../connections/gsc/inventory.js';

const FAKE_SITES = [
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  { siteUrl: 'https://www.example.com/', permissionLevel: 'siteFullUser' }
];

test('discoverInventory returns ops_platform_inventory-shaped row for best match', async () => {
  const persisted = [];
  const rows = await discoverInventory({
    clientUserId: 'cuid-1',
    websiteUrl: 'https://www.example.com',
    token: 'fake-tok',
    _listSites: async () => FAKE_SITES,
    _persistInventory: async (r) => { persisted.push(...r); }
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.client_user_id, 'cuid-1');
  assert.equal(row.connection_id, null);
  assert.equal(row.service_category, 'organic_search');
  assert.equal(row.provider, 'search_console');
  assert.equal(row.object_type, 'site');
  assert.equal(row.external_id, 'sc-domain:example.com');
  assert.equal(row.attributes_json.match_type, 'sc_domain');
  assert.ok(row.attributes_json.match_confidence >= 0.9);
  assert.equal(row.attributes_json.property_type, 'domain');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].external_id, 'sc-domain:example.com');
});

test('discoverInventory returns empty array when no property matches', async () => {
  const rows = await discoverInventory({
    clientUserId: 'cuid-2',
    websiteUrl: 'https://www.notfound.com',
    token: 'fake-tok',
    _listSites: async () => FAKE_SITES,
    _persistInventory: async () => {}
  });
  assert.equal(rows.length, 0);
});

test('discoverInventory surfaces listSites errors as empty (never throws)', async () => {
  const rows = await discoverInventory({
    clientUserId: 'cuid-3',
    websiteUrl: 'https://www.example.com',
    token: 'fake-tok',
    _listSites: async () => { throw new Error('GSC 403'); },
    _persistInventory: async () => {}
  });
  assert.equal(rows.length, 0);
});

test('getMatchedSite reads from db cache when row exists', async () => {
  const fakeRow = {
    site_url: 'sc-domain:example.com',
    match_type: 'sc_domain',
    match_confidence: 0.95,
    permission_level: 'siteOwner',
    property_type: 'domain'
  };
  const _query = async () => ({ rows: [fakeRow] });
  const r = await getMatchedSite('cuid-1', { _query });
  assert.equal(r.site_url, 'sc-domain:example.com');
  assert.equal(r.match_type, 'sc_domain');
});

test('getMatchedSite returns null when cache empty and no live discovery deps', async () => {
  const _query = async () => ({ rows: [] });
  const r = await getMatchedSite('cuid-1', { _query });
  assert.equal(r, null);
});

// DB round-trip (requires DATABASE_URL)
test('ops_gsc_site_inventory upsert and read back', async () => {
  const { query } = await import('../../../../db.js');
  const uid = '00000000-0000-0000-0001-' + Math.random().toString(36).slice(2).padEnd(12, '0');
  await query(
    `INSERT INTO ops_gsc_site_inventory
       (client_user_id, site_url, permission_level, property_type, match_type, match_confidence, website_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (client_user_id, site_url) DO UPDATE
       SET match_confidence = EXCLUDED.match_confidence`,
    [uid, 'sc-domain:roundtrip.com', 'siteOwner', 'domain', 'sc_domain', 0.95, 'https://roundtrip.com']
  );
  const { rows } = await query(
    `SELECT * FROM ops_gsc_site_inventory WHERE client_user_id = $1 AND site_url = $2`,
    [uid, 'sc-domain:roundtrip.com']
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].match_type, 'sc_domain');
  assert.ok(Number(rows[0].match_confidence) === 0.95);
  // cleanup
  await query(`DELETE FROM ops_gsc_site_inventory WHERE client_user_id = $1`, [uid]);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/gscInventory.test.js
```

Expected: FAIL — `Cannot resolve '../connections/gsc/inventory.js'`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/connections/gsc/inventory.js`:

```js
/**
 * GSC inventory discovery (north-star §6.4 / spec §5 discoverInventory).
 *
 * discoverInventory: lists all site properties the service account can see,
 * matches the best one to the client's website URL, persists the match to
 * ops_gsc_site_inventory, and returns rows conforming to the F1
 * ops_platform_inventory shape.
 *
 * getMatchedSite: reads the cached match; falls back to live discovery when
 * a token + _listSites are provided.
 */
import { query as defaultQuery } from '../../../../db.js';
import { matchProperty, propertyType } from './propertyMatcher.js';
import { resolveClientWebsiteUrl } from '../../checks/website/_lib/httpFetch.js';

const SITES_ENDPOINT = 'https://www.googleapis.com/webmasters/v3/sites';

/**
 * List all GSC site properties accessible to the given Bearer token.
 * Returns [] on any error (caller decides how to surface).
 */
export async function listSites(token, { signal, _fetch = globalThis.fetch } = {}) {
  const res = await _fetch(SITES_ENDPOINT, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    ...(signal ? { signal } : {})
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`GSC sites.list ${res.status}`), { status: res.status, body: body.slice(0, 400) });
  }
  const json = await res.json();
  return (json.siteEntry || []);
}

/**
 * Default persistence: upsert into ops_gsc_site_inventory.
 * Injected as _persistInventory in tests.
 */
async function persistInventoryDefault(rows, queryFn) {
  for (const row of rows) {
    const a = row.attributes_json;
    await queryFn(
      `INSERT INTO ops_gsc_site_inventory
         (client_user_id, site_url, permission_level, property_type,
          match_type, match_confidence, website_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (client_user_id, site_url) DO UPDATE
         SET permission_level   = EXCLUDED.permission_level,
             match_type         = EXCLUDED.match_type,
             match_confidence   = EXCLUDED.match_confidence,
             website_url        = EXCLUDED.website_url,
             discovered_at      = now()`,
      [
        row.client_user_id,
        row.external_id,
        a.permission_level,
        a.property_type,
        a.match_type,
        a.match_confidence,
        a.website_url
      ]
    );
  }
}

/**
 * Discover and persist the GSC property that best matches the client website.
 *
 * @param {object} opts
 * @param {string} opts.clientUserId
 * @param {string} opts.websiteUrl       - e.g. 'https://www.example.com'
 * @param {string} opts.token            - Bearer token
 * @param {string|null} [opts.exactConfig] - Overrides matching (client-configured sc_site_url)
 * @param {function} [opts._listSites]   - Injectable: async (token) => site[]
 * @param {function} [opts._persistInventory] - Injectable: async (rows) => void
 * @param {function} [opts._query]       - Injectable query fn for persistence
 * @returns {Promise<Array>} ops_platform_inventory-shaped rows (0 or 1 entry)
 */
export async function discoverInventory({
  clientUserId,
  websiteUrl,
  token,
  exactConfig = null,
  _listSites = listSites,
  _persistInventory = null,
  _query = defaultQuery
} = {}) {
  let sites;
  try {
    sites = await _listSites(token);
  } catch {
    return [];
  }

  const match = matchProperty(websiteUrl, sites, exactConfig);
  if (match.matchType === 'manual' || !match.siteUrl) return [];

  const ptype = propertyType(match.siteUrl);
  const row = {
    client_user_id: clientUserId,
    connection_id: null,                  // F1 will backfill via ops_service_connections
    service_category: 'organic_search',
    provider: 'search_console',
    object_type: 'site',
    external_id: match.siteUrl,
    name: match.siteUrl,
    attributes_json: {
      permission_level:  match.permissionLevel,
      property_type:     ptype,
      match_type:        match.matchType,
      match_confidence:  match.confidence,
      website_url:       websiteUrl
    }
  };

  const persistFn = _persistInventory || ((rows) => persistInventoryDefault(rows, _query));
  await persistFn([row]).catch(() => {});   // persistence failure is non-fatal

  return [row];
}

/**
 * Return the cached matched site for a client from ops_gsc_site_inventory.
 * Falls back to live discovery when token + _listSites are provided and cache
 * is empty.
 */
export async function getMatchedSite(clientUserId, {
  _query = defaultQuery,
  token = null,
  _listSites = null,
  websiteUrl = null
} = {}) {
  const { rows } = await _query(
    `SELECT site_url, match_type, match_confidence, permission_level, property_type
       FROM ops_gsc_site_inventory
      WHERE client_user_id = $1
      ORDER BY match_confidence DESC, discovered_at DESC
      LIMIT 1`,
    [clientUserId]
  ).catch(() => ({ rows: [] }));

  if (rows[0]) return rows[0];

  // Live fallback when caller supplies auth
  if (!token || !_listSites || !websiteUrl) return null;

  const discoveredUrl = websiteUrl || await resolveClientWebsiteUrl(_query, clientUserId);
  if (!discoveredUrl) return null;

  const inventoryRows = await discoverInventory({
    clientUserId,
    websiteUrl: discoveredUrl,
    token,
    _listSites,
    _query
  });
  if (!inventoryRows.length) return null;

  const a = inventoryRows[0].attributes_json;
  return {
    site_url:         inventoryRows[0].external_id,
    match_type:       a.match_type,
    match_confidence: a.match_confidence,
    permission_level: a.permission_level,
    property_type:    a.property_type
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/gscInventory.test.js
```

Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/gsc/inventory.js server/services/ops/__tests__/gscInventory.test.js
git commit -m "feat(ops/gsc): discoverInventory — property match + ops_gsc_site_inventory persistence"
```

---

### Task 5: Snapshot collection

**Files:**
- Create: `server/services/ops/connections/gsc/snapshot.js`
- Test: `server/services/ops/__tests__/gscSnapshot.test.js`

**Interfaces:**
- Produces:
  - `async querySearchAnalytics(token, siteUrl, body, { signal?, _fetch? }): Promise<{rows: Array}>` — calls `POST https://searchconsole.googleapis.com/webmasters/v3/sites/{encodedSiteUrl}/searchAnalytics/query`.
  - `async collectSnapshot({ clientUserId, siteUrl, token, date, signal?, _queryAnalytics? }): Promise<Array<ops_daily_snapshots_row>>` — fetches aggregate (no dimensions), by-page, by-query, and by-device data for the 28-day window ending on `date`; returns normalized `ops_daily_snapshots`-shaped rows. Does NOT persist (F3 owns persistence).
  - `ops_daily_snapshots_row` shape: `{ client_user_id, snapshot_date, service: 'search_console', scope_type: 'site'|'page'|'query'|'device', scope_id: string, metrics_json: { clicks, impressions, ctr, position }, source_run_id: null }`.

- [ ] **Step 1: Write the failing tests**

Create `server/services/ops/__tests__/gscSnapshot.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectSnapshot } from '../connections/gsc/snapshot.js';

const FAKE_AGGREGATE = { rows: [{ clicks: 1200, impressions: 45000, ctr: 0.0267, position: 18.3 }] };
const FAKE_BY_PAGE = {
  rows: [
    { keys: ['/blog/seo-tips'], clicks: 340, impressions: 12000, ctr: 0.028, position: 8.5 },
    { keys: ['/services/'], clicks: 200, impressions: 8000, ctr: 0.025, position: 12.1 }
  ]
};
const FAKE_BY_QUERY = {
  rows: [
    { keys: ['seo agency'], clicks: 180, impressions: 5000, ctr: 0.036, position: 5.2 }
  ]
};
const FAKE_BY_DEVICE = {
  rows: [
    { keys: ['MOBILE'], clicks: 700, impressions: 26000, ctr: 0.027, position: 19.1 },
    { keys: ['DESKTOP'], clicks: 450, impressions: 17000, ctr: 0.026, position: 16.8 }
  ]
};

function makeQueryAnalytics() {
  return async (_token, _siteUrl, body) => {
    const dims = body.dimensions || [];
    if (dims.length === 0) return FAKE_AGGREGATE;
    if (dims[0] === 'page')   return FAKE_BY_PAGE;
    if (dims[0] === 'query')  return FAKE_BY_QUERY;
    if (dims[0] === 'device') return FAKE_BY_DEVICE;
    return { rows: [] };
  };
}

test('collectSnapshot returns rows for all four scope types', async () => {
  const snaps = await collectSnapshot({
    clientUserId: 'cuid-1',
    siteUrl: 'sc-domain:example.com',
    token: 'fake-tok',
    date: '2026-06-28',
    _queryAnalytics: makeQueryAnalytics()
  });

  const types = [...new Set(snaps.map((s) => s.scope_type))].sort();
  assert.deepEqual(types, ['device', 'page', 'query', 'site']);

  const agg = snaps.find((s) => s.scope_type === 'site');
  assert.ok(agg, 'aggregate row present');
  assert.equal(agg.client_user_id, 'cuid-1');
  assert.equal(agg.service, 'search_console');
  assert.equal(agg.scope_id, 'sc-domain:example.com');
  assert.equal(agg.snapshot_date, '2026-06-28');
  assert.equal(agg.source_run_id, null);
  assert.deepEqual(agg.metrics_json, { clicks: 1200, impressions: 45000, ctr: 0.0267, position: 18.3 });

  const pages = snaps.filter((s) => s.scope_type === 'page');
  assert.equal(pages.length, 2);
  assert.equal(pages[0].scope_id, '/blog/seo-tips');
  assert.deepEqual(pages[0].metrics_json, { clicks: 340, impressions: 12000, ctr: 0.028, position: 8.5 });

  const queries = snaps.filter((s) => s.scope_type === 'query');
  assert.equal(queries.length, 1);
  assert.equal(queries[0].scope_id, 'seo agency');

  const devices = snaps.filter((s) => s.scope_type === 'device');
  assert.equal(devices.length, 2);
  const mobile = devices.find((s) => s.scope_id === 'MOBILE');
  assert.equal(mobile.metrics_json.clicks, 700);
});

test('collectSnapshot returns empty array when queryAnalytics throws', async () => {
  const snaps = await collectSnapshot({
    clientUserId: 'cuid-1',
    siteUrl: 'sc-domain:example.com',
    token: 'fake-tok',
    date: '2026-06-28',
    _queryAnalytics: async () => { throw new Error('GSC 429'); }
  });
  assert.equal(snaps.length, 0);
});

test('collectSnapshot passes correct date window to queryAnalytics', async () => {
  const calls = [];
  const _queryAnalytics = async (_tok, _site, body) => {
    calls.push({ startDate: body.startDate, endDate: body.endDate, dims: body.dimensions });
    return { rows: [] };
  };
  await collectSnapshot({ clientUserId: 'c', siteUrl: 'sc-domain:x.com', token: 't', date: '2026-06-28', _queryAnalytics });
  // All calls should use the same 28-day window
  for (const c of calls) {
    assert.equal(c.endDate, '2026-06-28');
    assert.equal(c.startDate, '2026-06-01');  // 28 days back from 2026-06-28
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gscSnapshot.test.js
```

Expected: FAIL — `Cannot resolve '../connections/gsc/snapshot.js'`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/connections/gsc/snapshot.js`:

```js
/**
 * GSC snapshot collection (spec §5 collectSnapshot).
 * Fetches Search Console search analytics data and returns rows conforming
 * to the F3 ops_daily_snapshots shape. Does NOT persist — F3 owns that.
 *
 * Four scope types returned:
 *   site    — aggregate totals for the property
 *   page    — per-page breakdown (top 25 000 rows)
 *   query   — per-query breakdown (top 25 000 rows)
 *   device  — by device type (MOBILE / DESKTOP / TABLET)
 */

const ANALYTICS_BASE = 'https://searchconsole.googleapis.com/webmasters/v3/sites';

/** Subtract `days` days from an ISO date string; returns ISO date string. */
function subtractDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * POST to the Search Console searchAnalytics/query endpoint.
 * Throws on HTTP errors.
 */
export async function querySearchAnalytics(token, siteUrl, body, { signal, _fetch = globalThis.fetch } = {}) {
  const url = `${ANALYTICS_BASE}/${encodeURIComponent(siteUrl)}/searchAnalytics/query`;
  const res = await _fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {})
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error(`GSC searchAnalytics ${res.status}`), { status: res.status, body: text.slice(0, 400) });
  }
  return res.json();
}

/**
 * Collect a full GSC snapshot for one site property on `date`.
 * Returns ops_daily_snapshots-shaped rows (not yet persisted).
 *
 * @param {object} opts
 * @param {string} opts.clientUserId
 * @param {string} opts.siteUrl       - GSC property (e.g. 'sc-domain:example.com')
 * @param {string} opts.token         - Bearer token
 * @param {string} opts.date          - ISO date 'YYYY-MM-DD' (the snapshot date / endDate)
 * @param {AbortSignal} [opts.signal]
 * @param {function} [opts._queryAnalytics] - Injectable: async (token, siteUrl, body) => {rows}
 * @returns {Promise<Array>}
 */
export async function collectSnapshot({ clientUserId, siteUrl, token, date, signal, _queryAnalytics = null } = {}) {
  const queryFn = _queryAnalytics || ((tok, site, body) => querySearchAnalytics(tok, site, body, { signal }));

  const endDate = date;
  const startDate = subtractDays(date, 27); // 28-day window inclusive

  const BASE_BODY = { startDate, endDate, rowLimit: 25000 };

  const snapshots = [];

  try {
    // Helper: turn an API response row into an ops_daily_snapshots row
    const makeRow = (scopeType, scopeId, apiRow) => ({
      client_user_id: clientUserId,
      snapshot_date:  date,
      service:        'search_console',
      scope_type:     scopeType,
      scope_id:       scopeId,
      metrics_json: {
        clicks:      apiRow.clicks      ?? 0,
        impressions: apiRow.impressions ?? 0,
        ctr:         apiRow.ctr         ?? 0,
        position:    apiRow.position    ?? 0
      },
      source_run_id: null
    });

    // 1. Aggregate (no dimensions)
    const agg = await queryFn(token, siteUrl, { ...BASE_BODY });
    for (const r of agg.rows || []) {
      snapshots.push(makeRow('site', siteUrl, r));
    }
    // If the API returns no rows but HTTP 200, emit a zeroed aggregate row
    if (!(agg.rows || []).length) {
      snapshots.push(makeRow('site', siteUrl, { clicks: 0, impressions: 0, ctr: 0, position: 0 }));
    }

    // 2. By page
    const byPage = await queryFn(token, siteUrl, { ...BASE_BODY, dimensions: ['page'] });
    for (const r of byPage.rows || []) {
      snapshots.push(makeRow('page', r.keys[0], r));
    }

    // 3. By query
    const byQuery = await queryFn(token, siteUrl, { ...BASE_BODY, dimensions: ['query'] });
    for (const r of byQuery.rows || []) {
      snapshots.push(makeRow('query', r.keys[0], r));
    }

    // 4. By device
    const byDevice = await queryFn(token, siteUrl, { ...BASE_BODY, dimensions: ['device'] });
    for (const r of byDevice.rows || []) {
      snapshots.push(makeRow('device', r.keys[0], r));
    }
  } catch {
    // Any failure returns whatever was collected so far (may be empty)
    return snapshots;
  }

  return snapshots;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test server/services/ops/__tests__/gscSnapshot.test.js
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/gsc/snapshot.js server/services/ops/__tests__/gscSnapshot.test.js
git commit -m "feat(ops/gsc): collectSnapshot — aggregate/page/query/device in ops_daily_snapshots shape"
```

---

### Task 6: Check implementations (11 checks)

**Files:**
- Create: `server/services/ops/connections/gsc/checks.js`
- Test: `server/services/ops/__tests__/gscChecks.test.js`

**Interfaces:**
- Consumes: `resolveGscToken` (Task 2), `getMatchedSite` (Task 4), `querySearchAnalytics` (Task 5), `listSites` (Task 4), `registerCheck` (existing `checks/registry.js`).
- Produces: 11 exported factory functions (each testable with injected fakes), each calling `registerCheck` at module bottom with `umbrella: 'website'`.
  - `makeConnectionHealthCheck(deps)` → handler for `gsc.connection_health`
  - `makeSiteAccessMissingCheck(deps)` → handler for `gsc.site_access_missing`
  - `makeClickDropCheck(deps)` → handler for `gsc.click_drop`
  - `makeImpressionDropCheck(deps)` → handler for `gsc.impression_drop`
  - `makePageDeclineCheck(deps)` → handler for `gsc.page_decline`
  - `makeQueryDeclineCheck(deps)` → handler for `gsc.query_decline`
  - `makeQueryOpportunityCheck(deps)` → handler for `gsc.query_opportunity`
  - `makePageIndexingIssueCheck(deps)` → handler for `gsc.page_indexing_issue`
  - `makeCanonicalMismatchCheck(deps)` → handler for `gsc.canonical_mismatch`
  - `makeDeviceSpecificDropCheck(deps)` → handler for `gsc.device_specific_drop`
  - `makeZeroClickHighImpressionCheck(deps)` → handler for `gsc.zero_click_high_impression_pages`
- Each handler signature: `async (ctx) => { status, severity?, payload }`.
- Drop checks (click_drop, impression_drop, page_decline, query_decline, device_specific_drop): fetch two 7-day windows (current = last 7 days, prior = days 8-14) from the Search Console API. Thresholds: aggregate-click drop > 20% → fail/warning; aggregate-impression drop > 25% → fail/warning; page/query drop > 30% per page/query → fail/warning; device drop > 25% on one device while others stable → fail/warning.
- Advisory checks (query_opportunity, zero_click_high_impression_pages): fetch 28d data; query_opportunity returns status='pass' with `payload.opportunities` array (queries with impressions > 500, CTR < 0.05, position 5–20); zero_click returns status='fail'/warning when any page has impressions > 1000 and clicks = 0.
- All checks: return `{ status: 'skipped', payload: { reason } }` when no token or no matched site.

- [ ] **Step 1: Write the failing tests**

Create `server/services/ops/__tests__/gscChecks.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeConnectionHealthCheck,
  makeSiteAccessMissingCheck,
  makeClickDropCheck,
  makeImpressionDropCheck,
  makePageDeclineCheck,
  makeQueryDeclineCheck,
  makeQueryOpportunityCheck,
  makePageIndexingIssueCheck,
  makeDeviceSpecificDropCheck,
  makeZeroClickHighImpressionCheck
} from '../connections/gsc/checks.js';

const SITE = { site_url: 'sc-domain:example.com' };
const CTX  = { clientUserId: 'cuid-1', signal: null, config: {} };

// ── connection_health ────────────────────────────────────────────────────────

test('gsc.connection_health: pass when sites accessible', async () => {
  const h = makeConnectionHealthCheck({
    resolveToken: async () => 'tok',
    listSites: async () => [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }]
  });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
  assert.equal(r.payload.site_count, 1);
});

test('gsc.connection_health: skipped when no token', async () => {
  const h = makeConnectionHealthCheck({ resolveToken: async () => null, listSites: async () => [] });
  const r = await h(CTX);
  assert.equal(r.status, 'skipped');
  assert.ok(r.payload.reason);
});

test('gsc.connection_health: error on listSites failure', async () => {
  const h = makeConnectionHealthCheck({
    resolveToken: async () => 'tok',
    listSites: async () => { throw new Error('GSC 403'); }
  });
  const r = await h(CTX);
  assert.equal(r.status, 'error');
  assert.equal(r.severity, 'critical');
});

// ── site_access_missing ──────────────────────────────────────────────────────

test('gsc.site_access_missing: pass when matched site accessible', async () => {
  const h = makeSiteAccessMissingCheck({
    resolveToken: async () => 'tok',
    getMatchedSite: async () => SITE,
    listSites: async () => [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }]
  });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
});

test('gsc.site_access_missing: fail when matched site not in accessible list', async () => {
  const h = makeSiteAccessMissingCheck({
    resolveToken: async () => 'tok',
    getMatchedSite: async () => SITE,
    listSites: async () => [{ siteUrl: 'sc-domain:other.com', permissionLevel: 'siteOwner' }]
  });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'critical');
});

// ── click_drop ───────────────────────────────────────────────────────────────

test('gsc.click_drop: fail when current 7d clicks < 80% of prior 7d', async () => {
  let callNum = 0;
  const queryAnalytics = async () => {
    callNum += 1;
    // First call = current period (low clicks), second = prior period (high clicks)
    const clicks = callNum === 1 ? 400 : 1000;
    return { rows: [{ clicks, impressions: 10000, ctr: clicks / 10000, position: 8 }] };
  };
  const h = makeClickDropCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.ok(r.payload.click_drop_pct >= 60);
  assert.ok(r.payload.current_clicks === 400);
  assert.ok(r.payload.prior_clicks === 1000);
});

test('gsc.click_drop: pass when clicks stable', async () => {
  const queryAnalytics = async () => ({ rows: [{ clicks: 950, impressions: 10000, ctr: 0.095, position: 7 }] });
  const h = makeClickDropCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
});

// ── impression_drop ──────────────────────────────────────────────────────────

test('gsc.impression_drop: fail when current 7d impressions < 75% of prior', async () => {
  let n = 0;
  const queryAnalytics = async () => ({ rows: [{ clicks: 100, impressions: ++n === 1 ? 5000 : 20000, ctr: 0.02, position: 10 }] });
  const h = makeImpressionDropCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.ok(r.payload.impression_drop_pct >= 75);
});

// ── page_decline ─────────────────────────────────────────────────────────────

test('gsc.page_decline: fail when a page drops > 30% in clicks', async () => {
  let n = 0;
  const queryAnalytics = async () => {
    n += 1;
    const clicks = n === 1 ? 100 : 500;
    return { rows: [{ keys: ['/blog/seo-tips'], clicks, impressions: 5000, ctr: clicks / 5000, position: 8 }] };
  };
  const h = makePageDeclineCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.ok(r.payload.declining_pages.length >= 1);
  assert.equal(r.payload.declining_pages[0].url, '/blog/seo-tips');
  assert.ok(r.payload.declining_pages[0].drop_pct >= 80);
});

// ── query_decline ─────────────────────────────────────────────────────────────

test('gsc.query_decline: fail when a query drops > 30% in clicks', async () => {
  let n = 0;
  const queryAnalytics = async () => {
    n += 1;
    const clicks = n === 1 ? 50 : 300;
    return { rows: [{ keys: ['seo agency'], clicks, impressions: 3000, ctr: clicks / 3000, position: 5 }] };
  };
  const h = makeQueryDeclineCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.ok(r.payload.declining_queries[0].query === 'seo agency');
});

// ── query_opportunity ─────────────────────────────────────────────────────────

test('gsc.query_opportunity: pass with opportunities array when queries qualify', async () => {
  const queryAnalytics = async () => ({
    rows: [
      { keys: ['digital marketing agency'], clicks: 20, impressions: 3000, ctr: 0.007, position: 11.5 },
      { keys: ['seo near me'],              clicks: 300, impressions: 8000, ctr: 0.038, position: 3.0 }  // not qualifying (high CTR)
    ]
  });
  const h = makeQueryOpportunityCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
  assert.equal(r.payload.opportunities.length, 1);
  assert.equal(r.payload.opportunities[0].query, 'digital marketing agency');
  assert.ok(r.payload.opportunities[0].impressions === 3000);
  assert.ok(r.payload.opportunities[0].position === 11.5);
});

// ── page_indexing_issue ───────────────────────────────────────────────────────

test('gsc.page_indexing_issue: fail when indexed_ratio < 0.7', async () => {
  const fetchSitemaps = async () => ({
    siteEntry: [],
    sitemap: [{ contents: [{ submitted: '100', indexed: '60' }] }]
  });
  const h = makePageIndexingIssueCheck({
    resolveToken: async () => 'tok',
    getMatchedSite: async () => SITE,
    fetchSitemaps
  });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.ok(r.payload.indexed_ratio < 0.7);
  assert.equal(r.payload.submitted, 100);
  assert.equal(r.payload.indexed, 60);
});

test('gsc.page_indexing_issue: pass when indexed_ratio >= 0.7', async () => {
  const fetchSitemaps = async () => ({
    sitemap: [{ contents: [{ submitted: '100', indexed: '90' }] }]
  });
  const h = makePageIndexingIssueCheck({
    resolveToken: async () => 'tok',
    getMatchedSite: async () => SITE,
    fetchSitemaps
  });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
});

// ── device_specific_drop ──────────────────────────────────────────────────────

test('gsc.device_specific_drop: fail when mobile drops while desktop stable', async () => {
  let n = 0;
  const queryAnalytics = async () => {
    n += 1;
    // current (n=1): mobile low, desktop stable; prior (n=2): mobile high, desktop stable
    const mobileClicks  = n === 1 ? 100 : 500;
    const desktopClicks = 300;
    return {
      rows: [
        { keys: ['MOBILE'],  clicks: mobileClicks,  impressions: 10000, ctr: mobileClicks / 10000,  position: 15 },
        { keys: ['DESKTOP'], clicks: desktopClicks, impressions: 8000,  ctr: desktopClicks / 8000, position: 12 }
      ]
    };
  };
  const h = makeDeviceSpecificDropCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.ok(r.payload.affected_devices.includes('MOBILE'));
});

// ── zero_click_high_impression ────────────────────────────────────────────────

test('gsc.zero_click_high_impression_pages: fail when pages have high impressions + 0 clicks', async () => {
  const queryAnalytics = async () => ({
    rows: [
      { keys: ['/landing/'], clicks: 0, impressions: 2500, ctr: 0, position: 3.2 },
      { keys: ['/about/'],   clicks: 50, impressions: 1500, ctr: 0.033, position: 5.1 }
    ]
  });
  const h = makeZeroClickHighImpressionCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.equal(r.payload.pages.length, 1);
  assert.equal(r.payload.pages[0].url, '/landing/');
  assert.equal(r.payload.pages[0].impressions, 2500);
});

test('gsc.zero_click_high_impression_pages: pass when no qualifying pages', async () => {
  const queryAnalytics = async () => ({
    rows: [{ keys: ['/about/'], clicks: 50, impressions: 1500, ctr: 0.033, position: 5.1 }]
  });
  const h = makeZeroClickHighImpressionCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gscChecks.test.js
```

Expected: FAIL — `Cannot resolve '../connections/gsc/checks.js'`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/connections/gsc/checks.js`:

```js
/**
 * GSC check implementations (north-star §6.8).
 * Each check is a factory(deps) that returns an async handler(ctx).
 * Default registrations at the bottom call registerCheck with umbrella:'website'
 * so the existing executor runs them immediately. F1 will add serviceCategory/provider
 * when the capability gate lands.
 *
 * Dep injection pattern: all network + auth calls are injectable so tests
 * run with zero network. Production handlers are built with default deps.
 *
 * Drop checks use two-period comparison (current 7d vs prior 7d) so they
 * work without F3 baselines.
 */
import { registerCheck } from '../../checks/registry.js';
import { resolveGscToken as defaultResolveToken } from './auth.js';
import { getMatchedSite as defaultGetMatchedSite, listSites as defaultListSites } from './inventory.js';
import { querySearchAnalytics as defaultQueryAnalytics } from './snapshot.js';

const SITEMAPS_BASE = 'https://www.googleapis.com/webmasters/v3/sites';
const INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function subtractDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dropPct(current, prior) {
  if (!prior) return 0;
  return Math.round(((prior - current) / prior) * 100);
}

function sumClicks(rows) {
  return (rows || []).reduce((s, r) => s + (r.clicks || 0), 0);
}

function sumImpressions(rows) {
  return (rows || []).reduce((s, r) => s + (r.impressions || 0), 0);
}

// ---------------------------------------------------------------------------
// connection_health
// ---------------------------------------------------------------------------

export function makeConnectionHealthCheck({
  resolveToken = defaultResolveToken,
  listSites = defaultListSites
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials configured (GA4_SERVICE_ACCOUNT_KEY / ADC / OAuth)' } };
    try {
      const sites = await listSites(token, { signal: ctx.signal });
      return { status: 'pass', payload: { site_count: sites.length } };
    } catch (err) {
      return { status: 'error', severity: 'critical', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// site_access_missing
// ---------------------------------------------------------------------------

export function makeSiteAccessMissingCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  listSites = defaultListSites
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property for client' } };
    try {
      const sites = await listSites(token, { signal: ctx.signal });
      const accessible = new Set(sites.map((s) => s.siteUrl));
      if (accessible.has(matched.site_url)) {
        return { status: 'pass', payload: { site_url: matched.site_url } };
      }
      return {
        status: 'fail', severity: 'critical',
        payload: { site_url: matched.site_url, reason: 'Matched GSC property not accessible with current credentials' }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// click_drop  (threshold: >20% drop in 7d clicks)
// ---------------------------------------------------------------------------

export function makeClickDropCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endCurrent = today();
    const startCurrent = subtractDays(endCurrent, 6);
    const endPrior = subtractDays(endCurrent, 7);
    const startPrior = subtractDays(endCurrent, 13);

    try {
      const [cur, prior] = await Promise.all([
        queryAnalytics(token, matched.site_url, { startDate: startCurrent, endDate: endCurrent, rowLimit: 1 }, { signal: ctx.signal }),
        queryAnalytics(token, matched.site_url, { startDate: startPrior,   endDate: endPrior,   rowLimit: 1 }, { signal: ctx.signal })
      ]);
      const curClicks   = sumClicks(cur.rows);
      const priorClicks = sumClicks(prior.rows);
      const pct = dropPct(curClicks, priorClicks);
      if (pct > 20) {
        return { status: 'fail', severity: 'warning', payload: { current_clicks: curClicks, prior_clicks: priorClicks, click_drop_pct: pct } };
      }
      return { status: 'pass', payload: { current_clicks: curClicks, prior_clicks: priorClicks, click_drop_pct: pct } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// impression_drop  (threshold: >25% drop in 7d impressions)
// ---------------------------------------------------------------------------

export function makeImpressionDropCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endCurrent = today();
    const startCurrent = subtractDays(endCurrent, 6);
    const endPrior = subtractDays(endCurrent, 7);
    const startPrior = subtractDays(endCurrent, 13);

    try {
      const [cur, prior] = await Promise.all([
        queryAnalytics(token, matched.site_url, { startDate: startCurrent, endDate: endCurrent, rowLimit: 1 }, { signal: ctx.signal }),
        queryAnalytics(token, matched.site_url, { startDate: startPrior,   endDate: endPrior,   rowLimit: 1 }, { signal: ctx.signal })
      ]);
      const curImp   = sumImpressions(cur.rows);
      const priorImp = sumImpressions(prior.rows);
      const pct = dropPct(curImp, priorImp);
      if (pct > 25) {
        return { status: 'fail', severity: 'warning', payload: { current_impressions: curImp, prior_impressions: priorImp, impression_drop_pct: pct } };
      }
      return { status: 'pass', payload: { current_impressions: curImp, prior_impressions: priorImp, impression_drop_pct: pct } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// page_decline  (threshold: any page drops >30% in clicks week-over-week)
// ---------------------------------------------------------------------------

export function makePageDeclineCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endCurrent = today();
    const startCurrent = subtractDays(endCurrent, 6);
    const endPrior = subtractDays(endCurrent, 7);
    const startPrior = subtractDays(endCurrent, 13);

    try {
      const [cur, prior] = await Promise.all([
        queryAnalytics(token, matched.site_url, { startDate: startCurrent, endDate: endCurrent, dimensions: ['page'], rowLimit: 1000 }, { signal: ctx.signal }),
        queryAnalytics(token, matched.site_url, { startDate: startPrior,   endDate: endPrior,   dimensions: ['page'], rowLimit: 1000 }, { signal: ctx.signal })
      ]);
      const priorMap = new Map((prior.rows || []).map((r) => [r.keys[0], r.clicks || 0]));
      const declining = [];
      for (const r of (cur.rows || [])) {
        const url = r.keys[0];
        const priorClicks = priorMap.get(url) || 0;
        if (priorClicks >= 10) {
          const pct = dropPct(r.clicks || 0, priorClicks);
          if (pct > 30) declining.push({ url, current_clicks: r.clicks || 0, prior_clicks: priorClicks, drop_pct: pct });
        }
      }
      if (declining.length) {
        declining.sort((a, b) => b.drop_pct - a.drop_pct);
        return { status: 'fail', severity: 'warning', payload: { declining_pages: declining.slice(0, 20) } };
      }
      return { status: 'pass', payload: { pages_checked: (cur.rows || []).length } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// query_decline  (threshold: any query drops >30% in clicks week-over-week)
// ---------------------------------------------------------------------------

export function makeQueryDeclineCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endCurrent = today();
    const startCurrent = subtractDays(endCurrent, 6);
    const endPrior = subtractDays(endCurrent, 7);
    const startPrior = subtractDays(endCurrent, 13);

    try {
      const [cur, prior] = await Promise.all([
        queryAnalytics(token, matched.site_url, { startDate: startCurrent, endDate: endCurrent, dimensions: ['query'], rowLimit: 1000 }, { signal: ctx.signal }),
        queryAnalytics(token, matched.site_url, { startDate: startPrior,   endDate: endPrior,   dimensions: ['query'], rowLimit: 1000 }, { signal: ctx.signal })
      ]);
      const priorMap = new Map((prior.rows || []).map((r) => [r.keys[0], r.clicks || 0]));
      const declining = [];
      for (const r of (cur.rows || [])) {
        const query = r.keys[0];
        const priorClicks = priorMap.get(query) || 0;
        if (priorClicks >= 5) {
          const pct = dropPct(r.clicks || 0, priorClicks);
          if (pct > 30) declining.push({ query, current_clicks: r.clicks || 0, prior_clicks: priorClicks, drop_pct: pct });
        }
      }
      if (declining.length) {
        declining.sort((a, b) => b.drop_pct - a.drop_pct);
        return { status: 'fail', severity: 'warning', payload: { declining_queries: declining.slice(0, 20) } };
      }
      return { status: 'pass', payload: { queries_checked: (cur.rows || []).length } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// query_opportunity  (impressions>500, CTR<0.05, position 5-20 → advisory)
// ---------------------------------------------------------------------------

export function makeQueryOpportunityCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endDate = today();
    const startDate = subtractDays(endDate, 27);

    try {
      const data = await queryAnalytics(token, matched.site_url, { startDate, endDate, dimensions: ['query'], rowLimit: 5000 }, { signal: ctx.signal });
      const opps = (data.rows || [])
        .filter((r) => r.impressions >= 500 && r.ctr < 0.05 && r.position >= 5 && r.position <= 20)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 20)
        .map((r) => ({ query: r.keys[0], impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position }));
      return { status: 'pass', payload: { opportunities: opps, total_opportunities: opps.length } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// page_indexing_issue  (sitemap submitted vs indexed ratio < 0.7)
// ---------------------------------------------------------------------------

export function makePageIndexingIssueCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  fetchSitemaps = null
} = {}) {
  const defaultFetchSitemaps = async (token, siteUrl, signal) => {
    const url = `${SITEMAPS_BASE}/${encodeURIComponent(siteUrl)}/sitemaps`;
    const res = await globalThis.fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      ...(signal ? { signal } : {})
    });
    if (!res.ok) throw new Error(`GSC sitemaps ${res.status}`);
    return res.json();
  };

  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const fetcher = fetchSitemaps || defaultFetchSitemaps;
    try {
      const data = await fetcher(token, matched.site_url, ctx.signal);
      const sitemaps = data.sitemap || [];
      const totals = sitemaps.reduce((acc, s) => {
        acc.submitted += Number(s.contents?.[0]?.submitted || 0);
        acc.indexed   += Number(s.contents?.[0]?.indexed   || 0);
        return acc;
      }, { submitted: 0, indexed: 0 });

      if (!totals.submitted) {
        return { status: 'skipped', payload: { reason: 'no sitemaps submitted to GSC' } };
      }
      const ratio = totals.indexed / totals.submitted;
      if (ratio < 0.7) {
        return {
          status: 'fail', severity: 'warning',
          payload: { submitted: totals.submitted, indexed: totals.indexed, indexed_ratio: ratio, site_url: matched.site_url }
        };
      }
      return { status: 'pass', payload: { submitted: totals.submitted, indexed: totals.indexed, indexed_ratio: ratio } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// canonical_mismatch  (URL inspection on top 10 pages by impressions)
// ---------------------------------------------------------------------------

export function makeCanonicalMismatchCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics,
  inspectUrl = null
} = {}) {
  const defaultInspectUrl = async (token, inspectionUrl, siteUrl, signal) => {
    const res = await globalThis.fetch(INSPECTION_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ inspectionUrl, siteUrl }),
      ...(signal ? { signal } : {})
    });
    if (!res.ok) throw new Error(`GSC urlInspection ${res.status}`);
    return res.json();
  };

  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endDate = today();
    const startDate = subtractDays(endDate, 27);
    const inspector = inspectUrl || defaultInspectUrl;

    try {
      const data = await queryAnalytics(token, matched.site_url, { startDate, endDate, dimensions: ['page'], rowLimit: 10 }, { signal: ctx.signal });
      const topPages = (data.rows || []).slice(0, 10).map((r) => r.keys[0]);
      const mismatches = [];

      for (const pageUrl of topPages) {
        try {
          const inspection = await inspector(token, pageUrl, matched.site_url, ctx.signal);
          const result = inspection.inspectionResult?.indexStatusResult;
          if (result) {
            const googleCanonical = result.googleCanonical || result.userCanonical;
            if (googleCanonical && googleCanonical !== pageUrl) {
              mismatches.push({ url: pageUrl, google_canonical: googleCanonical });
            }
          }
        } catch {
          // single page inspection failure is non-fatal
        }
      }

      if (mismatches.length) {
        return { status: 'fail', severity: 'warning', payload: { mismatches, pages_inspected: topPages.length } };
      }
      return { status: 'pass', payload: { pages_inspected: topPages.length } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// device_specific_drop  (threshold: any device drops >25% while aggregate stable)
// ---------------------------------------------------------------------------

export function makeDeviceSpecificDropCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endCurrent = today();
    const startCurrent = subtractDays(endCurrent, 6);
    const endPrior = subtractDays(endCurrent, 7);
    const startPrior = subtractDays(endCurrent, 13);

    try {
      const [cur, prior] = await Promise.all([
        queryAnalytics(token, matched.site_url, { startDate: startCurrent, endDate: endCurrent, dimensions: ['device'], rowLimit: 10 }, { signal: ctx.signal }),
        queryAnalytics(token, matched.site_url, { startDate: startPrior,   endDate: endPrior,   dimensions: ['device'], rowLimit: 10 }, { signal: ctx.signal })
      ]);

      const priorMap = new Map((prior.rows || []).map((r) => [r.keys[0], r.clicks || 0]));
      const affected = [];
      for (const r of (cur.rows || [])) {
        const device = r.keys[0];
        const priorClicks = priorMap.get(device) || 0;
        if (priorClicks >= 10) {
          const pct = dropPct(r.clicks || 0, priorClicks);
          if (pct > 25) affected.push({ device, current_clicks: r.clicks || 0, prior_clicks: priorClicks, drop_pct: pct });
        }
      }

      // Only flag if total clicks did NOT drop comparably (device-specific anomaly)
      if (affected.length) {
        const totalCur   = sumClicks(cur.rows);
        const totalPrior = sumClicks(prior.rows);
        const aggregatePct = dropPct(totalCur, totalPrior);
        if (aggregatePct < 15) {
          // Aggregate is stable — device drop is device-specific
          return { status: 'fail', severity: 'warning', payload: { affected_devices: affected.map((a) => a.device), devices: affected } };
        }
      }
      return { status: 'pass', payload: { devices_checked: (cur.rows || []).length } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// zero_click_high_impression_pages  (impressions>1000, clicks=0 → fail/warning)
// ---------------------------------------------------------------------------

export function makeZeroClickHighImpressionCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endDate = today();
    const startDate = subtractDays(endDate, 27);

    try {
      const data = await queryAnalytics(token, matched.site_url, { startDate, endDate, dimensions: ['page'], rowLimit: 5000 }, { signal: ctx.signal });
      const zero = (data.rows || [])
        .filter((r) => (r.impressions || 0) >= 1000 && (r.clicks || 0) === 0)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 20)
        .map((r) => ({ url: r.keys[0], impressions: r.impressions, position: r.position }));

      if (zero.length) {
        return { status: 'fail', severity: 'warning', payload: { pages: zero, total_zero_click_pages: zero.length } };
      }
      return { status: 'pass', payload: { pages_checked: (data.rows || []).length } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// Default registrations — umbrella:'website' keeps executor running them now.
// F1's registry shim will translate to serviceCategory:'organic_search' when it lands.
// ---------------------------------------------------------------------------

const TIER = 'weekly_deep';

registerCheck('gsc.connection_health',             { umbrella: 'website', tier: 'daily_essential', costEstimate: 0, requires: [], handler: makeConnectionHealthCheck() });
registerCheck('gsc.site_access_missing',           { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeSiteAccessMissingCheck() });
registerCheck('gsc.click_drop',                    { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeClickDropCheck() });
registerCheck('gsc.impression_drop',               { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeImpressionDropCheck() });
registerCheck('gsc.page_decline',                  { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makePageDeclineCheck() });
registerCheck('gsc.query_decline',                 { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeQueryDeclineCheck() });
registerCheck('gsc.query_opportunity',             { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeQueryOpportunityCheck() });
registerCheck('gsc.page_indexing_issue',           { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makePageIndexingIssueCheck() });
registerCheck('gsc.canonical_mismatch',            { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeCanonicalMismatchCheck() });
registerCheck('gsc.device_specific_drop',          { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeDeviceSpecificDropCheck() });
registerCheck('gsc.zero_click_high_impression_pages', { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeZeroClickHighImpressionCheck() });
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test server/services/ops/__tests__/gscChecks.test.js
```

Expected: PASS (all 16 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/connections/gsc/checks.js server/services/ops/__tests__/gscChecks.test.js
git commit -m "feat(ops/gsc): 11 check implementations — all injectable, north-star §6.8"
```

---

### Task 7: Connector assembly + umbrella shim

**Files:**
- Create: `server/services/ops/connections/gsc/index.js`
- Modify: `server/services/ops/checks/website/gsc.js` (rewrite to shim)
- Test: `server/services/ops/__tests__/gscConnectorShim.test.js`

**Interfaces:**
- Consumes: all modules from Tasks 2–6.
- Produces:
  - `server/services/ops/connections/gsc/index.js` — the spec §5 connector object, default export.
  - Rewritten `checks/website/gsc.js` — imports the 4 original handler factories from `connections/gsc/checks.js` and registers them under the original `web.gsc.*` IDs with `umbrella: 'website'`.
  - Shim test: after importing `checks/website/gsc.js`, `getCheck('web.gsc.indexed_pages_drop')` must be non-null and its handler must return a valid `{ status }` shape.

- [ ] **Step 1: Write the failing shim test**

Create `server/services/ops/__tests__/gscConnectorShim.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';

// Import the shim to trigger side-effect registrations
import '../checks/website/gsc.js';

import { getCheck } from '../checks/registry.js';
import { _resetRegistryForTests } from '../checks/registry.js';

// Note: we do NOT reset the registry before this test because we're testing
// that the shim's side-effect registrations happen on import. The shim test
// file should run in its own process (node --test isolates test files).

const ORIGINAL_CHECK_IDS = [
  'web.gsc.coverage_errors',
  'web.gsc.manual_actions',
  'web.gsc.crux_lcp',
  'web.gsc.indexed_pages_drop'
];

test('umbrella shim: all 4 original web.gsc.* check IDs are registered', () => {
  for (const id of ORIGINAL_CHECK_IDS) {
    const entry = getCheck(id);
    assert.ok(entry, `${id} must be registered`);
    assert.equal(entry.umbrella, 'website');
    assert.equal(typeof entry.handler, 'function');
  }
});

test('umbrella shim: web.gsc.indexed_pages_drop returns a valid shape when skipped (no auth)', async () => {
  const entry = getCheck('web.gsc.indexed_pages_drop');
  const ctx = { clientUserId: '00000000-0000-0000-0000-000000000001', signal: null, config: {}, credentials: {} };
  const result = await entry.handler(ctx);
  assert.ok(['pass', 'fail', 'error', 'skipped'].includes(result.status), `unexpected status: ${result.status}`);
  assert.ok(result.payload !== undefined, 'payload must be present');
});

test('umbrella shim: web.gsc.coverage_errors returns a valid shape', async () => {
  const entry = getCheck('web.gsc.coverage_errors');
  const ctx = { clientUserId: '00000000-0000-0000-0000-000000000001', signal: null, config: {}, credentials: {} };
  const result = await entry.handler(ctx);
  assert.ok(['pass', 'fail', 'error', 'skipped'].includes(result.status));
});

test('connector: new gsc.* check IDs are also registered', () => {
  // The checks.js module registers them on import (side effect)
  // Pull in the connector to ensure checks.js is loaded
  const NEW_IDS = [
    'gsc.connection_health',
    'gsc.click_drop',
    'gsc.impression_drop',
    'gsc.page_decline',
    'gsc.query_decline',
    'gsc.query_opportunity',
    'gsc.page_indexing_issue',
    'gsc.canonical_mismatch',
    'gsc.device_specific_drop',
    'gsc.zero_click_high_impression_pages'
  ];
  for (const id of NEW_IDS) {
    const entry = getCheck(id);
    assert.ok(entry, `${id} must be registered`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gscConnectorShim.test.js
```

Expected: FAIL — `Cannot resolve '../checks/website/gsc.js'` OR the old check IDs are missing after the shim is loaded.

- [ ] **Step 3: Read the current gsc.js to preserve its check IDs**

Open `server/services/ops/checks/website/gsc.js` and note the four original check IDs that must survive:
- `web.gsc.coverage_errors`
- `web.gsc.manual_actions`
- `web.gsc.crux_lcp`
- `web.gsc.indexed_pages_drop`

The handlers for these IDs in the new shim delegate to injectable factories from `connections/gsc/checks.js`, using the new service-account auth. This means the original OAuth-only path is replaced by the service-account primary / OAuth fallback — a behavior improvement that keeps the same check ID and same result shape.

- [ ] **Step 4: Rewrite gsc.js as the umbrella shim**

Replace the entire contents of `server/services/ops/checks/website/gsc.js` with:

```js
/**
 * website/gsc.js — umbrella shim (spec §4 back-compat).
 *
 * Keeps the four original web.gsc.* check IDs registered under umbrella:'website'
 * so the existing run executor dispatches them unchanged.
 *
 * All logic lives in server/services/ops/connections/gsc/checks.js.
 * Auth is now service-account primary / ADC / OAuth fallback (via resolveGscToken).
 *
 * When F1's connector registry lands, these four checks will be migrated to
 * the connector's checks[] array and this shim can be removed.
 */
import { registerCheck } from '../registry.js';
import {
  makePageIndexingIssueCheck,
  makeConnectionHealthCheck,
  makeZeroClickHighImpressionCheck,
  makeQueryOpportunityCheck
} from '../../../connections/gsc/checks.js';

// web.gsc.coverage_errors — connection health proxy (original checked OAuth; now checks SA)
registerCheck('web.gsc.coverage_errors', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: makeConnectionHealthCheck()
});

// web.gsc.manual_actions — not exposed via public API; returns skipped with advisory note
registerCheck('web.gsc.manual_actions', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (_ctx) => ({
    status: 'skipped',
    payload: { reason: 'Manual actions are not exposed via the Search Console API; verify in the Google Search Console UI.' }
  })
});

// web.gsc.crux_lcp — deferred to PSI check; keep registered as skipped placeholder
registerCheck('web.gsc.crux_lcp', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (_ctx) => ({
    status: 'skipped',
    payload: { reason: 'CrUX LCP is captured by web.psi; this check is a placeholder for per-page CrUX rollouts.' }
  })
});

// web.gsc.indexed_pages_drop — promoted to the full page indexing check
registerCheck('web.gsc.indexed_pages_drop', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: makePageIndexingIssueCheck()
});
```

- [ ] **Step 5: Create the connector index**

Create `server/services/ops/connections/gsc/index.js`:

```js
/**
 * Search Console connector — spec §5 locked interface.
 *
 * id:              'search_console'
 * serviceCategory: 'organic_search'
 * provider:        'search_console'
 *
 * checks[] lists the 11 new gsc.* IDs. Registration happens as a side
 * effect of importing checks.js; this array is for the F1 connector registry
 * to declare what this connector owns.
 */
import './checks.js';  // side-effect: registers all 11 gsc.* checks

import { resolveGscToken } from './auth.js';
import { listSites, discoverInventory, getMatchedSite } from './inventory.js';
import { collectSnapshot as collectSnapshotFn } from './snapshot.js';

const connector = {
  id: 'search_console',
  serviceCategory: 'organic_search',
  provider: 'search_console',
  connectionTypes: ['service_account', 'oauth'],

  /**
   * verifyConnection: confirm the token works and the matched property is accessible.
   * ctx: { clientUserId, signal? }
   * → { status: 'verified'|'degraded'|'failed', detail, capabilities }
   */
  async verifyConnection(ctx) {
    const token = await resolveGscToken({ env: process.env }).catch(() => null);
    if (!token) {
      return { status: 'failed', detail: 'No GSC credentials configured (GA4_SERVICE_ACCOUNT_KEY / ADC / OAuth)', capabilities: [] };
    }
    try {
      const sites = await listSites(token, { signal: ctx.signal });
      const matched = await getMatchedSite(ctx.clientUserId);
      if (!matched) {
        return { status: 'degraded', detail: `Authenticated (${sites.length} site(s) accessible) but no property matched to client website`, capabilities: ['read'] };
      }
      return { status: 'verified', detail: `Property ${matched.site_url} accessible (${matched.permission_level})`, capabilities: ['read'] };
    } catch (err) {
      return { status: 'failed', detail: err.message, capabilities: [] };
    }
  },

  /**
   * discoverInventory: match and persist the client's GSC property.
   * ctx: { clientUserId, signal? }
   * → Array of ops_platform_inventory-shaped rows
   */
  async discoverInventory(ctx) {
    const token = await resolveGscToken({ env: process.env }).catch(() => null);
    if (!token) return [];
    const { resolveClientWebsiteUrl } = await import('../../checks/website/_lib/httpFetch.js');
    const { query } = await import('../../../../db.js');
    const websiteUrl = await resolveClientWebsiteUrl(query, ctx.clientUserId).catch(() => null);
    if (!websiteUrl) return [];
    return discoverInventory({ clientUserId: ctx.clientUserId, websiteUrl, token });
  },

  /**
   * collectSnapshot: fetch GSC search analytics for the current date.
   * ctx: { clientUserId, signal? }
   * → Array of ops_daily_snapshots-shaped rows (caller persists)
   */
  async collectSnapshot(ctx) {
    const token = await resolveGscToken({ env: process.env }).catch(() => null);
    if (!token) return [];
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return [];
    const date = new Date().toISOString().slice(0, 10);
    return collectSnapshotFn({ clientUserId: ctx.clientUserId, siteUrl: matched.site_url, token, date, signal: ctx.signal });
  },

  /**
   * listCapabilities: what this connector can do given the current connection.
   */
  async listCapabilities(ctx) {
    const token = await resolveGscToken({ env: process.env }).catch(() => null);
    if (!token) return {};
    return { read: true, mutate: false };
  },

  // Mutating actions (submit_sitemap, request_url_inspection) require operator
  // approval and are deferred to a later phase per spec §8.
  actions: {},

  checks: [
    'gsc.connection_health',
    'gsc.site_access_missing',
    'gsc.click_drop',
    'gsc.impression_drop',
    'gsc.page_decline',
    'gsc.query_decline',
    'gsc.query_opportunity',
    'gsc.page_indexing_issue',
    'gsc.canonical_mismatch',
    'gsc.device_specific_drop',
    'gsc.zero_click_high_impression_pages'
  ]
};

export default connector;
```

- [ ] **Step 6: Run shim test to verify it passes**

```bash
node --test server/services/ops/__tests__/gscConnectorShim.test.js
```

Expected: PASS (4 tests — all 4 original IDs registered, handlers return valid shapes, all 10 new IDs registered).

- [ ] **Step 7: Run the full ops test suite for regressions**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops
```

Expected: all prior tests PASS; the 6 new GSC test files all PASS. No red.

- [ ] **Step 8: Commit**

```bash
git add server/services/ops/connections/gsc/index.js \
        server/services/ops/checks/website/gsc.js \
        server/services/ops/__tests__/gscConnectorShim.test.js
git commit -m "feat(ops/gsc): connector index + umbrella shim — web.gsc.* IDs preserved"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Covered by |
|---|---|
| Full connector conforming to spec §5 contract (`verifyConnection`, `discoverInventory`, `collectSnapshot`, `listCapabilities`, `checks`) | Task 7 — `connections/gsc/index.js` |
| Service-account auth via `GA4_SERVICE_ACCOUNT_KEY`/ADC + OAuth fallback | Task 2 — `auth.js` |
| Property matching: `exact_config → sc-domain → url-prefix https www → https → http → manual` (north-star §6.4) | Task 3 — `propertyMatcher.js` |
| Persist match confidence | Task 1 (`ops_gsc_site_inventory`) + Task 4 (`inventory.js` upsert) |
| Inventory: site properties + permission level + property type + matched client | Task 4 — `discoverInventory` returns `ops_platform_inventory`-shaped rows with all four fields |
| Snapshots: clicks/impressions/ctr/position; by page; by query; by device | Task 5 — `collectSnapshot` returns all 4 scope types |
| 11 checks (north-star §6.8): all listed | Task 6 |
| `web.gsc.*` umbrella shim keeps existing IDs working | Task 7 — shim rewrite + shim test |
| No new npm deps | `google-auth-library` already in `package.json`; `googleapis` NOT added |
| Credentials: env-var / Postgres, NOT Secret Manager (spec §3.1) | Task 2 — `resolveGscToken` reads `process.env` only |
| No LLM math; PHI not persisted | Snapshots store only numeric aggregates; no LLM calls anywhere |
| New migration registered | Task 1 |
| Drop checks work without F3 baselines | Tasks 6 — all drop checks fetch two periods directly from GSC API |
| `discoverInventory` / `collectSnapshot` return F1/F3-shaped rows | Tasks 4, 5 — shapes documented and verified in tests |
| `canonical_mismatch` check via URL Inspection API | Task 6 — `makeCanonicalMismatchCheck` |
| `site_access_missing` check | Task 6 |

**Placeholder scan:** All test code is concrete. No TBD/TODO in any step. The `canonical_mismatch` check inspects top-10 pages by impressions (28d window) — the sample size is explicit, not vague. The `makePageIndexingIssueCheck` `defaultFetchSitemaps` inline is complete production code, not a stub.

**Type consistency:**
- `resolveGscToken` returns `string|null` — consumed by all 11 check factories and `verifyConnection`.
- `getMatchedSite` returns `{ site_url, match_type, match_confidence, permission_level, property_type } | null` — all 11 checks reference `matched.site_url`, which is the correct field name.
- `discoverInventory` returns rows where `external_id` is the `siteUrl` string — `getMatchedSite` returns `site_url`, not `external_id`. Consistent: `discoverInventory` stores `site_url` in `ops_gsc_site_inventory.site_url`, and `getMatchedSite` reads that column back as `site_url`.
- `querySearchAnalytics` third arg is a plain body object — all check factories pass `{ startDate, endDate, dimensions?, rowLimit }`, consistent with the function signature.
- `collectSnapshot`'s `_queryAnalytics` injection signature is `async (token, siteUrl, body) => {rows}` — all test fakes match this exact signature.
- `ops_daily_snapshots` row `scope_type` values: `'site'|'page'|'query'|'device'` — used consistently in `snapshot.js` and verified in tests.
- `matchProperty` returns object with `siteUrl` key — `inventory.js` reads `match.siteUrl`. `propertyType` receives `match.siteUrl`. Consistent throughout.
