/**
 * clientOverview.js — per-client curated digest.
 *
 * Exports:
 *   shapeClientOverview(raw)  — pure function, unit-tested in __tests__/clientOverview.test.js
 *   loadClientOverview(clientUserId) — DB query → shapeClientOverview
 *
 * Note: ops_runs uses `cost_estimate_cents` for per-run cost tracking.
 */

import { query } from '../../db.js';

/**
 * Pure shaper — converts raw DB rows into the Overview digest shape.
 *
 * @param {object} params
 * @param {object[]} params.findings        - open/investigating ops_findings rows
 * @param {object[]} params.scheduledBlogs  - upcoming ops_blog_posts rows
 * @param {object[]} params.scheduledSocial - upcoming social_posts rows
 * @param {object|null} params.lastRun      - most recent ops_run row or null
 * @param {object|null} params.cost         - { spend_cents, cap_cents } or null
 * @returns {{ topFindings, scheduledToday, site, lastRun, counts }}
 */
export function shapeClientOverview({ findings = [], scheduledBlogs = [], scheduledSocial = [], lastRun = null, cost = null }) {
  const sorted = [...findings].sort(
    (a, b) => (b.attention_score ?? 0) - (a.attention_score ?? 0)
  );
  return {
    topFindings: sorted.slice(0, 5),
    scheduledToday: { blogs: scheduledBlogs, social: scheduledSocial },
    site: null,
    lastRun: lastRun || null,
    counts: {
      openFindings: findings.length,
      postsScheduled: scheduledBlogs.length + scheduledSocial.length,
      mtdSpendCents: cost?.spend_cents ?? 0,
      capCents: cost?.cap_cents ?? null
    }
  };
}

/**
 * Loads all raw data for a client from the DB and shapes it.
 *
 * @param {string} clientUserId - UUID of the client user
 * @returns {Promise<ReturnType<shapeClientOverview>>}
 */
export async function loadClientOverview(clientUserId) {
  const [findings, blogs, social, runRes, capRes, spendRes] = await Promise.all([
    // Open/investigating findings sorted by attention score
    query(
      `SELECT id, severity, category, summary, status, attention_score, created_at
         FROM ops_findings
        WHERE client_user_id = $1 AND status IN ('open','investigating')
        ORDER BY attention_score DESC NULLS LAST, created_at DESC
        LIMIT 25`,
      [clientUserId]
    ),
    // Blog posts scheduled in the next 48 hours
    query(
      `SELECT id, title, scheduled_for
         FROM ops_blog_posts
        WHERE client_id = $1 AND status = 'scheduled'
          AND scheduled_for >= date_trunc('day', NOW())
          AND scheduled_for < date_trunc('day', NOW()) + INTERVAL '2 days'
        ORDER BY scheduled_for ASC`,
      [clientUserId]
    ),
    // Social posts scheduled in the next 48 hours
    query(
      `SELECT id, content, scheduled_for
         FROM social_posts
        WHERE client_id = $1 AND status = 'scheduled'
          AND scheduled_for >= date_trunc('day', NOW())
          AND scheduled_for < date_trunc('day', NOW()) + INTERVAL '2 days'
        ORDER BY scheduled_for ASC`,
      [clientUserId]
    ),
    // Most recent run
    query(
      `SELECT id, status, tier, created_at
         FROM ops_runs
        WHERE client_user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [clientUserId]
    ),
    // Monthly spend cap from client profile
    query(
      `SELECT ops_monthly_cap_cents FROM client_profiles WHERE user_id = $1`,
      [clientUserId]
    ),
    // MTD spend — ops_runs.cost_estimate_cents is the per-run cost column
    query(
      `SELECT COALESCE(SUM(cost_estimate_cents), 0)::int AS spend_cents
         FROM ops_runs
        WHERE client_user_id = $1
          AND created_at >= date_trunc('month', NOW())`,
      [clientUserId]
    )
  ]);

  return shapeClientOverview({
    findings: findings.rows,
    scheduledBlogs: blogs.rows,
    scheduledSocial: social.rows,
    lastRun: runRes.rows[0] || null,
    cost: {
      spend_cents: spendRes.rows[0]?.spend_cents ?? 0,
      cap_cents: capRes.rows[0]?.ops_monthly_cap_cents ?? null
    }
  });
}
