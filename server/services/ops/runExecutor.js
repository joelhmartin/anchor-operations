/**
 * Run executor — Phase 1 skeleton.
 *
 * Loads a queued ops_run, walks its definition.check_set, dispatches each
 * registered handler (with bounded timeout), persists per-check results, and
 * marks the run completed/partial/failed/budget_exceeded.
 *
 * Phase 6 will fill in finding correlation and report rendering — both are
 * lazy-imported here so the executor stays self-contained until then.
 */

import { query } from '../../db.js';
import { getCheck } from './checks/registry.js';
import { getCredential } from './credentialStore.js';
import { createCostTracker } from './costTracker.js';
import { sanitize as sanitizePayload } from './payloadSanitizer.js';
import { recomputeForFinding } from './attentionScore.js';
import { runSkill } from './skills/executor.js';
import { createSuggestion } from './skills/store.js';

// Side-effect imports: ensure all umbrella check registrations execute before
// any run dispatch happens. New umbrellas (Phase 4 google_ads, Phase 5 meta)
// add their lines here.
import './checks/website/index.js';
import './checks/google_ads/index.js';
import './checks/meta/index.js';
import './checks/ctm/index.js';

const DEFAULT_CHECK_TIMEOUT_MS = 60_000;

const TIER_BUDGET_CENTS = {
  daily_essential: 50,
  weekly_deep: 200,
  monthly_audit: 500,
  on_demand: 250
};

function tierBudget(tier) {
  return TIER_BUDGET_CENTS[tier] ?? 250;
}

/**
 * Build a per-check AbortController whose signal aborts on EITHER:
 *   (a) the per-check timeout firing after `timeoutMs`, or
 *   (b) the run-level (parent) signal aborting (user cancel / SIGTERM drain).
 *
 * The returned signal is threaded into `ctx.signal` so handlers (and the
 * `safeHttpFetch` helper they call) can stop in-flight HTTP / token-burning
 * work the moment the deadline trips, instead of leaking sockets and Vertex
 * spend past it. Legacy handlers that ignore the signal degrade to the old
 * behavior — their result is still ignored once the executor moves on.
 *
 * Caller must invoke `dispose()` after the check settles so the timer and
 * the parent-signal listener don't pin the controller.
 */
function createCheckAbort(timeoutMs, label, parentSignal) {
  const controller = new AbortController();

  if (parentSignal?.aborted) {
    controller.abort(parentSignal.reason ?? new Error('run cancelled'));
    return { signal: controller.signal, dispose: () => {} };
  }

  const timer = setTimeout(() => {
    controller.abort(new Error(`check timeout after ${timeoutMs}ms: ${label}`));
  }, timeoutMs);

  const onParentAbort = () => {
    controller.abort(parentSignal.reason ?? new Error('run cancelled'));
  };
  parentSignal?.addEventListener?.('abort', onParentAbort, { once: true });

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener?.('abort', onParentAbort);
    }
  };
}

/**
 * Race a handler promise against an AbortSignal. Resolves with the handler's
 * value if it finishes first; rejects with the signal's abort reason (or a
 * generic abort error) when the signal fires first.
 *
 * Note: this CANNOT cancel an awaited promise on its own. Cancellation of the
 * underlying work happens via the AbortSignal that was threaded into
 * `ctx.signal` (and from there into `safeHttpFetch`); the race only releases
 * the executor so the next check can start.
 */
function raceAgainstAbort(promise, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;

    const reject_ = (reason) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      reject(reason);
    };
    const resolve_ = (value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      resolve(value);
    };
    const onAbort = () => {
      const reason = signal.reason;
      reject_(reason instanceof Error ? reason : new Error('aborted'));
    };

    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve_, reject_);
  });
}

async function persistCheckResult(runId, clientUserId, umbrella, checkId, outcome) {
  const status = outcome?.status || 'error';
  const severity = outcome?.severity || null;
  const rawPayload = outcome?.payload || {};
  // PHI defense in depth — strip emails / SSNs / phones / DOBs from string
  // values before persisting. See `payloadSanitizer.js`.
  const payload = sanitizePayload(rawPayload);
  const durationMs = outcome?.duration_ms ?? null;
  const costCents = outcome?.cost_cents ?? 0;

  const { rows } = await query(
    `
    INSERT INTO ops_check_results
      (run_id, client_user_id, umbrella, check_id, status, severity, payload_json, duration_ms, cost_cents)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    RETURNING id
    `,
    [runId, clientUserId || null, umbrella, checkId, status, severity, payload, durationMs, costCents]
  );
  return rows[0]?.id || null;
}

async function persistBudgetExceededFinding(runId, clientUserId, totalCents, budget) {
  const { rows } = await query(
    `
    INSERT INTO ops_findings
      (run_id, client_user_id, severity, category, summary, evidence_json)
    VALUES ($1, $2, 'warning', 'ops.budget_exceeded', $3, $4)
    RETURNING id
    `,
    [
      runId,
      clientUserId,
      `Run halted after exceeding tier budget (${totalCents}¢ > ${budget}¢)`,
      { total_cents: totalCents, budget_cents: budget }
    ]
  );
  const findingId = rows[0]?.id;
  if (findingId) {
    try {
      await recomputeForFinding(findingId);
    } catch (err) {
      console.warn(`[ops/runExecutor] attention-score recompute failed for ${findingId}: ${err?.message || err}`);
    }
  }
}

/**
 * Resolve credentials for the umbrellas this run touches. Returns a map keyed
 * by platform → credential record (or null if unconfigured). Phase 1 keeps
 * this naive — Phase 4/5 specialists will wrap this with platform-specific
 * resolution.
 */
async function resolveCredentialsForUmbrellas(clientUserId, umbrellas) {
  const platforms = new Set();
  for (const umb of umbrellas || []) {
    if (umb === 'website') {
      platforms.add('kinsta_site');
      platforms.add('gsc');
    } else if (umb === 'google_ads') {
      platforms.add('google_ads');
    } else if (umb === 'meta') {
      platforms.add('meta');
    }
  }

  const out = {};
  for (const platform of platforms) {
    try {
      out[platform] = await getCredential(clientUserId, platform);
    } catch (err) {
      console.warn(`[ops/executor] credential resolve failed for ${platform}: ${err.message}`);
      out[platform] = null;
    }
  }
  return out;
}

async function loadRunWithDefinition(runId) {
  const { rows } = await query(
    `
    SELECT r.*, d.check_set AS definition_check_set,
           d.umbrellas    AS definition_umbrellas,
           d.name         AS definition_name
      FROM ops_runs r
      LEFT JOIN ops_run_definitions d ON d.id = r.run_definition_id
     WHERE r.id = $1
    `,
    [runId]
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Bulk-run rollup
// ---------------------------------------------------------------------------

/**
 * After a child ops_run reaches a terminal state (complete or failed), roll up
 * aggregate stats into the parent ops_bulk_runs row.
 *
 * - findings_count: COUNT of ops_findings rows tied to any child run.
 * - cost_cents: SUM of cost_estimate_cents across all child runs.
 * - status:
 *     'running'  — at least one child still in flight (not complete/failed/cancelled).
 *     'partial'  — all children terminal but at least one failed.
 *     'complete' — all children terminal and none failed.
 * - completed_at: set (once) when all children are terminal.
 *
 * Safe to call with null — exits immediately.
 * HIPAA: pure aggregate math, no PHI accessed.
 */
async function rollupBulkRun(bulkRunId) {
  if (!bulkRunId) return;
  await query(
    `
    UPDATE ops_bulk_runs b
       SET findings_count = COALESCE((
             SELECT COUNT(*)::int
               FROM ops_findings f
               JOIN ops_runs r ON r.id = f.run_id
              WHERE r.bulk_run_id = b.id
           ), 0),
           cost_cents = COALESCE((
             SELECT SUM(cost_estimate_cents)::int
               FROM ops_runs r
              WHERE r.bulk_run_id = b.id
           ), 0),
           status = CASE
             WHEN EXISTS (
               SELECT 1 FROM ops_runs r
                WHERE r.bulk_run_id = b.id
                  AND r.status NOT IN ('complete','completed','failed','cancelled')
             ) THEN 'running'
             WHEN EXISTS (
               SELECT 1 FROM ops_runs r
                WHERE r.bulk_run_id = b.id
                  AND r.status = 'failed'
             ) THEN 'partial'
             ELSE 'complete'
           END,
           completed_at = CASE
             WHEN NOT EXISTS (
               SELECT 1 FROM ops_runs r
                WHERE r.bulk_run_id = b.id
                  AND r.status NOT IN ('complete','completed','failed','cancelled')
             ) THEN COALESCE(b.completed_at, now())
             ELSE b.completed_at
           END
     WHERE b.id = $1
    `,
    [bulkRunId]
  );
}

// Exported for tests only — do not call from application code outside this module.
export { rollupBulkRun as _rollupBulkRunForTests };

// ---------------------------------------------------------------------------
// Skill-based execution path
// ---------------------------------------------------------------------------

/**
 * Persist findings produced by a skill run into ops_findings.
 * Each finding from the agent output maps to one row.
 * HIPAA: we trust that skill collectors and the agent have not surfaced PHI.
 * We do NOT include raw error stacks — only the agent-produced detail string.
 */
async function persistSkillFindings(runId, clientUserId, findings) {
  const ids = [];
  for (const f of findings || []) {
    const severity = f.severity || (f.status === 'fail' ? 'critical' : f.status === 'warn' ? 'warning' : 'info');
    const category = `skill.${f.check_id || 'unknown'}`;
    const summary = typeof f.detail === 'string' ? f.detail : (typeof f.summary === 'string' ? f.summary : String(f.status || 'unknown'));
    const evidence = { status: f.status, check_id: f.check_id };

    const { rows } = await query(
      `INSERT INTO ops_findings (run_id, client_user_id, severity, category, summary, evidence_json)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [runId, clientUserId || null, severity, category, summary, evidence]
    );
    const findingId = rows[0]?.id;
    if (findingId) {
      ids.push(findingId);
      try {
        await recomputeForFinding(findingId);
      } catch (err) {
        console.warn(`[ops/runExecutor] attention-score recompute failed for ${findingId}: ${err?.message || err}`);
      }
    }
  }
  return ids;
}

/**
 * Persist a single critical ops_findings row for a skill run failure.
 * Error message must not contain PHI — err.message is from our own code or
 * the Vertex SDK, not from user data.
 */
async function persistSkillErrorFinding(runId, clientUserId, errMessage) {
  try {
    await query(
      `INSERT INTO ops_findings (run_id, client_user_id, severity, category, summary, evidence_json)
       VALUES ($1, $2, 'critical', 'skill.execution_error', $3, $4)`,
      [runId, clientUserId || null, 'Skill run failed: ' + (errMessage || 'unknown error'), {}]
    );
  } catch (persistErr) {
    console.error(`[ops/runExecutor] failed to persist skill error finding: ${persistErr?.message || persistErr}`);
  }
}

/**
 * Persist skill improvement suggestions from the agent into ops_skill_suggestions.
 */
async function persistSkillSuggestions(skillId, runId, suggestions) {
  for (const s of suggestions || []) {
    try {
      await createSuggestion({
        skillId,
        runId,
        proposedSlug: s.proposedSlug || null,
        proposedUmbrella: s.proposedUmbrella || null,
        proposedTitle: s.proposedTitle || null,
        proposedPromptMd: s.proposedPromptMd || '',
        proposedCollectors: Array.isArray(s.proposedCollectors) ? s.proposedCollectors : [],
        rationale: s.rationale || ''
      });
    } catch (err) {
      console.warn(`[ops/runExecutor] failed to persist skill suggestion: ${err?.message || err}`);
    }
  }
}

/**
 * Skill-based execution path. Called when a run has skill_id set.
 * Marks the run running, calls runSkill, persists findings + suggestions,
 * updates the run to completed/failed.
 */
async function executeSkillRun(run) {
  // Atomic compare-and-set: only the delivery that wins the transition from
  // 'queued' → 'running' proceeds. Pub/Sub is at-least-once and the prod
  // fallback can also re-enter the in-memory worker, so without this guard a
  // redelivery would re-run every check and double-write findings + cost.
  const claim = await query(
    `UPDATE ops_runs
        SET status = 'running', started_at = COALESCE(started_at, now())
      WHERE id = $1 AND status = 'queued'
      RETURNING id`,
    [run.id]
  );
  if (claim.rowCount === 0) {
    console.warn(`[ops/executor] skill run ${run.id} not claimed (already running or terminal); skipping`);
    return;
  }

  const startedAt = new Date();

  try {
    const out = await runSkill({
      skillId: run.skill_id,
      runId: run.id,
      clientUserId: run.client_user_id,
      umbrellaContext: {}
    });

    await persistSkillFindings(run.id, run.client_user_id, out.findings);
    await persistSkillSuggestions(run.skill_id, run.id, out.suggestions);

    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    // Preserve a mid-flight cancel: POST /runs/:id/cancel sets status to
    // 'cancelled' WHERE status IN ('queued','running'); without the CASE
    // guard the terminal UPDATE here would clobber it back to 'completed'.
    // finished_at uses COALESCE so the cancel's timestamp wins when present.
    await query(
      `UPDATE ops_runs
          SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'completed' END,
              finished_at = COALESCE(finished_at, $2),
              duration_ms = COALESCE(duration_ms, $3),
              cost_estimate_cents = $4,
              skill_version_number = $5
        WHERE id = $1`,
      [run.id, finishedAt, durationMs, out.cost_cents || 0, out.skillVersion || null]
    );

    // Roll up cost + findings into parent bulk run (no-op if not a bulk child).
    await rollupBulkRun(run.bulk_run_id);
  } catch (err) {
    const finishedAt = new Date();
    const durationMs = finishedAt.getTime() - startedAt.getTime();

    // Same cancel-preserving guard as the success path.
    await query(
      `UPDATE ops_runs
          SET status = CASE WHEN status = 'cancelled' THEN status ELSE 'failed' END,
              finished_at = COALESCE(finished_at, $2),
              duration_ms = COALESCE(duration_ms, $3)
        WHERE id = $1`,
      [run.id, finishedAt, durationMs]
    );

    // Persist a critical finding — do NOT include the stack trace to avoid
    // accidentally surfacing PHI from nested error context.
    await persistSkillErrorFinding(run.id, run.client_user_id, err?.message);

    // Roll up cost + findings into parent bulk run before re-throwing.
    await rollupBulkRun(run.bulk_run_id);

    throw err;
  }
}

// ---------------------------------------------------------------------------
// Legacy tier-based execution path
// ---------------------------------------------------------------------------

/**
 * Execute a single run end-to-end. Returns the final run row.
 *
 * The function intentionally does NOT throw on per-check failures — those are
 * captured as ops_check_results with status='error'. It only throws if the run
 * itself can't be loaded or persisted (the caller treats that as a hard fail).
 */
export async function executeRun(runId, options = {}) {
  if (!runId) throw new Error('executeRun: runId required');
  const signal = options.signal;

  const run = await loadRunWithDefinition(runId);
  if (!run) throw new Error(`executeRun: run ${runId} not found`);

  // Dispatch to skill-based path when this run is backed by a skill.
  // executeSkillRun performs its own atomic queued→running claim, so a
  // redelivered message safely no-ops if another worker already claimed it.
  if (run.skill_id) {
    await executeSkillRun(run);
    return loadRunWithDefinition(runId);
  }

  // Atomic compare-and-set: only the delivery that wins the transition from
  // 'queued' → 'running' proceeds. Pub/Sub is at-least-once and the prod
  // fallback can also re-enter the in-memory worker, so without this guard a
  // redelivery would re-run every check and double-write check_results +
  // findings + cost.
  const startedAt = new Date();
  const claim = await query(
    `UPDATE ops_runs
        SET status = 'running', started_at = $2
      WHERE id = $1 AND status = 'queued'
      RETURNING id`,
    [runId, startedAt]
  );
  if (claim.rowCount === 0) {
    console.warn(`[ops/executor] run ${runId} not claimed (already running or terminal); skipping`);
    return loadRunWithDefinition(runId);
  }

  const checkSet = Array.isArray(run.definition_check_set) ? run.definition_check_set : [];
  const umbrellas = Array.isArray(run.definition_umbrellas) ? run.definition_umbrellas : [];
  const budget = tierBudget(run.tier);

  const credentials = await resolveCredentialsForUmbrellas(run.client_user_id, umbrellas);

  const tokenUsage = { prompt_tokens: 0, completion_tokens: 0, cost_cents: 0, by_check: {} };
  const runCostTracker = createCostTracker();
  // Accumulate run cost in fractional dollars and Math.ceil ONCE when deriving
  // cents. Summing per-check ceiled cents inflates the total: N sub-cent checks
  // each round up to 1¢ individually, which over-reports cost_estimate_cents
  // (used by budget math + monthly spend rollups) and trips the tier-budget
  // guard prematurely with a spurious ops.budget_exceeded finding. Per-check
  // outcome.cost_cents stays ceiled — that's the display value persisted to
  // ops_check_results.cost_cents and surfaced in tokenUsage.by_check.
  let totalCostDollars = 0;
  let totalCostCents = 0;
  let hadError = false;
  let stopped = false;
  let stoppedReason = null;
  const checkResultIds = [];

  for (const entry of checkSet) {
    if (stopped) break;
    if (signal?.aborted) {
      stopped = true;
      stoppedReason = 'cancelled';
      break;
    }
    if (!entry || entry.enabled === false) continue;

    const def = getCheck(entry.check_id);
    if (!def) {
      console.warn(`[ops/executor] unknown check_id in run ${runId}: ${entry.check_id}`);
      const id = await persistCheckResult(runId, run.client_user_id, 'unknown', entry.check_id, {
        status: 'error',
        severity: 'warning',
        payload: { error: 'check_id not registered' }
      });
      if (id) checkResultIds.push(id);
      hadError = true;
      continue;
    }

    // Per-check abort: the signal in ctx is now combined (timeout + run cancel)
    // rather than the bare run-level signal. Handlers (and safeHttpFetch) that
    // honor it stop their in-flight work the moment the deadline trips.
    const timeoutMs = entry.config?.timeoutMs || DEFAULT_CHECK_TIMEOUT_MS;
    const checkAbort = createCheckAbort(timeoutMs, entry.check_id, signal);

    const ctx = {
      runId,
      clientUserId: run.client_user_id,
      config: entry.config || {},
      credentials,
      tier: run.tier,
      signal: checkAbort.signal
    };

    const startedTs = Date.now();
    const checkTracker = createCostTracker();
    let outcome;
    // Captured separately from outcome.cost_cents (which is ceiled per-check
    // for display). When the handler returns a cost_cents value directly, it
    // is authoritative for the run-level dollar accumulator below.
    let rawCostCents = null;
    try {
      const raw = await raceAgainstAbort(
        Promise.resolve().then(() => def.handler(ctx, checkTracker)),
        checkAbort.signal
      );
      if (raw?.cost_cents != null) rawCostCents = Number(raw.cost_cents) || 0;
      outcome = {
        status: raw?.status || 'pass',
        severity: raw?.severity || null,
        payload: raw?.payload || {},
        cost_cents: raw?.cost_cents ?? checkTracker.totalCents() ?? def.costEstimate ?? 0
      };
    } catch (err) {
      hadError = true;
      // Reconcile cost from the partial tracker on the failure / timeout path:
      // tracker entries accrued before the abort are real spend that should
      // still count against the run total. checkTracker.totalCents() is a
      // ceil of whatever fractional dollars made it in; def.costEstimate is
      // the existing nominal-budget fallback when the tracker is empty.
      outcome = {
        status: 'error',
        severity: 'warning',
        payload: { error: err.message },
        cost_cents: checkTracker.totalCents() || def.costEstimate || 0
      };
    } finally {
      // Always release the timeout + parent-signal listener; without this the
      // pending setTimeout would keep the controller alive until it fires.
      checkAbort.dispose();
    }
    outcome.duration_ms = Date.now() - startedTs;

    // Roll the per-check tracker entries into the run-level tracker so the
    // run summary captures every accrual (tokens + dollars + source).
    const checkSummary = checkTracker.summary();
    for (const entry2 of checkSummary.entries) {
      runCostTracker.add({
        dollars: entry2.dollars,
        tokens: entry2.tokens,
        promptTokens: entry2.prompt_tokens,
        completionTokens: entry2.completion_tokens,
        source: entry2.source
      });
    }

    // Run-level cost: contribute fractional dollars (not ceiled cents) so the
    // run total is ceiled once at the end of the iteration. Precedence mirrors
    // outcome.cost_cents above: handler-provided cost_cents > tracker accruals
    // > the value persisted to ops_check_results.cost_cents. Reading back
    // outcome.cost_cents in the final branch keeps the run total consistent
    // with what was stored per check: skipped/no-work paths leave
    // outcome.cost_cents at 0 (checkTracker.totalCents() short-circuits the
    // ?? chain), while the failure branch encodes the def.costEstimate
    // fallback via ||. Charging def.costEstimate unconditionally would inflate
    // the run total for skipped checks even though their persisted cost is 0.
    let checkDollars;
    if (rawCostCents != null) {
      checkDollars = rawCostCents / 100;
    } else if (checkSummary.total_dollars > 0) {
      checkDollars = checkSummary.total_dollars;
    } else {
      checkDollars = (Number(outcome.cost_cents) || 0) / 100;
    }
    totalCostDollars += checkDollars;
    totalCostCents = Math.ceil(totalCostDollars * 100);

    const cost = outcome.cost_cents || 0;
    tokenUsage.cost_cents = totalCostCents;
    tokenUsage.prompt_tokens = runCostTracker.summary().prompt_tokens;
    tokenUsage.completion_tokens = runCostTracker.summary().completion_tokens;
    tokenUsage.by_check[entry.check_id] = {
      cost_cents: cost,
      duration_ms: outcome.duration_ms,
      status: outcome.status,
      tokens: checkSummary.total_tokens,
      prompt_tokens: checkSummary.prompt_tokens,
      completion_tokens: checkSummary.completion_tokens,
      sources: checkSummary.entries.map((e) => e.source)
    };

    const resultId = await persistCheckResult(runId, run.client_user_id, def.umbrella, entry.check_id, outcome);
    if (resultId) checkResultIds.push(resultId);

    if (totalCostCents > budget) {
      stopped = true;
      stoppedReason = 'budget_exceeded';
      await persistBudgetExceededFinding(runId, run.client_user_id, totalCostCents, budget);
      break;
    }
  }

  // Phase 6 hooks — lazy-imported so future swaps don't ripple here.
  try {
    const correlator = await import('./correlator.js').catch(() => null);
    if (correlator?.correlateRun) await correlator.correlateRun(runId, { checkResultIds });
  } catch (err) {
    console.warn(`[ops/executor] correlator skipped: ${err.message}`);
  }

  try {
    const reporter = await import('./reportRenderer.js').catch(() => null);
    if (reporter?.render) await reporter.render(runId);
    else if (reporter?.renderReport) await reporter.renderReport(runId);
  } catch (err) {
    console.warn(`[ops/executor] report renderer skipped: ${err.message}`);
  }

  try {
    const digest = await import('./emailDigest.js').catch(() => null);
    if (digest?.sendRunSummary) await digest.sendRunSummary(runId);
  } catch (err) {
    console.warn(`[ops/executor] email digest skipped: ${err.message}`);
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();

  let finalStatus;
  if (stoppedReason === 'budget_exceeded') finalStatus = 'budget_exceeded';
  else if (stoppedReason === 'cancelled') finalStatus = 'cancelled';
  else if (hadError && checkSet.length > 0) finalStatus = 'partial';
  else if (checkSet.length === 0) finalStatus = 'completed';
  else finalStatus = 'completed';

  // Preserve a mid-flight cancel: POST /runs/:id/cancel sets status to
  // 'cancelled' WHERE status IN ('queued','running'); without the CASE guard
  // the terminal UPDATE would clobber it back to 'completed'/'partial'/etc.
  // finished_at uses COALESCE so the cancel's timestamp wins when present.
  await query(
    `
    UPDATE ops_runs
       SET status = CASE WHEN status = 'cancelled' THEN status ELSE $2 END,
           finished_at = COALESCE(finished_at, $3),
           duration_ms = COALESCE(duration_ms, $4),
           token_usage_json = $5,
           cost_estimate_cents = $6
     WHERE id = $1
    `,
    [runId, finalStatus, finishedAt, durationMs, tokenUsage, totalCostCents]
  );

  // NOTE: bulk-run rollup is only applied to skill runs today (via executeSkillRun).
  // Legacy tier-based runs are not produced by bulk schedules, but if they ever
  // gain bulk_run_id support, wire rollupBulkRun(run.bulk_run_id) here.

  const refreshed = await loadRunWithDefinition(runId);
  return refreshed;
}
