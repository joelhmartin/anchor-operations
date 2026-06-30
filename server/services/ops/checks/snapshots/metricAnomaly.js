/**
 * snapshot.metric_anomaly (V5) — the anomaly CHECK that closes the
 * snapshot → baseline → anomaly chain.
 *
 * For a client it loads the latest observed snapshot per (service, scope), and
 * for every numeric metric with a stored baseline it runs the deterministic
 * compareMetric → scoreAnomaly engine across all baseline periods. The worst
 * anomaly drives the check outcome: a metric deviating into 'warning' or
 * 'critical' returns status='fail' + that severity, which the correlator then
 * turns into an ops_findings row (see correlatorRules.js
 * `snapshot_metric_anomaly`).
 *
 * The math is PURE and lives in baselines/*; this handler only wires DB reads
 * into it. The core `evaluateAnomaliesForClient` is dependency-injected so it
 * unit-tests with no DB.
 */

import { registerCheck } from '../registry.js';
import { compareMetric } from '../../baselines/compareMetric.js';
import { scoreAcrossPeriods } from '../../baselines/anomalyScorer.js';
import {
  listLatestScopeSnapshots as listLatestScopeSnapshotsDefault,
  getLatestSnapshotDate as getLatestSnapshotDateDefault
} from '../../baselines/snapshotStore.js';
import { getBaselines as getBaselinesDefault } from '../../baselines/baselineStore.js';

const SEVERITY_RANK = { none: 0, info: 1, warning: 2, critical: 3 };
const isFiniteNumber = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Pure-ish core: evaluate every observed metric against its baselines and
 * return the worst anomaly. Deps injected for offline testing.
 *
 * @param {object} opts
 * @param {string} opts.clientUserId
 * @param {string} [opts.asOf]              defaults to latest snapshot date
 * @param {function} opts.listLatestScopeSnapshots
 * @param {function} opts.getBaselines
 * @returns {Promise<{evaluated:number, anomalies:Array, worst:object|null, asOf:string|null}>}
 */
export async function evaluateAnomaliesForClient({
  clientUserId, asOf = null,
  listLatestScopeSnapshots, getBaselines
}) {
  const scopes = await listLatestScopeSnapshots({ clientUserId, asOf });
  const anomalies = [];
  let evaluated = 0;

  for (const scope of scopes) {
    const metrics = scope.metrics_json || {};
    for (const [metric, rawValue] of Object.entries(metrics)) {
      const observed = typeof rawValue === 'string' ? Number(rawValue) : rawValue;
      if (!isFiniteNumber(observed)) continue;

      const baselines = await getBaselines({
        clientUserId,
        service: scope.service,
        scopeType: scope.scope_type,
        scopeId: scope.scope_id,
        metric
      });
      if (!baselines || baselines.length === 0) continue;

      const comparisonsByPeriod = {};
      for (const b of baselines) {
        comparisonsByPeriod[b.period] = compareMetric(observed, {
          baseline_value: b.baseline_value === null ? null : Number(b.baseline_value),
          stddev: b.stddev === null || b.stddev === undefined ? null : Number(b.stddev),
          sample_count: b.sample_count
        });
      }
      const scored = scoreAcrossPeriods({ comparisonsByPeriod, metric });
      evaluated += 1;

      if (SEVERITY_RANK[scored.severity] > 0) {
        const cmp = comparisonsByPeriod[scored.period] || {};
        anomalies.push({
          service: scope.service,
          scope_type: scope.scope_type,
          scope_id: scope.scope_id,
          snapshot_date: scope.snapshot_date,
          metric,
          period: scored.period,
          severity: scored.severity,
          score: scored.score,
          direction: scored.direction,
          observed,
          baseline_value: cmp.baseline_value ?? null,
          z_score: cmp.z_score ?? null,
          pct_change: cmp.pct_change ?? null,
          reason: scored.reason
        });
      }
    }
  }

  anomalies.sort((a, b) => (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (b.score - a.score));
  return {
    evaluated,
    anomalies,
    worst: anomalies[0] || null,
    asOf: scopes[0]?.snapshot_date || asOf || null
  };
}

registerCheck('snapshot.metric_anomaly', {
  // No connector umbrella — this is an internal baseline check. Explicit
  // classification; requiredCapabilities:[] means it is NEVER capability-gated.
  serviceCategory: 'baselines',
  provider: 'snapshot_anomaly',
  tier: 'daily_essential',
  costEstimate: 0,
  requires: [],
  requiredCapabilities: [],
  handler: async (ctx) => {
    const clientUserId = ctx.clientUserId;
    if (!clientUserId) {
      return { status: 'skipped', payload: { reason: 'no clientUserId' } };
    }

    const asOf = ctx.config?.asOf || await getLatestSnapshotDateDefault({ clientUserId });
    if (!asOf) {
      return { status: 'skipped', payload: { reason: 'no snapshots on record for client' } };
    }

    const result = await evaluateAnomaliesForClient({
      clientUserId,
      asOf,
      listLatestScopeSnapshots: listLatestScopeSnapshotsDefault,
      getBaselines: getBaselinesDefault
    });

    const worst = result.worst;
    const failing = worst && SEVERITY_RANK[worst.severity] >= SEVERITY_RANK.warning;

    if (failing) {
      return {
        status: 'fail',
        severity: worst.severity,
        payload: {
          as_of: result.asOf,
          metrics_evaluated: result.evaluated,
          anomaly_count: result.anomalies.length,
          worst,
          // Cap the surfaced list so a noisy day doesn't bloat the payload.
          anomalies: result.anomalies.slice(0, 10)
        }
      };
    }

    return {
      status: 'pass',
      severity: null,
      payload: {
        as_of: result.asOf,
        metrics_evaluated: result.evaluated,
        anomaly_count: result.anomalies.length,
        // info-level deviations are reported but don't fail the check.
        anomalies: result.anomalies.slice(0, 10)
      }
    };
  }
});
