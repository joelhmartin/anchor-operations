/**
 * Deterministic anomaly scoring (F3). PURE. Given a compareMetric result, emit a
 * stable score [0,1] + severity. Uses the z-score when a stddev-backed baseline
 * exists, otherwise the percent change. The LLM may later narrate this, but it
 * never computes it.
 *
 * Anti-false-positive gates (V5 review):
 *  - A percent-only deviation (no stddev-backed z) on thin history (< MIN_SAMPLES)
 *    cannot exceed `info` - too little data to trust a raw day-over-day swing.
 *  - Only an ADVERSE move alarms: a favorable change (clicks up, CPA down, rank
 *    improving) is at most `info`, never a warning/critical.
 */

export const Z_THRESHOLDS = { info: 1, warning: 2, critical: 3 };
export const PCT_THRESHOLDS = { info: 0.15, warning: 0.3, critical: 0.5 };
export const MIN_SAMPLES_FOR_ALARM = 4; // below this, percent-only deviations cap at `info`

// Default: higher is better, so a DROP is the concern. These metrics invert it -
// an INCREASE is the concern (cost/efficiency/rank where lower is better).
const LOWER_IS_BETTER = new Set([
  'cpa_cents',
  'cost_cents',
  'position',
  'average_position',
  'bounce_rate'
]);

const SEV_RANK = { none: 0, info: 1, warning: 2, critical: 3 };
const capAt = (sev, cap) => (SEV_RANK[sev] > SEV_RANK[cap] ? cap : sev);

const clamp01 = (n) => (n < 0 ? 0 : n > 1 ? 1 : n);
const round4 = (n) => Math.round(n * 1e4) / 1e4;

function isAdverse(metric, direction) {
  if (direction !== 'up' && direction !== 'down') return false;
  return LOWER_IS_BETTER.has(metric) ? direction === 'up' : direction === 'down';
}

function rawSeverity(absZ, absPct) {
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
  const sampleCount = comparison.sample_count ?? 0;

  // Baseline exactly zero + observed non-zero: pct/z are both null (divide-by-zero).
  // Treat an on/off flip as a strong signal - but still subject to the gates below.
  const zeroBaselineFlip =
    comparison.baseline_value === 0 &&
    absZ === null && absPct === null &&
    comparison.delta !== null && comparison.delta !== 0;

  let severity = zeroBaselineFlip ? 'critical' : rawSeverity(absZ, absPct);

  // C1: a percent-only deviation (or a zero-baseline flip) on thin history cannot
  // exceed `info` - a stddev-backed z is required to trust a warning/critical.
  const pctOnly = absZ === null;
  if ((pctOnly || zeroBaselineFlip) && sampleCount < MIN_SAMPLES_FOR_ALARM) {
    severity = capAt(severity, 'info');
  }
  // I1: only an adverse move alarms; a favorable one is informational at most.
  if (!isAdverse(metric, comparison.direction)) {
    severity = capAt(severity, 'info');
  }

  let score = 0;
  if (absZ !== null) score = clamp01(absZ / Z_THRESHOLDS.critical);
  else if (absPct !== null) score = clamp01(absPct / PCT_THRESHOLDS.critical);
  else if (zeroBaselineFlip) score = 1;

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
    // Prefer higher severity first, then higher score - so a thin pct-only period
    // (capped to info) can't hijack a robust z-backed warning/critical.
    const better = SEV_RANK[s.severity] > SEV_RANK[best.severity] ||
      (SEV_RANK[s.severity] === SEV_RANK[best.severity] && s.score > best.score);
    if (better) best = { ...s, period };
  }
  if (best.score < 0) best.score = 0;
  return best;
}
