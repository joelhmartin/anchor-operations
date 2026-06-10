/**
 * Cross-platform correlator — Phase 6.
 *
 * Loads all `ops_check_results` for a run, evaluates the rules array, and
 * writes one `ops_findings` row per matched rule with `linked_check_result_ids`
 * populated.
 *
 * Idempotent: clears prior `ops_findings` rows for this run whose category
 * starts with `correlation.` before inserting fresh rows. This keeps retries
 * (e.g. after a transient executor failure) from duplicating findings.
 *
 * Exposes both `correlateRun(runId)` (the executor's lazy hook contract from
 * Phase 1) and the friendlier alias `run(runId)`.
 */

import { query } from '../../db.js';
import RULES from './correlatorRules.js';
import { recomputeForFinding } from './attentionScore.js';

async function loadRunChecks(runId) {
  const { rows } = await query(
    `
    SELECT id, run_id, umbrella, check_id, status, severity, payload_json, duration_ms, cost_cents, created_at
      FROM ops_check_results
     WHERE run_id = $1
    `,
    [runId]
  );
  return rows;
}

async function loadRun(runId) {
  const { rows } = await query(
    `SELECT id, client_user_id FROM ops_runs WHERE id = $1`,
    [runId]
  );
  return rows[0] || null;
}

async function clearPriorCorrelationFindings(runId) {
  await query(
    `DELETE FROM ops_findings WHERE run_id = $1 AND category LIKE 'correlation.%'`,
    [runId]
  );
}

async function persistFinding(runId, clientUserId, finding) {
  const { rows } = await query(
    `
    INSERT INTO ops_findings
      (run_id, client_user_id, severity, category, summary, evidence_json, linked_check_result_ids)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    RETURNING id
    `,
    [
      runId,
      clientUserId,
      finding.severity,
      finding.category,
      finding.summary,
      finding.evidence,
      finding.linkedCheckResultIds
    ]
  );
  return rows[0]?.id || null;
}

/**
 * Pure evaluator (exported for tests). Given a run row + checks array, returns
 * an array of finding bodies (NOT yet persisted). No DB I/O.
 */
export function evaluateRules({ checks, rules = RULES }) {
  const findings = [];
  for (const rule of rules) {
    let matched = false;
    try {
      matched = Boolean(rule.when({ checks }));
    } catch (err) {
      console.warn(`[ops/correlator] rule ${rule.name} when() threw: ${err.message}`);
      matched = false;
    }
    if (!matched) continue;

    let summary = rule.name;
    let evidence = {};
    let linkedCheckResultIds = [];
    try {
      summary = rule.summary({ checks });
    } catch (err) {
      console.warn(`[ops/correlator] rule ${rule.name} summary() threw: ${err.message}`);
    }
    try {
      evidence = rule.evidence({ checks }) || {};
    } catch (err) {
      console.warn(`[ops/correlator] rule ${rule.name} evidence() threw: ${err.message}`);
    }
    try {
      linkedCheckResultIds = (rule.linkedCheckResultIds({ checks }) || []).filter(Boolean);
    } catch (err) {
      console.warn(`[ops/correlator] rule ${rule.name} linkedCheckResultIds() threw: ${err.message}`);
    }

    findings.push({
      name: rule.name,
      category: rule.category,
      severity: rule.severity,
      summary,
      evidence,
      linkedCheckResultIds
    });
  }
  return findings;
}

/**
 * Run the correlator end-to-end for a given run id.
 *
 * Returns `{ runId, evaluated, persisted }` so callers / tests can introspect.
 */
export async function correlateRun(runId) {
  if (!runId) throw new Error('correlateRun: runId required');
  const run = await loadRun(runId);
  if (!run) {
    console.warn(`[ops/correlator] run ${runId} not found; skipping`);
    return { runId, evaluated: 0, persisted: 0 };
  }
  const checks = await loadRunChecks(runId);
  const findings = evaluateRules({ checks });
  await clearPriorCorrelationFindings(runId);
  for (const f of findings) {
    try {
      const findingId = await persistFinding(runId, run.client_user_id, f);
      if (findingId) {
        try {
          await recomputeForFinding(findingId);
        } catch (err) {
          console.warn(`[ops/correlator] attention-score recompute failed for ${findingId}: ${err.message}`);
        }
      }
    } catch (err) {
      console.warn(`[ops/correlator] persist failed for ${f.name}: ${err.message}`);
    }
  }
  return { runId, evaluated: checks.length, persisted: findings.length };
}

// Friendly alias used by the spec ("correlator.run(runId)").
export const run = correlateRun;

export default { correlateRun, run, evaluateRules };
