# F0 — Access Audit Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove, from inside Cloud Run, which Operations services are connected / missing / misconfigured per the north-star §0 hard rule — starting with the infrastructure-access core (runtime identity, credential-env presence, Pub/Sub, database) persisted to `ops_access_audit_runs` and exposed at `/api/ops/access/audit`.

**Architecture:** A set of small, **dependency-injected, mostly-pure** checker modules under `server/services/ops/access/`. Each returns a normalized `{ status, detail, ... }` result. An orchestrator (`accessAudit.js`) runs them, classifies each into green/yellow/red, rolls up an overall status, and persists a single audit-run row. Two admin routes expose "run now" and "latest". Pure logic (credential presence, status classification) is exhaustively unit-tested with no DB/network; DB-touching pieces are tested against the local Postgres the repo already uses for `test:ops`.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, `pg` via `server/db.js` (`query`), `@google-cloud/pubsub` (already a dep), `google-auth-library` (already a dep, for the GCP metadata server). No new dependencies.

## Global Constraints

- **No new npm dependencies.** Use only what `package.json` already declares. (Verbatim from spec §3.4: each new external connector names its own dep in its own plan — F0 adds none.)
- **Credentials are env-var / Postgres, NOT Secret Manager.** The audit checks `process.env` presence + decryptability, never the Secret Manager API. (Spec §3.1.)
- **Never log or echo secret values.** Checkers report variable *names* and presence booleans only — never the value. (North-star §0.2 "Do not expose secrets in logs", coding rule 8.)
- **Checkers must be dependency-injected** so unit tests run with zero live GCP / DB where possible. Live clients are passed in by the orchestrator, faked in tests.
- **A failing checker must never throw out of the orchestrator** — it degrades to a `failed`/`error` service result with a reason. One broken service never fails the whole audit. (North-star coding rule 15, Phase-2 acceptance "failed service snapshots do not fail the whole run".)
- **Admin-only.** All `/api/ops/access/*` routes mount after `requireAuth` + `requireAdmin` in `server/routes/ops.js` (after line 91).
- **Tests need `DATABASE_URL`** set for DB-backed tasks: `postgresql://bif@localhost:5432/anchor`. Run suite with `yarn test:ops`.

---

## Scope

**In scope (this plan — F0a, infra-access core):**
- `ops_access_audit_runs` table + store.
- Runtime identity detection (environment / projectId / serviceAccount).
- Credential-env presence audit (the "missing secret reporting" acceptance item).
- Status classification + rollup (the "service status classification" acceptance item).
- Pub/Sub topic-presence checker (pure compare; live listing wired in orchestrator).
- Database table-presence + read/write probe.
- Orchestrator that assembles the north-star §0.1 report shape, classifies, persists.
- `POST /api/ops/access/audit/run` + `GET /api/ops/access/audit`.

**Deferred to the next plan (F0b):** live external-service reachability checkers (Google Ads `listAccessibleCustomers`, Search Console `sites.list`, GA4 tiny report, Google Chat test send, Kinsta/CTM/Meta API pings) and the **Operations → System → Access Audit** dashboard page. F0a delivers the persisted audit + API those build on.

## File Structure

| File | Responsibility |
|---|---|
| `server/sql/migrate_ops_access_audit_runs.sql` | Create `ops_access_audit_runs` (idempotent). |
| `server/migrations.js` | Register the migration (append to array). |
| `server/services/ops/access/auditStore.js` | `createAuditRun` / `finishAuditRun` / `getLatestAuditRun`. |
| `server/services/ops/access/requiredCredentials.js` | Declarative per-service env-var requirement map (grounded in `.env.example`). |
| `server/services/ops/access/envSecrets.js` | Pure credential-presence audit over an env object. |
| `server/services/ops/access/statusClassifier.js` | Pure `classifyService` + `rollupStatus`. |
| `server/services/ops/access/runtimeIdentity.js` | Detect environment / projectId / serviceAccount (injected metadata fetch). |
| `server/services/ops/access/pubsubAccess.js` | Pure expected-vs-actual topic compare. |
| `server/services/ops/access/databaseAccess.js` | Required-table presence + read/write probe (uses `query`). |
| `server/services/ops/access/accessAudit.js` | Orchestrator: run checkers → classify → assemble → persist. |
| `server/routes/ops.js` | Add `POST /access/audit/run` + `GET /access/audit`. |
| `server/services/ops/__tests__/accessEnvSecrets.test.js` | Pure tests. |
| `server/services/ops/__tests__/accessStatusClassifier.test.js` | Pure tests. |
| `server/services/ops/__tests__/accessRuntimeIdentity.test.js` | Injected tests. |
| `server/services/ops/__tests__/accessPubsub.test.js` | Pure tests. |
| `server/services/ops/__tests__/accessAuditOrchestrator.test.js` | Faked-deps orchestrator test. |
| `server/services/ops/__tests__/accessDatabaseAndStore.test.js` | DB-backed table-check + store round-trip. |

---

### Task 1: Migration + audit store

**Files:**
- Create: `server/sql/migrate_ops_access_audit_runs.sql`
- Modify: `server/migrations.js` (append filename to the migration array, after `'migrate_ops_blog_ssh.sql'`)
- Create: `server/services/ops/access/auditStore.js`
- Test: `server/services/ops/__tests__/accessDatabaseAndStore.test.js` (store half)

**Interfaces:**
- Produces:
  - `createAuditRun(): Promise<{ id, status, created_at }>` — inserts a `running` row, returns it.
  - `finishAuditRun(id, { status, environment, serviceAccount, projectId, summary, details, missing, warnings }): Promise<row>` — sets terminal status + JSON columns + `finished_at`.
  - `getLatestAuditRun(): Promise<row | null>` — most recent by `created_at`.
  - Row shape: `{ id, status, environment, service_account, project_id, summary_json, details_json, missing_json, warnings_json, created_at, finished_at }`.

- [ ] **Step 1: Write the migration SQL**

Create `server/sql/migrate_ops_access_audit_runs.sql`:

```sql
-- Access Audit (north-star §0.3). One row per audit run.
CREATE TABLE IF NOT EXISTS ops_access_audit_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status          text NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','verified','degraded','failed','error')),
  environment     text,
  service_account text,
  project_id      text,
  summary_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  details_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  missing_json    jsonb NOT NULL DEFAULT '[]'::jsonb,
  warnings_json   jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);

CREATE INDEX IF NOT EXISTS ops_access_audit_runs_created_idx
  ON ops_access_audit_runs (created_at DESC);
```

- [ ] **Step 2: Register the migration**

In `server/migrations.js`, append to the migration filename array (currently ending `'migrate_ops_blog_ssh.sql'`):

```js
  'migrate_ops_blog_ssh.sql',
  'migrate_ops_access_audit_runs.sql'
```

- [ ] **Step 3: Run the migration locally**

Run: `yarn db:migrate`
Expected: completes without error; re-running is a no-op (idempotent `IF NOT EXISTS`).

- [ ] **Step 4: Write the audit store**

Create `server/services/ops/access/auditStore.js`:

```js
/**
 * Persistence for Access Audit runs (ops_access_audit_runs).
 * One row per audit; created in 'running', finalized to a terminal status.
 */
import { query } from '../../../db.js';

export async function createAuditRun() {
  const { rows } = await query(
    `INSERT INTO ops_access_audit_runs (status) VALUES ('running')
     RETURNING id, status, created_at`
  );
  return rows[0];
}

export async function finishAuditRun(id, {
  status,
  environment = null,
  serviceAccount = null,
  projectId = null,
  summary = {},
  details = {},
  missing = [],
  warnings = []
} = {}) {
  const { rows } = await query(
    `UPDATE ops_access_audit_runs
        SET status = $2,
            environment = $3,
            service_account = $4,
            project_id = $5,
            summary_json = $6::jsonb,
            details_json = $7::jsonb,
            missing_json = $8::jsonb,
            warnings_json = $9::jsonb,
            finished_at = now()
      WHERE id = $1
      RETURNING *`,
    [
      id, status, environment, serviceAccount, projectId,
      JSON.stringify(summary), JSON.stringify(details),
      JSON.stringify(missing), JSON.stringify(warnings)
    ]
  );
  return rows[0] || null;
}

export async function getLatestAuditRun() {
  const { rows } = await query(
    `SELECT * FROM ops_access_audit_runs ORDER BY created_at DESC LIMIT 1`
  );
  return rows[0] || null;
}
```

- [ ] **Step 5: Write the store round-trip test**

Create `server/services/ops/__tests__/accessDatabaseAndStore.test.js` (store half — the DB-table-check half is added in Task 6):

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditRun, finishAuditRun, getLatestAuditRun } from '../access/auditStore.js';

test('audit store: create → finish → latest round-trips', async () => {
  const created = await createAuditRun();
  assert.ok(created.id, 'created row has an id');
  assert.equal(created.status, 'running');

  const finished = await finishAuditRun(created.id, {
    status: 'degraded',
    environment: 'local',
    serviceAccount: 'sa@example.iam.gserviceaccount.com',
    projectId: 'anchor-hub-480305',
    summary: { green: 2, yellow: 1, red: 0 },
    details: { core: { status: 'verified' } },
    missing: ['META: FACEBOOK_SYSTEM_USER_TOKEN'],
    warnings: ['pubsub list skipped (no client)']
  });
  assert.equal(finished.status, 'degraded');
  assert.equal(finished.project_id, 'anchor-hub-480305');
  assert.deepEqual(finished.missing_json, ['META: FACEBOOK_SYSTEM_USER_TOKEN']);
  assert.ok(finished.finished_at, 'finished_at is set');

  const latest = await getLatestAuditRun();
  assert.equal(latest.id, created.id, 'latest returns the row we just finished');
});
```

- [ ] **Step 6: Run the test**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/accessDatabaseAndStore.test.js`
Expected: PASS (1 test; the second test is added in Task 6).

- [ ] **Step 7: Commit**

```bash
git add server/sql/migrate_ops_access_audit_runs.sql server/migrations.js server/services/ops/access/auditStore.js server/services/ops/__tests__/accessDatabaseAndStore.test.js
git commit -m "feat(ops/access): ops_access_audit_runs table + audit store"
```

---

### Task 2: Credential-env presence audit

**Files:**
- Create: `server/services/ops/access/requiredCredentials.js`
- Create: `server/services/ops/access/envSecrets.js`
- Test: `server/services/ops/__tests__/accessEnvSecrets.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `REQUIRED_CREDENTIALS: Record<string, { required?: string[], optional?: string[], anyOf?: string[] }>`
  - `checkCredentialPresence(env, spec): { status, present: string[], missing: string[], optionalMissing: string[] }` where `status ∈ {'verified','degraded','missing'}`.
  - `auditCredentials(env, map = REQUIRED_CREDENTIALS): { services: Record<string,result>, missing: string[] }` — `missing` is a flat `["SERVICE: VAR", ...]` list of absent **required**/anyOf vars.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/accessEnvSecrets.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCredentialPresence, auditCredentials, REQUIRED_CREDENTIALS } from '../access/envSecrets.js';

test('all required present → verified', () => {
  const r = checkCredentialPresence({ A: 'x', B: 'y' }, { required: ['A', 'B'] });
  assert.equal(r.status, 'verified');
  assert.deepEqual(r.missing, []);
});

test('a required var absent (or blank) → missing', () => {
  const r = checkCredentialPresence({ A: 'x', B: '   ' }, { required: ['A', 'B'] });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.missing, ['B']);
});

test('anyOf satisfied by one present var → verified', () => {
  const r = checkCredentialPresence({ GA4_SERVICE_ACCOUNT_KEY: '{...}' }, { anyOf: ['GA4_SERVICE_ACCOUNT_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] });
  assert.equal(r.status, 'verified');
});

test('anyOf with none present → missing', () => {
  const r = checkCredentialPresence({}, { anyOf: ['GA4_SERVICE_ACCOUNT_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] });
  assert.equal(r.status, 'missing');
  assert.deepEqual(r.missing, ['GA4_SERVICE_ACCOUNT_KEY|GOOGLE_APPLICATION_CREDENTIALS']);
});

test('required present but optional missing → degraded (still usable)', () => {
  const r = checkCredentialPresence({ KINSTA_API_KEY: 'k' }, { required: ['KINSTA_API_KEY'], optional: ['KINSTA_USER'] });
  assert.equal(r.status, 'degraded');
  assert.deepEqual(r.optionalMissing, ['KINSTA_USER']);
});

test('auditCredentials flattens missing as "SERVICE: VAR" and never leaks values', () => {
  const env = { ENCRYPTION_KEY: 'k', JWT_SECRET: 'j', DATABASE_URL: 'postgres://x' };
  const out = auditCredentials(env, { core: REQUIRED_CREDENTIALS.core, meta: REQUIRED_CREDENTIALS.meta });
  assert.equal(out.services.core.status, 'verified');
  assert.equal(out.services.meta.status, 'missing');
  assert.ok(out.missing.includes('meta: FACEBOOK_SYSTEM_USER_TOKEN'));
  // value-leak guard: serialized result contains no secret values
  assert.ok(!JSON.stringify(out).includes('postgres://x'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/accessEnvSecrets.test.js`
Expected: FAIL — cannot resolve `../access/envSecrets.js`.

- [ ] **Step 3: Write the required-credentials map**

Create `server/services/ops/access/requiredCredentials.js` (names grounded in `.env.example`):

```js
/**
 * Per-service agency credential env-var requirements.
 * Names are authoritative against .env.example. Values are NEVER read here —
 * only presence is checked downstream. `anyOf` means at least one must be set.
 */
export const REQUIRED_CREDENTIALS = {
  core:           { required: ['ENCRYPTION_KEY', 'JWT_SECRET', 'DATABASE_URL'] },
  vertex:         { required: ['GOOGLE_CLOUD_PROJECT'] },
  google_ads:     { required: ['GOOGLE_ADS_DEVELOPER_TOKEN', 'GOOGLE_ADS_REFRESH_TOKEN', 'GOOGLE_ADS_MANAGER_ID', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET'] },
  meta:           { required: ['FACEBOOK_SYSTEM_USER_TOKEN'] },
  kinsta:         { required: ['KINSTA_API_KEY'], optional: ['KINSTA_USER', 'KINSTA_USER_PASSWORD', 'KINSTA_AGENCY_ID'] },
  ctm:            { required: ['CTM_API_KEY', 'CTM_API_SECRET'] },
  ga4:            { anyOf: ['GA4_SERVICE_ACCOUNT_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] },
  search_console: { anyOf: ['GA4_SERVICE_ACCOUNT_KEY', 'GOOGLE_APPLICATION_CREDENTIALS'] },
  mailgun:        { required: ['MAILGUN_API_KEY', 'MAILGUN_DOMAIN'] },
  anthropic:      { required: ['ANTHROPIC_API_KEY'] }
};
```

- [ ] **Step 4: Write the presence checker**

Create `server/services/ops/access/envSecrets.js`:

```js
/**
 * Pure credential-presence audit. Reports variable NAMES + booleans only —
 * never values (north-star §0.2: do not expose secrets).
 */
import { REQUIRED_CREDENTIALS } from './requiredCredentials.js';

export { REQUIRED_CREDENTIALS };

const isSet = (env, name) => typeof env[name] === 'string' && env[name].trim() !== '';

export function checkCredentialPresence(env = {}, spec = {}) {
  const present = [];
  const missing = [];
  const optionalMissing = [];

  for (const name of spec.required || []) {
    (isSet(env, name) ? present : missing).push(name);
  }
  if (spec.anyOf && spec.anyOf.length) {
    const hit = spec.anyOf.find((n) => isSet(env, n));
    if (hit) present.push(hit);
    else missing.push(spec.anyOf.join('|'));
  }
  for (const name of spec.optional || []) {
    (isSet(env, name) ? present : optionalMissing).push(name);
  }

  let status;
  if (missing.length) status = 'missing';
  else if (optionalMissing.length) status = 'degraded';
  else status = 'verified';

  return { status, present, missing, optionalMissing };
}

export function auditCredentials(env = {}, map = REQUIRED_CREDENTIALS) {
  const services = {};
  const missing = [];
  for (const [service, spec] of Object.entries(map)) {
    const r = checkCredentialPresence(env, spec);
    services[service] = r;
    for (const m of r.missing) missing.push(`${service}: ${m}`);
  }
  return { services, missing };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/accessEnvSecrets.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/access/requiredCredentials.js server/services/ops/access/envSecrets.js server/services/ops/__tests__/accessEnvSecrets.test.js
git commit -m "feat(ops/access): credential-env presence audit (no value leakage)"
```

---

### Task 3: Status classification + rollup

**Files:**
- Create: `server/services/ops/access/statusClassifier.js`
- Test: `server/services/ops/__tests__/accessStatusClassifier.test.js`

**Interfaces:**
- Produces:
  - `classifyService(status: string): 'green'|'yellow'|'red'|'gray'` — `verified→green`, `degraded|missing→yellow`, `failed|error→red`, `skipped|unknown→gray`.
  - `rollupStatus(statuses: string[]): 'verified'|'degraded'|'failed'` — any red → `failed`; else any yellow → `degraded`; else `verified`.
  - `summarize(statuses: string[]): { green, yellow, red, gray }` — counts by color.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/accessStatusClassifier.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyService, rollupStatus, summarize } from '../access/statusClassifier.js';

test('classifyService maps each status to a color', () => {
  assert.equal(classifyService('verified'), 'green');
  assert.equal(classifyService('degraded'), 'yellow');
  assert.equal(classifyService('missing'), 'yellow');
  assert.equal(classifyService('failed'), 'red');
  assert.equal(classifyService('error'), 'red');
  assert.equal(classifyService('skipped'), 'gray');
  assert.equal(classifyService('something-unknown'), 'gray');
});

test('rollupStatus: any red → failed', () => {
  assert.equal(rollupStatus(['verified', 'degraded', 'failed']), 'failed');
});

test('rollupStatus: yellow but no red → degraded', () => {
  assert.equal(rollupStatus(['verified', 'missing']), 'degraded');
});

test('rollupStatus: all green → verified', () => {
  assert.equal(rollupStatus(['verified', 'verified']), 'verified');
});

test('summarize counts colors', () => {
  assert.deepEqual(summarize(['verified', 'verified', 'missing', 'failed', 'skipped']), { green: 2, yellow: 1, red: 1, gray: 1 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/accessStatusClassifier.test.js`
Expected: FAIL — cannot resolve `../access/statusClassifier.js`.

- [ ] **Step 3: Write the classifier**

Create `server/services/ops/access/statusClassifier.js`:

```js
/** Pure status → color classification + audit rollup. */
const COLOR = {
  verified: 'green',
  degraded: 'yellow',
  missing: 'yellow',
  failed: 'red',
  error: 'red',
  skipped: 'gray'
};

export function classifyService(status) {
  return COLOR[status] || 'gray';
}

export function summarize(statuses = []) {
  const counts = { green: 0, yellow: 0, red: 0, gray: 0 };
  for (const s of statuses) counts[classifyService(s)] += 1;
  return counts;
}

export function rollupStatus(statuses = []) {
  const { red, yellow } = summarize(statuses);
  if (red > 0) return 'failed';
  if (yellow > 0) return 'degraded';
  return 'verified';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/accessStatusClassifier.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/access/statusClassifier.js server/services/ops/__tests__/accessStatusClassifier.test.js
git commit -m "feat(ops/access): service status classification + rollup"
```

---

### Task 4: Runtime identity detection

**Files:**
- Create: `server/services/ops/access/runtimeIdentity.js`
- Test: `server/services/ops/__tests__/accessRuntimeIdentity.test.js`

**Interfaces:**
- Produces:
  - `async detectRuntime({ env = process.env, fetchMetadata } = {}): Promise<{ environment, projectId, serviceAccount, cloudRunService }>`
  - `environment`: `'cloud-run'` if `env.K_SERVICE` is set; else `'local'` if `env.DATABASE_URL` points at localhost; else `'unknown'`.
  - `projectId`: `env.GOOGLE_CLOUD_PROJECT || env.VERTEX_PROJECT_ID || (await fetchMetadata('project/project-id')) || null`.
  - `serviceAccount`: `(await fetchMetadata('instance/service-accounts/default/email')) || null` — only attempted on Cloud Run.
  - `fetchMetadata(path): Promise<string|null>` is injectable; the default returns `null` off Cloud Run and queries the GCP metadata server on it.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/accessRuntimeIdentity.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRuntime } from '../access/runtimeIdentity.js';

test('cloud-run environment resolves SA + project from metadata', async () => {
  const fetchMetadata = async (path) => {
    if (path === 'project/project-id') return 'anchor-hub-480305';
    if (path === 'instance/service-accounts/default/email') return 'ops@anchor-hub-480305.iam.gserviceaccount.com';
    return null;
  };
  const out = await detectRuntime({ env: { K_SERVICE: 'anchor-ops', GOOGLE_CLOUD_PROJECT: '' }, fetchMetadata });
  assert.equal(out.environment, 'cloud-run');
  assert.equal(out.cloudRunService, 'anchor-ops');
  assert.equal(out.projectId, 'anchor-hub-480305');
  assert.equal(out.serviceAccount, 'ops@anchor-hub-480305.iam.gserviceaccount.com');
});

test('local environment: no metadata call, project from env', async () => {
  let called = false;
  const fetchMetadata = async () => { called = true; return null; };
  const out = await detectRuntime({
    env: { DATABASE_URL: 'postgresql://bif@localhost:5432/anchor', GOOGLE_CLOUD_PROJECT: 'anchor-hub-480305' },
    fetchMetadata
  });
  assert.equal(out.environment, 'local');
  assert.equal(out.projectId, 'anchor-hub-480305');
  assert.equal(out.serviceAccount, null);
  assert.equal(called, false, 'metadata server is not queried off Cloud Run');
});

test('unknown environment when neither K_SERVICE nor local DB', async () => {
  const out = await detectRuntime({ env: { DATABASE_URL: 'postgresql://u@prod-host:5432/db' }, fetchMetadata: async () => null });
  assert.equal(out.environment, 'unknown');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/accessRuntimeIdentity.test.js`
Expected: FAIL — cannot resolve `../access/runtimeIdentity.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/access/runtimeIdentity.js`:

```js
/**
 * Detect the runtime identity (north-star §0.2 Google Cloud / Cloud Run).
 * metadata fetch is injectable so tests run with zero network.
 */
const METADATA_BASE = 'http://metadata.google.internal/computeMetadata/v1/';

async function defaultFetchMetadata(path) {
  // Only meaningful on GCP; callers gate this to Cloud Run.
  try {
    const res = await fetch(METADATA_BASE + path, { headers: { 'Metadata-Flavor': 'Google' } });
    if (!res.ok) return null;
    return (await res.text()).trim() || null;
  } catch {
    return null;
  }
}

function isLocalDb(url) {
  return typeof url === 'string' && /@(localhost|127\.0\.0\.1)[:/]/.test(url);
}

export async function detectRuntime({ env = process.env, fetchMetadata = defaultFetchMetadata } = {}) {
  const cloudRunService = env.K_SERVICE || null;
  const onCloudRun = Boolean(cloudRunService);

  const environment = onCloudRun ? 'cloud-run' : (isLocalDb(env.DATABASE_URL) ? 'local' : 'unknown');

  let projectId = env.GOOGLE_CLOUD_PROJECT || env.VERTEX_PROJECT_ID || null;
  let serviceAccount = null;

  if (onCloudRun) {
    if (!projectId) projectId = await fetchMetadata('project/project-id');
    serviceAccount = await fetchMetadata('instance/service-accounts/default/email');
  }

  return { environment, projectId: projectId || null, serviceAccount, cloudRunService };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/accessRuntimeIdentity.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/access/runtimeIdentity.js server/services/ops/__tests__/accessRuntimeIdentity.test.js
git commit -m "feat(ops/access): runtime identity detection (env + GCP metadata)"
```

---

### Task 5: Pub/Sub topic-presence checker

**Files:**
- Create: `server/services/ops/access/pubsubAccess.js`
- Test: `server/services/ops/__tests__/accessPubsub.test.js`

**Interfaces:**
- Produces:
  - `EXPECTED_TOPICS: string[]` — short names the runner relies on. Seed with `['ops.run.requested', 'ops.run.cancel']` (the two `runQueue.js` publishes to). **Reconcile against `runQueue.js` `TOPIC_NAME`/`CANCEL_TOPIC_NAME` constants in Step 3 — copy their literal values.**
  - `checkPubSubTopics({ actual, expected = EXPECTED_TOPICS }): { status, present: string[], missing: string[] }` — pure set compare; `status` is `'verified'` when all expected present, `'degraded'` when some missing, `'skipped'` when `actual` is `null` (no client available).
  - `async listTopicShortNames(pubsubClient): Promise<string[]>` — maps `client.getTopics()` results to short names; the orchestrator passes a real `@google-cloud/pubsub` client, tests pass a fake.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/accessPubsub.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPubSubTopics, listTopicShortNames } from '../access/pubsubAccess.js';

test('all expected topics present → verified', () => {
  const r = checkPubSubTopics({ actual: ['ops.run.requested', 'ops.run.cancel', 'extra'], expected: ['ops.run.requested', 'ops.run.cancel'] });
  assert.equal(r.status, 'verified');
  assert.deepEqual(r.missing, []);
});

test('some expected topics missing → degraded', () => {
  const r = checkPubSubTopics({ actual: ['ops.run.requested'], expected: ['ops.run.requested', 'ops.run.cancel'] });
  assert.equal(r.status, 'degraded');
  assert.deepEqual(r.missing, ['ops.run.cancel']);
});

test('null actual (no client) → skipped', () => {
  const r = checkPubSubTopics({ actual: null, expected: ['ops.run.requested'] });
  assert.equal(r.status, 'skipped');
});

test('listTopicShortNames maps full resource paths to short names', async () => {
  const fakeClient = { getTopics: async () => [[{ name: 'projects/p/topics/ops.run.requested' }, { name: 'projects/p/topics/ops.run.cancel' }]] };
  assert.deepEqual(await listTopicShortNames(fakeClient), ['ops.run.requested', 'ops.run.cancel']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/accessPubsub.test.js`
Expected: FAIL — cannot resolve `../access/pubsubAccess.js`.

- [ ] **Step 3: Write the module**

First open `server/services/ops/runQueue.js` and copy the literal values of `TOPIC_NAME` and `CANCEL_TOPIC_NAME` into `EXPECTED_TOPICS` below (replace the seed values if they differ).

Create `server/services/ops/access/pubsubAccess.js`:

```js
/** Pub/Sub topic-presence check (north-star §0.2 Pub/Sub). Pure compare + a thin lister. */

// Reconcile with runQueue.js TOPIC_NAME / CANCEL_TOPIC_NAME.
export const EXPECTED_TOPICS = ['ops.run.requested', 'ops.run.cancel'];

const shortName = (full) => String(full || '').split('/').pop();

export function checkPubSubTopics({ actual, expected = EXPECTED_TOPICS } = {}) {
  if (actual == null) {
    return { status: 'skipped', present: [], missing: [...expected] };
  }
  const have = new Set(actual);
  const present = expected.filter((t) => have.has(t));
  const missing = expected.filter((t) => !have.has(t));
  return { status: missing.length ? 'degraded' : 'verified', present, missing };
}

export async function listTopicShortNames(pubsubClient) {
  const [topics] = await pubsubClient.getTopics();
  return topics.map((t) => shortName(t.name));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/accessPubsub.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/access/pubsubAccess.js server/services/ops/__tests__/accessPubsub.test.js
git commit -m "feat(ops/access): Pub/Sub topic-presence checker"
```

---

### Task 6: Database table-presence + read/write probe

**Files:**
- Create: `server/services/ops/access/databaseAccess.js`
- Modify: `server/services/ops/__tests__/accessDatabaseAndStore.test.js` (add the DB-check half)

**Interfaces:**
- Produces:
  - `REQUIRED_OPS_TABLES: string[]` — the core ops tables that must exist.
  - `async checkOpsTables(queryFn = query, required = REQUIRED_OPS_TABLES): { status, present: string[], missing: string[] }` — queries `information_schema.tables`; `'verified'` when all present, `'degraded'` when some missing, `'failed'` if the query throws.
  - `async probeReadWrite(queryFn = query): { status, detail }` — runs `SELECT 1` (and relies on `createAuditRun` insert elsewhere as the write proof); `'verified'`/`'failed'`.

- [ ] **Step 1: Write the failing test (append to existing file)**

Append to `server/services/ops/__tests__/accessDatabaseAndStore.test.js`:

```js
import { checkOpsTables, probeReadWrite, REQUIRED_OPS_TABLES } from '../access/databaseAccess.js';

test('checkOpsTables reports the audit table as present after migration', async () => {
  const r = await checkOpsTables();
  assert.ok(REQUIRED_OPS_TABLES.includes('ops_access_audit_runs'));
  assert.ok(r.present.includes('ops_access_audit_runs'), 'migrated table is detected');
  assert.equal(r.status === 'verified' || r.status === 'degraded', true);
});

test('checkOpsTables flags a bogus required table as missing', async () => {
  const r = await checkOpsTables(undefined, ['ops_runs', 'definitely_not_a_table_xyz']);
  assert.equal(r.status, 'degraded');
  assert.deepEqual(r.missing, ['definitely_not_a_table_xyz']);
});

test('checkOpsTables degrades to failed when the query throws', async () => {
  const boom = async () => { throw new Error('connection refused'); };
  const r = await checkOpsTables(boom, ['ops_runs']);
  assert.equal(r.status, 'failed');
});

test('probeReadWrite returns verified against the live db', async () => {
  const r = await probeReadWrite();
  assert.equal(r.status, 'verified');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/accessDatabaseAndStore.test.js`
Expected: FAIL — cannot resolve `../access/databaseAccess.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/access/databaseAccess.js`:

```js
/** Database access check (north-star §0.2 Database). Required-table presence + R/W probe. */
import { query } from '../../../db.js';

export const REQUIRED_OPS_TABLES = [
  'ops_runs',
  'ops_run_definitions',
  'ops_check_results',
  'ops_findings',
  'ops_tool_approvals',
  'client_platform_credentials',
  'ops_access_audit_runs'
];

export async function checkOpsTables(queryFn = query, required = REQUIRED_OPS_TABLES) {
  try {
    const { rows } = await queryFn(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
      [required]
    );
    const have = new Set(rows.map((r) => r.table_name));
    const present = required.filter((t) => have.has(t));
    const missing = required.filter((t) => !have.has(t));
    return { status: missing.length ? 'degraded' : 'verified', present, missing };
  } catch (err) {
    return { status: 'failed', present: [], missing: [...required], detail: err?.message || String(err) };
  }
}

export async function probeReadWrite(queryFn = query) {
  try {
    await queryFn('SELECT 1');
    return { status: 'verified', detail: 'select ok' };
  } catch (err) {
    return { status: 'failed', detail: err?.message || String(err) };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/accessDatabaseAndStore.test.js`
Expected: PASS (store test from Task 1 + 4 new = 5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/access/databaseAccess.js server/services/ops/__tests__/accessDatabaseAndStore.test.js
git commit -m "feat(ops/access): database table-presence + read/write probe"
```

---

### Task 7: Orchestrator — assemble, classify, persist

**Files:**
- Create: `server/services/ops/access/accessAudit.js`
- Test: `server/services/ops/__tests__/accessAuditOrchestrator.test.js`

**Interfaces:**
- Consumes: `detectRuntime`, `auditCredentials`, `checkOpsTables`, `probeReadWrite`, `checkPubSubTopics`, `listTopicShortNames`, `classifyService`, `rollupStatus`, `summarize`, `createAuditRun`, `finishAuditRun`.
- Produces:
  - `async runAccessAudit(deps = {}): Promise<row>` — runs every checker (each wrapped so a throw becomes a `failed` service result), builds the report, persists via the store, returns the finished row. `deps` lets tests inject every collaborator + an `env` + a `pubsubClient` (or `null` to skip live listing).
  - Report shape persisted in `details_json`: `{ runtime, services: { core, vertex, google_ads, meta, kinsta, ctm, ga4, search_console, mailgun, anthropic, database, pubsub } }` where each service value is `{ status, color, ...checkerFields }`.
  - `summary_json`: `{ green, yellow, red, gray }` color counts.
  - `missing_json`: flat credential-missing list. `warnings_json`: any `skipped`/`degraded` notes.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/accessAuditOrchestrator.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAccessAudit } from '../access/accessAudit.js';

function fakeStore() {
  const state = {};
  return {
    state,
    createAuditRun: async () => { state.id = 'aud-1'; return { id: 'aud-1', status: 'running' }; },
    finishAuditRun: async (id, payload) => { state.finished = { id, ...payload }; return { id, ...payload }; }
  };
}

test('runAccessAudit assembles, classifies, and persists a finished row', async () => {
  const store = fakeStore();
  const out = await runAccessAudit({
    env: { ENCRYPTION_KEY: 'k', JWT_SECRET: 'j', DATABASE_URL: 'postgresql://bif@localhost:5432/anchor', GOOGLE_CLOUD_PROJECT: 'p' },
    detectRuntime: async () => ({ environment: 'local', projectId: 'p', serviceAccount: null, cloudRunService: null }),
    checkOpsTables: async () => ({ status: 'verified', present: ['ops_runs'], missing: [] }),
    probeReadWrite: async () => ({ status: 'verified', detail: 'ok' }),
    pubsubClient: null, // no live listing → pubsub skipped
    createAuditRun: store.createAuditRun,
    finishAuditRun: store.finishAuditRun
  });

  // overall status reflects rollup (missing ad/meta creds → at least degraded)
  assert.ok(['degraded', 'failed'].includes(out.status));
  assert.equal(store.finished.environment, 'local');
  // database service classified green
  assert.equal(out.details.services.database.color, 'green');
  // pubsub skipped → gray, recorded as a warning
  assert.equal(out.details.services.pubsub.color, 'gray');
  assert.ok(out.warnings.some((w) => /pubsub/i.test(w)));
  // missing creds surfaced as "service: VAR"
  assert.ok(out.missing.some((m) => /meta: FACEBOOK_SYSTEM_USER_TOKEN/i.test(m)));
  // value-leak guard
  assert.ok(!JSON.stringify(out).includes('postgresql://bif'));
});

test('a checker that throws becomes a failed service, not a thrown audit', async () => {
  const store = fakeStore();
  const out = await runAccessAudit({
    env: { ENCRYPTION_KEY: 'k', JWT_SECRET: 'j', DATABASE_URL: 'x', GOOGLE_CLOUD_PROJECT: 'p' },
    detectRuntime: async () => ({ environment: 'unknown', projectId: 'p', serviceAccount: null, cloudRunService: null }),
    checkOpsTables: async () => { throw new Error('db down'); },
    probeReadWrite: async () => ({ status: 'failed', detail: 'db down' }),
    pubsubClient: null,
    createAuditRun: store.createAuditRun,
    finishAuditRun: store.finishAuditRun
  });
  assert.equal(out.status, 'failed');
  assert.equal(out.details.services.database.color, 'red');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/accessAuditOrchestrator.test.js`
Expected: FAIL — cannot resolve `../access/accessAudit.js`.

- [ ] **Step 3: Write the orchestrator**

Create `server/services/ops/access/accessAudit.js`:

```js
/**
 * Access Audit orchestrator (north-star §0). Runs each checker, classifies into
 * green/yellow/red, rolls up an overall status, and persists one audit-run row.
 * Every checker is wrapped so a throw degrades to a `failed` service result —
 * one broken service never fails the whole audit.
 */
import { detectRuntime as detectRuntimeDefault } from './runtimeIdentity.js';
import { auditCredentials } from './envSecrets.js';
import { checkOpsTables as checkOpsTablesDefault, probeReadWrite as probeReadWriteDefault } from './databaseAccess.js';
import { checkPubSubTopics, listTopicShortNames } from './pubsubAccess.js';
import { classifyService, rollupStatus, summarize } from './statusClassifier.js';
import { createAuditRun as createAuditRunDefault, finishAuditRun as finishAuditRunDefault } from './auditStore.js';

async function safe(fn, onError) {
  try {
    return await fn();
  } catch (err) {
    return onError(err);
  }
}

const withColor = (result) => ({ ...result, color: classifyService(result.status) });

export async function runAccessAudit(deps = {}) {
  const {
    env = process.env,
    detectRuntime = detectRuntimeDefault,
    checkOpsTables = checkOpsTablesDefault,
    probeReadWrite = probeReadWriteDefault,
    pubsubClient = undefined, // undefined → build a real client; null → skip
    createAuditRun = createAuditRunDefault,
    finishAuditRun = finishAuditRunDefault
  } = deps;

  const run = await createAuditRun();

  const runtime = await safe(
    () => detectRuntime({ env }),
    (err) => ({ environment: 'unknown', projectId: null, serviceAccount: null, cloudRunService: null, error: err?.message })
  );

  // --- credential services (pure) ---
  const cred = auditCredentials(env);
  const services = {};
  for (const [name, r] of Object.entries(cred.services)) services[name] = withColor(r);

  // --- database ---
  const dbTables = await safe(() => checkOpsTables(), (err) => ({ status: 'failed', present: [], missing: [], detail: err?.message }));
  const dbRw = await safe(() => probeReadWrite(), (err) => ({ status: 'failed', detail: err?.message }));
  const dbStatus = dbTables.status === 'failed' || dbRw.status === 'failed' ? 'failed' : dbTables.status;
  services.database = withColor({ status: dbStatus, tables: dbTables, readWrite: dbRw });

  // --- pub/sub ---
  const warnings = [];
  let actualTopics = null;
  if (pubsubClient === null) {
    warnings.push('pubsub: topic listing skipped (no client provided)');
  } else {
    actualTopics = await safe(async () => {
      const client = pubsubClient || (await import('@google-cloud/pubsub').then(({ PubSub }) => new PubSub()));
      return listTopicShortNames(client);
    }, (err) => { warnings.push(`pubsub: list failed — ${err?.message || err}`); return null; });
  }
  const pubsub = checkPubSubTopics({ actual: actualTopics });
  services.pubsub = withColor(pubsub);
  if (pubsub.status === 'skipped' && actualTopics === null && pubsubClient === null) {
    // already warned above
  } else if (pubsub.status === 'skipped') {
    warnings.push('pubsub: topic listing skipped');
  }

  // --- rollup ---
  const statuses = Object.values(services).map((s) => s.status);
  const overall = rollupStatus(statuses);
  const summary = summarize(statuses);

  const details = { runtime, services };
  const missing = [...cred.missing];

  const finished = await finishAuditRun(run.id, {
    status: overall,
    environment: runtime.environment,
    serviceAccount: runtime.serviceAccount,
    projectId: runtime.projectId,
    summary,
    details,
    missing,
    warnings
  });

  // Return a convenient view (store row + the assembled objects) for callers/tests.
  return { ...finished, status: overall, environment: runtime.environment, summary, details, missing, warnings };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/accessAuditOrchestrator.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full ops suite for regressions**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops`
Expected: all prior tests + the 5 new access test files PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/access/accessAudit.js server/services/ops/__tests__/accessAuditOrchestrator.test.js
git commit -m "feat(ops/access): audit orchestrator — assemble, classify, persist"
```

---

### Task 8: Admin routes — run + latest

**Files:**
- Modify: `server/routes/ops.js` (add two routes after the `requireAdmin` middleware at line ~91; add imports near the other service imports at the top)

**Interfaces:**
- Consumes: `runAccessAudit` (Task 7), `getLatestAuditRun` (Task 1).
- Produces:
  - `POST /api/ops/access/audit/run` → `{ audit: <finished view> }`, 200 on success, 500 on unexpected failure.
  - `GET /api/ops/access/audit` → `{ audit: <latest row | null> }`, 200.

- [ ] **Step 1: Add imports**

In `server/routes/ops.js`, near the existing ops-service imports at the top, add:

```js
import { runAccessAudit } from '../services/ops/access/accessAudit.js';
import { getLatestAuditRun } from '../services/ops/access/auditStore.js';
```

- [ ] **Step 2: Add the routes**

In `server/routes/ops.js`, immediately after `router.use(requireAdmin);` (line ~91), add:

```js
// --- Access Audit (north-star §0) ---
router.get('/access/audit', async (_req, res) => {
  try {
    const audit = await getLatestAuditRun();
    res.json({ audit });
  } catch (err) {
    res.status(500).json({ error: 'access_audit_fetch_failed', detail: err?.message });
  }
});

router.post('/access/audit/run', async (_req, res) => {
  try {
    const audit = await runAccessAudit();
    res.json({ audit });
  } catch (err) {
    res.status(500).json({ error: 'access_audit_run_failed', detail: err?.message });
  }
});
```

- [ ] **Step 3: Verify the server boots + module graph loads**

Run: `node --check server/routes/ops.js && node -e "import('./server/routes/ops.js').then(()=>console.log('ops routes module loaded')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `ops routes module loaded` with no error (catches missing-import / typo regressions).

- [ ] **Step 4: Manual end-to-end check against the running server**

Start the dev server (`./dev.sh` or `yarn dev`), authenticated as an admin, then:

```bash
# Trigger a run (cookie/JWT per the app's admin auth):
curl -s -X POST http://localhost:4000/api/ops/access/audit/run -H 'Cookie: <admin session>' | head -c 600
# Fetch the latest:
curl -s http://localhost:4000/api/ops/access/audit -H 'Cookie: <admin session>' | head -c 600
```

Expected: the POST returns `{ "audit": { "status": "degraded"|"failed"|"verified", "environment": "local", "summary": {...}, ... } }`; the GET returns the same row. Confirm no secret *values* appear anywhere in the JSON (only variable names + booleans).

- [ ] **Step 5: Commit**

```bash
git add server/routes/ops.js
git commit -m "feat(ops/access): POST /access/audit/run + GET /access/audit (admin)"
```

---

## Self-Review

**Spec coverage (F0 scope):**
- north-star §0.1 report shape → `details_json` (`runtime` + `services`) + `summary_json` + `missing_json` + `warnings_json` (Task 7). ✅
- §0.2 Google Cloud / Cloud Run identity → Task 4. ✅
- §0.2 Secret-presence (reconciled to env-var per spec §3.1) → Tasks 2. ✅
- §0.2 Pub/Sub → Task 5 (pure) + Task 7 (live listing). ✅
- §0.2 Database tables + R/W → Task 6. ✅
- §0.3 persist to `ops_access_audit_runs` → Task 1 + Task 7. ✅
- §0.2 route `GET /audit` + `POST /audit/run` → Task 8. ✅
- §22 Phase-0 acceptance "test coverage for missing secret reporting and service status classification" → Tasks 2 + 3 (pure, exhaustive). ✅
- **Deferred to F0b (declared in Scope):** live external-service checkers (Ads/GSC/GA4/Chat/Kinsta/CTM/Meta), the dashboard Access Audit page, and the infra plan/apply reconciliation script. Not gaps — next plan.

**Placeholder scan:** No TBD/TODO. The only "reconcile" instruction (Task 5 Step 3, `EXPECTED_TOPICS` vs `runQueue.js` constants) is a concrete copy-the-literal action with a default seed, not a placeholder. ✅

**Type consistency:** `status` vocabulary (`verified|degraded|missing|failed|error|skipped`) is consistent across `envSecrets`, `databaseAccess`, `pubsubAccess`, `statusClassifier`, and the orchestrator. `runAccessAudit` returns the same `{ status, environment, summary, details, missing, warnings }` view the route forwards and the tests assert. `withColor` adds `color` uniformly. ✅
