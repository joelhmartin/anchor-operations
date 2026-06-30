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

  // Guard near-zero denominators: a baseline of e.g. 0.0001 would make pct_change
  // (and a tiny-stddev z) explode into a false critical. Treat sub-epsilon
  // baselines/stddevs as "no ratio" rather than amplifying noise.
  const EPS = 1e-9;
  const pct_change = Math.abs(base) < EPS ? null : round6((observed - base) / base);
  const z_score = sd && Math.abs(sd) > EPS ? round6((observed - base) / sd) : null;
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
