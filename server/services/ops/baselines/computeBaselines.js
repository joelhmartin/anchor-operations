/**
 * Deterministic baseline math (F3). PURE — no DB, no I/O, no LLM.
 *
 * A baseline is the mean daily value (+ sample stddev when enough samples) over a
 * named historical window, so it is directly comparable to a single observed day.
 * The observed day (asOf) is always EXCLUDED from its own rolling baseline.
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
  const endRolling = addDays(asOf, -1);
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
