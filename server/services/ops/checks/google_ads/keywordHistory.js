/**
 * Google Ads — keyword ranking history (Phase 4 §6.5).
 *
 * gads.keywords.position_changes — captures top 50 keywords by spend each
 * run, persists to ops_keyword_history, then diffs vs the snapshot from
 * 7 days ago. > 3-position drop in average_position → warning.
 *
 * Note: average_position was deprecated by Google in 2019 in favour of
 * top/absolute_top impression share. We capture both: avg_position when
 * available (top_impression_percentage as proxy), plus the new metrics
 * for forward compatibility. Drop detection uses the percentile-style
 * metric — a *drop* in top_impression_percentage of > 0.10 (10pp) is
 * treated as a 3-position drop equivalent.
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { withCustomerCached } from './_client.js';

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function dateNDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const DROP_THRESHOLD_PCT_POINTS = 0.10; // ~equivalent to "3-position drop"

registerCheck('gads.keywords.position_changes', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 2,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) {
      return { status: 'skipped', payload: { reason: resolved.reason } };
    }
    const { customer, customerId } = resolved;

    const today = todayUtc();
    const start = dateNDaysAgo(7);

    let rows = [];
    try {
      rows = await customer.query(`
        SELECT ad_group_criterion.keyword.text,
               metrics.cost_micros,
               metrics.impressions,
               metrics.clicks,
               metrics.top_impression_percentage,
               metrics.absolute_top_impression_percentage
        FROM keyword_view
        WHERE segments.date BETWEEN '${start}' AND '${today}'
          AND ad_group_criterion.status = 'ENABLED'
        ORDER BY metrics.cost_micros DESC
        LIMIT 50
      `);
    } catch (err) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { customer_id: customerId, error: err.message }
      };
    }

    const snapshot = rows.map((r) => {
      const m = r.metrics || {};
      const kw = r.ad_group_criterion?.keyword?.text || '';
      // Use top_impression_percentage as the position proxy. We persist as
      // avg_position so the column name reflects intent across versions of the
      // metric — value is the share (0..1) where higher = better.
      const top = m.top_impression_percentage != null ? Number(m.top_impression_percentage) : null;
      return {
        keyword: kw,
        position_proxy: top,
        impressions: Number(m.impressions || 0),
        clicks: Number(m.clicks || 0)
      };
    }).filter((s) => s.keyword);

    // Persist snapshot for today.
    for (const s of snapshot) {
      try {
        await query(
          `INSERT INTO ops_keyword_history (customer_id, keyword, date, avg_position, impressions, clicks)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (customer_id, keyword, date) DO UPDATE
             SET avg_position = EXCLUDED.avg_position,
                 impressions = EXCLUDED.impressions,
                 clicks = EXCLUDED.clicks,
                 captured_at = NOW()`,
          [customerId, s.keyword, today, s.position_proxy, s.impressions, s.clicks]
        );
      } catch (err) {
        console.warn(`[ops/gads/keywordHistory] persist failed: ${err.message}`);
      }
    }

    // Diff vs 7d-ago snapshot.
    const cutoff = dateNDaysAgo(7);
    const priorRes = await query(
      `SELECT keyword, avg_position, impressions
         FROM ops_keyword_history
        WHERE customer_id = $1
          AND date <= $2
          AND keyword = ANY($3::text[])
        ORDER BY date DESC`,
      [customerId, cutoff, snapshot.map((s) => s.keyword)]
    ).catch(() => ({ rows: [] }));

    const priorByKeyword = new Map();
    for (const row of priorRes.rows || []) {
      if (!priorByKeyword.has(row.keyword)) {
        priorByKeyword.set(row.keyword, row);
      }
    }

    const drops = [];
    for (const s of snapshot) {
      const prior = priorByKeyword.get(s.keyword);
      if (!prior || prior.avg_position == null || s.position_proxy == null) continue;
      const delta = Number(prior.avg_position) - Number(s.position_proxy);
      // delta > threshold means the share dropped (proxy worsened).
      if (delta > DROP_THRESHOLD_PCT_POINTS) {
        drops.push({
          keyword: s.keyword,
          prior_position_proxy: Number(prior.avg_position),
          current_position_proxy: s.position_proxy,
          delta_pct_points: Math.round(delta * 1000) / 1000
        });
      }
    }

    const severity = drops.length ? 'warning' : null;
    return {
      status: drops.length ? 'fail' : 'pass',
      severity,
      payload: {
        customer_id: customerId,
        snapshot_size: snapshot.length,
        snapshot_date: today,
        comparison_cutoff: cutoff,
        drops,
        drop_threshold_pct_points: DROP_THRESHOLD_PCT_POINTS
      }
    };
  }
});
