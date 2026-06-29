/**
 * Deterministic anomaly scoring (F3). PURE. Given a compareMetric result, emit a
 * stable score [0,1] + severity. Uses the z-score when a stddev-backed baseline
 * exists, otherwise the percent change. The LLM may later narrate this, but it
 * never computes it.
 */

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
