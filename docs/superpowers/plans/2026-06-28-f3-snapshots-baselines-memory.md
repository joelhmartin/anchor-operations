# F3 — Snapshots + Baselines + Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Operations agent a "knows normal" learning loop — daily metric snapshots, deterministic per-period baselines + anomaly scoring, and a curated per-client memory that learns from approvals, repeated false positives, and stable configs.

**Architecture:** Three new tables (`ops_daily_snapshots`, `ops_metric_baselines`, `ops_agent_memory`) plus two pure-first service folders. `server/services/ops/baselines/` holds a normalized metric-name vocabulary, a **pure** baseline math engine (window selection + mean/stddev), a DB store, a pure `compareMetric`, and a pure `anomalyScorer`. `server/services/ops/memory/` holds a DB store, a **pure** `clientFactsExtractor`, and an injected-deps `updateMemoryFromRuns` orchestrator. All metric math and scoring is deterministic and exhaustively unit-tested with **no DB**; the LLM never does metric math. The baseline/anomaly engines read `ops_daily_snapshots` rows directly (the documented spec §2.4 shape) so they are independently testable before F1/F2 connectors exist.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, `pg` via `server/db.js` (`query`). No new dependencies.

## Global Constraints

- **No new npm dependencies.** Use only what `package.json` already declares. (Spec §3.4 / §8.)
- **Credentials are env-var / Postgres, NOT Secret Manager.** This phase touches no credentials, but adds nothing that assumes Secret Manager. (Spec §3.1.)
- **The LLM may summarize but does NOT do metric math and does NOT invent missing metrics.** Baselines, comparisons, and anomaly scoring are 100% deterministic functions. Missing metrics stay missing (`null`), never fabricated. (Spec §8 non-goals; prompt.)
- **PHI is never persisted.** Snapshots store numeric **aggregates only** — `metrics_json` is a flat map of `metricName → number`. No caller text, no per-person rows. (Spec §2: `payloadSanitizer.js` posture; prompt.)
- **Normalized metric names (closed vocabulary):** `cost_cents`, `impressions`, `clicks`, `conversions`, `conversion_value_cents`, `sessions`, `users`, `leads`, `calls`, `forms`, `ctr`, `cvr`, `cpa_cents`. Provider-specific extras live in `metrics_json` alongside them but are NOT part of the normalized set. (Prompt deliverable 4.)
- **New migration → `server/sql/migrate_ops_<name>.sql` + append to the `server/migrations.js` array** (`MIGRATIONS_BEFORE_SEED`, after `'migrate_ops_blog_ssh.sql'`). Every migration is idempotent (`CREATE TABLE IF NOT EXISTS` / `ALTER ... IF NOT EXISTS`).
- **DB tests** need `DATABASE_URL=postgresql://bif@localhost:5432/anchor`. Run the suite with `yarn test:ops`. Tests use `node:test` + `node:assert/strict`. Baseline/anomaly/extractor math is **PURE** and tested with **no DB**; only the three `*Store` modules and the orchestrators touch Postgres, and their DB tests isolate themselves with a random `client_user_id` (`crypto.randomUUID()`).
- **No vendor-named umbrella checks, no LLM mutation, no destructive actions.** (Spec §8.)

---

## File Structure

| File | Responsibility |
|---|---|
| `server/sql/migrate_ops_f3_snapshots_baselines_memory.sql` | Create `ops_daily_snapshots` (§2.4), `ops_metric_baselines` (§2.5), `ops_agent_memory` (§2.9). Idempotent. |
| `server/migrations.js` | Register the migration (append to `MIGRATIONS_BEFORE_SEED`). |
| `server/services/ops/baselines/metricNames.js` | Normalized metric vocabulary + `normalizeMetrics` / `deriveMetrics` / `isNormalizedMetric` (PURE). |
| `server/services/ops/baselines/computeBaselines.js` | PURE period-window math (`windowForPeriod`, `selectSamples`, `computeStats`, `computeBaselinesForSeries`) + injected-deps orchestrator `computeAndPersistBaselines`. |
| `server/services/ops/baselines/baselineStore.js` | DB: `loadSnapshotSeries`, `upsertBaseline`, `getBaselines`. |
| `server/services/ops/baselines/compareMetric.js` | PURE `compareMetric(observed, baseline)`. |
| `server/services/ops/baselines/anomalyScorer.js` | PURE `scoreAnomaly` + `scoreAcrossPeriods`. |
| `server/services/ops/memory/memoryStore.js` | DB: `upsertMemoryFact`, `getMemory`, `archiveMemoryFact`, `recordManualNote`. |
| `server/services/ops/memory/clientFactsExtractor.js` | PURE fact extraction from approvals / rejections / repeated findings / stable configs / notes. |
| `server/services/ops/memory/updateMemoryFromRuns.js` | Injected-deps orchestrator: load → `extractFacts` (pure) → upsert. |
| `server/services/ops/__tests__/f3MetricNames.test.js` | Pure tests. |
| `server/services/ops/__tests__/f3ComputeBaselines.test.js` | Pure tests. |
| `server/services/ops/__tests__/f3BaselineStore.test.js` | DB tests. |
| `server/services/ops/__tests__/f3ComputeBaselinesOrchestrator.test.js` | Faked-deps tests. |
| `server/services/ops/__tests__/f3CompareMetric.test.js` | Pure tests. |
| `server/services/ops/__tests__/f3AnomalyScorer.test.js` | Pure tests. |
| `server/services/ops/__tests__/f3MemoryStore.test.js` | DB tests. |
| `server/services/ops/__tests__/f3ClientFactsExtractor.test.js` | Pure tests. |
| `server/services/ops/__tests__/f3UpdateMemory.test.js` | Faked-deps tests. |

**Dependency note (verbatim from prompt):** F1's connector contract `collectSnapshot(ctx)` (spec §5) is what will *write* `ops_daily_snapshots`; F1/F2 are not built yet. This plan writes the baseline/anomaly/memory engines to **consume `ops_daily_snapshots` rows directly** (spec §2.4 shape: `client_user_id`, `snapshot_date`, `service`, `scope_type`, `scope_id`, `metrics_json`), so every piece is independently testable. `metricNames.normalizeMetrics` is provided for those future connectors but no connector code is written here.

---

### Task 1: Migrations + registration (three F3 tables)

**Files:**
- Create: `server/sql/migrate_ops_f3_snapshots_baselines_memory.sql`
- Modify: `server/migrations.js` (append filename to `MIGRATIONS_BEFORE_SEED`, after `'migrate_ops_blog_ssh.sql'`)

**Interfaces:**
- Produces three tables consumed by later tasks:
  - `ops_daily_snapshots(id, client_user_id, snapshot_date, service, scope_type, scope_id, metrics_json, source_run_id, captured_at)`, UNIQUE `(client_user_id, snapshot_date, service, scope_type, scope_id)`.
  - `ops_metric_baselines(id, client_user_id, service, scope_type, scope_id, metric, period, baseline_value, stddev, sample_count, window_start, window_end, computed_at)`, UNIQUE `(client_user_id, service, scope_type, scope_id, metric, period)`.
  - `ops_agent_memory(id, client_user_id, scope, fact_type, fact_key, fact_value, confidence, occurrences, source, status, first_seen_at, last_seen_at, created_by)`, UNIQUE `(client_user_id, scope, fact_type, fact_key)`.

- [ ] **Step 1: Write the migration SQL**

Create `server/sql/migrate_ops_f3_snapshots_baselines_memory.sql`:

```sql
-- F3 — Snapshots + baselines + memory (north-star §2.4, §2.5, §2.9).
-- Idempotent. The "knows normal" learning loop sits underneath the run spine.
-- Snapshots store NUMERIC AGGREGATES ONLY (no PHI). Baselines + anomaly scoring
-- read these rows deterministically; the LLM never does metric math here.

-- ---------------------------------------------------------------------------
-- ops_daily_snapshots (§2.4) — one row per client/day/service/scope object.
-- metrics_json is a flat map of normalized metricName -> number, plus provider
-- extras. Written by F1 connectors' collectSnapshot(); read by the baseline
-- engine. UNIQUE key makes daily writes upsertable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_daily_snapshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL,
  snapshot_date DATE NOT NULL,
  service       TEXT NOT NULL,          -- service_category or provider id (e.g. paid_ads, ga4)
  scope_type    TEXT NOT NULL,          -- account | campaign | property | site | ...
  scope_id      TEXT NOT NULL,          -- external id of the scoped object
  metrics_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_run_id UUID,
  captured_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_user_id, snapshot_date, service, scope_type, scope_id)
);

CREATE INDEX IF NOT EXISTS idx_ops_daily_snapshots_series
  ON ops_daily_snapshots (client_user_id, service, scope_type, scope_id, snapshot_date DESC);

-- ---------------------------------------------------------------------------
-- ops_metric_baselines (§2.5) — one row per client/scope/metric/period.
-- baseline_value = mean daily value over the window; stddev null when too few
-- samples; sample_count = days of data used. Upserted by computeAndPersistBaselines.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_metric_baselines (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL,
  service       TEXT NOT NULL,
  scope_type    TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  metric        TEXT NOT NULL,          -- normalized metric name
  period        TEXT NOT NULL,          -- 7_day|30_day|weekday_4_week|previous_month|trailing_90_day|month_to_date
  baseline_value NUMERIC,
  stddev        NUMERIC,
  sample_count  INT NOT NULL DEFAULT 0,
  window_start  DATE,
  window_end    DATE,
  computed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (client_user_id, service, scope_type, scope_id, metric, period)
);

CREATE INDEX IF NOT EXISTS idx_ops_metric_baselines_lookup
  ON ops_metric_baselines (client_user_id, service, scope_type, scope_id, metric);

-- ---------------------------------------------------------------------------
-- ops_agent_memory (§2.9) — curated per-client memory. Learned from approved/
-- rejected recommendations, repeated false positives, stable configs, and
-- manual notes. fact_key dedupes; occurrences/confidence accrue on repeat.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ops_agent_memory (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID NOT NULL,
  scope         TEXT NOT NULL DEFAULT 'client',  -- 'client' or a service name
  fact_type     TEXT NOT NULL,          -- approved_pattern|rejected_pattern|false_positive|stable_config|manual_note
  fact_key      TEXT NOT NULL,
  fact_value    JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence    NUMERIC NOT NULL DEFAULT 0.5,
  occurrences   INT NOT NULL DEFAULT 1,
  source        TEXT NOT NULL DEFAULT 'learned',  -- learned | manual
  status        TEXT NOT NULL DEFAULT 'active',   -- active | archived
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by    UUID,
  UNIQUE (client_user_id, scope, fact_type, fact_key)
);

CREATE INDEX IF NOT EXISTS idx_ops_agent_memory_client
  ON ops_agent_memory (client_user_id, status, fact_type);
```

- [ ] **Step 2: Register the migration**

In `server/migrations.js`, in the `MIGRATIONS_BEFORE_SEED` array, change the last line `'migrate_ops_blog_ssh.sql'` to add the new file after it:

```js
  'migrate_ops_blog_ssh.sql',
  'migrate_ops_f3_snapshots_baselines_memory.sql'
```

- [ ] **Step 3: Run the migration locally**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn db:migrate`
Expected: log shows `[migrations] applied migrate_ops_f3_snapshots_baselines_memory.sql`; re-running is a no-op (idempotent `IF NOT EXISTS`).

- [ ] **Step 4: Verify the three tables exist**

Run:
```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor node -e "import('./server/db.js').then(async ({query})=>{const {rows}=await query(\"SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name = ANY(ARRAY['ops_daily_snapshots','ops_metric_baselines','ops_agent_memory']) ORDER BY 1\");console.log(rows.map(r=>r.table_name));process.exit(0)})"
```
Expected: prints `[ 'ops_agent_memory', 'ops_daily_snapshots', 'ops_metric_baselines' ]`.

- [ ] **Step 5: Commit**

```bash
git add server/sql/migrate_ops_f3_snapshots_baselines_memory.sql server/migrations.js
git commit -m "feat(ops/f3): snapshots + baselines + memory tables"
```

---

### Task 2: Normalized metric names (PURE)

**Files:**
- Create: `server/services/ops/baselines/metricNames.js`
- Test: `server/services/ops/__tests__/f3MetricNames.test.js`

**Interfaces:**
- Produces:
  - `NORMALIZED_METRICS: string[]` — the closed vocabulary.
  - `DERIVED_METRICS: string[]` — `['ctr','cvr','cpa_cents']`.
  - `isNormalizedMetric(name: string): boolean`.
  - `normalizeMetrics(raw: object): { metrics: Record<string, number>, extras: Record<string, any> }` — picks normalized numeric keys into `metrics`; everything else into `extras`. Non-numeric values for a normalized key are dropped (never coerced to NaN).
  - `deriveMetrics(metrics: object): object` — returns a copy with `ctr`, `cvr`, `cpa_cents` filled from base metrics when computable; leaves them absent otherwise. Never invents base metrics.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/f3MetricNames.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NORMALIZED_METRICS,
  DERIVED_METRICS,
  isNormalizedMetric,
  normalizeMetrics,
  deriveMetrics
} from '../baselines/metricNames.js';

test('vocabulary is the exact closed set', () => {
  assert.deepEqual(NORMALIZED_METRICS, [
    'cost_cents', 'impressions', 'clicks', 'conversions', 'conversion_value_cents',
    'sessions', 'users', 'leads', 'calls', 'forms', 'ctr', 'cvr', 'cpa_cents'
  ]);
  assert.deepEqual(DERIVED_METRICS, ['ctr', 'cvr', 'cpa_cents']);
});

test('isNormalizedMetric recognizes vocab and rejects extras', () => {
  assert.equal(isNormalizedMetric('clicks'), true);
  assert.equal(isNormalizedMetric('cpa_cents'), true);
  assert.equal(isNormalizedMetric('search_impression_share'), false);
  assert.equal(isNormalizedMetric(''), false);
});

test('normalizeMetrics splits normalized numbers from provider extras', () => {
  const { metrics, extras } = normalizeMetrics({
    cost_cents: 12345,
    clicks: 200,
    impressions: 10000,
    search_impression_share: 0.42,
    campaign_name: 'Brand'
  });
  assert.deepEqual(metrics, { cost_cents: 12345, clicks: 200, impressions: 10000 });
  assert.deepEqual(extras, { search_impression_share: 0.42, campaign_name: 'Brand' });
});

test('normalizeMetrics drops non-numeric values for normalized keys (no NaN)', () => {
  const { metrics } = normalizeMetrics({ clicks: 'oops', impressions: 5, conversions: null });
  assert.deepEqual(metrics, { impressions: 5 });
});

test('normalizeMetrics coerces numeric strings for normalized keys', () => {
  const { metrics } = normalizeMetrics({ cost_cents: '500', clicks: '10' });
  assert.deepEqual(metrics, { cost_cents: 500, clicks: 10 });
});

test('deriveMetrics computes ctr/cvr/cpa_cents from base metrics', () => {
  const out = deriveMetrics({ impressions: 1000, clicks: 50, conversions: 5, cost_cents: 10000 });
  assert.equal(out.ctr, 0.05);          // 50 / 1000
  assert.equal(out.cvr, 0.1);           // 5 / 50
  assert.equal(out.cpa_cents, 2000);    // 10000 / 5, rounded to int cents
});

test('deriveMetrics never divides by zero and never invents missing bases', () => {
  const out = deriveMetrics({ impressions: 0, clicks: 0, conversions: 0, cost_cents: 100 });
  assert.equal('ctr' in out, false);
  assert.equal('cvr' in out, false);
  assert.equal('cpa_cents' in out, false);
  const out2 = deriveMetrics({ sessions: 10 }); // no ads bases at all
  assert.deepEqual(out2, { sessions: 10 });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/f3MetricNames.test.js`
Expected: FAIL — cannot resolve `../baselines/metricNames.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/baselines/metricNames.js`:

```js
/**
 * Normalized metric vocabulary (F3, prompt deliverable 4).
 *
 * The agent reasons over ONE closed set of metric names across every provider.
 * Provider-specific extras are preserved separately so nothing is lost, but they
 * are NOT part of the normalized set and are never baselined as normalized metrics.
 *
 * Pure. No DB, no I/O. The LLM never computes these — derivation is deterministic.
 */

export const NORMALIZED_METRICS = [
  'cost_cents',
  'impressions',
  'clicks',
  'conversions',
  'conversion_value_cents',
  'sessions',
  'users',
  'leads',
  'calls',
  'forms',
  'ctr',
  'cvr',
  'cpa_cents'
];

export const DERIVED_METRICS = ['ctr', 'cvr', 'cpa_cents'];

const NORMALIZED_SET = new Set(NORMALIZED_METRICS);

export function isNormalizedMetric(name) {
  return NORMALIZED_SET.has(name);
}

function toFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function normalizeMetrics(raw = {}) {
  const metrics = {};
  const extras = {};
  for (const [key, value] of Object.entries(raw)) {
    if (NORMALIZED_SET.has(key)) {
      const n = toFiniteNumber(value);
      if (n !== null) metrics[key] = n; // drop non-numeric: never persist NaN
    } else {
      extras[key] = value;
    }
  }
  return { metrics, extras };
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

export function deriveMetrics(metrics = {}) {
  const out = { ...metrics };
  const { impressions, clicks, conversions, cost_cents } = metrics;

  if (Number.isFinite(impressions) && impressions > 0 && Number.isFinite(clicks)) {
    out.ctr = round6(clicks / impressions);
  }
  if (Number.isFinite(clicks) && clicks > 0 && Number.isFinite(conversions)) {
    out.cvr = round6(conversions / clicks);
  }
  if (Number.isFinite(conversions) && conversions > 0 && Number.isFinite(cost_cents)) {
    out.cpa_cents = Math.round(cost_cents / conversions);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/f3MetricNames.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/baselines/metricNames.js server/services/ops/__tests__/f3MetricNames.test.js
git commit -m "feat(ops/f3): normalized metric vocabulary + pure normalize/derive"
```

---

### Task 3: Baseline math (PURE)

**Files:**
- Create: `server/services/ops/baselines/computeBaselines.js`
- Test: `server/services/ops/__tests__/f3ComputeBaselines.test.js`

**Interfaces:**
- Produces (all PURE):
  - `ALL_PERIODS: string[]` = `['7_day','30_day','weekday_4_week','previous_month','trailing_90_day','month_to_date']`.
  - `MIN_STDDEV_SAMPLES: number` = `4`.
  - `windowForPeriod(period, asOf): { start, end }` — inclusive `YYYY-MM-DD` bounds. Rolling windows end the day **before** `asOf` (the observed day is excluded from its own baseline).
  - `selectSamples(series, period, asOf): number[]` — `series` is `[{ date:'YYYY-MM-DD', value:number }]`; returns values inside the period (weekday_4_week filters to `asOf`'s weekday).
  - `computeStats(values): { count, mean, stddev }` — sample stddev (n−1) only when `count >= MIN_STDDEV_SAMPLES`, else `null`; `mean` `null` when empty.
  - `computeBaselinesForSeries({ series, asOf, periods }): Array<{ period, baseline_value, stddev, sample_count, window_start, window_end }>`.
- Note: the injected-deps orchestrator `computeAndPersistBaselines` is added to this same file in **Task 5** (after `baselineStore` exists).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/f3ComputeBaselines.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_PERIODS,
  MIN_STDDEV_SAMPLES,
  windowForPeriod,
  selectSamples,
  computeStats,
  computeBaselinesForSeries
} from '../baselines/computeBaselines.js';

const AS_OF = '2026-06-28'; // a Sunday (UTC)

test('ALL_PERIODS is the exact ordered set', () => {
  assert.deepEqual(ALL_PERIODS, [
    '7_day', '30_day', 'weekday_4_week', 'previous_month', 'trailing_90_day', 'month_to_date'
  ]);
  assert.equal(MIN_STDDEV_SAMPLES, 4);
});

test('windowForPeriod: rolling windows exclude the observed day', () => {
  assert.deepEqual(windowForPeriod('7_day', AS_OF), { start: '2026-06-21', end: '2026-06-27' });
  assert.deepEqual(windowForPeriod('30_day', AS_OF), { start: '2026-05-29', end: '2026-06-27' });
  assert.deepEqual(windowForPeriod('trailing_90_day', AS_OF), { start: '2026-03-30', end: '2026-06-27' });
});

test('windowForPeriod: weekday_4_week bounds the four prior same-weekdays', () => {
  assert.deepEqual(windowForPeriod('weekday_4_week', AS_OF), { start: '2026-05-31', end: '2026-06-21' });
});

test('windowForPeriod: previous_month + month_to_date', () => {
  assert.deepEqual(windowForPeriod('previous_month', AS_OF), { start: '2026-05-01', end: '2026-05-31' });
  assert.deepEqual(windowForPeriod('month_to_date', AS_OF), { start: '2026-06-01', end: '2026-06-27' });
});

test('selectSamples weekday_4_week keeps only matching weekday (Sundays)', () => {
  const series = [
    { date: '2026-05-31', value: 1 }, // Sun
    { date: '2026-06-01', value: 99 }, // Mon (excluded)
    { date: '2026-06-07', value: 2 }, // Sun
    { date: '2026-06-14', value: 3 }, // Sun
    { date: '2026-06-21', value: 4 }, // Sun
    { date: '2026-06-27', value: 99 } // Sat (outside weekday window)
  ];
  assert.deepEqual(selectSamples(series, 'weekday_4_week', AS_OF), [1, 2, 3, 4]);
});

test('selectSamples 7_day keeps only the contiguous prior-7 window', () => {
  const series = [
    { date: '2026-06-20', value: 99 }, // before window
    { date: '2026-06-21', value: 10 },
    { date: '2026-06-27', value: 16 },
    { date: '2026-06-28', value: 99 }  // the observed day, excluded
  ];
  assert.deepEqual(selectSamples(series, '7_day', AS_OF), [10, 16]);
});

test('computeStats: mean + sample stddev when >= MIN_STDDEV_SAMPLES', () => {
  const r = computeStats([10, 20, 30, 40]);
  assert.equal(r.count, 4);
  assert.equal(r.mean, 25);
  // sample stddev = sqrt(500/3) ~= 12.909944
  assert.ok(Math.abs(r.stddev - 12.909944) < 1e-5);
});

test('computeStats: stddev null below threshold, mean still computed', () => {
  const r = computeStats([10, 20, 30]);
  assert.equal(r.count, 3);
  assert.equal(r.mean, 20);
  assert.equal(r.stddev, null);
});

test('computeStats: empty → all null/zero', () => {
  assert.deepEqual(computeStats([]), { count: 0, mean: null, stddev: null });
});

test('computeBaselinesForSeries returns one row per period with rounded stats', () => {
  // 30 contiguous days each value 100 → mean 100, stddev 0 over enough samples.
  const series = [];
  for (let i = 1; i <= 30; i++) {
    const d = String(i).padStart(2, '0');
    series.push({ date: `2026-05-${d}`, value: 100 });
  }
  for (let i = 1; i <= 27; i++) {
    const d = String(i).padStart(2, '0');
    series.push({ date: `2026-06-${d}`, value: 100 });
  }
  const rows = computeBaselinesForSeries({ series, asOf: AS_OF });
  assert.equal(rows.length, 6);
  const byPeriod = Object.fromEntries(rows.map((r) => [r.period, r]));
  assert.equal(byPeriod['7_day'].baseline_value, 100);
  assert.equal(byPeriod['7_day'].sample_count, 7);
  assert.equal(byPeriod['7_day'].stddev, 0);
  assert.equal(byPeriod['previous_month'].sample_count, 31); // May has 31 days
  assert.equal(byPeriod['previous_month'].baseline_value, 100);
  assert.deepEqual(
    { s: byPeriod['7_day'].window_start, e: byPeriod['7_day'].window_end },
    { s: '2026-06-21', e: '2026-06-27' }
  );
});

test('computeBaselinesForSeries: empty window → null baseline, zero samples', () => {
  const rows = computeBaselinesForSeries({ series: [], asOf: AS_OF });
  for (const r of rows) {
    assert.equal(r.baseline_value, null);
    assert.equal(r.stddev, null);
    assert.equal(r.sample_count, 0);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/f3ComputeBaselines.test.js`
Expected: FAIL — cannot resolve `../baselines/computeBaselines.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/baselines/computeBaselines.js`:

```js
/**
 * Deterministic baseline math (F3). PURE — no DB, no I/O, no LLM.
 *
 * A baseline is the mean daily value (+ sample stddev when enough samples) over a
 * named historical window, so it is directly comparable to a single observed day.
 * The observed day (asOf) is always EXCLUDED from its own rolling baseline.
 *
 * Date helpers operate on 'YYYY-MM-DD' strings in UTC. Lexicographic string
 * comparison of that format equals chronological comparison.
 */

export const ALL_PERIODS = [
  '7_day',
  '30_day',
  'weekday_4_week',
  'previous_month',
  'trailing_90_day',
  'month_to_date'
];

export const MIN_STDDEV_SAMPLES = 4;

function toDate(s) { return new Date(`${s}T00:00:00Z`); }
function ymd(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return ymd(d); }
function firstOfMonth(s) { const d = toDate(s); return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))); }
function firstOfPrevMonth(s) { const d = toDate(s); return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1))); }
function lastOfPrevMonth(s) { const d = toDate(s); return ymd(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0))); }
function weekday(s) { return toDate(s).getUTCDay(); }

export function windowForPeriod(period, asOf) {
  const endRolling = addDays(asOf, -1); // exclude the observed day
  switch (period) {
    case '7_day': return { start: addDays(asOf, -7), end: endRolling };
    case '30_day': return { start: addDays(asOf, -30), end: endRolling };
    case 'trailing_90_day': return { start: addDays(asOf, -90), end: endRolling };
    case 'weekday_4_week': return { start: addDays(asOf, -28), end: addDays(asOf, -7) };
    case 'previous_month': return { start: firstOfPrevMonth(asOf), end: lastOfPrevMonth(asOf) };
    case 'month_to_date': return { start: firstOfMonth(asOf), end: endRolling };
    default: throw new Error(`unknown period ${period}`);
  }
}

export function selectSamples(series, period, asOf) {
  const { start, end } = windowForPeriod(period, asOf);
  const inWindow = (series || []).filter((p) => p.date >= start && p.date <= end);
  if (period === 'weekday_4_week') {
    const wd = weekday(asOf);
    return inWindow.filter((p) => weekday(p.date) === wd).map((p) => p.value);
  }
  return inWindow.map((p) => p.value);
}

const round4 = (n) => Math.round(n * 1e4) / 1e4;

export function computeStats(values = []) {
  const count = values.length;
  if (count === 0) return { count: 0, mean: null, stddev: null };
  const mean = values.reduce((a, b) => a + b, 0) / count;
  let stddev = null;
  if (count >= MIN_STDDEV_SAMPLES) {
    const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (count - 1);
    stddev = Math.sqrt(variance);
  }
  return { count, mean, stddev };
}

export function computeBaselinesForSeries({ series, asOf, periods = ALL_PERIODS }) {
  return periods.map((period) => {
    const { start, end } = windowForPeriod(period, asOf);
    const { count, mean, stddev } = computeStats(selectSamples(series, period, asOf));
    return {
      period,
      baseline_value: mean == null ? null : round4(mean),
      stddev: stddev == null ? null : round4(stddev),
      sample_count: count,
      window_start: start,
      window_end: end
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/f3ComputeBaselines.test.js`
Expected: PASS (11 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/baselines/computeBaselines.js server/services/ops/__tests__/f3ComputeBaselines.test.js
git commit -m "feat(ops/f3): pure baseline math (windows, sample selection, stats)"
```

---

### Task 4: Baseline store (DB)

**Files:**
- Create: `server/services/ops/baselines/baselineStore.js`
- Test: `server/services/ops/__tests__/f3BaselineStore.test.js`

**Interfaces:**
- Consumes: `ops_daily_snapshots` + `ops_metric_baselines` (Task 1).
- Produces:
  - `async loadSnapshotSeries({ clientUserId, service, scopeType, scopeId, metric, asOf, lookbackDays }): Promise<Array<{ date, value }>>` — pulls one metric out of `metrics_json` for dates `>= asOf - lookbackDays` and `< asOf`, numeric only, ascending. Default `lookbackDays = 95` (covers the 90-day window).
  - `async upsertBaseline({ clientUserId, service, scopeType, scopeId, metric, period, baseline_value, stddev, sample_count, window_start, window_end }): Promise<row>` — idempotent upsert on the UNIQUE key.
  - `async getBaselines({ clientUserId, service, scopeType, scopeId, metric }): Promise<row[]>` — all periods for a scope+metric.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/f3BaselineStore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query } from '../../../db.js';
import { loadSnapshotSeries, upsertBaseline, getBaselines } from '../baselines/baselineStore.js';

const CLIENT = randomUUID();
const SERVICE = 'paid_ads';
const SCOPE_TYPE = 'account';
const SCOPE_ID = 'acc-123';

async function seedSnapshot(date, metrics) {
  await query(
    `INSERT INTO ops_daily_snapshots (client_user_id, snapshot_date, service, scope_type, scope_id, metrics_json)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     ON CONFLICT (client_user_id, snapshot_date, service, scope_type, scope_id)
     DO UPDATE SET metrics_json = EXCLUDED.metrics_json`,
    [CLIENT, date, SERVICE, SCOPE_TYPE, SCOPE_ID, JSON.stringify(metrics)]
  );
}

test('loadSnapshotSeries returns numeric points before asOf, ascending', async () => {
  await seedSnapshot('2026-06-25', { cost_cents: 1000, clicks: 10 });
  await seedSnapshot('2026-06-26', { cost_cents: 2000, clicks: 20 });
  await seedSnapshot('2026-06-28', { cost_cents: 9999, clicks: 99 }); // == asOf, excluded

  const series = await loadSnapshotSeries({
    clientUserId: CLIENT, service: SERVICE, scopeType: SCOPE_TYPE, scopeId: SCOPE_ID,
    metric: 'cost_cents', asOf: '2026-06-28'
  });
  assert.deepEqual(series, [
    { date: '2026-06-25', value: 1000 },
    { date: '2026-06-26', value: 2000 }
  ]);
});

test('loadSnapshotSeries skips rows missing the metric key', async () => {
  await seedSnapshot('2026-06-27', { clicks: 5 }); // no cost_cents
  const series = await loadSnapshotSeries({
    clientUserId: CLIENT, service: SERVICE, scopeType: SCOPE_TYPE, scopeId: SCOPE_ID,
    metric: 'cost_cents', asOf: '2026-06-28'
  });
  assert.equal(series.find((p) => p.date === '2026-06-27'), undefined);
});

test('upsertBaseline is idempotent on the unique key and getBaselines reads it back', async () => {
  const base = {
    clientUserId: CLIENT, service: SERVICE, scopeType: SCOPE_TYPE, scopeId: SCOPE_ID,
    metric: 'cost_cents', period: '7_day', baseline_value: 1500, stddev: 500,
    sample_count: 2, window_start: '2026-06-21', window_end: '2026-06-27'
  };
  const first = await upsertBaseline(base);
  assert.equal(Number(first.baseline_value), 1500);
  const second = await upsertBaseline({ ...base, baseline_value: 1600, sample_count: 3 });
  assert.equal(Number(second.baseline_value), 1600);
  assert.equal(second.id, first.id, 'upsert updates the same row');

  const all = await getBaselines({
    clientUserId: CLIENT, service: SERVICE, scopeType: SCOPE_TYPE, scopeId: SCOPE_ID, metric: 'cost_cents'
  });
  assert.equal(all.length, 1);
  assert.equal(all[0].period, '7_day');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/f3BaselineStore.test.js`
Expected: FAIL — cannot resolve `../baselines/baselineStore.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/baselines/baselineStore.js`:

```js
/**
 * DB layer for the baseline engine (F3). Reads ops_daily_snapshots series and
 * upserts ops_metric_baselines. The math lives in computeBaselines.js (pure);
 * this module only moves rows.
 */
import { query } from '../../../db.js';

export async function loadSnapshotSeries({
  clientUserId, service, scopeType, scopeId, metric, asOf, lookbackDays = 95
}) {
  const { rows } = await query(
    `SELECT snapshot_date::text AS date, (metrics_json->>$6)::numeric AS value
       FROM ops_daily_snapshots
      WHERE client_user_id = $1
        AND service = $2
        AND scope_type = $3
        AND scope_id = $4
        AND snapshot_date < $5::date
        AND snapshot_date >= ($5::date - $7::int)
        AND metrics_json ? $6
      ORDER BY snapshot_date ASC`,
    [clientUserId, service, scopeType, scopeId, asOf, metric, lookbackDays]
  );
  return rows
    .map((r) => ({ date: r.date, value: Number(r.value) }))
    .filter((r) => Number.isFinite(r.value));
}

export async function upsertBaseline({
  clientUserId, service, scopeType, scopeId, metric, period,
  baseline_value, stddev, sample_count, window_start, window_end
}) {
  const { rows } = await query(
    `INSERT INTO ops_metric_baselines
       (client_user_id, service, scope_type, scope_id, metric, period,
        baseline_value, stddev, sample_count, window_start, window_end, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
     ON CONFLICT (client_user_id, service, scope_type, scope_id, metric, period)
     DO UPDATE SET baseline_value = EXCLUDED.baseline_value,
                   stddev = EXCLUDED.stddev,
                   sample_count = EXCLUDED.sample_count,
                   window_start = EXCLUDED.window_start,
                   window_end = EXCLUDED.window_end,
                   computed_at = NOW()
     RETURNING *`,
    [clientUserId, service, scopeType, scopeId, metric, period,
     baseline_value, stddev, sample_count, window_start, window_end]
  );
  return rows[0];
}

export async function getBaselines({ clientUserId, service, scopeType, scopeId, metric }) {
  const { rows } = await query(
    `SELECT * FROM ops_metric_baselines
      WHERE client_user_id = $1 AND service = $2 AND scope_type = $3
        AND scope_id = $4 AND metric = $5
      ORDER BY period ASC`,
    [clientUserId, service, scopeType, scopeId, metric]
  );
  return rows;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/f3BaselineStore.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/baselines/baselineStore.js server/services/ops/__tests__/f3BaselineStore.test.js
git commit -m "feat(ops/f3): baseline store (snapshot series + baseline upsert)"
```

---

### Task 5: Baseline orchestrator (injected deps)

**Files:**
- Modify: `server/services/ops/baselines/computeBaselines.js` (add the orchestrator + its imports)
- Test: `server/services/ops/__tests__/f3ComputeBaselinesOrchestrator.test.js`

**Interfaces:**
- Consumes: `computeBaselinesForSeries` (Task 3), `loadSnapshotSeries` + `upsertBaseline` (Task 4).
- Produces:
  - `async computeAndPersistBaselines({ clientUserId, service, scopeType, scopeId, metric, asOf, periods, loadSnapshotSeries, upsertBaseline }): Promise<{ metric, computed, persisted }>` — loads the series, computes all periods, and upserts only periods with `sample_count > 0`. `loadSnapshotSeries`/`upsertBaseline` default to the store but are injectable for tests.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/f3ComputeBaselinesOrchestrator.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeAndPersistBaselines } from '../baselines/computeBaselines.js';

test('computeAndPersistBaselines loads series, computes, persists non-empty periods', async () => {
  const series = [];
  for (let i = 1; i <= 27; i++) {
    series.push({ date: `2026-06-${String(i).padStart(2, '0')}`, value: 100 });
  }
  const upserted = [];
  const out = await computeAndPersistBaselines({
    clientUserId: 'c1', service: 'paid_ads', scopeType: 'account', scopeId: 'a1',
    metric: 'cost_cents', asOf: '2026-06-28',
    loadSnapshotSeries: async () => series,
    upsertBaseline: async (row) => { upserted.push(row); return { id: 'x', ...row }; }
  });

  assert.equal(out.metric, 'cost_cents');
  assert.equal(out.computed, 6);                 // all periods computed
  assert.ok(out.persisted >= 3 && out.persisted <= 6);
  // every persisted row carries identity + a positive sample_count
  for (const r of upserted) {
    assert.equal(r.clientUserId, 'c1');
    assert.equal(r.metric, 'cost_cents');
    assert.ok(r.sample_count > 0);
  }
  // previous_month had no June-only data → not persisted
  assert.equal(upserted.some((r) => r.period === 'previous_month'), false);
});

test('computeAndPersistBaselines persists nothing when there is no history', async () => {
  const out = await computeAndPersistBaselines({
    clientUserId: 'c1', service: 'paid_ads', scopeType: 'account', scopeId: 'a1',
    metric: 'cost_cents', asOf: '2026-06-28',
    loadSnapshotSeries: async () => [],
    upsertBaseline: async () => { throw new Error('should not be called'); }
  });
  assert.equal(out.persisted, 0);
  assert.equal(out.computed, 6);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/f3ComputeBaselinesOrchestrator.test.js`
Expected: FAIL — `computeAndPersistBaselines` is not exported.

- [ ] **Step 3: Add the orchestrator**

At the TOP of `server/services/ops/baselines/computeBaselines.js`, add an import (the pure functions stay; the file gains a DB-aware orchestrator with injectable deps):

```js
import {
  loadSnapshotSeries as loadSnapshotSeriesDefault,
  upsertBaseline as upsertBaselineDefault
} from './baselineStore.js';
```

At the BOTTOM of the same file, append:

```js
/**
 * Orchestrator: load a metric's snapshot series, compute every period's baseline,
 * and persist the periods that actually have data. Deps are injectable so this is
 * testable with no DB. The math is delegated to the pure functions above.
 */
export async function computeAndPersistBaselines({
  clientUserId, service, scopeType, scopeId, metric, asOf,
  periods = ALL_PERIODS,
  loadSnapshotSeries = loadSnapshotSeriesDefault,
  upsertBaseline = upsertBaselineDefault
}) {
  const series = await loadSnapshotSeries({ clientUserId, service, scopeType, scopeId, metric, asOf });
  const baselines = computeBaselinesForSeries({ series, asOf, periods });
  let persisted = 0;
  for (const b of baselines) {
    if (b.sample_count === 0) continue; // nothing learned for this period yet
    await upsertBaseline({ clientUserId, service, scopeType, scopeId, metric, ...b });
    persisted += 1;
  }
  return { metric, computed: baselines.length, persisted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/f3ComputeBaselinesOrchestrator.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Confirm the pure tests still pass (no regression from the new import)**

Run: `node --test server/services/ops/__tests__/f3ComputeBaselines.test.js`
Expected: PASS (11 tests).

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/baselines/computeBaselines.js server/services/ops/__tests__/f3ComputeBaselinesOrchestrator.test.js
git commit -m "feat(ops/f3): baseline orchestrator (load → compute → persist)"
```

---

### Task 6: Compare a metric to its baseline (PURE)

**Files:**
- Create: `server/services/ops/baselines/compareMetric.js`
- Test: `server/services/ops/__tests__/f3CompareMetric.test.js`

**Interfaces:**
- Produces (PURE):
  - `compareMetric(observed: number, baseline: { baseline_value, stddev, sample_count }): { comparable, observed, baseline_value, delta, pct_change, z_score, direction, stddev, sample_count }`. `comparable` is `false` when `baseline_value` is `null`/missing. `pct_change` is `null` when `baseline_value === 0`. `z_score` is `null` when `stddev` is `null`/`0`. `direction ∈ 'up'|'down'|'flat'`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/f3CompareMetric.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { compareMetric } from '../baselines/compareMetric.js';

test('compareMetric computes delta, pct, and z-score', () => {
  const r = compareMetric(100, { baseline_value: 50, stddev: 10, sample_count: 5 });
  assert.equal(r.comparable, true);
  assert.equal(r.delta, 50);
  assert.equal(r.pct_change, 1);   // (100-50)/50
  assert.equal(r.z_score, 5);      // (100-50)/10
  assert.equal(r.direction, 'up');
});

test('compareMetric down direction + negative values', () => {
  const r = compareMetric(20, { baseline_value: 50, stddev: 10, sample_count: 5 });
  assert.equal(r.delta, -30);
  assert.equal(r.pct_change, -0.6);
  assert.equal(r.z_score, -3);
  assert.equal(r.direction, 'down');
});

test('compareMetric: null baseline → not comparable', () => {
  const r = compareMetric(100, { baseline_value: null, stddev: null, sample_count: 0 });
  assert.equal(r.comparable, false);
});

test('compareMetric: zero baseline → pct_change null (no divide by zero)', () => {
  const r = compareMetric(5, { baseline_value: 0, stddev: null, sample_count: 4 });
  assert.equal(r.comparable, true);
  assert.equal(r.pct_change, null);
  assert.equal(r.z_score, null);
  assert.equal(r.direction, 'up');
});

test('compareMetric: no stddev → z_score null but still comparable', () => {
  const r = compareMetric(60, { baseline_value: 50, stddev: null, sample_count: 3 });
  assert.equal(r.comparable, true);
  assert.equal(r.z_score, null);
  assert.equal(r.pct_change, 0.2);
});

test('compareMetric: equal value → flat', () => {
  const r = compareMetric(50, { baseline_value: 50, stddev: 10, sample_count: 5 });
  assert.equal(r.direction, 'flat');
  assert.equal(r.delta, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/f3CompareMetric.test.js`
Expected: FAIL — cannot resolve `../baselines/compareMetric.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/baselines/compareMetric.js`:

```js
/**
 * Compare an observed metric value to a stored baseline (F3). PURE.
 * No LLM, no fabrication — when there is no baseline, comparison is impossible
 * and we say so rather than guessing.
 */

const round6 = (n) => Math.round(n * 1e6) / 1e6;

export function compareMetric(observed, baseline = {}) {
  const { baseline_value, stddev, sample_count } = baseline;
  if (baseline_value === null || baseline_value === undefined) {
    return { comparable: false, observed, baseline_value: null, delta: null,
             pct_change: null, z_score: null, direction: null,
             stddev: stddev ?? null, sample_count: sample_count ?? 0 };
  }

  const base = Number(baseline_value);
  const sd = stddev === null || stddev === undefined ? null : Number(stddev);
  const delta = round6(observed - base);

  const pct_change = base === 0 ? null : round6((observed - base) / base);
  const z_score = sd && sd !== 0 ? round6((observed - base) / sd) : null;
  const direction = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';

  return {
    comparable: true,
    observed,
    baseline_value: base,
    delta,
    pct_change,
    z_score,
    direction,
    stddev: sd,
    sample_count: sample_count ?? 0
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/f3CompareMetric.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/baselines/compareMetric.js server/services/ops/__tests__/f3CompareMetric.test.js
git commit -m "feat(ops/f3): pure compareMetric (delta, pct, z-score)"
```

---

### Task 7: Anomaly scorer (PURE)

**Files:**
- Create: `server/services/ops/baselines/anomalyScorer.js`
- Test: `server/services/ops/__tests__/f3AnomalyScorer.test.js`

**Interfaces:**
- Consumes: comparison objects from `compareMetric` (Task 6).
- Produces (PURE, deterministic):
  - `Z_THRESHOLDS` / `PCT_THRESHOLDS` constants.
  - `scoreAnomaly({ comparison, metric }): { score, severity, direction, reason }`. `score ∈ [0,1]`. `severity ∈ 'none'|'info'|'warning'|'critical'`. Uses |z| when available, else |pct_change|. Not comparable → `score 0, severity 'none'`.
  - `scoreAcrossPeriods({ comparisonsByPeriod, metric }): { score, severity, direction, period, reason }` — returns the single most-anomalous period (max score; ties broken by `ALL_PERIODS`-independent first-seen order of the input object).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/f3AnomalyScorer.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAnomaly, scoreAcrossPeriods } from '../baselines/anomalyScorer.js';

test('not comparable → none', () => {
  const r = scoreAnomaly({ comparison: { comparable: false }, metric: 'cost_cents' });
  assert.equal(r.severity, 'none');
  assert.equal(r.score, 0);
});

test('high z-score → critical, score saturates at 1', () => {
  const r = scoreAnomaly({
    comparison: { comparable: true, z_score: 5, pct_change: 1, direction: 'up', observed: 100, baseline_value: 50 },
    metric: 'cost_cents'
  });
  assert.equal(r.severity, 'critical');
  assert.equal(r.score, 1);
  assert.equal(r.direction, 'up');
  assert.match(r.reason, /cost_cents/);
});

test('moderate z-score → warning', () => {
  const r = scoreAnomaly({
    comparison: { comparable: true, z_score: 2.2, pct_change: 0.1, direction: 'down', observed: 40, baseline_value: 50 },
    metric: 'clicks'
  });
  assert.equal(r.severity, 'warning');
  assert.ok(r.score > 0 && r.score < 1);
});

test('small z-score → info', () => {
  const r = scoreAnomaly({
    comparison: { comparable: true, z_score: 1.2, pct_change: 0.05, direction: 'up', observed: 53, baseline_value: 50 },
    metric: 'clicks'
  });
  assert.equal(r.severity, 'info');
});

test('within tolerance → none', () => {
  const r = scoreAnomaly({
    comparison: { comparable: true, z_score: 0.3, pct_change: 0.02, direction: 'up', observed: 51, baseline_value: 50 },
    metric: 'clicks'
  });
  assert.equal(r.severity, 'none');
});

test('falls back to pct_change when z_score is null', () => {
  const critical = scoreAnomaly({
    comparison: { comparable: true, z_score: null, pct_change: 0.8, direction: 'up', observed: 90, baseline_value: 50 },
    metric: 'cost_cents'
  });
  assert.equal(critical.severity, 'critical'); // |pct| >= 0.5
  const info = scoreAnomaly({
    comparison: { comparable: true, z_score: null, pct_change: 0.18, direction: 'up', observed: 59, baseline_value: 50 },
    metric: 'cost_cents'
  });
  assert.equal(info.severity, 'info'); // |pct| >= 0.15
});

test('scoreAcrossPeriods returns the most anomalous period', () => {
  const r = scoreAcrossPeriods({
    metric: 'cost_cents',
    comparisonsByPeriod: {
      '7_day': { comparable: true, z_score: 1.1, pct_change: 0.05, direction: 'up' },
      '30_day': { comparable: true, z_score: 4.0, pct_change: 0.9, direction: 'up' },
      'previous_month': { comparable: false }
    }
  });
  assert.equal(r.period, '30_day');
  assert.equal(r.severity, 'critical');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/f3AnomalyScorer.test.js`
Expected: FAIL — cannot resolve `../baselines/anomalyScorer.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/baselines/anomalyScorer.js`:

```js
/**
 * Deterministic anomaly scoring (F3). PURE. Given a compareMetric result, emit a
 * stable score [0,1] + severity. Uses the z-score when a stddev-backed baseline
 * exists, otherwise the percent change. The LLM may later narrate this, but it
 * never computes it.
 */

// severity cutoffs (absolute). z first; pct fallback.
export const Z_THRESHOLDS = { info: 1, warning: 2, critical: 3 };
export const PCT_THRESHOLDS = { info: 0.15, warning: 0.3, critical: 0.5 };

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const round4 = (n) => Math.round(n * 1e4) / 1e4;

function severityFor(absZ, absPct) {
  if (absZ !== null) {
    if (absZ >= Z_THRESHOLDS.critical) return 'critical';
    if (absZ >= Z_THRESHOLDS.warning) return 'warning';
    if (absZ >= Z_THRESHOLDS.info) return 'info';
    return 'none';
  }
  if (absPct !== null) {
    if (absPct >= PCT_THRESHOLDS.critical) return 'critical';
    if (absPct >= PCT_THRESHOLDS.warning) return 'warning';
    if (absPct >= PCT_THRESHOLDS.info) return 'info';
    return 'none';
  }
  return 'none';
}

export function scoreAnomaly({ comparison, metric }) {
  if (!comparison || !comparison.comparable) {
    return { score: 0, severity: 'none', direction: null, reason: `${metric}: no baseline to compare against` };
  }
  const absZ = comparison.z_score === null || comparison.z_score === undefined ? null : Math.abs(comparison.z_score);
  const absPct = comparison.pct_change === null || comparison.pct_change === undefined ? null : Math.abs(comparison.pct_change);

  const severity = severityFor(absZ, absPct);
  // score is normalized against the CRITICAL cutoff of whichever signal is used.
  let score = 0;
  if (absZ !== null) score = clamp01(absZ / Z_THRESHOLDS.critical);
  else if (absPct !== null) score = clamp01(absPct / PCT_THRESHOLDS.critical);

  const dir = comparison.direction;
  const magnitude = absZ !== null ? `z=${round4(comparison.z_score)}` :
    absPct !== null ? `${round4(comparison.pct_change * 100)}%` : 'n/a';
  const reason = `${metric} ${dir} vs baseline (${magnitude}); observed ${comparison.observed} vs ${comparison.baseline_value}`;

  return { score: round4(score), severity, direction: dir, reason };
}

export function scoreAcrossPeriods({ comparisonsByPeriod = {}, metric }) {
  let best = { score: -1, severity: 'none', direction: null, period: null, reason: `${metric}: no comparable periods` };
  for (const [period, comparison] of Object.entries(comparisonsByPeriod)) {
    const s = scoreAnomaly({ comparison, metric });
    if (s.score > best.score) {
      best = { ...s, period };
    }
  }
  if (best.score < 0) best.score = 0;
  return best;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/f3AnomalyScorer.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/baselines/anomalyScorer.js server/services/ops/__tests__/f3AnomalyScorer.test.js
git commit -m "feat(ops/f3): pure deterministic anomaly scorer"
```

---

### Task 8: Memory store (DB)

**Files:**
- Create: `server/services/ops/memory/memoryStore.js`
- Test: `server/services/ops/__tests__/f3MemoryStore.test.js`

**Interfaces:**
- Consumes: `ops_agent_memory` (Task 1).
- Produces:
  - `async upsertMemoryFact({ clientUserId, scope, fact_type, fact_key, fact_value, confidence, source }): Promise<row>` — insert, or on `(client_user_id, scope, fact_type, fact_key)` conflict bump `occurrences + 1`, refresh `last_seen_at`, raise `confidence` toward 1 (learned facts) and refresh `fact_value`.
  - `async getMemory({ clientUserId, scope, factType, status }): Promise<row[]>` — `status` defaults to `'active'`; `scope`/`factType` optional filters.
  - `async archiveMemoryFact(id): Promise<row>` — set `status='archived'`.
  - `async recordManualNote({ clientUserId, scope, text, createdBy }): Promise<row>` — a `manual_note` fact with `source='manual'`, `confidence=1`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/f3MemoryStore.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { upsertMemoryFact, getMemory, archiveMemoryFact, recordManualNote } from '../memory/memoryStore.js';

const CLIENT = randomUUID();

test('upsertMemoryFact inserts then accrues on conflict', async () => {
  const first = await upsertMemoryFact({
    clientUserId: CLIENT, scope: 'paid_ads', fact_type: 'approved_pattern',
    fact_key: 'approved:pause_keyword', fact_value: { tool: 'pause_keyword' }, confidence: 0.5, source: 'learned'
  });
  assert.equal(first.occurrences, 1);
  assert.equal(Number(first.confidence), 0.5);

  const second = await upsertMemoryFact({
    clientUserId: CLIENT, scope: 'paid_ads', fact_type: 'approved_pattern',
    fact_key: 'approved:pause_keyword', fact_value: { tool: 'pause_keyword', last: 'again' }, confidence: 0.5, source: 'learned'
  });
  assert.equal(second.id, first.id, 'same row');
  assert.equal(second.occurrences, 2, 'occurrences accrued');
  assert.ok(Number(second.confidence) > 0.5, 'confidence raised');
  assert.deepEqual(second.fact_value, { tool: 'pause_keyword', last: 'again' });
});

test('getMemory filters by status/scope/type', async () => {
  const all = await getMemory({ clientUserId: CLIENT });
  assert.ok(all.length >= 1);
  const scoped = await getMemory({ clientUserId: CLIENT, scope: 'paid_ads', factType: 'approved_pattern' });
  assert.ok(scoped.every((r) => r.scope === 'paid_ads' && r.fact_type === 'approved_pattern'));
});

test('archiveMemoryFact hides a fact from active reads', async () => {
  const note = await recordManualNote({ clientUserId: CLIENT, scope: 'client', text: 'Client only wants weekday changes', createdBy: null });
  assert.equal(note.source, 'manual');
  assert.equal(Number(note.confidence), 1);

  await archiveMemoryFact(note.id);
  const active = await getMemory({ clientUserId: CLIENT, status: 'active' });
  assert.equal(active.some((r) => r.id === note.id), false);
  const archived = await getMemory({ clientUserId: CLIENT, status: 'archived' });
  assert.equal(archived.some((r) => r.id === note.id), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/f3MemoryStore.test.js`
Expected: FAIL — cannot resolve `../memory/memoryStore.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/memory/memoryStore.js`:

```js
/**
 * DB layer for curated per-client agent memory (F3, §2.9). The extraction logic
 * (what is worth remembering) lives in clientFactsExtractor.js (pure); this module
 * only persists. Learned facts gain confidence on repeat; manual notes are pinned.
 */
import { query } from '../../../db.js';

export async function upsertMemoryFact({
  clientUserId, scope = 'client', fact_type, fact_key, fact_value = {},
  confidence = 0.5, source = 'learned'
}) {
  const { rows } = await query(
    `INSERT INTO ops_agent_memory
       (client_user_id, scope, fact_type, fact_key, fact_value, confidence, occurrences, source)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,1,$7)
     ON CONFLICT (client_user_id, scope, fact_type, fact_key)
     DO UPDATE SET occurrences = ops_agent_memory.occurrences + 1,
                   last_seen_at = NOW(),
                   fact_value = EXCLUDED.fact_value,
                   confidence = LEAST(1.0, ops_agent_memory.confidence + 0.1),
                   status = 'active'
     RETURNING *`,
    [clientUserId, scope, fact_type, fact_key, JSON.stringify(fact_value), confidence, source]
  );
  return rows[0];
}

export async function getMemory({ clientUserId, scope, factType, status = 'active' } = {}) {
  const { rows } = await query(
    `SELECT * FROM ops_agent_memory
      WHERE client_user_id = $1
        AND ($2::text IS NULL OR status = $2)
        AND ($3::text IS NULL OR scope = $3)
        AND ($4::text IS NULL OR fact_type = $4)
      ORDER BY confidence DESC, last_seen_at DESC`,
    [clientUserId, status ?? null, scope ?? null, factType ?? null]
  );
  return rows;
}

export async function archiveMemoryFact(id) {
  const { rows } = await query(
    `UPDATE ops_agent_memory SET status = 'archived' WHERE id = $1 RETURNING *`,
    [id]
  );
  return rows[0] || null;
}

export async function recordManualNote({ clientUserId, scope = 'client', text, createdBy = null }) {
  const fact_key = `note:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const { rows } = await query(
    `INSERT INTO ops_agent_memory
       (client_user_id, scope, fact_type, fact_key, fact_value, confidence, occurrences, source, created_by)
     VALUES ($1,$2,'manual_note',$3,$4::jsonb,1.0,1,'manual',$5)
     RETURNING *`,
    [clientUserId, scope, fact_key, JSON.stringify({ text }), createdBy]
  );
  return rows[0];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/f3MemoryStore.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/memory/memoryStore.js server/services/ops/__tests__/f3MemoryStore.test.js
git commit -m "feat(ops/f3): agent memory store (upsert/get/archive/manual note)"
```

---

### Task 9: Client facts extractor (PURE)

**Files:**
- Create: `server/services/ops/memory/clientFactsExtractor.js`
- Test: `server/services/ops/__tests__/f3ClientFactsExtractor.test.js`

**Interfaces:**
- Produces (PURE). A "fact candidate" is `{ scope, fact_type, fact_key, fact_value, confidence, source }`:
  - `FALSE_POSITIVE_MIN_RECURRENCE: number` = `3`; `STABLE_CONFIG_MIN_DAYS: number` = `30`.
  - `factsFromApprovals(approvals): fact[]` — aggregates approved+executed tool invocations into `approved_pattern` facts keyed by `approved:${tool_name}` (one per tool, confidence scaled by count).
  - `factsFromRejections(rejections): fact[]` — `rejected_pattern` keyed by `rejected:${tool_name}`.
  - `factsFromRepeatedFindings(findings): fact[]` — `false_positive` keyed by `false_positive:${category}` when a category recurs `>= FALSE_POSITIVE_MIN_RECURRENCE` times AND every occurrence was resolved/dismissed.
  - `factsFromStableConfigs(configs): fact[]` — `stable_config` keyed by `stable:${key}` when `days_stable >= STABLE_CONFIG_MIN_DAYS`.
  - `factsFromManualNotes(notes): fact[]` — passthrough `manual_note` facts (`source:'manual'`, confidence 1).
  - `extractFacts({ approvals, rejections, findings, configs, notes }): fact[]` — concatenated + deduped by `(scope, fact_type, fact_key)` (max confidence wins on dup).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/f3ClientFactsExtractor.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALSE_POSITIVE_MIN_RECURRENCE,
  STABLE_CONFIG_MIN_DAYS,
  factsFromApprovals,
  factsFromRejections,
  factsFromRepeatedFindings,
  factsFromStableConfigs,
  factsFromManualNotes,
  extractFacts
} from '../memory/clientFactsExtractor.js';

test('constants', () => {
  assert.equal(FALSE_POSITIVE_MIN_RECURRENCE, 3);
  assert.equal(STABLE_CONFIG_MIN_DAYS, 30);
});

test('factsFromApprovals aggregates by tool and scales confidence', () => {
  const facts = factsFromApprovals([
    { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' },
    { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' },
    { tool_name: 'unexecuted', scope: 'paid_ads', approved_at: 't', executed_at: null } // ignored
  ]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].fact_type, 'approved_pattern');
  assert.equal(facts[0].fact_key, 'approved:pause_keyword');
  assert.equal(facts[0].fact_value.count, 2);
  assert.ok(facts[0].confidence > 0.5);
});

test('factsFromRejections emits rejected_pattern', () => {
  const facts = factsFromRejections([{ tool_name: 'raise_budget', scope: 'paid_ads' }]);
  assert.equal(facts[0].fact_type, 'rejected_pattern');
  assert.equal(facts[0].fact_key, 'rejected:raise_budget');
});

test('factsFromRepeatedFindings flags only consistently-dismissed recurring categories', () => {
  const facts = factsFromRepeatedFindings([
    { category: 'gads.spend_spike', occurrences: 4, dismissed_count: 4 }, // false positive
    { category: 'gads.real_issue', occurrences: 5, dismissed_count: 1 },  // genuine, skip
    { category: 'gads.rare', occurrences: 2, dismissed_count: 2 }          // too few, skip
  ]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].fact_key, 'false_positive:gads.spend_spike');
  assert.equal(facts[0].fact_type, 'false_positive');
});

test('factsFromStableConfigs requires the minimum stable days', () => {
  const facts = factsFromStableConfigs([
    { key: 'budget_cents', value: 50000, days_stable: 45, scope: 'paid_ads' },
    { key: 'flaky', value: 1, days_stable: 5, scope: 'paid_ads' }
  ]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].fact_key, 'stable:budget_cents');
});

test('factsFromManualNotes passes through with manual source', () => {
  const facts = factsFromManualNotes([{ text: 'No weekend changes', scope: 'client' }]);
  assert.equal(facts[0].fact_type, 'manual_note');
  assert.equal(facts[0].source, 'manual');
  assert.equal(facts[0].confidence, 1);
});

test('extractFacts merges all sources and dedupes by key keeping max confidence', () => {
  const facts = extractFacts({
    approvals: [
      { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' },
      { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' },
      { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' }
    ],
    findings: [{ category: 'x', occurrences: 3, dismissed_count: 3 }],
    notes: [{ text: 'hi', scope: 'client' }]
  });
  const keys = facts.map((f) => `${f.scope}|${f.fact_type}|${f.fact_key}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
  assert.ok(facts.some((f) => f.fact_key === 'approved:pause_keyword'));
  assert.ok(facts.some((f) => f.fact_key === 'false_positive:x'));
  assert.ok(facts.some((f) => f.fact_type === 'manual_note'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/f3ClientFactsExtractor.test.js`
Expected: FAIL — cannot resolve `../memory/clientFactsExtractor.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/memory/clientFactsExtractor.js`:

```js
/**
 * Extract memory-worthy facts from agent activity (F3, §2.9). PURE — takes plain
 * arrays, returns fact candidates; the orchestrator loads the arrays and persists.
 * Keeping this pure means it is independent of WHERE the rows come from: today the
 * loaders read ops_tool_approvals + ops_findings; when F4's ops_action_recommendations
 * lands, only the loader changes, not this logic.
 *
 * A fact candidate: { scope, fact_type, fact_key, fact_value, confidence, source }.
 */

export const FALSE_POSITIVE_MIN_RECURRENCE = 3;
export const STABLE_CONFIG_MIN_DAYS = 30;

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function factsFromApprovals(approvals = []) {
  const byTool = new Map();
  for (const a of approvals) {
    if (!a.approved_at || !a.executed_at) continue; // only learn from carried-out approvals
    const scope = a.scope || 'client';
    const k = `${scope}|${a.tool_name}`;
    const cur = byTool.get(k) || { scope, tool: a.tool_name, count: 0 };
    cur.count += 1;
    byTool.set(k, cur);
  }
  return [...byTool.values()].map((v) => ({
    scope: v.scope,
    fact_type: 'approved_pattern',
    fact_key: `approved:${v.tool}`,
    fact_value: { tool: v.tool, count: v.count },
    confidence: clamp01(0.5 + 0.1 * v.count),
    source: 'learned'
  }));
}

export function factsFromRejections(rejections = []) {
  const byTool = new Map();
  for (const r of rejections) {
    const scope = r.scope || 'client';
    const k = `${scope}|${r.tool_name}`;
    const cur = byTool.get(k) || { scope, tool: r.tool_name, count: 0 };
    cur.count += 1;
    byTool.set(k, cur);
  }
  return [...byTool.values()].map((v) => ({
    scope: v.scope,
    fact_type: 'rejected_pattern',
    fact_key: `rejected:${v.tool}`,
    fact_value: { tool: v.tool, count: v.count },
    confidence: clamp01(0.5 + 0.1 * v.count),
    source: 'learned'
  }));
}

export function factsFromRepeatedFindings(findings = []) {
  const out = [];
  for (const f of findings) {
    const occurrences = Number(f.occurrences) || 0;
    const dismissed = Number(f.dismissed_count) || 0;
    if (occurrences >= FALSE_POSITIVE_MIN_RECURRENCE && dismissed === occurrences) {
      out.push({
        scope: f.scope || 'client',
        fact_type: 'false_positive',
        fact_key: `false_positive:${f.category}`,
        fact_value: { category: f.category, occurrences, dismissed },
        confidence: clamp01(0.5 + 0.1 * occurrences),
        source: 'learned'
      });
    }
  }
  return out;
}

export function factsFromStableConfigs(configs = []) {
  return configs
    .filter((c) => (Number(c.days_stable) || 0) >= STABLE_CONFIG_MIN_DAYS)
    .map((c) => ({
      scope: c.scope || 'client',
      fact_type: 'stable_config',
      fact_key: `stable:${c.key}`,
      fact_value: { key: c.key, value: c.value, days_stable: c.days_stable },
      confidence: 0.7,
      source: 'learned'
    }));
}

export function factsFromManualNotes(notes = []) {
  return notes.map((n) => ({
    scope: n.scope || 'client',
    fact_type: 'manual_note',
    fact_key: n.fact_key || `note:${n.id ?? n.text}`,
    fact_value: { text: n.text },
    confidence: 1,
    source: 'manual'
  }));
}

export function extractFacts({ approvals = [], rejections = [], findings = [], configs = [], notes = [] } = {}) {
  const all = [
    ...factsFromApprovals(approvals),
    ...factsFromRejections(rejections),
    ...factsFromRepeatedFindings(findings),
    ...factsFromStableConfigs(configs),
    ...factsFromManualNotes(notes)
  ];
  const byKey = new Map();
  for (const f of all) {
    const k = `${f.scope}|${f.fact_type}|${f.fact_key}`;
    const existing = byKey.get(k);
    if (!existing || f.confidence > existing.confidence) byKey.set(k, f);
  }
  return [...byKey.values()];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/f3ClientFactsExtractor.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/memory/clientFactsExtractor.js server/services/ops/__tests__/f3ClientFactsExtractor.test.js
git commit -m "feat(ops/f3): pure client-facts extractor (learning rules)"
```

---

### Task 10: Memory updater orchestrator (injected deps)

**Files:**
- Create: `server/services/ops/memory/updateMemoryFromRuns.js`
- Test: `server/services/ops/__tests__/f3UpdateMemory.test.js`

**Interfaces:**
- Consumes: `extractFacts` (Task 9), `upsertMemoryFact` (Task 8).
- Produces:
  - `async loadApprovals(clientUserId): Promise<approval[]>` — default loader: approved+executed `ops_tool_approvals` rows joined to `ops_runs` for the client. (Exported so it can be swapped for F4's `ops_action_recommendations` later.)
  - `async loadRepeatedFindings(clientUserId): Promise<finding[]>` — default loader: per-category counts from `ops_findings` (`occurrences`, `dismissed_count = acknowledged or resolved`).
  - `async loadStableConfigs(clientUserId): Promise<config[]>` — default loader returns `[]` (config inventory arrives with F1; documented seam, not a placeholder).
  - `async updateMemoryFromRuns({ clientUserId, notes, deps }): Promise<{ extracted, upserted }>` — loads sources, runs `extractFacts` (pure), upserts each fact (with `clientUserId`). All loaders + `upsertFact` are injectable via `deps`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/f3UpdateMemory.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { updateMemoryFromRuns } from '../memory/updateMemoryFromRuns.js';

test('updateMemoryFromRuns extracts from injected loaders and upserts each fact', async () => {
  const upserts = [];
  const out = await updateMemoryFromRuns({
    clientUserId: 'client-1',
    notes: [{ text: 'No weekend pushes', scope: 'client' }],
    deps: {
      loadApprovals: async () => [
        { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' },
        { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' }
      ],
      loadRepeatedFindings: async () => [{ category: 'gads.spike', occurrences: 3, dismissed_count: 3 }],
      loadStableConfigs: async () => [],
      upsertFact: async (fact) => { upserts.push(fact); return { id: `m-${upserts.length}`, ...fact }; }
    }
  });

  assert.equal(out.extracted, 3); // approved_pattern + false_positive + manual_note
  assert.equal(out.upserted, 3);
  // every upserted fact carries the client id
  assert.ok(upserts.every((f) => f.clientUserId === 'client-1'));
  assert.ok(upserts.some((f) => f.fact_key === 'approved:pause_keyword'));
  assert.ok(upserts.some((f) => f.fact_key === 'false_positive:gads.spike'));
  assert.ok(upserts.some((f) => f.fact_type === 'manual_note'));
});

test('updateMemoryFromRuns with no activity upserts nothing', async () => {
  const out = await updateMemoryFromRuns({
    clientUserId: 'client-1',
    deps: {
      loadApprovals: async () => [],
      loadRepeatedFindings: async () => [],
      loadStableConfigs: async () => [],
      upsertFact: async () => { throw new Error('should not upsert'); }
    }
  });
  assert.equal(out.extracted, 0);
  assert.equal(out.upserted, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test server/services/ops/__tests__/f3UpdateMemory.test.js`
Expected: FAIL — cannot resolve `../memory/updateMemoryFromRuns.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/memory/updateMemoryFromRuns.js`:

```js
/**
 * Memory updater orchestrator (F3, §2.9). Loads the raw activity for a client,
 * delegates the "what's worth remembering" decision to the pure extractor, and
 * persists each fact. Loaders + upsert are injectable so the logic is testable
 * with no DB. Default loaders read tables that already exist (ops_tool_approvals,
 * ops_findings); the stable-config loader is a documented seam for F1.
 */
import { query } from '../../../db.js';
import { extractFacts } from './clientFactsExtractor.js';
import { upsertMemoryFact } from './memoryStore.js';

export async function loadApprovals(clientUserId) {
  const { rows } = await query(
    `SELECT a.tool_name, a.approved_at, a.executed_at, a.args_json
       FROM ops_tool_approvals a
       JOIN ops_runs r ON r.id = a.run_id
      WHERE r.client_user_id = $1
        AND a.approved_at IS NOT NULL
        AND a.executed_at IS NOT NULL`,
    [clientUserId]
  );
  // scope is best-effort from args_json.umbrella/service when present.
  return rows.map((r) => ({
    tool_name: r.tool_name,
    approved_at: r.approved_at,
    executed_at: r.executed_at,
    scope: r.args_json?.service || r.args_json?.umbrella || 'client'
  }));
}

export async function loadRepeatedFindings(clientUserId) {
  const { rows } = await query(
    `SELECT category,
            COUNT(*)::int AS occurrences,
            COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL OR resolved_at IS NOT NULL)::int AS dismissed_count
       FROM ops_findings
      WHERE client_user_id = $1
      GROUP BY category`,
    [clientUserId]
  );
  return rows.map((r) => ({
    category: r.category,
    occurrences: r.occurrences,
    dismissed_count: r.dismissed_count,
    scope: 'client'
  }));
}

// Config inventory arrives with F1 (ops_service_connections / ops_platform_inventory).
// Until then this returns nothing; the seam keeps the orchestrator stable.
export async function loadStableConfigs(_clientUserId) {
  return [];
}

export async function updateMemoryFromRuns({ clientUserId, notes = [], deps = {} }) {
  const {
    loadApprovals: loadApprovalsDep = loadApprovals,
    loadRepeatedFindings: loadFindingsDep = loadRepeatedFindings,
    loadStableConfigs: loadConfigsDep = loadStableConfigs,
    upsertFact = upsertMemoryFact
  } = deps;

  const [approvals, findings, configs] = await Promise.all([
    loadApprovalsDep(clientUserId),
    loadFindingsDep(clientUserId),
    loadConfigsDep(clientUserId)
  ]);

  const facts = extractFacts({ approvals, findings, configs, notes });

  let upserted = 0;
  for (const fact of facts) {
    await upsertFact({ clientUserId, ...fact });
    upserted += 1;
  }
  return { extracted: facts.length, upserted };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test server/services/ops/__tests__/f3UpdateMemory.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full ops suite for regressions**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops`
Expected: all prior ops tests PASS plus the nine new `f3*` test files PASS.

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/memory/updateMemoryFromRuns.js server/services/ops/__tests__/f3UpdateMemory.test.js
git commit -m "feat(ops/f3): memory updater orchestrator (load → extract → upsert)"
```

---

## Self-Review

**1. Spec coverage (F3 deliverables):**
- Deliverable 1 — migrations + registration for `ops_daily_snapshots` (§2.4), `ops_metric_baselines` (§2.5), `ops_agent_memory` (§2.9) → **Task 1.** ✅
- Deliverable 2 — baseline engine under `baselines/`: `computeBaselines` (Tasks 3+5), `baselineStore` (Task 4), `compareMetric` (Task 6), `anomalyScorer` (Task 7). All six periods (`7_day`, `30_day`, `weekday_4_week`, `previous_month`, `trailing_90_day`, `month_to_date`) in `ALL_PERIODS` + stddev gated by `MIN_STDDEV_SAMPLES` "when enough samples." ✅
- Deliverable 3 — memory updater under `memory/`: `memoryStore` (Task 8), `updateMemoryFromRuns` (Task 10), `clientFactsExtractor` (Task 9). Learns from approved (`factsFromApprovals`) / rejected (`factsFromRejections`) recommendations, repeated false positives (`factsFromRepeatedFindings`), stable configs (`factsFromStableConfigs`), manual notes (`factsFromManualNotes`). ✅
- Deliverable 4 — normalized metric names (the exact 13: `cost_cents, impressions, clicks, conversions, conversion_value_cents, sessions, users, leads, calls, forms, ctr, cvr, cpa_cents`) with provider extras routed to `metrics_json` via `normalizeMetrics` → **Task 2.** ✅

**2. Global-constraint coverage:**
- Credentials env-var/Postgres — phase touches none; no Secret Manager introduced. ✅
- LLM does no metric math / invents no metrics — all baseline/compare/anomaly/derive logic is deterministic pure code; missing metrics stay `null` (`compareMetric` returns `comparable:false`; `deriveMetrics` never fabricates bases). ✅
- PHI never persisted — `ops_daily_snapshots.metrics_json` is a numeric map; `normalizeMetrics` drops non-numeric normalized values. ✅
- Migration pattern + registration — Task 1 Steps 1–2. ✅
- DB tests use `DATABASE_URL` + `node:test`/`assert/strict`; pure math has zero-DB tests (Tasks 2,3,6,7,9); only `*Store` + orchestrators touch DB (Tasks 4,8) and isolate via `randomUUID()`. ✅
- No new npm deps — only `node:test`, `node:crypto`, `pg` via `server/db.js`. ✅

**3. Dependency-note compliance:** Engines consume `ops_daily_snapshots` rows directly (Task 4 `loadSnapshotSeries`); no code is written against unbuilt F1/F2 connector files. `normalizeMetrics` is provided for future `collectSnapshot` use but no connector is fabricated. The memory loaders read existing tables (`ops_tool_approvals`, `ops_findings`) with the F4 swap documented as a seam. ✅

**4. Placeholder scan:** No TBD/TODO. `loadStableConfigs` returning `[]` is an explicit injected seam with documented rationale (config inventory lands in F1), exercised by a passing test, not a placeholder. ✅

**5. Type consistency:** Fact shape `{ scope, fact_type, fact_key, fact_value, confidence, source }` is identical across `clientFactsExtractor` (produces), `updateMemoryFromRuns` (spreads with `clientUserId`), and `memoryStore.upsertMemoryFact` (consumes those exact keys). Baseline row shape `{ period, baseline_value, stddev, sample_count, window_start, window_end }` is identical across `computeBaselinesForSeries` (produces), `computeAndPersistBaselines` (spreads), and `baselineStore.upsertBaseline` (consumes). `compareMetric` output keys (`comparable, z_score, pct_change, direction, observed, baseline_value`) match exactly what `anomalyScorer.scoreAnomaly` reads. Period vocabulary matches the migration `CHECK`-free `period` column comment and `ALL_PERIODS`. ✅
