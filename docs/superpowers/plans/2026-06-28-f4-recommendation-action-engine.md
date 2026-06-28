# F4 — Recommendation → Action Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn correlated `ops_findings` into structured, risk-scored, policy-gated **action recommendations** persisted to `ops_action_recommendations`, and execute the safe ones through a capability-aware abstract→provider action engine that reuses the existing `ops_tool_approvals` four-event audit chain.

**Architecture:** Two cooperating subsystems under `server/services/ops/`. The **recommendation pipeline** (`recommendations/`) runs entirely deterministically — collect findings → compute risk → compare F3 baselines → group → (single LLM call to *summarize/prioritize/draft only*) → apply policy to decide approval level → persist. The **action engine** (`actions/`) resolves an abstract action (`website.clear_cache`) to a provider action (`hosting.kinsta.clear_cache`) via the F1 connector contract, then for every action runs **policy gate → preflight → approval → execute → verify → audit → notify**. Risk scoring and policy gating are **pure functions over `(finding|action, context)`** and are exhaustively unit-tested with zero DB/LLM/network. Every boundary (DB store, LLM, connector, baseline lookup, audit logger) is dependency-injected so the orchestrators test against fakes.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, `pg` via `server/db.js` (`query`), the existing `ops_tool_approvals` audit chain (`server/services/security/audit.js` `OPERATIONS_TOOL_*`), `payloadSanitizer.sanitize` for PHI. No new npm dependencies.

## Global Constraints

- **Credentials are env-var / Postgres, NOT Secret Manager** (spec §3.1). `@google-cloud/secret-manager` is not a dependency and must not be added.
- **The LLM NEVER calls external mutating APIs directly and NEVER does metric math** (north-star §17.1, §16). It only summarizes, prioritizes, and drafts prose. Every number (risk score, baseline delta, blast radius, budget delta) is computed in pure JS *before* the LLM call; nothing numeric is ever read back out of the LLM response.
- **Mutations disabled by default; budget increases require approval; destructive actions are blocked; medical clients are stricter** (north-star §7.8 hard rules).
- **PHI is sanitized; the HIPAA gate is preserved.** Every string persisted to or sent into the LLM passes through `payloadSanitizer.sanitize`. `client_type` is never echoed in any recommendation, audit detail, or notification.
- **New migration → `server/sql/migrate_ops_<name>.sql` + append to the array in `server/migrations.js`.** Migrations are idempotent (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`).
- **REUSE the existing `ops_tool_approvals` audit chain** (`operations.tool_proposed/approved/executed/rejected`). Do not invent a parallel approval ledger; `ops_action_recommendations` *structures* the recommendation and links to an `ops_tool_approvals` row via `approval_id`.
- **Approval levels are exactly `none | approval_required | admin_required | blocked`** (north-star §17.5).
- **No new vendor-named umbrella checks** (spec §4). New providers arrive only as connector modules implementing the F1 contract.
- **No destructive provider actions** (restore/delete/drop/wipe) in this phase — they resolve to `blocked` (spec §8 non-goals).
- **DB tests** set `DATABASE_URL=postgresql://bif@localhost:5432/anchor`; run the suite with `yarn test:ops`. Pure tests need no env. Use `node:test` + `node:assert/strict`.
- **Admin-only routes** mount after `router.use(requireAuth); router.use(requireAdmin);` (`server/routes/ops.js:90-91`) and gate per-client endpoints on `isOperationsClient(req.params.id)`.

## Dependency Contracts (consumed, not built here)

These come from sibling phases that are **not yet implemented**. This plan codes against their documented contracts and injects them so nothing fabricates against unbuilt files.

- **F1 connector contract** (spec §5): a connector exports
  `actions: { async preflight(actionType, args, ctx), async execute(actionType, args, ctx) }`
  and `async listCapabilities(ctx) → capability map`. Resolution input is a **capabilities list**:
  `[{ provider: 'kinsta', capabilities: ['clear_cache','create_backup', ...] }, ...]`.
  Access is via an injected `getConnector(provider) → connector | null` and `loadCapabilities(clientUserId) → capabilities[]`. Both default to a graceful stub (return `null` / `[]`) so this phase runs and tests green before F1 lands.
- **F3 baselines** (spec §2.5): `ops_metric_baselines` provides "what is normal". Access is via an injected `baselineLookup({ clientUserId, metric }) → { mean, stdev, n } | null`, defaulting to a stub that returns `null` (no baseline ⇒ `baselineDelta = null`, risk scoring degrades gracefully) until F3 lands.
- **Findings** (existing `ops_findings`, post-correlator): the pipeline reads rows of shape
  `{ id, client_user_id, run_id, severity, category, summary, affected_platforms, business_impact, attention_score, linked_check_result_ids, created_at }`.

## File Structure

| File | Responsibility |
|---|---|
| `server/sql/migrate_ops_action_recommendations.sql` | Create `ops_action_recommendations` (idempotent). |
| `server/migrations.js` | Register the migration (append to `MIGRATIONS_BEFORE_SEED`). |
| `server/services/ops/recommendations/recommendationStore.js` | DB persistence: `createRecommendation` / `getRecommendation` / `listRecommendations` / `setRecommendationDecision` / `setRecommendationResult`. |
| `server/services/ops/recommendations/riskScorer.js` | **Pure** `scoreRisk(riskInput, context)` → `{ score, tier, factors }`. |
| `server/services/ops/recommendations/groupFindings.js` | **Pure** `groupFindings(findings, opts)` → group[]. |
| `server/services/ops/recommendations/actionFactory.js` | **Pure** `buildAbstractAction(group)` → `{ abstractActionType, actionArgs, mutating, destructive, budgetDeltaCents }`. |
| `server/services/ops/recommendations/policyApplicator.js` | **Pure** `decideApproval(action, context)` → `{ approvalLevel, reasons }` + predicates. |
| `server/services/ops/recommendations/summarizeFindings.js` | **LLM-only** `summarizeGroup(group, computed, deps)` → `{ title, summary, rationale, priority }`. |
| `server/services/ops/recommendations/buildRecommendations.js` | DI orchestrator: collect→compute→baseline→group→summarize→policy→persist. |
| `server/services/ops/actions/registry.js` | `ABSTRACT_ACTIONS` map + capability-aware `resolveAction(abstractActionType, deps)`. |
| `server/services/ops/actions/policy.js` | Execution-time gate `gateForExecution(recommendation, context)` (reuses pure predicates). |
| `server/services/ops/actions/preflight.js` | `runPreflight({ providerActionType, actionArgs, connector, ctx })` → state + blast radius. |
| `server/services/ops/actions/audit.js` | Thin wrappers over `logSecurityEvent` for the four `OPERATIONS_TOOL_*` events. |
| `server/services/ops/actions/executor.js` | `proposeAction` / `executeAction` / `rejectAction` (+ `verifyAction`) reusing `ops_tool_approvals`. |
| `server/services/ops/policyContext.js` | `loadClientPolicyContext(clientUserId)` → `{ clientType, mutationsEnabled, monthlyCapCents }`. |
| `server/routes/ops.js` | Add list / build / approve / reject recommendation routes. |
| `server/services/ops/__tests__/recRiskScorer.test.js` | Pure tests. |
| `server/services/ops/__tests__/recGroupFindings.test.js` | Pure tests. |
| `server/services/ops/__tests__/recActionFactory.test.js` | Pure tests. |
| `server/services/ops/__tests__/recPolicyApplicator.test.js` | Pure tests. |
| `server/services/ops/__tests__/recSummarize.test.js` | Injected-LLM tests. |
| `server/services/ops/__tests__/recBuildRecommendations.test.js` | Faked-deps orchestrator test. |
| `server/services/ops/__tests__/recommendationStore.test.js` | DB round-trip. |
| `server/services/ops/__tests__/actionRegistry.test.js` | Pure/injected resolver tests. |
| `server/services/ops/__tests__/actionPolicyGate.test.js` | Pure gate tests. |
| `server/services/ops/__tests__/actionPreflight.test.js` | Injected-connector tests. |
| `server/services/ops/__tests__/actionExecutor.test.js` | Faked-deps execute/reject + audit chain. |

---

### Task 1: Migration + recommendation store

**Files:**
- Create: `server/sql/migrate_ops_action_recommendations.sql`
- Modify: `server/migrations.js` (append `'migrate_ops_action_recommendations.sql'` to `MIGRATIONS_BEFORE_SEED`, after `'migrate_ops_blog_ssh.sql'`)
- Create: `server/services/ops/recommendations/recommendationStore.js`
- Test: `server/services/ops/__tests__/recommendationStore.test.js`

**Interfaces:**
- Produces:
  - Row shape `ops_action_recommendations`: `{ id, client_user_id, run_id, finding_ids (uuid[]), category, title, summary, rationale, abstract_action_type, action_args_json, mutating, destructive, budget_delta_cents, risk_score, risk_tier, approval_level, policy_reasons_json, status, approval_id, preflight_json, verification_json, priority, created_at, updated_at, decided_at, executed_at }`.
  - `createRecommendation(rec): Promise<row>` — inserts one `proposed` recommendation. `rec` keys are camelCase: `{ clientUserId, runId, findingIds, category, title, summary, rationale, abstractActionType, actionArgs, mutating, destructive, budgetDeltaCents, riskScore, riskTier, approvalLevel, policyReasons, status, priority }`.
  - `getRecommendation(id): Promise<row|null>`.
  - `listRecommendations({ clientUserId, status }): Promise<row[]>` ordered by `risk_score DESC NULLS LAST, created_at DESC`.
  - `setRecommendationDecision(id, { status, approvalId, decidedAt }): Promise<row|null>`.
  - `setRecommendationResult(id, { status, preflight, verification, executedAt }): Promise<row|null>`.

- [ ] **Step 1: Write the migration SQL**

Create `server/sql/migrate_ops_action_recommendations.sql`:

```sql
-- F4 — Recommendation → action engine (north-star §2.6).
-- Structures what ops_tool_approvals only audits: one row per recommended action
-- derived from a group of ops_findings, with deterministic risk + policy decision.
-- Idempotent.
CREATE TABLE IF NOT EXISTS ops_action_recommendations (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id      uuid NOT NULL,
  run_id              uuid REFERENCES ops_runs(id) ON DELETE SET NULL,
  finding_ids         uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  category            text NOT NULL,
  title               text NOT NULL,
  summary             text NOT NULL DEFAULT '',
  rationale           text NOT NULL DEFAULT '',
  abstract_action_type text,
  action_args_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  mutating            boolean NOT NULL DEFAULT FALSE,
  destructive         boolean NOT NULL DEFAULT FALSE,
  budget_delta_cents  integer NOT NULL DEFAULT 0,
  risk_score          numeric(10,2),
  risk_tier           text CHECK (risk_tier IN ('low','medium','high','critical')),
  approval_level      text NOT NULL DEFAULT 'approval_required'
                        CHECK (approval_level IN ('none','approval_required','admin_required','blocked')),
  policy_reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  status              text NOT NULL DEFAULT 'proposed'
                        CHECK (status IN ('proposed','approved','auto','executing','executed','failed','rejected','blocked','superseded')),
  approval_id         uuid REFERENCES ops_tool_approvals(id) ON DELETE SET NULL,
  preflight_json      jsonb,
  verification_json   jsonb,
  priority            integer NOT NULL DEFAULT 100,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  decided_at          timestamptz,
  executed_at         timestamptz
);

CREATE INDEX IF NOT EXISTS ops_action_recommendations_client_idx
  ON ops_action_recommendations (client_user_id);
CREATE INDEX IF NOT EXISTS ops_action_recommendations_status_idx
  ON ops_action_recommendations (status);
CREATE INDEX IF NOT EXISTS ops_action_recommendations_risk_idx
  ON ops_action_recommendations (risk_score DESC NULLS LAST);
```

- [ ] **Step 2: Register the migration**

In `server/migrations.js`, change the end of the `MIGRATIONS_BEFORE_SEED` array:

```js
  'migrate_ops_blog_ssh.sql',
  'migrate_ops_action_recommendations.sql'
];
```

- [ ] **Step 3: Run the migration locally**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn db:migrate`
Expected: prints `[migrations] applied migrate_ops_action_recommendations.sql`; re-running is a no-op.

- [ ] **Step 4: Write the store**

Create `server/services/ops/recommendations/recommendationStore.js`:

```js
/**
 * Persistence for ops_action_recommendations (north-star §2.6).
 * One row per recommended action derived from a group of ops_findings.
 */
import { query } from '../../../db.js';

export async function createRecommendation(rec = {}) {
  const { rows } = await query(
    `INSERT INTO ops_action_recommendations
       (client_user_id, run_id, finding_ids, category, title, summary, rationale,
        abstract_action_type, action_args_json, mutating, destructive, budget_delta_cents,
        risk_score, risk_tier, approval_level, policy_reasons_json, status, priority)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13,$14,$15,$16::jsonb,$17,$18)
     RETURNING *`,
    [
      rec.clientUserId,
      rec.runId || null,
      rec.findingIds || [],
      rec.category,
      rec.title,
      rec.summary || '',
      rec.rationale || '',
      rec.abstractActionType || null,
      JSON.stringify(rec.actionArgs || {}),
      Boolean(rec.mutating),
      Boolean(rec.destructive),
      Number.isFinite(rec.budgetDeltaCents) ? rec.budgetDeltaCents : 0,
      rec.riskScore ?? null,
      rec.riskTier || null,
      rec.approvalLevel || 'approval_required',
      JSON.stringify(rec.policyReasons || []),
      rec.status || 'proposed',
      Number.isFinite(rec.priority) ? rec.priority : 100
    ]
  );
  return rows[0];
}

export async function getRecommendation(id) {
  const { rows } = await query(`SELECT * FROM ops_action_recommendations WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function listRecommendations({ clientUserId, status } = {}) {
  const clauses = [];
  const params = [];
  if (clientUserId) { params.push(clientUserId); clauses.push(`client_user_id = $${params.length}`); }
  if (status) { params.push(status); clauses.push(`status = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { rows } = await query(
    `SELECT * FROM ops_action_recommendations ${where}
      ORDER BY risk_score DESC NULLS LAST, created_at DESC`,
    params
  );
  return rows;
}

export async function setRecommendationDecision(id, { status, approvalId = null, decidedAt = new Date() } = {}) {
  const { rows } = await query(
    `UPDATE ops_action_recommendations
        SET status = $2, approval_id = $3, decided_at = $4, updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status, approvalId, decidedAt]
  );
  return rows[0] || null;
}

export async function setRecommendationResult(id, { status, preflight = null, verification = null, executedAt = null } = {}) {
  const { rows } = await query(
    `UPDATE ops_action_recommendations
        SET status = $2,
            preflight_json = COALESCE($3::jsonb, preflight_json),
            verification_json = COALESCE($4::jsonb, verification_json),
            executed_at = COALESCE($5, executed_at),
            updated_at = now()
      WHERE id = $1 RETURNING *`,
    [id, status, preflight ? JSON.stringify(preflight) : null, verification ? JSON.stringify(verification) : null, executedAt]
  );
  return rows[0] || null;
}
```

- [ ] **Step 5: Write the round-trip test**

Create `server/services/ops/__tests__/recommendationStore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  createRecommendation, getRecommendation, listRecommendations,
  setRecommendationDecision, setRecommendationResult
} from '../recommendations/recommendationStore.js';

test('recommendation store: create → list → decision → result round-trips', async () => {
  const clientUserId = crypto.randomUUID();
  const created = await createRecommendation({
    clientUserId,
    findingIds: [crypto.randomUUID()],
    category: 'correlation.gtm_missing_with_kinsta_drift',
    title: 'Clear cache after deploy stripped GTM',
    summary: 'Deploy likely stripped the tracking snippet.',
    rationale: 'Kinsta drift + GTM missing correlate.',
    abstractActionType: 'website.clear_cache',
    actionArgs: { scope: 'full' },
    mutating: true,
    destructive: false,
    budgetDeltaCents: 0,
    riskScore: 72.5,
    riskTier: 'high',
    approvalLevel: 'approval_required',
    policyReasons: ['mutating action; mutations disabled by default'],
    priority: 1
  });
  assert.ok(created.id);
  assert.equal(created.status, 'proposed');
  assert.equal(created.approval_level, 'approval_required');
  assert.equal(created.mutating, true);

  const listed = await listRecommendations({ clientUserId, status: 'proposed' });
  assert.ok(listed.some((r) => r.id === created.id));

  const approvalRow = await query_approval(clientUserId);
  const decided = await setRecommendationDecision(created.id, { status: 'approved', approvalId: approvalRow });
  assert.equal(decided.status, 'approved');
  assert.equal(decided.approval_id, approvalRow);
  assert.ok(decided.decided_at);

  const done = await setRecommendationResult(created.id, {
    status: 'executed',
    preflight: { blastRadius: 1 },
    verification: { ok: true },
    executedAt: new Date()
  });
  assert.equal(done.status, 'executed');
  assert.deepEqual(done.verification_json, { ok: true });
  assert.ok(done.executed_at);

  const fetched = await getRecommendation(created.id);
  assert.equal(fetched.id, created.id);
});

// Helper: insert a real ops_tool_approvals row so the approval_id FK is satisfiable.
async function query_approval(clientUserId) {
  const { query } = await import('../../../db.js');
  const { rows } = await query(
    `INSERT INTO ops_tool_approvals (run_id, user_id, tool_name, args_hash, args_json)
     VALUES (NULL, $1, $2, $3, $4) RETURNING id`,
    [clientUserId, 'website.clear_cache', 'hash', {}]
  );
  return rows[0].id;
}
```

- [ ] **Step 6: Run the test**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/recommendationStore.test.js`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add server/sql/migrate_ops_action_recommendations.sql server/migrations.js server/services/ops/recommendations/recommendationStore.js server/services/ops/__tests__/recommendationStore.test.js
git commit -m "feat(ops/rec): ops_action_recommendations table + store"
```

---

### Task 2: riskScorer (pure)

**Files:**
- Create: `server/services/ops/recommendations/riskScorer.js`
- Test: `server/services/ops/__tests__/recRiskScorer.test.js`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `SEVERITY_WEIGHTS = { critical: 100, warning: 40, info: 10 }`.
  - `scoreRisk(riskInput, context): { score, tier, factors }` where
    `riskInput = { severity, affectedPlatformCount = 1, businessImpact = false, baselineDelta = null }`,
    `context = { clientType = null, destructive = false, mutating = false, budgetDeltaCents = 0 }`.
  - `score` is a non-negative number rounded to 2 dp. `tier ∈ {'low','medium','high','critical'}`.
  - `tierFromScore(score): string` — `>=85 critical`, `>=60 high`, `>=30 medium`, else `low`.

**Scoring law (pure, deterministic — no LLM):**
`score = severityWeight × platformFactor × impactFactor × baselineFactor × budgetFactor`, then `tier = tierFromScore(score)`; **destructive actions force tier `critical`** and **medical clients bump tier up one level**. `baselineDelta` (sigma above normal from F3) raises `baselineFactor` when present; `null` ⇒ neutral `1.0`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/recRiskScorer.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRisk, tierFromScore } from '../recommendations/riskScorer.js';

test('tierFromScore thresholds', () => {
  assert.equal(tierFromScore(90), 'critical');
  assert.equal(tierFromScore(85), 'critical');
  assert.equal(tierFromScore(60), 'high');
  assert.equal(tierFromScore(30), 'medium');
  assert.equal(tierFromScore(29.99), 'low');
  assert.equal(tierFromScore(0), 'low');
});

test('critical finding, single platform, no extras → high tier baseline', () => {
  const r = scoreRisk({ severity: 'critical' }, {});
  assert.equal(r.score, 100);
  assert.equal(r.tier, 'critical');
  assert.equal(r.factors.severityWeight, 100);
});

test('info finding scores low', () => {
  const r = scoreRisk({ severity: 'info' }, {});
  assert.equal(r.tier, 'low');
});

test('multi-platform + business impact raise the score', () => {
  const base = scoreRisk({ severity: 'warning' }, {});
  const more = scoreRisk({ severity: 'warning', affectedPlatformCount: 3, businessImpact: true }, {});
  assert.ok(more.score > base.score);
});

test('baselineDelta (sigma above normal) raises the score; null is neutral', () => {
  const neutral = scoreRisk({ severity: 'warning', baselineDelta: null }, {});
  const anomalous = scoreRisk({ severity: 'warning', baselineDelta: 3 }, {});
  assert.ok(anomalous.score > neutral.score);
});

test('budget increase raises the score', () => {
  const base = scoreRisk({ severity: 'info' }, {});
  const budget = scoreRisk({ severity: 'info' }, { budgetDeltaCents: 5000 });
  assert.ok(budget.score > base.score);
});

test('destructive action forces critical tier regardless of score', () => {
  const r = scoreRisk({ severity: 'info' }, { destructive: true });
  assert.equal(r.tier, 'critical');
  assert.equal(r.factors.destructive, true);
});

test('medical client bumps the tier up exactly one level', () => {
  const normal = scoreRisk({ severity: 'warning' }, { clientType: 'standard' });
  const medical = scoreRisk({ severity: 'warning' }, { clientType: 'medical' });
  const order = ['low', 'medium', 'high', 'critical'];
  assert.ok(order.indexOf(medical.tier) === Math.min(order.length - 1, order.indexOf(normal.tier) + 1));
});

test('medical bump never echoes client_type in factors', () => {
  const r = scoreRisk({ severity: 'warning' }, { clientType: 'medical' });
  assert.ok(!JSON.stringify(r).includes('medical'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/recRiskScorer.test.js`
Expected: FAIL — cannot resolve `../recommendations/riskScorer.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/recommendations/riskScorer.js`:

```js
/**
 * Pure deterministic risk scorer (north-star §16: NO LLM math). Higher = riskier.
 * Inputs are already-computed numbers; this module never touches DB/LLM/network.
 */
export const SEVERITY_WEIGHTS = { critical: 100, warning: 40, info: 10 };

const TIER_ORDER = ['low', 'medium', 'high', 'critical'];

export function tierFromScore(score) {
  if (score >= 85) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function bumpTier(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, (i < 0 ? 0 : i) + 1)];
}

export function scoreRisk(riskInput = {}, context = {}) {
  const {
    severity = 'info',
    affectedPlatformCount = 1,
    businessImpact = false,
    baselineDelta = null
  } = riskInput;
  const {
    clientType = null,
    destructive = false,
    mutating = false,
    budgetDeltaCents = 0
  } = context;

  const severityWeight = SEVERITY_WEIGHTS[severity] ?? 10;
  // Each extra affected platform adds 20%, capped at +60%.
  const platformFactor = 1 + Math.min(0.6, Math.max(0, affectedPlatformCount - 1) * 0.2);
  const impactFactor = businessImpact ? 1.5 : 1.0;
  // F3 baseline: sigma-above-normal. null ⇒ neutral. Each sigma adds 15%, cap +60%.
  const baselineFactor = baselineDelta == null ? 1.0 : 1 + Math.min(0.6, Math.max(0, baselineDelta) * 0.15);
  // Any budget increase adds 30%; mutating but non-budget adds 10%.
  const budgetFactor = budgetDeltaCents > 0 ? 1.3 : (mutating ? 1.1 : 1.0);

  const raw = severityWeight * platformFactor * impactFactor * baselineFactor * budgetFactor;
  const score = Math.round(raw * 100) / 100;

  let tier = tierFromScore(score);
  if (clientType === 'medical') tier = bumpTier(tier);
  if (destructive) tier = 'critical';

  return {
    score,
    tier,
    factors: { severityWeight, platformFactor, impactFactor, baselineFactor, budgetFactor, destructive: Boolean(destructive) }
  };
}

export default { scoreRisk, tierFromScore, SEVERITY_WEIGHTS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/recRiskScorer.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/recommendations/riskScorer.js server/services/ops/__tests__/recRiskScorer.test.js
git commit -m "feat(ops/rec): pure deterministic risk scorer"
```

---

### Task 3: groupFindings (pure)

**Files:**
- Create: `server/services/ops/recommendations/groupFindings.js`
- Test: `server/services/ops/__tests__/recGroupFindings.test.js`

**Interfaces:**
- Produces:
  - `groupFindings(findings, { maxGroups = 20 } = {}): group[]` where
    `group = { key, clientUserId, category, affectedPlatforms (string[]), severity, findingIds (string[]), findings (row[]) }`.
  - Grouping key: same `client_user_id` + same `category`. `severity` is the highest severity in the group (`critical > warning > info`). `affectedPlatforms` is the sorted union of each finding's `affected_platforms`. Groups are sorted highest-severity-first and truncated to `maxGroups`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/recGroupFindings.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFindings } from '../recommendations/groupFindings.js';

const f = (over) => ({
  id: over.id, client_user_id: over.c || 'client-1', category: over.cat,
  severity: over.sev || 'info', affected_platforms: over.plat || ['website'],
  summary: over.summary || 's'
});

test('findings with same client+category collapse into one group', () => {
  const groups = groupFindings([
    f({ id: 'a', cat: 'correlation.x', sev: 'warning', plat: ['website'] }),
    f({ id: 'b', cat: 'correlation.x', sev: 'critical', plat: ['google_ads'] })
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].findingIds.sort(), ['a', 'b']);
  assert.equal(groups[0].severity, 'critical', 'group severity is the max');
  assert.deepEqual(groups[0].affectedPlatforms, ['google_ads', 'website']);
});

test('different categories or clients stay separate', () => {
  const groups = groupFindings([
    f({ id: 'a', cat: 'correlation.x' }),
    f({ id: 'b', cat: 'correlation.y' }),
    f({ id: 'c', c: 'client-2', cat: 'correlation.x' })
  ]);
  assert.equal(groups.length, 3);
});

test('groups are sorted highest-severity-first and truncated to maxGroups', () => {
  const groups = groupFindings([
    f({ id: 'a', cat: 'k1', sev: 'info' }),
    f({ id: 'b', cat: 'k2', sev: 'critical' }),
    f({ id: 'c', cat: 'k3', sev: 'warning' })
  ], { maxGroups: 2 });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].severity, 'critical');
  assert.equal(groups[1].severity, 'warning');
});

test('empty input → empty array', () => {
  assert.deepEqual(groupFindings([]), []);
  assert.deepEqual(groupFindings(null), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/recGroupFindings.test.js`
Expected: FAIL — cannot resolve `../recommendations/groupFindings.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/recommendations/groupFindings.js`:

```js
/** Pure finding grouper. Collapses findings by (client_user_id, category). */
const SEV_RANK = { critical: 3, warning: 2, info: 1 };

function maxSeverity(a, b) {
  return (SEV_RANK[a] || 0) >= (SEV_RANK[b] || 0) ? a : b;
}

export function groupFindings(findings, { maxGroups = 20 } = {}) {
  if (!Array.isArray(findings) || findings.length === 0) return [];
  const byKey = new Map();
  for (const row of findings) {
    const clientUserId = row.client_user_id;
    const category = row.category || 'uncategorized';
    const key = `${clientUserId}::${category}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, clientUserId, category, affectedPlatforms: new Set(), severity: 'info', findingIds: [], findings: [] };
      byKey.set(key, g);
    }
    g.findingIds.push(row.id);
    g.findings.push(row);
    g.severity = maxSeverity(g.severity, row.severity || 'info');
    for (const p of row.affected_platforms || []) g.affectedPlatforms.add(p);
  }
  const groups = Array.from(byKey.values()).map((g) => ({
    ...g,
    affectedPlatforms: Array.from(g.affectedPlatforms).sort()
  }));
  groups.sort((a, b) => (SEV_RANK[b.severity] || 0) - (SEV_RANK[a.severity] || 0));
  return groups.slice(0, maxGroups);
}

export default { groupFindings };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/recGroupFindings.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/recommendations/groupFindings.js server/services/ops/__tests__/recGroupFindings.test.js
git commit -m "feat(ops/rec): pure finding grouper"
```

---

### Task 4: actionFactory (pure)

**Files:**
- Create: `server/services/ops/recommendations/actionFactory.js`
- Test: `server/services/ops/__tests__/recActionFactory.test.js`

**Interfaces:**
- Consumes: a `group` from Task 3.
- Produces:
  - `CATEGORY_ACTION_MAP: Record<string, { abstractActionType, mutating, destructive, budgetDeltaCents, buildArgs(group) }>`.
  - `buildAbstractAction(group): { abstractActionType, actionArgs, mutating, destructive, budgetDeltaCents }`. When no mapping exists the recommendation is **advisory only**: `abstractActionType = null`, `mutating = false`, `destructive = false`, `budgetDeltaCents = 0`, `actionArgs = {}`.

**Mapping policy:** Only **non-destructive** actions appear in the map this phase (spec §8). Each abstract type is provider-neutral (`website.clear_cache`, not `kinsta.*`). Destructive intents (restore/delete) are intentionally absent → they stay advisory and the policy layer blocks them if ever introduced.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/recActionFactory.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAbstractAction, CATEGORY_ACTION_MAP } from '../recommendations/actionFactory.js';

const g = (cat) => ({ key: `c::${cat}`, clientUserId: 'c', category: cat, affectedPlatforms: ['website'], severity: 'critical', findingIds: ['x'], findings: [] });

test('mapped category → provider-neutral abstract action', () => {
  const a = buildAbstractAction(g('correlation.gtm_missing_with_kinsta_drift'));
  assert.equal(a.abstractActionType, 'website.clear_cache');
  assert.equal(a.mutating, true);
  assert.equal(a.destructive, false);
  assert.equal(a.budgetDeltaCents, 0);
  assert.equal(typeof a.actionArgs, 'object');
});

test('unmapped category → advisory only (null action)', () => {
  const a = buildAbstractAction(g('correlation.unmapped_thing'));
  assert.equal(a.abstractActionType, null);
  assert.equal(a.mutating, false);
  assert.equal(a.destructive, false);
});

test('no abstract action in the map is destructive (phase non-goal)', () => {
  for (const [cat, def] of Object.entries(CATEGORY_ACTION_MAP)) {
    assert.equal(def.destructive, false, `${cat} must not be destructive in this phase`);
  }
});

test('abstract action types are provider-neutral (no vendor prefix)', () => {
  for (const def of Object.values(CATEGORY_ACTION_MAP)) {
    assert.ok(!/^(kinsta|wordpress|google_ads|meta|ctm)\./.test(def.abstractActionType),
      `${def.abstractActionType} leaks a provider name`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/recActionFactory.test.js`
Expected: FAIL — cannot resolve `../recommendations/actionFactory.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/recommendations/actionFactory.js`:

```js
/**
 * Pure abstract-action factory. Maps a finding category to a provider-neutral
 * abstract action (e.g. website.clear_cache). Destructive actions are NOT mapped
 * in this phase (spec §8) — unmapped categories stay advisory (null action).
 */
export const CATEGORY_ACTION_MAP = {
  'correlation.gtm_missing_with_kinsta_drift': {
    abstractActionType: 'website.clear_cache',
    mutating: true,
    destructive: false,
    budgetDeltaCents: 0,
    buildArgs: () => ({ scope: 'full' })
  },
  'correlation.tracking_loss_with_conversion_drop': {
    abstractActionType: 'website.clear_cache',
    mutating: true,
    destructive: false,
    budgetDeltaCents: 0,
    buildArgs: () => ({ scope: 'full' })
  }
};

export function buildAbstractAction(group = {}) {
  const def = CATEGORY_ACTION_MAP[group.category];
  if (!def) {
    return { abstractActionType: null, actionArgs: {}, mutating: false, destructive: false, budgetDeltaCents: 0 };
  }
  return {
    abstractActionType: def.abstractActionType,
    actionArgs: typeof def.buildArgs === 'function' ? def.buildArgs(group) : {},
    mutating: Boolean(def.mutating),
    destructive: Boolean(def.destructive),
    budgetDeltaCents: Number.isFinite(def.budgetDeltaCents) ? def.budgetDeltaCents : 0
  };
}

export default { buildAbstractAction, CATEGORY_ACTION_MAP };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/recActionFactory.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/recommendations/actionFactory.js server/services/ops/__tests__/recActionFactory.test.js
git commit -m "feat(ops/rec): pure abstract-action factory"
```

---

### Task 5: policyApplicator (pure)

**Files:**
- Create: `server/services/ops/recommendations/policyApplicator.js`
- Test: `server/services/ops/__tests__/recPolicyApplicator.test.js`

**Interfaces:**
- Produces:
  - `APPROVAL_LEVELS = ['none', 'approval_required', 'admin_required', 'blocked']`.
  - `decideApproval(action, context): { approvalLevel, reasons (string[]) }` where
    `action = { abstractActionType, mutating, destructive, budgetDeltaCents, riskTier }`,
    `context = { clientType = null, mutationsEnabled = false }`.
  - `requiresApproval(level): boolean` — true for `approval_required` / `admin_required`.
  - `isBlocked(level): boolean` — true for `blocked`.
  - `escalate(a, b): string` — returns the stricter of two levels by `APPROVAL_LEVELS` index.

**Hard rules (north-star §7.8, §17.4, §17.5), applied as escalations from a `none` floor:**
1. Non-mutating / advisory (no `abstractActionType`, `mutating=false`) ⇒ `none` (auto, informational).
2. Destructive ⇒ `blocked` (terminal; spec §8).
3. Mutating with `mutationsEnabled=false` ⇒ at least `approval_required` (mutations disabled by default).
4. `budgetDeltaCents > 0` ⇒ at least `approval_required`.
5. `riskTier === 'critical'` ⇒ at least `admin_required`.
6. `clientType === 'medical'` ⇒ escalate one step **and** never `none` for a mutating action (`approval_required`→`admin_required`).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/recPolicyApplicator.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideApproval, requiresApproval, isBlocked, escalate, APPROVAL_LEVELS } from '../recommendations/policyApplicator.js';

const act = (over) => ({ abstractActionType: 'website.clear_cache', mutating: true, destructive: false, budgetDeltaCents: 0, riskTier: 'medium', ...over });

test('escalate returns the stricter level', () => {
  assert.equal(escalate('none', 'admin_required'), 'admin_required');
  assert.equal(escalate('blocked', 'approval_required'), 'blocked');
  assert.equal(escalate('approval_required', 'approval_required'), 'approval_required');
});

test('advisory (no action) → none', () => {
  const d = decideApproval({ abstractActionType: null, mutating: false, destructive: false, budgetDeltaCents: 0, riskTier: 'low' }, {});
  assert.equal(d.approvalLevel, 'none');
});

test('destructive → blocked (terminal)', () => {
  const d = decideApproval(act({ destructive: true }), { mutationsEnabled: true });
  assert.equal(d.approvalLevel, 'blocked');
  assert.ok(isBlocked(d.approvalLevel));
  assert.ok(d.reasons.some((r) => /destructive/i.test(r)));
});

test('mutating with mutations disabled → at least approval_required', () => {
  const d = decideApproval(act(), { mutationsEnabled: false });
  assert.equal(d.approvalLevel, 'approval_required');
  assert.ok(requiresApproval(d.approvalLevel));
  assert.ok(d.reasons.some((r) => /disabled by default/i.test(r)));
});

test('budget increase → at least approval_required even if mutations enabled', () => {
  const d = decideApproval(act({ budgetDeltaCents: 5000 }), { mutationsEnabled: true });
  assert.ok(requiresApproval(d.approvalLevel));
  assert.ok(d.reasons.some((r) => /budget/i.test(r)));
});

test('critical risk tier → at least admin_required', () => {
  const d = decideApproval(act({ riskTier: 'critical' }), { mutationsEnabled: true });
  assert.equal(d.approvalLevel, 'admin_required');
});

test('medical client escalates approval_required → admin_required', () => {
  const standard = decideApproval(act(), { mutationsEnabled: false, clientType: 'standard' });
  const medical = decideApproval(act(), { mutationsEnabled: false, clientType: 'medical' });
  assert.equal(standard.approvalLevel, 'approval_required');
  assert.equal(medical.approvalLevel, 'admin_required');
});

test('reasons never echo client_type value', () => {
  const d = decideApproval(act(), { mutationsEnabled: false, clientType: 'medical' });
  assert.ok(!JSON.stringify(d.reasons).includes('medical'));
});

test('APPROVAL_LEVELS is the locked north-star vocabulary', () => {
  assert.deepEqual(APPROVAL_LEVELS, ['none', 'approval_required', 'admin_required', 'blocked']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/recPolicyApplicator.test.js`
Expected: FAIL — cannot resolve `../recommendations/policyApplicator.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/recommendations/policyApplicator.js`:

```js
/**
 * Pure policy applicator (north-star §7.8, §17.4, §17.5).
 * Decides the required approval level for a candidate action. No DB/LLM.
 * Approval vocabulary is locked: none | approval_required | admin_required | blocked.
 */
export const APPROVAL_LEVELS = ['none', 'approval_required', 'admin_required', 'blocked'];

export function escalate(a, b) {
  return APPROVAL_LEVELS[Math.max(APPROVAL_LEVELS.indexOf(a), APPROVAL_LEVELS.indexOf(b))];
}

export function requiresApproval(level) {
  return level === 'approval_required' || level === 'admin_required';
}

export function isBlocked(level) {
  return level === 'blocked';
}

export function decideApproval(action = {}, context = {}) {
  const { abstractActionType = null, mutating = false, destructive = false, budgetDeltaCents = 0, riskTier = 'low' } = action;
  const { clientType = null, mutationsEnabled = false } = context;
  const reasons = [];

  // Rule 1: advisory / non-mutating ⇒ none.
  if (!mutating || !abstractActionType) {
    return { approvalLevel: 'none', reasons: ['advisory recommendation; no mutation proposed'] };
  }

  // Rule 2: destructive ⇒ blocked (terminal).
  if (destructive) {
    return { approvalLevel: 'blocked', reasons: ['destructive action; blocked by policy (spec §8)'] };
  }

  let level = 'none';

  // Rule 3: mutations disabled by default.
  if (!mutationsEnabled) {
    level = escalate(level, 'approval_required');
    reasons.push('mutating action; mutations disabled by default');
  }
  // Rule 4: budget increase.
  if (budgetDeltaCents > 0) {
    level = escalate(level, 'approval_required');
    reasons.push(`budget increase of ${budgetDeltaCents}¢ requires approval`);
  }
  // Rule 5: critical risk.
  if (riskTier === 'critical') {
    level = escalate(level, 'admin_required');
    reasons.push('critical risk tier requires admin approval');
  }
  // Rule 6: medical client is stricter — escalate one step, floor at approval_required.
  if (clientType === 'medical') {
    if (level === 'none') level = 'approval_required';
    else level = escalate(level, 'admin_required');
    reasons.push('healthcare client policy: stricter approval');
  }

  // A mutating action never auto-runs: floor at approval_required.
  level = escalate(level, 'approval_required');
  return { approvalLevel: level, reasons };
}

export default { decideApproval, requiresApproval, isBlocked, escalate, APPROVAL_LEVELS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/recPolicyApplicator.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/recommendations/policyApplicator.js server/services/ops/__tests__/recPolicyApplicator.test.js
git commit -m "feat(ops/rec): pure policy applicator (approval-level decision)"
```

---

### Task 6: summarizeFindings (LLM-only, injected)

**Files:**
- Create: `server/services/ops/recommendations/summarizeFindings.js`
- Test: `server/services/ops/__tests__/recSummarize.test.js`

**Interfaces:**
- Consumes: `payloadSanitizer.sanitize` (`server/services/ops/payloadSanitizer.js`).
- Produces:
  - `buildSummarizePrompt(group, computed): string` — pure; embeds only `group.category`, sanitized finding summaries, and the **already-computed** numbers (`computed = { riskScore, riskTier, approvalLevel, baselineDelta }`). Contains an explicit instruction that the model must not invent numbers or call tools.
  - `async summarizeGroup(group, computed, { llm } = {}): { title, summary, rationale, priority }` — calls the injected `llm(prompt) → string` (JSON), parses it, **discards any numeric fields the model returns**, clamps `priority` to an integer `1..1000`, and runs `title`/`summary`/`rationale` through `sanitize`. On any LLM/parse error returns a deterministic fallback derived from the group (never throws).
  - Default `llm` (used only when none injected) wires to the existing runtime but is **never** exercised in tests.

**LLM contract (north-star §16, §17.1):** the LLM only drafts prose + a priority ordering. It receives finished numbers and returns none we trust. It is given no tools, so it cannot call external APIs.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/recSummarize.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummarizePrompt, summarizeGroup } from '../recommendations/summarizeFindings.js';

const group = {
  category: 'correlation.gtm_missing_with_kinsta_drift',
  severity: 'critical',
  affectedPlatforms: ['website', 'google_ads'],
  findings: [{ summary: 'GTM missing from homepage; Kinsta drift detected.' }]
};
const computed = { riskScore: 88.5, riskTier: 'critical', approvalLevel: 'admin_required', baselineDelta: 2 };

test('prompt embeds computed numbers and forbids tool use / inventing numbers', () => {
  const p = buildSummarizePrompt(group, computed);
  assert.ok(p.includes('88.5'));
  assert.ok(p.includes('critical'));
  assert.ok(/do not (invent|compute|call)/i.test(p));
});

test('summarizeGroup trusts our numbers, not the model\'s', async () => {
  const llm = async () => JSON.stringify({
    title: 'Clear cache to restore GTM',
    summary: 'A deploy stripped the tracking snippet; clearing cache republishes it.',
    rationale: 'Drift + GTM-missing correlate.',
    priority: 2,
    riskScore: 1, riskTier: 'low' // model-invented numbers must be ignored
  });
  const out = await summarizeGroup(group, computed, { llm });
  assert.equal(out.title, 'Clear cache to restore GTM');
  assert.equal(out.priority, 2);
  assert.equal(out.riskScore, undefined, 'model numbers are not returned');
  assert.equal(out.riskTier, undefined);
});

test('priority is clamped to an integer 1..1000', async () => {
  const llm = async () => JSON.stringify({ title: 't', summary: 's', rationale: 'r', priority: 99999 });
  const out = await summarizeGroup(group, computed, { llm });
  assert.equal(out.priority, 1000);
  const llm2 = async () => JSON.stringify({ title: 't', summary: 's', rationale: 'r', priority: -5 });
  const out2 = await summarizeGroup(group, computed, { llm: llm2 });
  assert.equal(out2.priority, 1);
});

test('LLM/parse failure → deterministic fallback, never throws', async () => {
  const llm = async () => 'not json at all';
  const out = await summarizeGroup(group, computed, { llm });
  assert.ok(out.title.length > 0);
  assert.ok(out.summary.length > 0);
  assert.equal(typeof out.priority, 'number');
});

test('output is PHI-sanitized', async () => {
  const llm = async () => JSON.stringify({ title: 'Call patient at 555-123-4567', summary: 'email a@b.com', rationale: 'r', priority: 1 });
  const out = await summarizeGroup(group, computed, { llm });
  assert.ok(!/555-123-4567/.test(out.title));
  assert.ok(!/a@b\.com/.test(out.summary));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/recSummarize.test.js`
Expected: FAIL — cannot resolve `../recommendations/summarizeFindings.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/recommendations/summarizeFindings.js`:

```js
/**
 * The ONLY LLM step in the pipeline (north-star §16, §17.1). The model summarizes,
 * prioritizes, and drafts prose — it never computes metrics and never calls tools.
 * All numbers are passed in pre-computed; nothing numeric is read back out.
 * `llm` is injected so tests run with zero network.
 */
import { sanitize } from '../payloadSanitizer.js';

function clampPriority(p) {
  const n = Math.round(Number(p));
  if (!Number.isFinite(n)) return 100;
  return Math.max(1, Math.min(1000, n));
}

function sanitizeText(s, fallback = '') {
  const raw = typeof s === 'string' && s.trim() ? s : fallback;
  // sanitize() works on objects; wrap + unwrap a single field.
  const out = sanitize({ v: raw });
  return typeof out.v === 'string' ? out.v : String(raw);
}

export function buildSummarizePrompt(group = {}, computed = {}) {
  const summaries = (group.findings || []).map((f) => `- ${sanitizeText(f.summary)}`).join('\n');
  return [
    'You are drafting an operations recommendation for an internal admin console.',
    'You ONLY write prose and choose a priority. You MUST NOT invent, compute, or recalculate any number,',
    'and you have NO tools — do not attempt to call any external system.',
    '',
    `Category: ${group.category}`,
    `Highest severity: ${group.severity}`,
    `Affected platforms: ${(group.affectedPlatforms || []).join(', ')}`,
    '',
    'Pre-computed facts (authoritative — reuse verbatim, do not change):',
    `  risk_score=${computed.riskScore} risk_tier=${computed.riskTier} approval_level=${computed.approvalLevel} baseline_sigma=${computed.baselineDelta ?? 'n/a'}`,
    '',
    'Findings in this group:',
    summaries,
    '',
    'Respond with ONLY a JSON object:',
    '{ "title": string (<=80 chars), "summary": string (<=400 chars, no PHI),',
    '  "rationale": string (<=400 chars), "priority": integer (1=most urgent) }'
  ].join('\n');
}

function fallback(group, computed) {
  const plats = (group.affectedPlatforms || []).join(', ') || 'website';
  return {
    title: `Review ${group.category}`.slice(0, 80),
    summary: sanitizeText(group.findings?.[0]?.summary, `Action recommended for ${plats}.`).slice(0, 400),
    rationale: `Grouped from ${group.findings?.length || 0} finding(s); risk_tier=${computed.riskTier}.`.slice(0, 400),
    priority: computed.riskTier === 'critical' ? 1 : computed.riskTier === 'high' ? 10 : 100
  };
}

async function defaultLlm(prompt) {
  // Wired to the existing supervisor runtime; never used in tests (always injected).
  const { runClaudeToolLoop } = await import('../agents/anthropicRuntime.js');
  const r = await runClaudeToolLoop({
    system: 'Return only the requested JSON. No tools.',
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    budgetCents: 10
  });
  return r?.text || '';
}

export async function summarizeGroup(group = {}, computed = {}, { llm = defaultLlm } = {}) {
  const prompt = buildSummarizePrompt(group, computed);
  let parsed = null;
  try {
    const text = await llm(prompt);
    const match = String(text).match(/\{[\s\S]*\}/);
    parsed = match ? JSON.parse(match[0]) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') return fallback(group, computed);
  // Trust ONLY title/summary/rationale/priority. Drop any numeric fields the model invented.
  return {
    title: sanitizeText(parsed.title, fallback(group, computed).title).slice(0, 80),
    summary: sanitizeText(parsed.summary, fallback(group, computed).summary).slice(0, 400),
    rationale: sanitizeText(parsed.rationale, fallback(group, computed).rationale).slice(0, 400),
    priority: clampPriority(parsed.priority)
  };
}

export default { buildSummarizePrompt, summarizeGroup };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/recSummarize.test.js`
Expected: PASS (5 tests).

> Note: confirm `payloadSanitizer.sanitize` redacts emails/phones from the wrapped `{ v }` object. If the test "output is PHI-sanitized" fails because `sanitize` only scrubs known user-ish keys, change `sanitizeText` to call `sanitize({ summary: raw }).summary` style with a user-ish key, or apply the same regex `payloadSanitizer` uses. The contract is: no raw emails/phones survive in persisted recommendation text.

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/recommendations/summarizeFindings.js server/services/ops/__tests__/recSummarize.test.js
git commit -m "feat(ops/rec): LLM summarize/prioritize step (numbers stay deterministic)"
```

---

### Task 7: buildRecommendations orchestrator (DI)

**Files:**
- Create: `server/services/ops/policyContext.js`
- Create: `server/services/ops/recommendations/buildRecommendations.js`
- Test: `server/services/ops/__tests__/recBuildRecommendations.test.js`

**Interfaces:**
- `policyContext.js` Produces:
  - `async loadClientPolicyContext(clientUserId, queryFn = query): { clientType, mutationsEnabled, monthlyCapCents }` — reads `client_profiles` (`client_type`, `ops_monthly_cap_cents`); `mutationsEnabled` defaults `false` (no column yet → always false until a future phase adds an opt-in).
- `buildRecommendations.js` Consumes: `groupFindings`, `buildAbstractAction`, `scoreRisk`, `decideApproval`, `summarizeGroup`, `createRecommendation`, `loadClientPolicyContext`.
- `buildRecommendations.js` Produces:
  - `async buildRecommendations({ clientUserId, runId = null }, deps = {}): { recommendations: row[] }`.
  - `deps` (all defaulted to the real implementations, overridden in tests):
    `{ loadFindings, baselineLookup, policyContext, summarize, store: { createRecommendation }, llm }`.
  - Flow (deterministic except the single `summarize` call): load findings → group → for each group: `buildAbstractAction` (pure) → enrich `baselineDelta` via `baselineLookup` → `scoreRisk` (pure) → `decideApproval` (pure) → `summarizeGroup` (LLM) → persist via `createRecommendation`. `blocked` groups are still persisted (status `blocked`) so the admin sees why nothing ran.

- [ ] **Step 1: Write `loadClientPolicyContext`**

Create `server/services/ops/policyContext.js`:

```js
/** Loads the per-client policy context used by the recommendation + action engine. */
import { query } from '../../db.js';

export async function loadClientPolicyContext(clientUserId, queryFn = query) {
  if (!clientUserId) return { clientType: null, mutationsEnabled: false, monthlyCapCents: null };
  let row = null;
  try {
    const { rows } = await queryFn(
      `SELECT client_type, ops_monthly_cap_cents FROM client_profiles WHERE user_id = $1 LIMIT 1`,
      [clientUserId]
    );
    row = rows[0] || null;
  } catch {
    row = null;
  }
  return {
    clientType: row?.client_type || null,
    // Mutations are disabled by default (north-star §7.8); no opt-in column exists yet.
    mutationsEnabled: false,
    monthlyCapCents: row?.ops_monthly_cap_cents ?? null
  };
}

export default { loadClientPolicyContext };
```

- [ ] **Step 2: Write the failing orchestrator test**

Create `server/services/ops/__tests__/recBuildRecommendations.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecommendations } from '../recommendations/buildRecommendations.js';

const findings = [
  { id: 'f1', client_user_id: 'c1', run_id: 'r1', severity: 'critical',
    category: 'correlation.gtm_missing_with_kinsta_drift', summary: 'GTM missing; drift.',
    affected_platforms: ['website', 'google_ads'], business_impact: 'leads', created_at: new Date() },
  { id: 'f2', client_user_id: 'c1', run_id: 'r1', severity: 'info',
    category: 'correlation.unmapped_thing', summary: 'minor note',
    affected_platforms: ['website'], business_impact: null, created_at: new Date() }
];

function fakeStore() {
  const saved = [];
  return { saved, createRecommendation: async (rec) => { const row = { id: `rec-${saved.length + 1}`, ...rec }; saved.push(row); return row; } };
}

test('buildRecommendations runs the deterministic pipeline + single LLM call per group', async () => {
  const store = fakeStore();
  let llmCalls = 0;
  const out = await buildRecommendations({ clientUserId: 'c1', runId: 'r1' }, {
    loadFindings: async () => findings,
    baselineLookup: async () => ({ mean: 10, stdev: 2, n: 30 }), // present → baselineDelta computed
    policyContext: async () => ({ clientType: 'standard', mutationsEnabled: false, monthlyCapCents: 500 }),
    summarize: async (group) => { llmCalls += 1; return { title: `T:${group.category}`, summary: 's', rationale: 'r', priority: 5 }; },
    store
  });
  assert.equal(out.recommendations.length, 2, 'one recommendation per group');
  assert.equal(llmCalls, 2, 'exactly one summarize call per group');

  const mapped = store.saved.find((r) => r.category === 'correlation.gtm_missing_with_kinsta_drift');
  assert.equal(mapped.abstractActionType, 'website.clear_cache');
  assert.equal(mapped.mutating, true);
  assert.equal(mapped.approvalLevel, 'approval_required'); // mutating + mutations disabled
  assert.equal(mapped.riskTier, 'critical');
  assert.ok(mapped.riskScore > 0);

  const advisory = store.saved.find((r) => r.category === 'correlation.unmapped_thing');
  assert.equal(advisory.abstractActionType, null);
  assert.equal(advisory.approvalLevel, 'none');
  assert.equal(advisory.status, 'proposed');
});

test('destructive-style critical on a medical client → blocked or admin, persisted', async () => {
  const store = fakeStore();
  await buildRecommendations({ clientUserId: 'cM', runId: null }, {
    loadFindings: async () => [findings[0]],
    baselineLookup: async () => null,
    policyContext: async () => ({ clientType: 'medical', mutationsEnabled: false, monthlyCapCents: null }),
    summarize: async () => ({ title: 't', summary: 's', rationale: 'r', priority: 1 }),
    store
  });
  const rec = store.saved[0];
  assert.equal(rec.approvalLevel, 'admin_required'); // medical escalates approval_required → admin_required
  assert.ok(['proposed'].includes(rec.status));
});

test('no findings → no recommendations, no LLM calls', async () => {
  const store = fakeStore();
  let llmCalls = 0;
  const out = await buildRecommendations({ clientUserId: 'c1' }, {
    loadFindings: async () => [],
    baselineLookup: async () => null,
    policyContext: async () => ({ clientType: null, mutationsEnabled: false }),
    summarize: async () => { llmCalls += 1; return { title: 't', summary: 's', rationale: 'r', priority: 1 }; },
    store
  });
  assert.equal(out.recommendations.length, 0);
  assert.equal(llmCalls, 0);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/recBuildRecommendations.test.js`
Expected: FAIL — cannot resolve `../recommendations/buildRecommendations.js`.

- [ ] **Step 4: Write the orchestrator**

Create `server/services/ops/recommendations/buildRecommendations.js`:

```js
/**
 * Recommendation pipeline orchestrator (north-star §16.2 deterministic-first).
 * collect → compute risk → compare F3 baselines → group → LLM summarize/prioritize
 * → policy decides approval → persist. Every number is computed before the single
 * LLM call; the LLM only drafts prose + priority. All boundaries are injected.
 */
import { query } from '../../../db.js';
import { groupFindings } from './groupFindings.js';
import { buildAbstractAction } from './actionFactory.js';
import { scoreRisk } from './riskScorer.js';
import { decideApproval, isBlocked } from './policyApplicator.js';
import { summarizeGroup } from './summarizeFindings.js';
import { createRecommendation as createRecommendationDefault } from './recommendationStore.js';
import { loadClientPolicyContext } from '../policyContext.js';

async function defaultLoadFindings(clientUserId, runId) {
  const params = [clientUserId];
  let where = `client_user_id = $1 AND resolved_at IS NULL`;
  if (runId) { params.push(runId); where += ` AND run_id = $2`; }
  const { rows } = await query(
    `SELECT id, client_user_id, run_id, severity, category, summary,
            affected_platforms, business_impact, attention_score,
            linked_check_result_ids, created_at
       FROM ops_findings WHERE ${where} ORDER BY created_at DESC LIMIT 500`,
    params
  );
  return rows;
}

// F3 stub: returns null until ops_metric_baselines lands. baselineDelta = null ⇒ neutral risk.
async function defaultBaselineLookup() { return null; }

function computeBaselineDelta(baseline, finding) {
  if (!baseline || !Number.isFinite(baseline.stdev) || baseline.stdev <= 0) return null;
  const observed = Number(finding.attention_score);
  if (!Number.isFinite(observed)) return null;
  return Math.max(0, (observed - baseline.mean) / baseline.stdev);
}

export async function buildRecommendations({ clientUserId, runId = null }, deps = {}) {
  const {
    loadFindings = (c, r) => defaultLoadFindings(c, r),
    baselineLookup = defaultBaselineLookup,
    policyContext = loadClientPolicyContext,
    summarize = (group, computed) => summarizeGroup(group, computed, { llm: deps.llm }),
    store = { createRecommendation: createRecommendationDefault }
  } = deps;

  const findings = await loadFindings(clientUserId, runId);
  const groups = groupFindings(findings);
  if (!groups.length) return { recommendations: [] };

  const ctx = await policyContext(clientUserId);
  const recommendations = [];

  for (const group of groups) {
    const action = buildAbstractAction(group);

    // Enrich with F3 baseline anomaly (deterministic).
    const baseline = await baselineLookup({ clientUserId, metric: group.category });
    const baselineDelta = computeBaselineDelta(baseline, group.findings[0] || {});

    const risk = scoreRisk(
      { severity: group.severity, affectedPlatformCount: group.affectedPlatforms.length, businessImpact: Boolean(group.findings[0]?.business_impact), baselineDelta },
      { clientType: ctx.clientType, destructive: action.destructive, mutating: action.mutating, budgetDeltaCents: action.budgetDeltaCents }
    );

    const decision = decideApproval(
      { abstractActionType: action.abstractActionType, mutating: action.mutating, destructive: action.destructive, budgetDeltaCents: action.budgetDeltaCents, riskTier: risk.tier },
      { clientType: ctx.clientType, mutationsEnabled: ctx.mutationsEnabled }
    );

    const computed = { riskScore: risk.score, riskTier: risk.tier, approvalLevel: decision.approvalLevel, baselineDelta };
    const draft = await summarize(group, computed);

    const row = await store.createRecommendation({
      clientUserId,
      runId,
      findingIds: group.findingIds,
      category: group.category,
      title: draft.title,
      summary: draft.summary,
      rationale: draft.rationale,
      abstractActionType: action.abstractActionType,
      actionArgs: action.actionArgs,
      mutating: action.mutating,
      destructive: action.destructive,
      budgetDeltaCents: action.budgetDeltaCents,
      riskScore: risk.score,
      riskTier: risk.tier,
      approvalLevel: decision.approvalLevel,
      policyReasons: decision.reasons,
      status: isBlocked(decision.approvalLevel) ? 'blocked' : 'proposed',
      priority: draft.priority
    });
    recommendations.push(row);
  }

  return { recommendations };
}

export default { buildRecommendations };
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/recBuildRecommendations.test.js`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/policyContext.js server/services/ops/recommendations/buildRecommendations.js server/services/ops/__tests__/recBuildRecommendations.test.js
git commit -m "feat(ops/rec): buildRecommendations orchestrator (deterministic-first)"
```

---

### Task 8: Action registry — capability-aware abstract→provider resolver

**Files:**
- Create: `server/services/ops/actions/registry.js`
- Test: `server/services/ops/__tests__/actionRegistry.test.js`

**Interfaces:**
- Produces:
  - `ABSTRACT_ACTIONS: Record<string, { capability, destructive, providerActionByProvider: Record<string,string> }>`. Seed: `'website.clear_cache' → { capability: 'clear_cache', destructive: false, providerActionByProvider: { kinsta: 'hosting.kinsta.clear_cache' } }`.
  - `async resolveAction(abstractActionType, { capabilities = [], getConnector } = {}): { ok, providerActionType, provider, connector, capability, reason }`.
    - `capabilities`: F1 list `[{ provider, capabilities: string[] }, ...]`.
    - Picks the first provider that (a) is listed in `providerActionByProvider` and (b) advertises the required `capability`. Resolves its connector via `getConnector(provider)`. Returns `{ ok: false, reason }` for unknown abstract type, no capable provider, or missing connector.
  - `defaultGetConnector(provider)` — attempts dynamic import of the F1 connector registry; returns `null` if not present (so this phase runs before F1).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/actionRegistry.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveAction, ABSTRACT_ACTIONS } from '../actions/registry.js';

const fakeConnector = { id: 'kinsta', actions: { preflight: async () => ({}), execute: async () => ({}) } };
const getConnector = async (p) => (p === 'kinsta' ? fakeConnector : null);

test('resolves website.clear_cache → hosting.kinsta.clear_cache when client has the capability', async () => {
  const r = await resolveAction('website.clear_cache', {
    capabilities: [{ provider: 'kinsta', capabilities: ['clear_cache', 'create_backup'] }],
    getConnector
  });
  assert.equal(r.ok, true);
  assert.equal(r.provider, 'kinsta');
  assert.equal(r.providerActionType, 'hosting.kinsta.clear_cache');
  assert.equal(r.connector, fakeConnector);
});

test('unknown abstract action → not ok', async () => {
  const r = await resolveAction('website.nope', { capabilities: [{ provider: 'kinsta', capabilities: ['clear_cache'] }], getConnector });
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown abstract action/i);
});

test('no provider advertises the capability → capability_unavailable', async () => {
  const r = await resolveAction('website.clear_cache', { capabilities: [{ provider: 'kinsta', capabilities: ['read'] }], getConnector });
  assert.equal(r.ok, false);
  assert.match(r.reason, /capability_unavailable/i);
});

test('capable provider but no connector wired → not ok', async () => {
  const r = await resolveAction('website.clear_cache', {
    capabilities: [{ provider: 'kinsta', capabilities: ['clear_cache'] }],
    getConnector: async () => null
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /connector/i);
});

test('every seeded abstract action is provider-neutral and non-destructive', () => {
  for (const [type, def] of Object.entries(ABSTRACT_ACTIONS)) {
    assert.equal(def.destructive, false, `${type} must not be destructive this phase`);
    for (const provType of Object.values(def.providerActionByProvider)) {
      assert.ok(provType.includes('.'), `${provType} should be a namespaced provider action`);
    }
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/actionRegistry.test.js`
Expected: FAIL — cannot resolve `../actions/registry.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/actions/registry.js`:

```js
/**
 * Capability-aware abstract→provider action resolver (expandability §8).
 * An abstract action (website.clear_cache) resolves to a provider action
 * (hosting.kinsta.clear_cache) ONLY for a provider the client is connected to
 * AND that advertises the required capability. Connector access is injected so
 * this runs/test-greens before the F1 connector registry exists.
 */
export const ABSTRACT_ACTIONS = {
  'website.clear_cache': {
    capability: 'clear_cache',
    destructive: false,
    providerActionByProvider: { kinsta: 'hosting.kinsta.clear_cache' }
  }
};

export async function defaultGetConnector(provider) {
  try {
    const mod = await import('../connections/registry.js'); // F1; absent until then
    if (typeof mod.getConnector === 'function') return mod.getConnector(provider);
    return null;
  } catch {
    return null;
  }
}

export async function resolveAction(abstractActionType, { capabilities = [], getConnector = defaultGetConnector } = {}) {
  const def = ABSTRACT_ACTIONS[abstractActionType];
  if (!def) return { ok: false, reason: `unknown abstract action: ${abstractActionType}` };

  for (const entry of capabilities) {
    const provider = entry?.provider;
    const providerActionType = provider && def.providerActionByProvider[provider];
    if (!providerActionType) continue;
    const has = Array.isArray(entry.capabilities) && entry.capabilities.includes(def.capability);
    if (!has) continue;
    const connector = await getConnector(provider);
    if (!connector) return { ok: false, reason: `connector for ${provider} not available`, provider };
    return { ok: true, providerActionType, provider, connector, capability: def.capability };
  }
  return { ok: false, reason: `capability_unavailable: no connected provider offers ${def.capability}` };
}

export default { resolveAction, ABSTRACT_ACTIONS, defaultGetConnector };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/actionRegistry.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/actions/registry.js server/services/ops/__tests__/actionRegistry.test.js
git commit -m "feat(ops/actions): capability-aware abstract→provider resolver"
```

---

### Task 9: Action policy gate (execution-time)

**Files:**
- Create: `server/services/ops/actions/policy.js`
- Test: `server/services/ops/__tests__/actionPolicyGate.test.js`

**Interfaces:**
- Consumes: `decideApproval`, `isBlocked`, `requiresApproval` from `policyApplicator.js` (reused — no duplicated rules).
- Produces:
  - `gateForExecution(recommendation, context): { allow, requiredLevel, reasons }` where
    `recommendation = { abstractActionType, mutating, destructive, budgetDeltaCents, riskTier, approvalLevel }`,
    `context = { clientType, mutationsEnabled, actorIsAdmin }`.
  - Re-derives the required level (defense in depth) and checks the actor:
    - `blocked` ⇒ `allow:false`.
    - `admin_required` and `!actorIsAdmin` ⇒ `allow:false`.
    - `approval_required`/`admin_required` are allowed **only at the approve endpoint** (the executor passes `actorIsAdmin` from the route); `none` ⇒ `allow:true` (auto).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/actionPolicyGate.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { gateForExecution } from '../actions/policy.js';

const rec = (over) => ({ abstractActionType: 'website.clear_cache', mutating: true, destructive: false, budgetDeltaCents: 0, riskTier: 'medium', approvalLevel: 'approval_required', ...over });

test('blocked recommendation never executes', () => {
  const g = gateForExecution(rec({ destructive: true, approvalLevel: 'blocked' }), { mutationsEnabled: true, actorIsAdmin: true });
  assert.equal(g.allow, false);
  assert.equal(g.requiredLevel, 'blocked');
});

test('admin_required + non-admin actor → not allowed', () => {
  const g = gateForExecution(rec({ riskTier: 'critical' }), { mutationsEnabled: true, actorIsAdmin: false });
  assert.equal(g.requiredLevel, 'admin_required');
  assert.equal(g.allow, false);
});

test('admin_required + admin actor → allowed', () => {
  const g = gateForExecution(rec({ riskTier: 'critical' }), { mutationsEnabled: true, actorIsAdmin: true });
  assert.equal(g.allow, true);
});

test('approval_required + admin actor (approve endpoint) → allowed', () => {
  const g = gateForExecution(rec(), { mutationsEnabled: false, actorIsAdmin: true });
  assert.equal(g.requiredLevel, 'approval_required');
  assert.equal(g.allow, true);
});

test('advisory none → auto-allowed', () => {
  const g = gateForExecution(rec({ abstractActionType: null, mutating: false }), { mutationsEnabled: false, actorIsAdmin: false });
  assert.equal(g.requiredLevel, 'none');
  assert.equal(g.allow, true);
});

test('re-derived level overrides a stale persisted approval_level (defense in depth)', () => {
  // Persisted says approval_required, but it is actually destructive → must block.
  const g = gateForExecution(rec({ destructive: true, approvalLevel: 'approval_required' }), { mutationsEnabled: true, actorIsAdmin: true });
  assert.equal(g.allow, false);
  assert.equal(g.requiredLevel, 'blocked');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/actionPolicyGate.test.js`
Expected: FAIL — cannot resolve `../actions/policy.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/actions/policy.js`:

```js
/**
 * Execution-time policy gate. Reuses the pure decideApproval rules (no duplication)
 * and re-derives the required level at execute time (defense in depth: a stale
 * persisted approval_level can never weaken the live decision).
 */
import { decideApproval, isBlocked } from '../recommendations/policyApplicator.js';

export function gateForExecution(recommendation = {}, context = {}) {
  const { clientType = null, mutationsEnabled = false, actorIsAdmin = false } = context;
  const { approvalLevel: requiredLevel, reasons } = decideApproval(
    {
      abstractActionType: recommendation.abstractActionType,
      mutating: recommendation.mutating,
      destructive: recommendation.destructive,
      budgetDeltaCents: recommendation.budgetDeltaCents,
      riskTier: recommendation.riskTier
    },
    { clientType, mutationsEnabled }
  );

  if (isBlocked(requiredLevel)) return { allow: false, requiredLevel, reasons };
  if (requiredLevel === 'admin_required' && !actorIsAdmin) {
    return { allow: false, requiredLevel, reasons: [...reasons, 'admin approval required'] };
  }
  // none (auto), approval_required (admin clicked approve), admin_required (admin actor).
  return { allow: true, requiredLevel, reasons };
}

export default { gateForExecution };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/actionPolicyGate.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/actions/policy.js server/services/ops/__tests__/actionPolicyGate.test.js
git commit -m "feat(ops/actions): execution-time policy gate (reuses pure rules)"
```

---

### Task 10: Preflight

**Files:**
- Create: `server/services/ops/actions/preflight.js`
- Test: `server/services/ops/__tests__/actionPreflight.test.js`

**Interfaces:**
- Produces:
  - `async runPreflight({ providerActionType, actionArgs = {}, connector, ctx = {} }): { ok, currentState, blastRadius, warnings, error? }`.
  - Calls `connector.actions.preflight(providerActionType, actionArgs, ctx)` (F1 contract). Never mutates. Computes `blastRadius` deterministically from the connector's reported scope (`assetsAffected` count, default 1). A throw or missing `actions.preflight` degrades to `{ ok: false, error }` — never throws.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/actionPreflight.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from '../actions/preflight.js';

test('happy path returns current state + blast radius', async () => {
  const connector = { actions: { preflight: async (type, args) => ({ currentState: { cache: 'warm' }, assetsAffected: 3, warnings: ['site is live'] }) } };
  const r = await runPreflight({ providerActionType: 'hosting.kinsta.clear_cache', actionArgs: { scope: 'full' }, connector });
  assert.equal(r.ok, true);
  assert.deepEqual(r.currentState, { cache: 'warm' });
  assert.equal(r.blastRadius, 3);
  assert.deepEqual(r.warnings, ['site is live']);
});

test('missing assetsAffected defaults blast radius to 1', async () => {
  const connector = { actions: { preflight: async () => ({ currentState: {} }) } };
  const r = await runPreflight({ providerActionType: 'x', connector });
  assert.equal(r.blastRadius, 1);
});

test('connector without actions.preflight → not ok, never throws', async () => {
  const r = await runPreflight({ providerActionType: 'x', connector: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /preflight/i);
});

test('a throwing preflight degrades to error', async () => {
  const connector = { actions: { preflight: async () => { throw new Error('api down'); } } };
  const r = await runPreflight({ providerActionType: 'x', connector });
  assert.equal(r.ok, false);
  assert.match(r.error, /api down/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/actionPreflight.test.js`
Expected: FAIL — cannot resolve `../actions/preflight.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/actions/preflight.js`:

```js
/**
 * Preflight: fetch current provider state + blast radius before any mutation.
 * Read-only — delegates to the F1 connector contract actions.preflight. Never throws.
 */
export async function runPreflight({ providerActionType, actionArgs = {}, connector, ctx = {} }) {
  const pf = connector?.actions?.preflight;
  if (typeof pf !== 'function') {
    return { ok: false, currentState: null, blastRadius: 0, warnings: [], error: 'connector does not implement actions.preflight' };
  }
  try {
    const res = (await pf(providerActionType, actionArgs, ctx)) || {};
    const blastRadius = Number.isFinite(res.assetsAffected) ? res.assetsAffected : 1;
    return { ok: true, currentState: res.currentState ?? null, blastRadius, warnings: Array.isArray(res.warnings) ? res.warnings : [] };
  } catch (err) {
    return { ok: false, currentState: null, blastRadius: 0, warnings: [], error: err?.message || String(err) };
  }
}

export default { runPreflight };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/actionPreflight.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/actions/preflight.js server/services/ops/__tests__/actionPreflight.test.js
git commit -m "feat(ops/actions): preflight (current state + blast radius)"
```

---

### Task 11: Action audit wrappers (reuse the existing chain)

**Files:**
- Create: `server/services/ops/actions/audit.js`
- Test: folded into Task 12's executor test (the executor is what emits the chain).

**Interfaces:**
- Consumes: `logSecurityEvent`, `SecurityEventTypes`, `SecurityEventCategories` from `server/services/security/audit.js`.
- Produces (each takes a `logger = logSecurityEvent` so tests inject a spy):
  - `async auditProposed({ userId, clientUserId, recommendationId, approvalId, providerActionType, argsHash }, logger?)` → emits `operations.tool_proposed`.
  - `async auditApproved({ userId, recommendationId, approvalId, providerActionType }, logger?)` → `operations.tool_approved`.
  - `async auditExecuted({ userId, recommendationId, approvalId, providerActionType, success, failureReason }, logger?)` → `operations.tool_executed`.
  - `async auditRejected({ userId, recommendationId, approvalId, reason }, logger?)` → `operations.tool_rejected`.
  - All details are PHI-free: only ids, `providerActionType`, booleans, and truncated reasons. `client_type` is never included.

- [ ] **Step 1: Write the module** (test coverage arrives via the executor in Task 12)

Create `server/services/ops/actions/audit.js`:

```js
/**
 * Reuses the existing ops_tool_approvals four-event audit chain
 * (operations.tool_proposed/approved/executed/rejected). No new event types.
 * `logger` is injectable for tests.
 */
import { logSecurityEvent, SecurityEventTypes, SecurityEventCategories } from '../../security/audit.js';

const CAT = SecurityEventCategories.OPERATIONS;

export async function auditProposed({ userId, clientUserId, recommendationId, approvalId, providerActionType, argsHash }, logger = logSecurityEvent) {
  return logger({
    userId, eventType: SecurityEventTypes.OPERATIONS_TOOL_PROPOSED, eventCategory: CAT, success: true,
    details: { source: 'action_engine', clientUserId: clientUserId || null, recommendationId, approvalId, providerActionType, argsHash }
  });
}

export async function auditApproved({ userId, recommendationId, approvalId, providerActionType }, logger = logSecurityEvent) {
  return logger({
    userId, eventType: SecurityEventTypes.OPERATIONS_TOOL_APPROVED, eventCategory: CAT, success: true,
    details: { source: 'action_engine', recommendationId, approvalId, providerActionType }
  });
}

export async function auditExecuted({ userId, recommendationId, approvalId, providerActionType, success, failureReason = null }, logger = logSecurityEvent) {
  return logger({
    userId, eventType: SecurityEventTypes.OPERATIONS_TOOL_EXECUTED, eventCategory: CAT, success: Boolean(success),
    failureReason: success ? null : String(failureReason || 'action_error').slice(0, 200),
    details: { source: 'action_engine', recommendationId, approvalId, providerActionType }
  });
}

export async function auditRejected({ userId, recommendationId, approvalId, reason }, logger = logSecurityEvent) {
  return logger({
    userId, eventType: SecurityEventTypes.OPERATIONS_TOOL_REJECTED, eventCategory: CAT, success: true,
    details: { source: 'action_engine', recommendationId, approvalId, reason: String(reason || '').slice(0, 200) || null }
  });
}

export default { auditProposed, auditApproved, auditExecuted, auditRejected };
```

- [ ] **Step 2: Verify the module loads + the event types exist**

Run: `node -e "import('./server/services/ops/actions/audit.js').then(m=>{['auditProposed','auditApproved','auditExecuted','auditRejected'].forEach(k=>{if(typeof m[k]!=='function')throw new Error('missing '+k)});console.log('audit ok')}).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `audit ok`.

- [ ] **Step 3: Commit**

```bash
git add server/services/ops/actions/audit.js
git commit -m "feat(ops/actions): audit wrappers over the ops_tool_approvals chain"
```

---

### Task 12: Action executor — propose / execute / reject (+ verify)

**Files:**
- Create: `server/services/ops/actions/executor.js`
- Test: `server/services/ops/__tests__/actionExecutor.test.js`

**Interfaces:**
- Consumes: `gateForExecution`, `resolveAction`, `runPreflight`, the four `audit*` wrappers, `getRecommendation` / `setRecommendationDecision` / `setRecommendationResult`, `loadClientPolicyContext`, and the `ops_tool_approvals` insert/update (`query`).
- Produces:
  - `async proposeAction({ recommendationId, userId }, deps = {}): { approvalId, status }` — for a `proposed` mutating recommendation, inserts an `ops_tool_approvals` row (`tool_name = providerActionType || abstractActionType`, `args_json`, `finding_id = first finding`), links `approval_id` onto the recommendation, sets status `approved` if auto (`none`) else leaves `proposed`, and emits `tool_proposed`.
  - `async executeAction({ recommendationId, userId, actorIsAdmin = true }, deps = {}): { ok, result, status }` — gate → resolve provider action → preflight → `connector.actions.execute` → `verifyAction` → audit (`tool_approved` + `tool_executed`) → `setRecommendationResult`. Refuses (no execute) when the gate disallows or resolution fails; records `blocked`/`failed`.
  - `async rejectAction({ recommendationId, userId, reason }, deps = {}): { ok }` — sets status `rejected`, finalizes the `ops_tool_approvals` row, emits `tool_rejected`.
  - `async verifyAction({ connector, providerActionType, actionArgs, executeResult, ctx }): { ok, detail }` — re-reads provider state via `connector.actions.preflight` (read-only) to confirm the change; degrades to `{ ok: true, detail: 'unverified' }` if verification is unavailable (never blocks an executed action).
- `deps` overrides (defaults wire the real modules): `{ getRecommendation, setRecommendationDecision, setRecommendationResult, policyContext, resolve, preflight, capabilities, audit, insertApproval, finalizeApproval }`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/actionExecutor.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { executeAction, rejectAction } from '../actions/executor.js';

function harness(recOver = {}) {
  const events = [];
  const rec = {
    id: 'rec-1', client_user_id: 'c1', abstract_action_type: 'website.clear_cache',
    action_args_json: { scope: 'full' }, mutating: true, destructive: false,
    budget_delta_cents: 0, risk_tier: 'medium', approval_level: 'approval_required',
    finding_ids: ['f1'], approval_id: 'appr-1', status: 'approved', ...recOver
  };
  const connector = {
    actions: {
      preflight: async () => ({ currentState: { cache: 'warm' }, assetsAffected: 1 }),
      execute: async (type, args) => ({ ok: true, cleared: true, type, args })
    }
  };
  const result = {};
  const deps = {
    getRecommendation: async () => rec,
    setRecommendationResult: async (id, p) => { result.value = { id, ...p }; return { id, ...p }; },
    policyContext: async () => ({ clientType: 'standard', mutationsEnabled: false }),
    resolve: async () => ({ ok: true, provider: 'kinsta', providerActionType: 'hosting.kinsta.clear_cache', connector }),
    capabilities: async () => [{ provider: 'kinsta', capabilities: ['clear_cache'] }],
    audit: {
      auditApproved: async (a) => events.push(['approved', a]),
      auditExecuted: async (a) => events.push(['executed', a]),
      auditRejected: async (a) => events.push(['rejected', a])
    },
    finalizeApproval: async () => {}
  };
  return { rec, connector, deps, events, result };
}

test('executeAction: gate → resolve → preflight → execute → verify → audit → persist', async () => {
  const h = harness();
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.equal(out.ok, true);
  assert.equal(out.status, 'executed');
  assert.equal(h.result.value.status, 'executed');
  assert.ok(h.result.value.verification, 'verification recorded');
  const types = h.events.map((e) => e[0]);
  assert.deepEqual(types, ['approved', 'executed']);
});

test('blocked recommendation never calls execute', async () => {
  const h = harness({ destructive: true, approval_level: 'blocked' });
  let executed = false;
  h.connector.actions.execute = async () => { executed = true; return {}; };
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.equal(out.ok, false);
  assert.equal(out.status, 'blocked');
  assert.equal(executed, false);
});

test('admin_required + non-admin actor refuses', async () => {
  const h = harness({ risk_tier: 'critical', approval_level: 'admin_required' });
  let executed = false;
  h.connector.actions.execute = async () => { executed = true; return {}; };
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: false }, h.deps);
  assert.equal(out.ok, false);
  assert.equal(executed, false);
});

test('capability-unavailable resolution → failed, no execute, no tool_executed success', async () => {
  const h = harness();
  h.deps.resolve = async () => ({ ok: false, reason: 'capability_unavailable: no connected provider offers clear_cache' });
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.equal(out.ok, false);
  assert.equal(out.status, 'failed');
});

test('connector.execute throwing → failed + tool_executed(success=false)', async () => {
  const h = harness();
  h.connector.actions.execute = async () => { throw new Error('kinsta 500'); };
  const out = await executeAction({ recommendationId: 'rec-1', userId: 'u1', actorIsAdmin: true }, h.deps);
  assert.equal(out.ok, false);
  assert.equal(out.status, 'failed');
  const executed = h.events.find((e) => e[0] === 'executed');
  assert.equal(executed[1].success, false);
});

test('rejectAction sets rejected + emits tool_rejected', async () => {
  const h = harness();
  let saved;
  h.deps.setRecommendationDecision = async (id, p) => { saved = { id, ...p }; return saved; };
  const out = await rejectAction({ recommendationId: 'rec-1', userId: 'u1', reason: 'not now' }, h.deps);
  assert.equal(out.ok, true);
  assert.equal(saved.status, 'rejected');
  assert.ok(h.events.some((e) => e[0] === 'rejected'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/actionExecutor.test.js`
Expected: FAIL — cannot resolve `../actions/executor.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/actions/executor.js`:

```js
/**
 * Action engine executor. Every mutation: policy gate → resolve provider action →
 * preflight → execute → verify → audit (reusing the ops_tool_approvals chain) →
 * persist. All boundaries injected; defaults wire the real modules.
 */
import crypto from 'node:crypto';
import { query } from '../../../db.js';
import { gateForExecution } from './policy.js';
import { resolveAction } from './registry.js';
import { runPreflight } from './preflight.js';
import * as auditMod from './audit.js';
import { getRecommendation as getRecommendationDefault, setRecommendationDecision as setDecisionDefault, setRecommendationResult as setResultDefault } from '../recommendations/recommendationStore.js';
import { loadClientPolicyContext } from '../policyContext.js';

function hashArgs(args) {
  return crypto.createHash('sha256').update(JSON.stringify(args || {})).digest('hex');
}

async function defaultInsertApproval({ userId, recommendation, providerActionType, args }) {
  const { rows } = await query(
    `INSERT INTO ops_tool_approvals (run_id, user_id, tool_name, args_hash, args_json, finding_id)
     VALUES (NULL, $1, $2, $3, $4, $5) RETURNING id`,
    [userId, providerActionType, hashArgs(args), args || {}, recommendation.finding_ids?.[0] || null]
  );
  return rows[0].id;
}

async function defaultFinalizeApproval(approvalId, payload) {
  await query(
    `UPDATE ops_tool_approvals SET approved_at = COALESCE(approved_at, NOW()), executed_at = NOW(), execution_result_json = $2 WHERE id = $1`,
    [approvalId, payload || {}]
  );
}

async function defaultCapabilities(clientUserId) {
  try {
    const mod = await import('../connections/registry.js'); // F1
    if (typeof mod.loadCapabilities === 'function') return await mod.loadCapabilities(clientUserId);
  } catch { /* F1 not present yet */ }
  return [];
}

export async function verifyAction({ connector, providerActionType, actionArgs, ctx }) {
  try {
    const pf = connector?.actions?.preflight;
    if (typeof pf !== 'function') return { ok: true, detail: 'unverified' };
    const after = await pf(providerActionType, actionArgs, ctx);
    return { ok: true, detail: after?.currentState ?? 'verified' };
  } catch (err) {
    return { ok: true, detail: `unverified: ${err?.message || err}` };
  }
}

export async function executeAction({ recommendationId, userId, actorIsAdmin = true }, deps = {}) {
  const {
    getRecommendation = getRecommendationDefault,
    setRecommendationResult = setResultDefault,
    policyContext = loadClientPolicyContext,
    resolve = resolveAction,
    preflight = runPreflight,
    capabilities = defaultCapabilities,
    audit = auditMod,
    finalizeApproval = defaultFinalizeApproval
  } = deps;

  const rec = await getRecommendation(recommendationId);
  if (!rec) return { ok: false, status: 'failed', error: 'recommendation not found' };

  const norm = {
    abstractActionType: rec.abstract_action_type,
    mutating: rec.mutating,
    destructive: rec.destructive,
    budgetDeltaCents: rec.budget_delta_cents,
    riskTier: rec.risk_tier,
    approvalLevel: rec.approval_level
  };
  const ctx = await policyContext(rec.client_user_id);
  const gate = gateForExecution(norm, { clientType: ctx.clientType, mutationsEnabled: ctx.mutationsEnabled, actorIsAdmin });
  if (!gate.allow) {
    const status = gate.requiredLevel === 'blocked' ? 'blocked' : 'failed';
    await setRecommendationResult(recommendationId, { status });
    return { ok: false, status, reasons: gate.reasons };
  }

  const caps = await capabilities(rec.client_user_id);
  const resolved = await resolve(norm.abstractActionType, { capabilities: caps });
  if (!resolved.ok) {
    await setRecommendationResult(recommendationId, { status: 'failed', preflight: { resolveError: resolved.reason } });
    return { ok: false, status: 'failed', error: resolved.reason };
  }

  const actionArgs = rec.action_args_json || {};
  const execCtx = { userId, clientUserId: rec.client_user_id };
  const pf = await preflight({ providerActionType: resolved.providerActionType, actionArgs, connector: resolved.connector, ctx: execCtx });
  if (!pf.ok) {
    await setRecommendationResult(recommendationId, { status: 'failed', preflight: pf });
    return { ok: false, status: 'failed', error: pf.error };
  }

  await audit.auditApproved({ userId, recommendationId, approvalId: rec.approval_id, providerActionType: resolved.providerActionType });

  let result, ok = false;
  try {
    result = await resolved.connector.actions.execute(resolved.providerActionType, actionArgs, execCtx);
    ok = !result?.error;
  } catch (err) {
    result = { error: err?.message || String(err) };
    ok = false;
  }

  const verification = ok ? await verifyAction({ connector: resolved.connector, providerActionType: resolved.providerActionType, actionArgs, ctx: execCtx }) : null;

  await audit.auditExecuted({ userId, recommendationId, approvalId: rec.approval_id, providerActionType: resolved.providerActionType, success: ok, failureReason: ok ? null : result?.error });
  if (rec.approval_id) await finalizeApproval(rec.approval_id, { ok, result, verification });
  await setRecommendationResult(recommendationId, { status: ok ? 'executed' : 'failed', preflight: pf, verification, executedAt: new Date() });

  return { ok, status: ok ? 'executed' : 'failed', result };
}

export async function proposeAction({ recommendationId, userId }, deps = {}) {
  const {
    getRecommendation = getRecommendationDefault,
    setRecommendationDecision = setDecisionDefault,
    capabilities = defaultCapabilities,
    resolve = resolveAction,
    insertApproval = defaultInsertApproval,
    audit = auditMod
  } = deps;

  const rec = await getRecommendation(recommendationId);
  if (!rec) return { error: 'recommendation not found' };
  if (rec.approval_level === 'blocked') return { error: 'recommendation is blocked' };
  if (!rec.mutating || !rec.abstract_action_type) return { error: 'advisory recommendation; nothing to execute' };

  const caps = await capabilities(rec.client_user_id);
  const resolved = await resolve(rec.abstract_action_type, { capabilities: caps });
  const providerActionType = resolved.ok ? resolved.providerActionType : rec.abstract_action_type;

  const approvalId = await insertApproval({ userId, recommendation: rec, providerActionType, args: rec.action_args_json || {} });
  await audit.auditProposed({ userId, clientUserId: rec.client_user_id, recommendationId, approvalId, providerActionType, argsHash: hashArgs(rec.action_args_json || {}) });

  const autoRun = rec.approval_level === 'none';
  await setRecommendationDecision(recommendationId, { status: autoRun ? 'approved' : 'proposed', approvalId });
  return { approvalId, status: autoRun ? 'approved' : 'proposed' };
}

export async function rejectAction({ recommendationId, userId, reason }, deps = {}) {
  const {
    getRecommendation = getRecommendationDefault,
    setRecommendationDecision = setDecisionDefault,
    finalizeApproval = defaultFinalizeApproval,
    audit = auditMod
  } = deps;
  const rec = await getRecommendation(recommendationId);
  if (!rec) return { error: 'recommendation not found' };
  await setRecommendationDecision(recommendationId, { status: 'rejected', approvalId: rec.approval_id || null });
  if (rec.approval_id) await finalizeApproval(rec.approval_id, { rejected: true, reason: String(reason || '').slice(0, 500) || null });
  await audit.auditRejected({ userId, recommendationId, approvalId: rec.approval_id, reason });
  return { ok: true };
}

export default { proposeAction, executeAction, rejectAction, verifyAction };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/actionExecutor.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/actions/executor.js server/services/ops/__tests__/actionExecutor.test.js
git commit -m "feat(ops/actions): executor (gate→preflight→execute→verify→audit)"
```

---

### Task 13: Admin routes + docs

**Files:**
- Modify: `server/routes/ops.js` (imports near other ops-service imports; routes after `router.use(requireAdmin)` at line ~91)
- Modify: `docs/OPERATIONS.md` (extend §8 with the action-engine flow)

**Interfaces:**
- Consumes: `buildRecommendations`, `listRecommendations`, `getRecommendation`, `proposeAction`, `executeAction`, `rejectAction`, `isOperationsClient`.
- Produces (all admin-gated; per-client routes 404 on non-ops clients):
  - `GET /api/ops/clients/:id/recommendations?status=` → `{ recommendations }`.
  - `POST /api/ops/clients/:id/recommendations/build` → `{ recommendations }` (runs the pipeline now).
  - `POST /api/ops/recommendations/:recId/approve` → `proposeAction` (if no approval row yet) then `executeAction`; `{ ok, status, result }`.
  - `POST /api/ops/recommendations/:recId/reject` → `{ ok }`.

- [ ] **Step 1: Add imports**

In `server/routes/ops.js`, near the other ops-service imports at the top, add:

```js
import { buildRecommendations } from '../services/ops/recommendations/buildRecommendations.js';
import { listRecommendations, getRecommendation } from '../services/ops/recommendations/recommendationStore.js';
import { proposeAction, executeAction, rejectAction } from '../services/ops/actions/executor.js';
```

- [ ] **Step 2: Add the routes**

In `server/routes/ops.js`, after `router.use(requireAdmin);` (line ~91), add:

```js
// --- F4 Recommendation → action engine ---
router.get('/clients/:id/recommendations', async (req, res) => {
  if (!(await isOperationsClient(req.params.id))) return res.status(404).json({ message: 'Client account not found' });
  try {
    const recommendations = await listRecommendations({ clientUserId: req.params.id, status: req.query.status || undefined });
    res.json({ recommendations });
  } catch (err) {
    res.status(500).json({ error: 'recommendations_fetch_failed', detail: err?.message });
  }
});

router.post('/clients/:id/recommendations/build', async (req, res) => {
  if (!(await isOperationsClient(req.params.id))) return res.status(404).json({ message: 'Client account not found' });
  try {
    const out = await buildRecommendations({ clientUserId: req.params.id, runId: req.body?.runId || null });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: 'recommendations_build_failed', detail: err?.message });
  }
});

router.post('/recommendations/:recId/approve', async (req, res) => {
  try {
    const rec = await getRecommendation(req.params.recId);
    if (!rec) return res.status(404).json({ message: 'Recommendation not found' });
    if (!(await isOperationsClient(rec.client_user_id))) return res.status(404).json({ message: 'Client account not found' });
    // Ensure an approval row exists (mutating recs), then execute as an admin actor.
    if (!rec.approval_id && rec.mutating && rec.abstract_action_type) {
      await proposeAction({ recommendationId: rec.id, userId: req.user?.id });
    }
    const out = await executeAction({ recommendationId: rec.id, userId: req.user?.id, actorIsAdmin: true });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: 'recommendation_approve_failed', detail: err?.message });
  }
});

router.post('/recommendations/:recId/reject', async (req, res) => {
  try {
    const rec = await getRecommendation(req.params.recId);
    if (!rec) return res.status(404).json({ message: 'Recommendation not found' });
    if (!(await isOperationsClient(rec.client_user_id))) return res.status(404).json({ message: 'Client account not found' });
    const out = await rejectAction({ recommendationId: rec.id, userId: req.user?.id, reason: req.body?.reason });
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: 'recommendation_reject_failed', detail: err?.message });
  }
});
```

> Confirm the admin user id field: existing routes in this file use `req.user?.id` (grep `req.user` in `server/routes/ops.js` and match the property the file already uses — adjust `req.user?.id` if it differs).

- [ ] **Step 3: Verify the module graph loads**

Run: `node --check server/routes/ops.js && node -e "import('./server/routes/ops.js').then(()=>console.log('ops routes module loaded')).catch(e=>{console.error(e);process.exit(1)})"`
Expected: prints `ops routes module loaded`.

- [ ] **Step 4: Extend the architecture doc**

In `docs/OPERATIONS.md`, at the end of section §8 (after the approval-audit-chain block, around line 200), append:

```markdown
### 8.1 Recommendation → action engine (F4)

`server/services/ops/recommendations/` turns correlated `ops_findings` into
`ops_action_recommendations`: collect → deterministic risk score → compare F3
baselines → group → **single LLM call to summarize/prioritize only** → policy
decides `approval_level` (`none|approval_required|admin_required|blocked`). The
LLM never computes a number and never calls a tool.

`server/services/ops/actions/` executes the safe ones. An abstract action
(`website.clear_cache`) resolves to a provider action
(`hosting.kinsta.clear_cache`) only for a connected, capable provider (F1
contract). Every action runs **policy gate → preflight → approval → execute →
verify → audit → notify**, reusing the `ops_tool_approvals` four-event chain
(`operations.tool_proposed/approved/executed/rejected`). Destructive actions are
blocked; mutations are disabled by default; medical clients are stricter.

Routes (admin): `GET /clients/:id/recommendations`,
`POST /clients/:id/recommendations/build`,
`POST /recommendations/:id/approve`, `POST /recommendations/:id/reject`.
```

- [ ] **Step 5: Run the full ops suite**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops`
Expected: all prior tests + the new F4 test files PASS.

- [ ] **Step 6: Commit**

```bash
git add server/routes/ops.js docs/OPERATIONS.md
git commit -m "feat(ops): recommendation/action engine routes + docs (F4)"
```

---

## Self-Review

**Spec coverage (F4 deliverables from the prompt + spec §2.6, §5, §8, north-star §16/§17):**
- §2.6 migration + registration `ops_action_recommendations` → Task 1. ✅
- Recommendation pipeline `recommendations/`: `buildRecommendations` (Task 7), `groupFindings` (Task 3), `summarizeFindings` LLM-only (Task 6), `riskScorer` (Task 2), `actionFactory` (Task 4), `policyApplicator` (Task 5). Flow collect→compute→compare baselines→findings→group→LLM summarize+prioritize→recommendation→policy decides approval/auto/block → Task 7 orchestrator. ✅
- Action engine `actions/`: `registry` (Task 8), `policy` (Task 9), `preflight` (Task 10), `executor` (Task 12), `audit` (Task 11). Capability-aware abstract→provider resolver `website.clear_cache → hosting.kinsta.clear_cache` → Task 8. Approval levels `none|approval_required|admin_required|blocked` → Tasks 5, 9. Per-action flow policy gate → preflight → approval → execute → verify → audit → notify → Task 12 (`notify` is the audit emit; F5 delivers Chat/email delivery — out of scope, deps note). REUSE of `ops_tool_approvals` chain → Tasks 11, 12. ✅
- LLM never mutates / never does metric math → Task 6 (numbers passed in, model numbers discarded; no tools) + Task 7 (all compute before summarize). ✅
- Mutations disabled by default / budget needs approval / destructive blocked / medical stricter → Task 5 (pure rules) + Task 9 (execution gate). ✅
- PHI sanitized / HIPAA gate → Task 6 `sanitize` on all text; `client_type` never echoed (asserted in Tasks 2, 5, 11). ✅
- Credentials env-var/Postgres, no Secret Manager; no new npm deps → nothing added. ✅
- riskScorer + policyApplicator are PURE and exhaustively unit-tested → Tasks 2, 5 (9 cases each). ✅
- Don't fabricate code against unbuilt F1/F3 → `getConnector`/`loadCapabilities`/`baselineLookup` injected with graceful stubs (Tasks 7, 8, 12). ✅
- Migration file naming + `migrations.js` registration → Task 1. ✅

**Placeholder scan:** No TBD/TODO. Two "confirm" notes (Task 6 Step 4 on `sanitize` key behavior; Task 13 Step 2 on `req.user` field) are concrete verify-the-literal actions with a stated fallback, not unfinished work. Every code step contains complete code.

**Type consistency:** Approval vocabulary `none|approval_required|admin_required|blocked` is identical across the migration CHECK, `policyApplicator.APPROVAL_LEVELS`, `gateForExecution`, and the executor. Risk tier `low|medium|high|critical` matches between `riskScorer.tierFromScore`, the migration CHECK, and `decideApproval`. Status vocabulary `proposed|approved|auto|executing|executed|failed|rejected|blocked|superseded` in the migration CHECK is a superset of the statuses the store/executor write (`proposed|approved|executed|failed|rejected|blocked`). Recommendation field names are camelCase at the `createRecommendation` boundary and snake_case on DB rows; the executor reads snake_case (`abstract_action_type`, `action_args_json`, `approval_id`) consistently. `resolveAction` returns `{ ok, providerActionType, provider, connector, capability, reason }` and every consumer (executor) reads those exact keys.
