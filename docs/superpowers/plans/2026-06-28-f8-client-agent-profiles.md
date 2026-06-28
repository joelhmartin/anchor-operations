# F8 — Client Agent Profiles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-client agent profiles (`ops_client_agent_profiles`) that store goals, budgets, and automation/notification policies, exposed via GET/PUT routes and a Config menu UI panel, and merged by a pure `profileResolver` into an effective policy object ready for F4 (policyApplicator) and F5 (notificationRouter).

**Architecture:** A new Postgres table (`ops_client_agent_profiles`) extends — but does not duplicate — the pre-existing `client_profiles` table. A pure `agentProfileResolver.js` merges one row from each table into a resolved policy object. A thin `agentProfileStore.js` owns the DB I/O. Two new admin routes in `server/routes/ops.js` gate on `isOperationsClient`. A React/MUI `ClientAgentProfileEditor` component renders under the existing Config gear menu in the per-client workspace.

**Tech Stack:** Node ESM, `pg` via `server/db.js`, `node:test` + `node:assert/strict`, React 18, MUI v5, existing `api/ops.js` axios client.

## Global Constraints

- **No new npm dependencies.** Use only what `package.json` already declares.
- **Credentials are env-var / Postgres, NOT Secret Manager.** (Spec §3.1.)
- **`hipaa_restricted` / `client_type` drive the HIPAA gate — never weaken it.** A `client_type = 'medical'` row in `client_profiles` forces `hipaa_restricted: true` in the resolved profile regardless of the stored agent-profile value. The PUT handler enforces the same: if `client_type === 'medical'`, the stored `hipaa_restricted` is set to `true` before write.
- **Authz:** every `/clients/:id/*` route gates on `isOperationsClient(req.params.id)` before executing. (Matches existing hardening in `docs/OPERATIONS.md §10`.)
- **New migration:** `server/sql/migrate_ops_client_agent_profiles.sql` (idempotent `CREATE TABLE IF NOT EXISTS`). Append filename to the `MIGRATIONS_AFTER_SEED` array in `server/migrations.js` (currently ends with `'migrate_ops_run_definition_model.sql'`).
- **DB tests:** `DATABASE_URL=postgresql://bif@localhost:5432/anchor`; run with `yarn test:ops`; `node:test` + `node:assert/strict`.
- **`profileResolver` merge logic is PURE** — no DB calls, no I/O. Unit-tested without a database.
- **F4 / F5 dependency boundary:** `policyApplicator` (F4) and `notificationRouter` (F5) are not yet built. This plan defines the resolved-profile shape precisely so those phases can import `loadResolvedProfile` and consume the result without any changes to this plan's files.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/sql/migrate_ops_client_agent_profiles.sql` | Idempotent `CREATE TABLE IF NOT EXISTS ops_client_agent_profiles`. |
| `server/migrations.js` | Append migration filename to `MIGRATIONS_AFTER_SEED`. |
| `server/services/ops/agentProfileResolver.js` | **Pure** `resolveProfile(cpRow, apRow)` → resolved policy object. No DB. |
| `server/services/ops/agentProfileStore.js` | `getAgentProfile`, `upsertAgentProfile`, `loadResolvedProfile` — all DB I/O. |
| `server/routes/ops.js` | Add imports + `GET /clients/:id/agent-profile` + `PUT /clients/:id/agent-profile`. |
| `server/services/ops/__tests__/agentProfileResolver.test.js` | Pure unit tests — no DB. |
| `server/services/ops/__tests__/agentProfileStore.test.js` | DB-backed round-trip tests. |
| `src/api/ops.js` | Add `getClientAgentProfile` + `updateClientAgentProfile`. |
| `src/views/admin/Operations/OpsWorkspaceContext.jsx` | Append `{ value: 'agent_profile', label: 'Agent profile' }` to `CONFIG_SECTIONS`. |
| `src/views/admin/Operations/Clients/ClientWorkspace.jsx` | Add `import ClientAgentProfileEditor` + `case 'agent_profile'` in `SectionBody`. |
| `src/views/admin/Operations/Clients/ClientAgentProfileEditor.jsx` | New React/MUI form component for the agent profile Config section. |

---

## Resolved-Profile Shape (interface contract for F4 + F5)

The object returned by `resolveProfile(cpRow, apRow)` and `loadResolvedProfile(clientUserId)` is the **only** shape F4 and F5 should program against. Never add fields to this shape without updating both the resolver and this section.

```js
{
  // From agentProfileResolver.js / loadResolvedProfile — clientUserId appended by store
  clientUserId: string,          // UUID — added by loadResolvedProfile, not the pure fn

  // Identity (from ops_client_agent_profiles; client_type from client_profiles)
  enabled: boolean,              // false when no profile row exists
  client_name: string | null,
  website_url: string | null,
  client_type: string | null,    // READ from client_profiles, NOT stored in ops_client_agent_profiles
  hipaa_restricted: boolean,     // true when client_type==='medical' OR profile.hipaa_restricted===true

  // Goals (from ops_client_agent_profiles)
  primary_services: string[],    // from primary_services_json; e.g. ['paid_ads','organic_search']
  target_cpa_cents: number | null,
  daily_budget_expected_cents: number | null,
  monthly_budget_expected_cents: number | null,
  monthly_budget_cap_cents: number | null,  // READ from client_profiles.ops_monthly_cap_cents
  lead_goal_monthly: number | null,

  // Policy (from ops_client_agent_profiles JSONB columns)
  allowed_platforms: string[],   // from allowed_platforms_json; e.g. ['google_ads','meta']
  auto_action_policy: {
    mode: 'off' | 'suggest' | 'auto',
    max_risk_level: 'low' | 'medium' | 'high'
  },
  notification_policy: {
    email: boolean,
    digest_frequency: 'none' | 'daily' | 'weekly'
  },
  google_chat_policy: {
    enabled: boolean,
    space_id: string | null
  },

  // Freeform
  agent_notes: string | null
}
```

**F4 policyApplicator** consumes: `enabled`, `hipaa_restricted`, `allowed_platforms`, `auto_action_policy`, `target_cpa_cents`.
**F5 notificationRouter** consumes: `hipaa_restricted`, `notification_policy`, `google_chat_policy`, `client_type`.

---

### Task 1: Migration + registration

**Files:**
- Create: `server/sql/migrate_ops_client_agent_profiles.sql`
- Modify: `server/migrations.js` (append to `MIGRATIONS_AFTER_SEED` array)

**Interfaces:**
- Produces: `ops_client_agent_profiles` table with PK `user_id` (FK → `users.id` ON DELETE CASCADE).

- [ ] **Step 1: Write the migration SQL**

Create `server/sql/migrate_ops_client_agent_profiles.sql`:

```sql
-- F8: per-client agent profile (goals, policies). Extends client_profiles.
-- client_type and ops_monthly_cap_cents stay in client_profiles — not duplicated here.
-- The resolver (agentProfileResolver.js) merges both rows into the effective policy.
CREATE TABLE IF NOT EXISTS ops_client_agent_profiles (
  user_id                       uuid PRIMARY KEY
                                  REFERENCES users(id) ON DELETE CASCADE,

  -- Identity overrides (supplement client_profiles)
  enabled                       boolean NOT NULL DEFAULT false,
  client_name                   text,              -- display-name override (max 200 chars)
  website_url                   text,              -- primary site URL (max 500 chars)
  hipaa_restricted              boolean NOT NULL DEFAULT false,
                                                   -- true forces HIPAA gate regardless of client_type;
                                                   -- resolver also enforces: client_type='medical' → always true

  -- Goals
  primary_services_json         jsonb NOT NULL DEFAULT '[]'::jsonb,
                                                   -- string[] e.g. ["paid_ads","organic_search"]
  target_cpa_cents              int CHECK (target_cpa_cents IS NULL OR target_cpa_cents >= 0),
  daily_budget_expected_cents   int CHECK (daily_budget_expected_cents IS NULL OR daily_budget_expected_cents >= 0),
  monthly_budget_expected_cents int CHECK (monthly_budget_expected_cents IS NULL OR monthly_budget_expected_cents >= 0),
  lead_goal_monthly             int CHECK (lead_goal_monthly IS NULL OR lead_goal_monthly >= 0),

  -- Platform + automation policy
  allowed_platforms_json        jsonb NOT NULL DEFAULT '[]'::jsonb,
                                                   -- string[] e.g. ["google_ads","meta","ctm"]
  auto_action_policy_json       jsonb NOT NULL DEFAULT '{"mode":"off","max_risk_level":"low"}'::jsonb,
  notification_policy_json      jsonb NOT NULL DEFAULT '{"email":true,"digest_frequency":"weekly"}'::jsonb,
  google_chat_policy_json       jsonb NOT NULL DEFAULT '{"enabled":false,"space_id":null}'::jsonb,

  -- Freeform context
  agent_notes                   text,              -- max 2000 chars enforced in route layer

  created_at                    timestamptz NOT NULL DEFAULT now(),
  updated_at                    timestamptz NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Register the migration**

In `server/migrations.js`, change the `MIGRATIONS_AFTER_SEED` array (line 42) from:

```js
const MIGRATIONS_AFTER_SEED = ['migrate_ops_recipes.sql', 'migrate_ops_skill_model.sql', 'migrate_ops_run_definition_model.sql'];
```

to:

```js
const MIGRATIONS_AFTER_SEED = ['migrate_ops_recipes.sql', 'migrate_ops_skill_model.sql', 'migrate_ops_run_definition_model.sql', 'migrate_ops_client_agent_profiles.sql'];
```

- [ ] **Step 3: Run the migration locally**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn db:migrate
```

Expected: completes without error. Re-running is a no-op (`IF NOT EXISTS`).

- [ ] **Step 4: Verify table exists**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor node -e "
import('./server/db.js').then(async ({query}) => {
  const {rows} = await query(\"SELECT column_name FROM information_schema.columns WHERE table_name='ops_client_agent_profiles' ORDER BY ordinal_position\");
  console.log(rows.map(r=>r.column_name).join(', '));
  process.exit(0);
}).catch(e=>{console.error(e);process.exit(1)});
"
```

Expected output includes: `user_id, enabled, client_name, website_url, hipaa_restricted, primary_services_json, target_cpa_cents, daily_budget_expected_cents, monthly_budget_expected_cents, lead_goal_monthly, allowed_platforms_json, auto_action_policy_json, notification_policy_json, google_chat_policy_json, agent_notes, created_at, updated_at`

- [ ] **Step 5: Commit**

```bash
git add server/sql/migrate_ops_client_agent_profiles.sql server/migrations.js
git commit -m "feat(ops/f8): ops_client_agent_profiles migration + registration"
```

---

### Task 2: Profile resolver (pure function + unit tests)

**Files:**
- Create: `server/services/ops/agentProfileResolver.js`
- Create: `server/services/ops/__tests__/agentProfileResolver.test.js`

**Interfaces:**
- Consumes: nothing (pure — no imports from this codebase).
- Produces:
  - `resolveProfile(cpRow, apRow): ResolvedProfile` where `cpRow = { client_type, ops_monthly_cap_cents }` and `apRow` is an `ops_client_agent_profiles` row or `null`. Returns the resolved-profile shape defined above (without `clientUserId` — that is added by the store).
  - `parseJsonArray(val): string[]` — exported for tests.
  - `parseJsonObject(val, defaults): object` — exported for tests.

- [ ] **Step 1: Write the failing tests**

Create `server/services/ops/__tests__/agentProfileResolver.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveProfile, parseJsonArray, parseJsonObject } from '../agentProfileResolver.js';

// ── parseJsonArray ──────────────────────────────────────────────────────────

test('parseJsonArray: already-parsed array passes through', () => {
  assert.deepEqual(parseJsonArray(['a', 'b']), ['a', 'b']);
});

test('parseJsonArray: JSON string is parsed', () => {
  assert.deepEqual(parseJsonArray('["x","y"]'), ['x', 'y']);
});

test('parseJsonArray: null/undefined/non-array returns []', () => {
  assert.deepEqual(parseJsonArray(null), []);
  assert.deepEqual(parseJsonArray(undefined), []);
  assert.deepEqual(parseJsonArray(42), []);
  assert.deepEqual(parseJsonArray('not-json'), []);
});

// ── parseJsonObject ─────────────────────────────────────────────────────────

test('parseJsonObject: merges object over defaults', () => {
  const defaults = { mode: 'off', max_risk_level: 'low' };
  assert.deepEqual(parseJsonObject({ mode: 'auto' }, defaults), { mode: 'auto', max_risk_level: 'low' });
});

test('parseJsonObject: JSON string is parsed and merged', () => {
  const defaults = { email: true, digest_frequency: 'weekly' };
  assert.deepEqual(parseJsonObject('{"email":false}', defaults), { email: false, digest_frequency: 'weekly' });
});

test('parseJsonObject: null/invalid returns defaults', () => {
  const defaults = { enabled: false, space_id: null };
  assert.deepEqual(parseJsonObject(null, defaults), defaults);
  assert.deepEqual(parseJsonObject('bad-json', defaults), defaults);
});

// ── resolveProfile: HIPAA gate ───────────────────────────────────────────────

test('resolveProfile: medical client_type forces hipaa_restricted=true even if profile says false', () => {
  const cp = { client_type: 'medical', ops_monthly_cap_cents: 500 };
  const ap = { hipaa_restricted: false, enabled: true, client_name: 'Test', website_url: null,
    primary_services_json: [], target_cpa_cents: null, daily_budget_expected_cents: null,
    monthly_budget_expected_cents: null, lead_goal_monthly: null, allowed_platforms_json: [],
    auto_action_policy_json: { mode: 'off', max_risk_level: 'low' },
    notification_policy_json: { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json: { enabled: false, space_id: null }, agent_notes: null };
  const profile = resolveProfile(cp, ap);
  assert.equal(profile.hipaa_restricted, true, 'medical client must always be hipaa_restricted');
  assert.equal(profile.client_type, 'medical');
});

test('resolveProfile: non-medical with hipaa_restricted=true stays restricted', () => {
  const cp = { client_type: 'ecommerce', ops_monthly_cap_cents: 500 };
  const ap = { hipaa_restricted: true, enabled: false, client_name: null, website_url: null,
    primary_services_json: [], target_cpa_cents: null, daily_budget_expected_cents: null,
    monthly_budget_expected_cents: null, lead_goal_monthly: null, allowed_platforms_json: [],
    auto_action_policy_json: { mode: 'off', max_risk_level: 'low' },
    notification_policy_json: { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json: { enabled: false, space_id: null }, agent_notes: null };
  const profile = resolveProfile(cp, ap);
  assert.equal(profile.hipaa_restricted, true);
});

test('resolveProfile: non-medical with hipaa_restricted=false is not restricted', () => {
  const cp = { client_type: 'ecommerce', ops_monthly_cap_cents: 500 };
  const ap = { hipaa_restricted: false, enabled: true, client_name: null, website_url: null,
    primary_services_json: [], target_cpa_cents: null, daily_budget_expected_cents: null,
    monthly_budget_expected_cents: null, lead_goal_monthly: null, allowed_platforms_json: [],
    auto_action_policy_json: { mode: 'off', max_risk_level: 'low' },
    notification_policy_json: { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json: { enabled: false, space_id: null }, agent_notes: null };
  const profile = resolveProfile(cp, ap);
  assert.equal(profile.hipaa_restricted, false);
  assert.equal(profile.client_type, 'ecommerce');
});

// ── resolveProfile: null apRow (no profile row yet) ─────────────────────────

test('resolveProfile: null apRow yields safe defaults and inherits cap from client_profiles', () => {
  const cp = { client_type: null, ops_monthly_cap_cents: 1000 };
  const profile = resolveProfile(cp, null);
  assert.equal(profile.enabled, false);
  assert.equal(profile.hipaa_restricted, false);
  assert.equal(profile.monthly_budget_cap_cents, 1000, 'cap from client_profiles');
  assert.deepEqual(profile.primary_services, []);
  assert.deepEqual(profile.allowed_platforms, []);
  assert.deepEqual(profile.auto_action_policy, { mode: 'off', max_risk_level: 'low' });
  assert.deepEqual(profile.notification_policy, { email: true, digest_frequency: 'weekly' });
  assert.deepEqual(profile.google_chat_policy, { enabled: false, space_id: null });
  assert.equal(profile.agent_notes, null);
});

test('resolveProfile: null cpRow ops_monthly_cap_cents yields null monthly_budget_cap_cents', () => {
  const cp = { client_type: null, ops_monthly_cap_cents: null };
  const profile = resolveProfile(cp, null);
  assert.equal(profile.monthly_budget_cap_cents, null);
});

// ── resolveProfile: fields from apRow ───────────────────────────────────────

test('resolveProfile: monthly_budget_cap_cents comes from client_profiles, monthly_budget_expected_cents from apRow', () => {
  const cp = { client_type: null, ops_monthly_cap_cents: 2500 };
  const ap = { hipaa_restricted: false, enabled: true, client_name: 'ACME', website_url: 'https://acme.com',
    primary_services_json: ['paid_ads'], target_cpa_cents: 500, daily_budget_expected_cents: 1000,
    monthly_budget_expected_cents: 25000, lead_goal_monthly: 50, allowed_platforms_json: ['google_ads', 'meta'],
    auto_action_policy_json: { mode: 'suggest', max_risk_level: 'medium' },
    notification_policy_json: { email: false, digest_frequency: 'daily' },
    google_chat_policy_json: { enabled: true, space_id: 'spaces/ABC123' }, agent_notes: 'VIP client' };
  const profile = resolveProfile(cp, ap);
  assert.equal(profile.monthly_budget_cap_cents, 2500, 'cap = client_profiles value');
  assert.equal(profile.monthly_budget_expected_cents, 25000, 'goal = apRow value');
  assert.equal(profile.client_name, 'ACME');
  assert.equal(profile.website_url, 'https://acme.com');
  assert.equal(profile.target_cpa_cents, 500);
  assert.deepEqual(profile.primary_services, ['paid_ads']);
  assert.deepEqual(profile.allowed_platforms, ['google_ads', 'meta']);
  assert.deepEqual(profile.auto_action_policy, { mode: 'suggest', max_risk_level: 'medium' });
  assert.deepEqual(profile.notification_policy, { email: false, digest_frequency: 'daily' });
  assert.deepEqual(profile.google_chat_policy, { enabled: true, space_id: 'spaces/ABC123' });
  assert.equal(profile.agent_notes, 'VIP client');
});

test('resolveProfile: JSONB columns stored as strings (pg raw) are parsed correctly', () => {
  const cp = { client_type: null, ops_monthly_cap_cents: 500 };
  // pg sometimes returns JSONB as already-parsed objects; ensure both forms work
  const ap = { hipaa_restricted: false, enabled: true, client_name: null, website_url: null,
    primary_services_json: '["organic_search","website"]',
    target_cpa_cents: null, daily_budget_expected_cents: null,
    monthly_budget_expected_cents: null, lead_goal_monthly: null,
    allowed_platforms_json: '["ctm"]',
    auto_action_policy_json: '{"mode":"auto","max_risk_level":"high"}',
    notification_policy_json: '{"email":true,"digest_frequency":"none"}',
    google_chat_policy_json: '{"enabled":false,"space_id":null}', agent_notes: null };
  const profile = resolveProfile(cp, ap);
  assert.deepEqual(profile.primary_services, ['organic_search', 'website']);
  assert.deepEqual(profile.allowed_platforms, ['ctm']);
  assert.deepEqual(profile.auto_action_policy, { mode: 'auto', max_risk_level: 'high' });
  assert.deepEqual(profile.notification_policy, { email: true, digest_frequency: 'none' });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
node --test server/services/ops/__tests__/agentProfileResolver.test.js
```

Expected: FAIL — `Cannot find module '../agentProfileResolver.js'`.

- [ ] **Step 3: Write the resolver**

Create `server/services/ops/agentProfileResolver.js`:

```js
/**
 * agentProfileResolver.js — PURE profile merger (no DB, no I/O).
 *
 * resolveProfile(cpRow, apRow) merges:
 *   cpRow: { client_type, ops_monthly_cap_cents }  from client_profiles
 *   apRow: ops_client_agent_profiles row | null
 *
 * Returns the effective policy object consumed by F4 (policyApplicator)
 * and F5 (notificationRouter). Shape is the contract defined in the F8 plan.
 *
 * HIPAA gate (never weakened):
 *   hipaa_restricted = client_type === 'medical' || Boolean(apRow?.hipaa_restricted)
 */

export function parseJsonArray(val) {
  if (Array.isArray(val)) return val;
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // fall through
    }
  }
  return [];
}

export function parseJsonObject(val, defaults) {
  if (val && typeof val === 'object' && !Array.isArray(val)) {
    return { ...defaults, ...val };
  }
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...defaults, ...parsed };
      }
    } catch {
      // fall through
    }
  }
  return defaults;
}

export function resolveProfile(cpRow, apRow) {
  const clientType = cpRow?.client_type ?? null;

  // HIPAA gate: never weakened. medical → always true.
  const hipaaRestricted = clientType === 'medical' || Boolean(apRow?.hipaa_restricted);

  return {
    enabled: Boolean(apRow?.enabled ?? false),
    client_name: apRow?.client_name ?? null,
    website_url: apRow?.website_url ?? null,
    client_type: clientType,
    hipaa_restricted: hipaaRestricted,

    primary_services: parseJsonArray(apRow?.primary_services_json),
    target_cpa_cents: apRow?.target_cpa_cents ?? null,
    daily_budget_expected_cents: apRow?.daily_budget_expected_cents ?? null,
    monthly_budget_expected_cents: apRow?.monthly_budget_expected_cents ?? null,
    monthly_budget_cap_cents: cpRow?.ops_monthly_cap_cents ?? null,
    lead_goal_monthly: apRow?.lead_goal_monthly ?? null,

    allowed_platforms: parseJsonArray(apRow?.allowed_platforms_json),
    auto_action_policy: parseJsonObject(apRow?.auto_action_policy_json, { mode: 'off', max_risk_level: 'low' }),
    notification_policy: parseJsonObject(apRow?.notification_policy_json, { email: true, digest_frequency: 'weekly' }),
    google_chat_policy: parseJsonObject(apRow?.google_chat_policy_json, { enabled: false, space_id: null }),

    agent_notes: apRow?.agent_notes ?? null
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
node --test server/services/ops/__tests__/agentProfileResolver.test.js
```

Expected: PASS (12 tests, no DB required).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/agentProfileResolver.js server/services/ops/__tests__/agentProfileResolver.test.js
git commit -m "feat(ops/f8): pure agentProfileResolver — HIPAA-safe merge of client_profiles + agent profile"
```

---

### Task 3: Profile store (DB layer + DB round-trip tests)

**Files:**
- Create: `server/services/ops/agentProfileStore.js`
- Create: `server/services/ops/__tests__/agentProfileStore.test.js`

**Interfaces:**
- Consumes: `query` from `../../db.js`; `resolveProfile` from `./agentProfileResolver.js`.
- Produces:
  - `getAgentProfile(clientUserId): Promise<row | null>` — raw `ops_client_agent_profiles` row or `null`.
  - `upsertAgentProfile(clientUserId, fields): Promise<row>` — INSERT … ON CONFLICT (user_id) DO UPDATE … RETURNING *.
  - `loadResolvedProfile(clientUserId): Promise<{ clientUserId, ...ResolvedProfile }>` — queries both tables, calls `resolveProfile`, prepends `clientUserId`. Returns a valid resolved profile even when no agent-profile row exists yet.

- [ ] **Step 1: Write the failing DB test**

Create `server/services/ops/__tests__/agentProfileStore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../db.js';
import { getAgentProfile, upsertAgentProfile, loadResolvedProfile } from '../agentProfileStore.js';

// ── getAgentProfile: unknown UUID returns null ───────────────────────────────
test('getAgentProfile returns null for a non-existent user_id', async () => {
  // Use a valid UUID format that will never be in the DB
  const result = await getAgentProfile('00000000-0000-0000-0000-000000000000');
  assert.equal(result, null);
});

// ── loadResolvedProfile: no profile row → safe defaults ─────────────────────
test('loadResolvedProfile returns safe defaults when no agent profile row exists', async () => {
  const { rows: userRows } = await query(
    "SELECT id FROM users WHERE role = 'client' LIMIT 1"
  );
  if (userRows.length === 0) {
    // No client user in this test environment — skip gracefully.
    console.log('SKIP: no client user found in DB');
    return;
  }
  const clientUserId = userRows[0].id;

  // Ensure no agent profile row exists for this user before we test defaults.
  await query('DELETE FROM ops_client_agent_profiles WHERE user_id = $1', [clientUserId]);

  const profile = await loadResolvedProfile(clientUserId);
  assert.equal(profile.clientUserId, clientUserId);
  assert.equal(profile.enabled, false);
  assert.deepEqual(profile.primary_services, []);
  assert.deepEqual(profile.allowed_platforms, []);
  assert.deepEqual(profile.auto_action_policy, { mode: 'off', max_risk_level: 'low' });
  assert.deepEqual(profile.notification_policy, { email: true, digest_frequency: 'weekly' });
  assert.deepEqual(profile.google_chat_policy, { enabled: false, space_id: null });
});

// ── upsertAgentProfile + getAgentProfile round-trip ─────────────────────────
test('upsertAgentProfile inserts then updates, getAgentProfile retrieves', async () => {
  const { rows: userRows } = await query(
    "SELECT id FROM users WHERE role = 'client' LIMIT 1"
  );
  if (userRows.length === 0) {
    console.log('SKIP: no client user found in DB');
    return;
  }
  const clientUserId = userRows[0].id;

  // Clean slate
  await query('DELETE FROM ops_client_agent_profiles WHERE user_id = $1', [clientUserId]);

  // Insert
  const inserted = await upsertAgentProfile(clientUserId, {
    enabled: true,
    client_name: '__f8test__',
    website_url: 'https://f8test.example.com',
    hipaa_restricted: false,
    primary_services_json: ['paid_ads', 'organic_search'],
    target_cpa_cents: 1500,
    daily_budget_expected_cents: 5000,
    monthly_budget_expected_cents: 100000,
    lead_goal_monthly: 40,
    allowed_platforms_json: ['google_ads', 'ctm'],
    auto_action_policy_json: { mode: 'suggest', max_risk_level: 'medium' },
    notification_policy_json: { email: false, digest_frequency: 'daily' },
    google_chat_policy_json: { enabled: true, space_id: 'spaces/TEST123' },
    agent_notes: 'f8 integration test'
  });

  assert.equal(inserted.user_id, clientUserId);
  assert.equal(inserted.enabled, true);
  assert.equal(inserted.client_name, '__f8test__');
  assert.equal(inserted.target_cpa_cents, 1500);
  assert.equal(inserted.agent_notes, 'f8 integration test');

  // Retrieve
  const fetched = await getAgentProfile(clientUserId);
  assert.ok(fetched, 'row must exist after upsert');
  assert.equal(fetched.user_id, clientUserId);
  assert.equal(fetched.client_name, '__f8test__');

  // Update (upsert again — different values)
  const updated = await upsertAgentProfile(clientUserId, {
    enabled: false,
    client_name: '__f8test_v2__',
    website_url: null,
    hipaa_restricted: true,
    primary_services_json: [],
    target_cpa_cents: null,
    daily_budget_expected_cents: null,
    monthly_budget_expected_cents: null,
    lead_goal_monthly: null,
    allowed_platforms_json: [],
    auto_action_policy_json: { mode: 'off', max_risk_level: 'low' },
    notification_policy_json: { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json: { enabled: false, space_id: null },
    agent_notes: null
  });
  assert.equal(updated.enabled, false);
  assert.equal(updated.client_name, '__f8test_v2__');
  assert.equal(updated.hipaa_restricted, true);
  assert.equal(updated.target_cpa_cents, null);

  // Cleanup
  await query('DELETE FROM ops_client_agent_profiles WHERE user_id = $1', [clientUserId]);
});

// ── loadResolvedProfile: merges client_profiles cap ─────────────────────────
test('loadResolvedProfile merges monthly_budget_cap_cents from client_profiles', async () => {
  const { rows: userRows } = await query(
    "SELECT u.id, cp.ops_monthly_cap_cents FROM users u LEFT JOIN client_profiles cp ON cp.user_id = u.id WHERE u.role = 'client' LIMIT 1"
  );
  if (userRows.length === 0) {
    console.log('SKIP: no client user found in DB');
    return;
  }
  const { id: clientUserId, ops_monthly_cap_cents } = userRows[0];

  // Ensure clean agent profile
  await query('DELETE FROM ops_client_agent_profiles WHERE user_id = $1', [clientUserId]);

  const profile = await loadResolvedProfile(clientUserId);
  assert.equal(profile.monthly_budget_cap_cents, ops_monthly_cap_cents ?? null,
    'monthly_budget_cap_cents must come from client_profiles.ops_monthly_cap_cents');
  assert.equal(profile.clientUserId, clientUserId);
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/agentProfileStore.test.js
```

Expected: FAIL — `Cannot find module '../agentProfileStore.js'`.

- [ ] **Step 3: Write the store**

Create `server/services/ops/agentProfileStore.js`:

```js
/**
 * agentProfileStore.js — DB I/O for ops_client_agent_profiles.
 *
 * getAgentProfile(clientUserId)           → row | null
 * upsertAgentProfile(clientUserId, fields) → row
 * loadResolvedProfile(clientUserId)        → { clientUserId, ...ResolvedProfile }
 *
 * loadResolvedProfile is the function F4 (policyApplicator) and F5
 * (notificationRouter) should call. It queries both tables and delegates
 * to the pure resolveProfile() for the merge.
 */

import { query } from '../../db.js';
import { resolveProfile } from './agentProfileResolver.js';

export async function getAgentProfile(clientUserId) {
  const { rows } = await query(
    'SELECT * FROM ops_client_agent_profiles WHERE user_id = $1',
    [clientUserId]
  );
  return rows[0] || null;
}

export async function upsertAgentProfile(clientUserId, fields) {
  const {
    enabled = false,
    client_name = null,
    website_url = null,
    hipaa_restricted = false,
    primary_services_json = [],
    target_cpa_cents = null,
    daily_budget_expected_cents = null,
    monthly_budget_expected_cents = null,
    lead_goal_monthly = null,
    allowed_platforms_json = [],
    auto_action_policy_json = { mode: 'off', max_risk_level: 'low' },
    notification_policy_json = { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json = { enabled: false, space_id: null },
    agent_notes = null
  } = fields;

  const { rows } = await query(
    `INSERT INTO ops_client_agent_profiles
       (user_id, enabled, client_name, website_url, hipaa_restricted,
        primary_services_json, target_cpa_cents, daily_budget_expected_cents,
        monthly_budget_expected_cents, lead_goal_monthly, allowed_platforms_json,
        auto_action_policy_json, notification_policy_json, google_chat_policy_json,
        agent_notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (user_id) DO UPDATE SET
       enabled                       = EXCLUDED.enabled,
       client_name                   = EXCLUDED.client_name,
       website_url                   = EXCLUDED.website_url,
       hipaa_restricted              = EXCLUDED.hipaa_restricted,
       primary_services_json         = EXCLUDED.primary_services_json,
       target_cpa_cents              = EXCLUDED.target_cpa_cents,
       daily_budget_expected_cents   = EXCLUDED.daily_budget_expected_cents,
       monthly_budget_expected_cents = EXCLUDED.monthly_budget_expected_cents,
       lead_goal_monthly             = EXCLUDED.lead_goal_monthly,
       allowed_platforms_json        = EXCLUDED.allowed_platforms_json,
       auto_action_policy_json       = EXCLUDED.auto_action_policy_json,
       notification_policy_json      = EXCLUDED.notification_policy_json,
       google_chat_policy_json       = EXCLUDED.google_chat_policy_json,
       agent_notes                   = EXCLUDED.agent_notes,
       updated_at                    = NOW()
     RETURNING *`,
    [
      clientUserId,
      Boolean(enabled),
      client_name,
      website_url,
      Boolean(hipaa_restricted),
      JSON.stringify(Array.isArray(primary_services_json) ? primary_services_json : []),
      target_cpa_cents,
      daily_budget_expected_cents,
      monthly_budget_expected_cents,
      lead_goal_monthly,
      JSON.stringify(Array.isArray(allowed_platforms_json) ? allowed_platforms_json : []),
      JSON.stringify(typeof auto_action_policy_json === 'object' && auto_action_policy_json !== null ? auto_action_policy_json : { mode: 'off', max_risk_level: 'low' }),
      JSON.stringify(typeof notification_policy_json === 'object' && notification_policy_json !== null ? notification_policy_json : { email: true, digest_frequency: 'weekly' }),
      JSON.stringify(typeof google_chat_policy_json === 'object' && google_chat_policy_json !== null ? google_chat_policy_json : { enabled: false, space_id: null }),
      agent_notes
    ]
  );
  return rows[0];
}

export async function loadResolvedProfile(clientUserId) {
  const [{ rows: cpRows }, apRow] = await Promise.all([
    query(
      'SELECT client_type, ops_monthly_cap_cents FROM client_profiles WHERE user_id = $1',
      [clientUserId]
    ),
    getAgentProfile(clientUserId)
  ]);
  const cpRow = cpRows[0] || { client_type: null, ops_monthly_cap_cents: null };
  return { clientUserId, ...resolveProfile(cpRow, apRow) };
}
```

- [ ] **Step 4: Run the store tests**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/agentProfileStore.test.js
```

Expected: PASS (4 tests; any SKIP messages for missing client users are acceptable in an empty test environment).

- [ ] **Step 5: Run the full ops test suite to confirm no regressions**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops
```

Expected: all existing tests pass plus the 4 new store tests and 12 resolver tests.

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/agentProfileStore.js server/services/ops/__tests__/agentProfileStore.test.js
git commit -m "feat(ops/f8): agentProfileStore — get/upsert/loadResolved with HIPAA-safe merge"
```

---

### Task 4: CRUD routes — GET + PUT /clients/:id/agent-profile

**Files:**
- Modify: `server/routes/ops.js` — add two imports near the top; add two routes after the cap endpoint.

**Interfaces:**
- Consumes: `loadResolvedProfile`, `upsertAgentProfile` from `../services/ops/agentProfileStore.js`; `query` already imported; `isUuid`, `isOperationsClient`, `badUuid` already defined in the file.
- Produces:
  - `GET /api/ops/clients/:id/agent-profile` → `{ profile: ResolvedProfile }`, 200. Always succeeds even if no agent profile row exists (returns defaults).
  - `PUT /api/ops/clients/:id/agent-profile` → `{ profile: ResolvedProfile }`, 200. Enforces HIPAA gate before write: if `client_type === 'medical'`, forces `hipaa_restricted: true` in stored data.

- [ ] **Step 1: Add the imports**

In `server/routes/ops.js`, find the existing import block (lines 13–54). After the last import line (`import { loadHomeDigest } ...`), add:

```js
import { loadResolvedProfile, upsertAgentProfile } from '../services/ops/agentProfileStore.js';
```

- [ ] **Step 2: Add the routes**

In `server/routes/ops.js`, locate the end of the cap endpoint (around line 1352, ending `});`). Immediately after that closing `});` and before the comment `// ---------------- AI chat`, add:

```js
// ---------------- Agent profiles (F8) ----------------

router.get('/clients/:id/agent-profile', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'client id');
  if (!(await isOperationsClient(req.params.id))) {
    return res.status(404).json({ message: 'Client account not found' });
  }
  try {
    const profile = await loadResolvedProfile(req.params.id);
    res.json({ profile });
  } catch (err) {
    console.error('[ops] GET /clients/:id/agent-profile failed:', err);
    res.status(500).json({ message: 'Failed to load agent profile' });
  }
});

router.put('/clients/:id/agent-profile', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'client id');
  if (!(await isOperationsClient(req.params.id))) {
    return res.status(404).json({ message: 'Client account not found' });
  }

  // Fetch client_type so we can enforce the HIPAA gate before write.
  let clientType = null;
  try {
    const { rows: cpRows } = await query(
      'SELECT client_type FROM client_profiles WHERE user_id = $1',
      [req.params.id]
    );
    clientType = cpRows[0]?.client_type || null;
  } catch (err) {
    console.warn('[ops] agent-profile PUT: client_type fetch failed:', err?.message);
  }

  const {
    enabled,
    client_name,
    website_url,
    hipaa_restricted,
    primary_services_json,
    target_cpa_cents,
    daily_budget_expected_cents,
    monthly_budget_expected_cents,
    lead_goal_monthly,
    allowed_platforms_json,
    auto_action_policy_json,
    notification_policy_json,
    google_chat_policy_json,
    agent_notes
  } = req.body || {};

  // HIPAA gate (never weakened): medical clients must always be hipaa_restricted.
  const effectiveHipaaRestricted = clientType === 'medical' ? true : Boolean(hipaa_restricted);

  const intOrNull = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };

  try {
    await upsertAgentProfile(req.params.id, {
      enabled: Boolean(enabled),
      client_name: client_name != null ? String(client_name).slice(0, 200) : null,
      website_url: website_url != null ? String(website_url).slice(0, 500) : null,
      hipaa_restricted: effectiveHipaaRestricted,
      primary_services_json: Array.isArray(primary_services_json) ? primary_services_json : [],
      target_cpa_cents: intOrNull(target_cpa_cents),
      daily_budget_expected_cents: intOrNull(daily_budget_expected_cents),
      monthly_budget_expected_cents: intOrNull(monthly_budget_expected_cents),
      lead_goal_monthly: intOrNull(lead_goal_monthly),
      allowed_platforms_json: Array.isArray(allowed_platforms_json) ? allowed_platforms_json : [],
      auto_action_policy_json: (auto_action_policy_json && typeof auto_action_policy_json === 'object' && !Array.isArray(auto_action_policy_json))
        ? auto_action_policy_json
        : { mode: 'off', max_risk_level: 'low' },
      notification_policy_json: (notification_policy_json && typeof notification_policy_json === 'object' && !Array.isArray(notification_policy_json))
        ? notification_policy_json
        : { email: true, digest_frequency: 'weekly' },
      google_chat_policy_json: (google_chat_policy_json && typeof google_chat_policy_json === 'object' && !Array.isArray(google_chat_policy_json))
        ? google_chat_policy_json
        : { enabled: false, space_id: null },
      agent_notes: agent_notes != null ? String(agent_notes).slice(0, 2000) : null
    });

    const profile = await loadResolvedProfile(req.params.id);
    res.json({ profile });
  } catch (err) {
    console.error('[ops] PUT /clients/:id/agent-profile failed:', err);
    res.status(500).json({ message: 'Failed to update agent profile' });
  }
});
```

- [ ] **Step 3: Verify the module graph loads without errors**

```bash
node --check server/routes/ops.js && node -e "import('./server/routes/ops.js').then(()=>console.log('ops routes OK')).catch(e=>{console.error(e);process.exit(1)})"
```

Expected: prints `ops routes OK`.

- [ ] **Step 4: Manual smoke test (requires running dev server)**

Start the server (`yarn dev` or `./dev.sh`), then with a valid admin session cookie:

```bash
# GET — should return { profile: { enabled: false, ... } } even before any PUT
curl -s http://localhost:4000/api/ops/clients/<VALID_CLIENT_UUID>/agent-profile \
  -H 'Cookie: <admin session>' | python3 -m json.tool | head -40

# PUT — save a profile
curl -s -X PUT http://localhost:4000/api/ops/clients/<VALID_CLIENT_UUID>/agent-profile \
  -H 'Content-Type: application/json' \
  -H 'Cookie: <admin session>' \
  -d '{"enabled":true,"client_name":"Test Client","target_cpa_cents":2500,"auto_action_policy_json":{"mode":"suggest","max_risk_level":"low"}}' \
  | python3 -m json.tool | head -40
```

Expected: GET returns `{ "profile": { "enabled": false, "hipaa_restricted": false, ... } }` before PUT. PUT returns `{ "profile": { "enabled": true, "client_name": "Test Client", ... } }`. A medical client's PUT with `"hipaa_restricted": false` must return `"hipaa_restricted": true`.

- [ ] **Step 5: Commit**

```bash
git add server/routes/ops.js
git commit -m "feat(ops/f8): GET + PUT /clients/:id/agent-profile — HIPAA-gated, isOperationsClient authz"
```

---

### Task 5: UI — API client + Config menu + React form component

**Files:**
- Modify: `src/api/ops.js` (add two API functions)
- Modify: `src/views/admin/Operations/OpsWorkspaceContext.jsx` (add `agent_profile` to CONFIG_SECTIONS)
- Modify: `src/views/admin/Operations/Clients/ClientWorkspace.jsx` (add import + case)
- Create: `src/views/admin/Operations/Clients/ClientAgentProfileEditor.jsx`

**Interfaces:**
- Consumes: `getClientAgentProfile(clientUserId)` → `{ profile }` and `updateClientAgentProfile(clientUserId, body)` → `{ profile }` from `api/ops.js`. Standard MUI components + existing `ui-component` primitives.
- Produces: A Config gear-menu item "Agent profile" that renders `ClientAgentProfileEditor` in the per-client workspace.

- [ ] **Step 1: Add API client functions**

In `src/api/ops.js`, after the last export (currently `export const getChatModels = ...`), add:

```js
export const getClientAgentProfile = (clientUserId) =>
  client.get(`/ops/clients/${clientUserId}/agent-profile`).then((r) => r.data);

export const updateClientAgentProfile = (clientUserId, body) =>
  client.put(`/ops/clients/${clientUserId}/agent-profile`, body).then((r) => r.data);
```

- [ ] **Step 2: Add agent_profile to CONFIG_SECTIONS**

In `src/views/admin/Operations/OpsWorkspaceContext.jsx`, change `CONFIG_SECTIONS` (lines 13–18) from:

```js
export const CONFIG_SECTIONS = [
  { value: 'health', label: 'Health checks' },
  { value: 'connections', label: 'Connections' },
  { value: 'runs', label: 'Run history' },
  { value: 'cost', label: 'Cost' }
];
```

to:

```js
export const CONFIG_SECTIONS = [
  { value: 'health', label: 'Health checks' },
  { value: 'connections', label: 'Connections' },
  { value: 'runs', label: 'Run history' },
  { value: 'cost', label: 'Cost' },
  { value: 'agent_profile', label: 'Agent profile' }
];
```

`ALL_SECTIONS` (line 19) derives from the spread of both arrays and automatically includes `agent_profile` — no further change needed there.

- [ ] **Step 3: Wire the new section into ClientWorkspace**

In `src/views/admin/Operations/Clients/ClientWorkspace.jsx`:

Add an import after the existing `import ClientOpsView` line:

```js
import ClientAgentProfileEditor from './ClientAgentProfileEditor';
```

In `SectionBody`, add a case before the `default` branch:

```js
case 'agent_profile':
  return <ClientAgentProfileEditor clientUserId={clientUserId} />;
```

The full updated `SectionBody` function becomes:

```js
function SectionBody({ section, clientUserId, activeClient, setSection }) {
  switch (section) {
    case 'overview':
      return <ClientOverview clientUserId={clientUserId} />;
    case 'findings':
      return <DiscoveriesTab activeClientId={clientUserId} onOpenDiscovery={() => {}} onOpenRun={() => {}} />;
    case 'socials':
      return <ContentTab activeClientId={clientUserId} mode="social" />;
    case 'blog':
      return <ContentTab activeClientId={clientUserId} mode="blog" />;
    case 'chat':
      return <ClientChat lockedClientUserId={clientUserId} />;
    case 'sites':
      return <ClientSitesPanel clientUserId={clientUserId} />;
    case 'health':
    case 'connections':
    case 'runs':
    case 'cost':
      return (
        <ClientOpsView
          clientUserId={clientUserId}
          clientName={clientLabel(activeClient)}
          onOpenChat={() => setSection('chat')}
          onOpenRun={() => setSection('runs')}
        />
      );
    case 'agent_profile':
      return <ClientAgentProfileEditor clientUserId={clientUserId} />;
    default:
      return <EmptyState title="Coming up" message={`The "${section}" section renders here.`} />;
  }
}
```

- [ ] **Step 4: Create the ClientAgentProfileEditor component**

Create `src/views/admin/Operations/Clients/ClientAgentProfileEditor.jsx`:

```jsx
/**
 * ClientAgentProfileEditor — per-client agent profile Config section.
 *
 * Backed by GET/PUT /api/ops/clients/:id/agent-profile.
 * The GET returns the resolved profile (merged from client_profiles +
 * ops_client_agent_profiles). The PUT saves only agent-profile-specific
 * fields; client_type and monthly_budget_cap_cents are read-only (managed
 * via the existing client profile and Cost config).
 *
 * HIPAA display: if client_type === 'medical', the hipaa_restricted checkbox
 * is rendered checked + disabled. Saving with hipaa_restricted=false for a
 * medical client is rejected server-side anyway, but the UI makes this obvious.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  Box,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  InputAdornment,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography
} from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveIcon from '@mui/icons-material/Save';
import MainCard from 'ui-component/cards/MainCard';
import LoadingButton from 'ui-component/extended/LoadingButton';
import EmptyState from 'ui-component/extended/EmptyState';
import { useToast } from 'contexts/ToastContext';
import { getClientAgentProfile, updateClientAgentProfile } from 'api/ops';

const PRIMARY_SERVICES_OPTIONS = [
  'paid_ads', 'organic_search', 'website', 'call_tracking', 'analytics', 'social'
];
const PLATFORM_OPTIONS = ['google_ads', 'meta', 'ctm', 'ga4', 'search_console'];

const DEFAULT_FORM = {
  enabled: false,
  client_name: '',
  website_url: '',
  hipaa_restricted: false,
  primary_services_json: [],
  target_cpa_cents: '',
  daily_budget_expected_cents: '',
  monthly_budget_expected_cents: '',
  lead_goal_monthly: '',
  allowed_platforms_json: [],
  auto_action_policy_json: { mode: 'off', max_risk_level: 'low' },
  notification_policy_json: { email: true, digest_frequency: 'weekly' },
  google_chat_policy_json: { enabled: false, space_id: '' },
  agent_notes: ''
};

function profileToForm(profile) {
  if (!profile) return DEFAULT_FORM;
  return {
    enabled: Boolean(profile.enabled),
    client_name: profile.client_name ?? '',
    website_url: profile.website_url ?? '',
    hipaa_restricted: Boolean(profile.hipaa_restricted),
    primary_services_json: Array.isArray(profile.primary_services) ? profile.primary_services : [],
    target_cpa_cents: profile.target_cpa_cents != null ? String(profile.target_cpa_cents) : '',
    daily_budget_expected_cents: profile.daily_budget_expected_cents != null ? String(profile.daily_budget_expected_cents) : '',
    monthly_budget_expected_cents: profile.monthly_budget_expected_cents != null ? String(profile.monthly_budget_expected_cents) : '',
    lead_goal_monthly: profile.lead_goal_monthly != null ? String(profile.lead_goal_monthly) : '',
    allowed_platforms_json: Array.isArray(profile.allowed_platforms) ? profile.allowed_platforms : [],
    auto_action_policy_json: profile.auto_action_policy ?? { mode: 'off', max_risk_level: 'low' },
    notification_policy_json: profile.notification_policy ?? { email: true, digest_frequency: 'weekly' },
    google_chat_policy_json: {
      ...{ enabled: false, space_id: '' },
      ...(profile.google_chat_policy ?? {}),
      space_id: profile.google_chat_policy?.space_id ?? ''
    },
    agent_notes: profile.agent_notes ?? ''
  };
}

function formToPayload(form) {
  const intOrNull = (v) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  return {
    enabled: form.enabled,
    client_name: form.client_name.trim() || null,
    website_url: form.website_url.trim() || null,
    hipaa_restricted: form.hipaa_restricted,
    primary_services_json: form.primary_services_json,
    target_cpa_cents: intOrNull(form.target_cpa_cents),
    daily_budget_expected_cents: intOrNull(form.daily_budget_expected_cents),
    monthly_budget_expected_cents: intOrNull(form.monthly_budget_expected_cents),
    lead_goal_monthly: intOrNull(form.lead_goal_monthly),
    allowed_platforms_json: form.allowed_platforms_json,
    auto_action_policy_json: form.auto_action_policy_json,
    notification_policy_json: form.notification_policy_json,
    google_chat_policy_json: {
      enabled: form.google_chat_policy_json.enabled,
      space_id: form.google_chat_policy_json.space_id.trim() || null
    },
    agent_notes: form.agent_notes.trim() || null
  };
}

export default function ClientAgentProfileEditor({ clientUserId }) {
  const { showToast } = useToast();
  const [profile, setProfile] = useState(null);
  const [form, setForm] = useState(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // Derived: is this a medical client? (hipaa_restricted checkbox becomes locked)
  const isMedical = profile?.client_type === 'medical';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { profile: p } = await getClientAgentProfile(clientUserId);
      setProfile(p);
      setForm(profileToForm(p));
    } catch (err) {
      showToast(`Couldn't load agent profile: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [clientUserId, showToast]);

  useEffect(() => { load(); }, [load]);

  const patch = (key, value) => setForm((prev) => ({ ...prev, [key]: value }));

  const patchPolicy = (policyKey, key, value) =>
    setForm((prev) => ({ ...prev, [policyKey]: { ...prev[policyKey], [key]: value } }));

  const toggleList = (listKey, item) =>
    setForm((prev) => {
      const cur = prev[listKey];
      return {
        ...prev,
        [listKey]: cur.includes(item) ? cur.filter((x) => x !== item) : [...cur, item]
      };
    });

  const save = async () => {
    setSaving(true);
    try {
      const { profile: updated } = await updateClientAgentProfile(clientUserId, formToPayload(form));
      setProfile(updated);
      setForm(profileToForm(updated));
      showToast('Agent profile saved', 'success');
    } catch (err) {
      showToast(`Save failed: ${err.response?.data?.message || err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !profile) {
    return <EmptyState title="Loading…" message="Fetching agent profile." />;
  }

  return (
    <Stack spacing={2}>
      {/* Toolbar */}
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="h4">Agent Profile</Typography>
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<RefreshIcon />} variant="outlined" size="small" onClick={load} disabled={loading}>
          Refresh
        </Button>
        <LoadingButton
          startIcon={<SaveIcon />}
          variant="contained"
          size="small"
          onClick={save}
          loading={saving}
          loadingLabel="Saving"
        >
          Save
        </LoadingButton>
      </Stack>

      {/* Identity */}
      <MainCard title="Identity">
        <Stack spacing={2}>
          <FormControlLabel
            control={<Switch checked={form.enabled} onChange={(e) => patch('enabled', e.target.checked)} />}
            label="Agent enabled for this client"
          />
          <TextField
            label="Client name override"
            value={form.client_name}
            onChange={(e) => patch('client_name', e.target.value)}
            size="small"
            fullWidth
            inputProps={{ maxLength: 200 }}
            helperText="Overrides the display name used in agent context."
          />
          <TextField
            label="Website URL"
            value={form.website_url}
            onChange={(e) => patch('website_url', e.target.value)}
            size="small"
            fullWidth
            inputProps={{ maxLength: 500 }}
            placeholder="https://"
          />
          <FormControlLabel
            control={
              <Checkbox
                checked={isMedical ? true : form.hipaa_restricted}
                disabled={isMedical}
                onChange={(e) => patch('hipaa_restricted', e.target.checked)}
              />
            }
            label={
              isMedical
                ? 'HIPAA restricted (enforced — medical client type)'
                : 'HIPAA restricted'
            }
          />
        </Stack>
      </MainCard>

      {/* Goals */}
      <MainCard title="Goals">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} flexWrap="wrap">
          <TextField
            label="Target CPA"
            value={form.target_cpa_cents}
            onChange={(e) => patch('target_cpa_cents', e.target.value)}
            size="small"
            type="number"
            inputProps={{ min: 0 }}
            InputProps={{ endAdornment: <InputAdornment position="end">¢</InputAdornment> }}
            sx={{ width: 180 }}
          />
          <TextField
            label="Daily budget expected"
            value={form.daily_budget_expected_cents}
            onChange={(e) => patch('daily_budget_expected_cents', e.target.value)}
            size="small"
            type="number"
            inputProps={{ min: 0 }}
            InputProps={{ endAdornment: <InputAdornment position="end">¢</InputAdornment> }}
            sx={{ width: 220 }}
          />
          <TextField
            label="Monthly budget expected"
            value={form.monthly_budget_expected_cents}
            onChange={(e) => patch('monthly_budget_expected_cents', e.target.value)}
            size="small"
            type="number"
            inputProps={{ min: 0 }}
            InputProps={{ endAdornment: <InputAdornment position="end">¢</InputAdornment> }}
            sx={{ width: 230 }}
          />
          <TextField
            label="Monthly lead goal"
            value={form.lead_goal_monthly}
            onChange={(e) => patch('lead_goal_monthly', e.target.value)}
            size="small"
            type="number"
            inputProps={{ min: 0 }}
            sx={{ width: 180 }}
          />
        </Stack>
        {profile?.monthly_budget_cap_cents != null && (
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
            Monthly run cap: {profile.monthly_budget_cap_cents}¢ — edit via Cost config.
          </Typography>
        )}
      </MainCard>

      {/* Services + Platforms */}
      <MainCard title="Services &amp; Platforms">
        <Stack spacing={1.5}>
          <Typography variant="subtitle2">Primary services</Typography>
          <Stack direction="row" flexWrap="wrap" gap={0.5}>
            {PRIMARY_SERVICES_OPTIONS.map((s) => (
              <FormControlLabel
                key={s}
                control={
                  <Checkbox
                    size="small"
                    checked={form.primary_services_json.includes(s)}
                    onChange={() => toggleList('primary_services_json', s)}
                  />
                }
                label={s}
              />
            ))}
          </Stack>
          <Typography variant="subtitle2" sx={{ pt: 1 }}>Allowed platforms</Typography>
          <Stack direction="row" flexWrap="wrap" gap={0.5}>
            {PLATFORM_OPTIONS.map((p) => {
              const metaGated = isMedical && p === 'meta';
              return (
                <FormControlLabel
                  key={p}
                  control={
                    <Checkbox
                      size="small"
                      checked={form.allowed_platforms_json.includes(p)}
                      onChange={() => !metaGated && toggleList('allowed_platforms_json', p)}
                      disabled={metaGated}
                    />
                  }
                  label={metaGated ? `${p} (HIPAA gated)` : p}
                />
              );
            })}
          </Stack>
        </Stack>
      </MainCard>

      {/* Automation policy */}
      <MainCard title="Automation policy">
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
          <FormControl size="small" sx={{ minWidth: 160 }}>
            <InputLabel>Mode</InputLabel>
            <Select
              label="Mode"
              value={form.auto_action_policy_json.mode}
              onChange={(e) => patchPolicy('auto_action_policy_json', 'mode', e.target.value)}
            >
              <MenuItem value="off">Off — no autonomous actions</MenuItem>
              <MenuItem value="suggest">Suggest only</MenuItem>
              <MenuItem value="auto">Autonomous</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>Max risk level</InputLabel>
            <Select
              label="Max risk level"
              value={form.auto_action_policy_json.max_risk_level}
              onChange={(e) => patchPolicy('auto_action_policy_json', 'max_risk_level', e.target.value)}
            >
              <MenuItem value="low">Low</MenuItem>
              <MenuItem value="medium">Medium</MenuItem>
              <MenuItem value="high">High</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </MainCard>

      {/* Notification policy */}
      <MainCard title="Notifications">
        <Stack spacing={2}>
          <FormControlLabel
            control={
              <Switch
                checked={form.notification_policy_json.email}
                onChange={(e) => patchPolicy('notification_policy_json', 'email', e.target.checked)}
              />
            }
            label="Email notifications"
          />
          <FormControl size="small" sx={{ minWidth: 180 }}>
            <InputLabel>Digest frequency</InputLabel>
            <Select
              label="Digest frequency"
              value={form.notification_policy_json.digest_frequency}
              onChange={(e) => patchPolicy('notification_policy_json', 'digest_frequency', e.target.value)}
            >
              <MenuItem value="none">None</MenuItem>
              <MenuItem value="daily">Daily</MenuItem>
              <MenuItem value="weekly">Weekly</MenuItem>
            </Select>
          </FormControl>
        </Stack>
      </MainCard>

      {/* Google Chat */}
      <MainCard title="Google Chat">
        <Stack spacing={2}>
          <FormControlLabel
            control={
              <Switch
                checked={form.google_chat_policy_json.enabled}
                onChange={(e) => patchPolicy('google_chat_policy_json', 'enabled', e.target.checked)}
              />
            }
            label="Send digests / alerts to Google Chat"
          />
          {form.google_chat_policy_json.enabled && (
            <TextField
              label="Space ID"
              value={form.google_chat_policy_json.space_id}
              onChange={(e) => patchPolicy('google_chat_policy_json', 'space_id', e.target.value)}
              size="small"
              fullWidth
              placeholder="spaces/XXXXXXXXXX"
              helperText="From the Google Chat space URL: chat.google.com/room/<space-id>."
            />
          )}
        </Stack>
      </MainCard>

      {/* Agent notes */}
      <MainCard title="Agent notes">
        <TextField
          multiline
          minRows={3}
          maxRows={8}
          fullWidth
          value={form.agent_notes}
          onChange={(e) => patch('agent_notes', e.target.value)}
          placeholder="Internal notes for the agent — client preferences, campaign context, special constraints…"
          inputProps={{ maxLength: 2000 }}
          helperText={`${form.agent_notes.length}/2000`}
        />
      </MainCard>

      {profile?.client_type && (
        <Typography variant="caption" color="text.secondary">
          Client type: {profile.client_type}
        </Typography>
      )}
    </Stack>
  );
}
```

- [ ] **Step 5: Verify the JS module compiles (no syntax errors)**

```bash
node --check src/views/admin/Operations/Clients/ClientAgentProfileEditor.jsx 2>/dev/null || \
  npx acorn --ecma2022 --module src/views/admin/Operations/Clients/ClientAgentProfileEditor.jsx > /dev/null && echo 'syntax OK'
```

(If neither works in this project, skip and rely on the Vite dev-server output in Step 6.)

- [ ] **Step 6: Visual smoke test in the running app**

Start the dev server. Navigate to Operations → Clients → pick any client → click the gear (Config) button. Verify "Agent profile" appears in the dropdown. Click it. Verify the form renders with all sections: Identity, Goals, Services & Platforms, Automation policy, Notifications, Google Chat, Agent notes. Fill a field, click Save, verify the toast shows "Agent profile saved" and the form repopulates with the saved values. For a medical client, verify the "HIPAA restricted" checkbox is checked and disabled.

- [ ] **Step 7: Run the full ops test suite one final time**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops
```

Expected: all prior tests + 12 resolver tests + 4 store tests = all PASS.

- [ ] **Step 8: Commit**

```bash
git add src/api/ops.js \
        src/views/admin/Operations/OpsWorkspaceContext.jsx \
        src/views/admin/Operations/Clients/ClientWorkspace.jsx \
        src/views/admin/Operations/Clients/ClientAgentProfileEditor.jsx
git commit -m "feat(ops/f8): Agent profile Config section — form, API client, context wiring"
```

---

## Self-Review

### Spec coverage

| Requirement | Task |
|---|---|
| `ops_client_agent_profiles` table with all §2.2 columns (`enabled`, `client_name`, `website_url`, `hipaa_restricted`, `primary_services_json`, `target_cpa_cents`, `daily_budget_expected_cents`, `monthly_budget_expected_cents`, `lead_goal_monthly`, `allowed_platforms_json`, `auto_action_policy_json`, `notification_policy_json`, `google_chat_policy_json`, `agent_notes`) | Task 1 |
| `client_type` and `ops_monthly_cap_cents` referenced from `client_profiles`, NOT duplicated | Tasks 2, 3 |
| Migration in `server/sql/` + append to `server/migrations.js` | Task 1 |
| `isOperationsClient(req.params.id)` authz gate on both routes | Task 4 |
| HIPAA gate: `client_type === 'medical'` forces `hipaa_restricted: true`, never weakened | Tasks 2 (resolver test), 4 (route enforcement) |
| GET/PUT `/api/ops/clients/:id/agent-profile` | Task 4 |
| Profile store module (`agentProfileStore.js`) | Task 3 |
| `profileResolver` merges both tables into effective policy object | Task 2 |
| Resolved-profile shape precisely defined for F4 + F5 | Resolved-Profile Shape section above |
| `profileResolver` merge logic is PURE — no DB | Tasks 2 (confirmed: no imports from `db.js`) |
| Unit tests for resolver — no DB | Task 2 (12 tests, `node --test` only) |
| DB tests for store | Task 3 (4 tests, `DATABASE_URL=... yarn test:ops`) |
| UI Config menu item "Agent profile" in per-client Config gear | Task 5 |
| `ClientAgentProfileEditor` React/MUI component + API wiring | Task 5 |
| No new npm dependencies | All tasks: only existing MUI, `pg`, React |
| Credentials env-var/Postgres, not Secret Manager | All tasks: no Secret Manager calls |

### Placeholder scan

No TBD / TODO / "add validation" / "similar to Task N" patterns. Every step contains the actual code. The only conditional in tests ("SKIP: no client user") is a concrete guard with a `console.log` message, not a placeholder — the test still runs and passes in empty environments.

### Type consistency

- `resolveProfile` returns `primary_services` (not `primary_services_json`); `allowed_platforms` (not `allowed_platforms_json`). The store's `loadResolvedProfile` calls `resolveProfile` so the route and UI both see the resolved names.
- `auto_action_policy`, `notification_policy`, `google_chat_policy` are the resolved keys (objects); `*_json` suffix names are internal DB column names only.
- `monthly_budget_cap_cents` (resolved; from `client_profiles.ops_monthly_cap_cents`) vs `monthly_budget_expected_cents` (agent-profile goal; stored in `ops_client_agent_profiles`) — distinct throughout.
- `parseJsonArray` and `parseJsonObject` are exported from the resolver and used in tests with the exact same names.
- `getClientAgentProfile` / `updateClientAgentProfile` in `src/api/ops.js` match the import names in `ClientAgentProfileEditor.jsx`.
- `CONFIG_SECTIONS` value `'agent_profile'` matches the `case 'agent_profile'` in `ClientWorkspace.jsx` `SectionBody`.
