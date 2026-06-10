/**
 * PSI quota tracker — Phase 3.
 *
 * PageSpeed Insights API has a daily quota (default 25,000 queries / day for
 * an authenticated key). This helper maintains an in-process counter keyed by
 * UTC date, bumped each time a PSI request is sent. We back off at 90% of the
 * configured cap to leave headroom for ad-hoc UI requests outside the run
 * pipeline.
 *
 * Persistence is intentionally light — a process restart resets the counter,
 * which we accept because:
 *   1. The Cloud Run Job runner is the only sustained PSI consumer
 *   2. Quota over-spend just means a 429 from PSI, which we treat as a
 *      'skipped' check outcome rather than a fatal error
 *
 * Phase 8 may swap this for a Postgres-backed counter if we start running
 * many concurrent runners.
 */

const QUOTA_CEILING = Number(process.env.PSI_DAILY_QUOTA || 25_000);
const BACKOFF_RATIO = 0.9;

let currentDateKey = null;
let currentCount = 0;

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function rollIfNewDay() {
  const k = todayKey();
  if (k !== currentDateKey) {
    currentDateKey = k;
    currentCount = 0;
  }
}

export function reservePsiSlot() {
  rollIfNewDay();
  if (currentCount >= QUOTA_CEILING * BACKOFF_RATIO) {
    return { ok: false, reason: 'psi_daily_backoff', count: currentCount, ceiling: QUOTA_CEILING };
  }
  currentCount += 1;
  return { ok: true, count: currentCount, ceiling: QUOTA_CEILING };
}

export function snapshotPsiQuota() {
  rollIfNewDay();
  return { date: currentDateKey, count: currentCount, ceiling: QUOTA_CEILING };
}
