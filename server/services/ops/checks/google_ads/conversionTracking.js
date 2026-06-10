/**
 * Google Ads — conversion tracking checks (Phase 4 §6.2).
 *
 * Read-only checks against the Google Ads API + cross-references against
 * tracking_configs. All queries are GAQL via the gRPC client.
 *
 * Registered checks:
 *   - gads.conversion_tag.installed       (cross-ref tracking_configs + Customer.conversion_tracking_setting)
 *   - gads.conversion_tag.firing          (last-7d conversions vs spend)
 *   - gads.conversion_action.cpa_drift    (last-7d vs last-30d-excluding-7d; >50% drift)
 *   - gads.conversion_source.validity     (each ENABLED action has ≥1 conversion in 30d)
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { withCustomerCached } from './_client.js';

function dateNDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// gads.conversion_tag.installed
// ---------------------------------------------------------------------------
registerCheck('gads.conversion_tag.installed', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) {
      return { status: 'skipped', payload: { reason: resolved.reason } };
    }
    const { customer, customerId } = resolved;

    // Cross-ref tracking_configs for expected conversion id/label.
    const cfgRes = await query(
      `SELECT google_ads_customer_id, google_ads_conversion_id, google_ads_conversion_label
         FROM tracking_configs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [ctx.clientUserId]
    ).catch(() => ({ rows: [] }));
    const expected = cfgRes.rows[0] || null;

    // Pull conversion tracking setting + count of enabled actions.
    let trackingSetting = null;
    let enabledActions = 0;
    try {
      const settingRows = await customer.query(`
        SELECT customer.conversion_tracking_setting.conversion_tracking_id,
               customer.conversion_tracking_setting.conversion_tracking_status,
               customer.conversion_tracking_setting.cross_account_conversion_tracking_id
        FROM customer
        LIMIT 1
      `);
      trackingSetting = settingRows[0]?.customer?.conversion_tracking_setting || null;

      const actionRows = await customer.query(`
        SELECT conversion_action.id
        FROM conversion_action
        WHERE conversion_action.status = 'ENABLED'
      `);
      enabledActions = actionRows.length || 0;
    } catch (err) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { customer_id: customerId, error: err.message }
      };
    }

    const hasConversionId = !!trackingSetting?.conversion_tracking_id;
    const hasEnabledAction = enabledActions > 0;
    const tagInstalled = hasConversionId && hasEnabledAction;

    const issues = [];
    if (!hasConversionId) {
      issues.push({ kind: 'no_conversion_tracking_id', severity: 'critical' });
    }
    if (!hasEnabledAction) {
      issues.push({ kind: 'no_enabled_conversion_action', severity: 'critical' });
    }
    if (
      expected?.google_ads_customer_id &&
      String(expected.google_ads_customer_id).replace(/-/g, '') !== String(customerId).replace(/-/g, '')
    ) {
      issues.push({
        kind: 'customer_id_mismatch',
        severity: 'warning',
        expected: expected.google_ads_customer_id,
        actual: customerId
      });
    }

    const severity = issues.some((i) => i.severity === 'critical')
      ? 'critical'
      : issues.length
        ? 'warning'
        : null;

    return {
      status: tagInstalled && !severity ? 'pass' : 'fail',
      severity,
      payload: {
        customer_id: customerId,
        tag_installed: tagInstalled,
        enabled_action_count: enabledActions,
        tracking_setting: trackingSetting,
        expected,
        issues
      }
    };
  }
});

// ---------------------------------------------------------------------------
// gads.conversion_tag.firing
// ---------------------------------------------------------------------------
registerCheck('gads.conversion_tag.firing', {
  umbrella: 'google_ads',
  tier: 'daily_essential',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) {
      return { status: 'skipped', payload: { reason: resolved.reason } };
    }
    const { customer, customerId } = resolved;

    const start = dateNDaysAgo(7);
    const end = todayUtc();

    let summary;
    try {
      const rows = await customer.query(`
        SELECT metrics.conversions, metrics.cost_micros
        FROM customer
        WHERE segments.date BETWEEN '${start}' AND '${end}'
      `);
      summary = rows[0]?.metrics || {};
    } catch (err) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { customer_id: customerId, error: err.message }
      };
    }

    const conversions = parseFloat(summary.conversions || 0);
    const spend = Number(summary.cost_micros || 0) / 1_000_000;

    let severity = null;
    let status = 'pass';
    if (spend > 0 && conversions === 0) {
      severity = 'critical';
      status = 'fail';
    } else if (spend === 0) {
      // No spend → can't determine, mark skipped instead of false-positive pass.
      return {
        status: 'skipped',
        payload: { customer_id: customerId, reason: 'no spend in window', start, end }
      };
    }

    return {
      status,
      severity,
      payload: {
        customer_id: customerId,
        window: { start, end },
        spend: Math.round(spend * 100) / 100,
        conversions: Math.round(conversions * 100) / 100,
        firing: conversions > 0
      }
    };
  }
});

// ---------------------------------------------------------------------------
// gads.conversion_action.cpa_drift
// ---------------------------------------------------------------------------
registerCheck('gads.conversion_action.cpa_drift', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) {
      return { status: 'skipped', payload: { reason: resolved.reason } };
    }
    const { customer, customerId } = resolved;

    const recentStart = dateNDaysAgo(7);
    const recentEnd = todayUtc();
    const baselineStart = dateNDaysAgo(30);
    const baselineEnd = dateNDaysAgo(8); // last-30d excluding the most-recent-7d

    let recentRows = [];
    let baselineRows = [];
    try {
      [recentRows, baselineRows] = await Promise.all([
        customer.query(`
          SELECT segments.conversion_action_name,
                 segments.conversion_action,
                 metrics.conversions,
                 metrics.cost_micros
          FROM customer
          WHERE segments.date BETWEEN '${recentStart}' AND '${recentEnd}'
        `),
        customer.query(`
          SELECT segments.conversion_action_name,
                 segments.conversion_action,
                 metrics.conversions,
                 metrics.cost_micros
          FROM customer
          WHERE segments.date BETWEEN '${baselineStart}' AND '${baselineEnd}'
        `)
      ]);
    } catch (err) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { customer_id: customerId, error: err.message }
      };
    }

    function aggregate(rows) {
      const map = new Map();
      for (const row of rows) {
        const key = row.segments?.conversion_action || row.segments?.conversion_action_name || 'unknown';
        const name = row.segments?.conversion_action_name || key;
        const conv = parseFloat(row.metrics?.conversions || 0);
        const cost = Number(row.metrics?.cost_micros || 0) / 1_000_000;
        const cur = map.get(key) || { name, conversions: 0, cost: 0 };
        cur.conversions += conv;
        cur.cost += cost;
        map.set(key, cur);
      }
      return map;
    }

    const recent = aggregate(recentRows);
    const baseline = aggregate(baselineRows);

    const drifts = [];
    for (const [key, r] of recent.entries()) {
      const b = baseline.get(key);
      if (!b) continue;
      const recentCpa = r.conversions > 0 ? r.cost / r.conversions : null;
      const baselineCpa = b.conversions > 0 ? b.cost / b.conversions : null;
      if (recentCpa == null || baselineCpa == null || baselineCpa === 0) continue;
      const driftPct = ((recentCpa - baselineCpa) / baselineCpa) * 100;
      if (Math.abs(driftPct) > 50) {
        drifts.push({
          conversion_action: key,
          name: r.name,
          recent_cpa: Math.round(recentCpa * 100) / 100,
          baseline_cpa: Math.round(baselineCpa * 100) / 100,
          drift_pct: Math.round(driftPct * 10) / 10
        });
      }
    }

    const severity = drifts.length ? 'warning' : null;
    return {
      status: drifts.length ? 'fail' : 'pass',
      severity,
      payload: {
        customer_id: customerId,
        recent_window: { start: recentStart, end: recentEnd },
        baseline_window: { start: baselineStart, end: baselineEnd },
        drifted_actions: drifts,
        threshold_pct: 50
      }
    };
  }
});

// ---------------------------------------------------------------------------
// gads.conversion_source.validity
// ---------------------------------------------------------------------------
registerCheck('gads.conversion_source.validity', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) {
      return { status: 'skipped', payload: { reason: resolved.reason } };
    }
    const { customer, customerId } = resolved;

    const start = dateNDaysAgo(30);
    const end = todayUtc();

    let actions = [];
    let attributionRows = [];
    try {
      [actions, attributionRows] = await Promise.all([
        customer.query(`
          SELECT conversion_action.id,
                 conversion_action.name,
                 conversion_action.resource_name,
                 conversion_action.type,
                 conversion_action.status
          FROM conversion_action
          WHERE conversion_action.status = 'ENABLED'
        `),
        customer.query(`
          SELECT segments.conversion_action,
                 metrics.conversions
          FROM customer
          WHERE segments.date BETWEEN '${start}' AND '${end}'
        `)
      ]);
    } catch (err) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { customer_id: customerId, error: err.message }
      };
    }

    const conversionsByAction = new Map();
    for (const row of attributionRows) {
      const key = row.segments?.conversion_action;
      if (!key) continue;
      const conv = parseFloat(row.metrics?.conversions || 0);
      conversionsByAction.set(key, (conversionsByAction.get(key) || 0) + conv);
    }

    const stale = [];
    const summary = [];
    for (const row of actions) {
      const action = row.conversion_action || {};
      const resource = action.resource_name;
      const conv = conversionsByAction.get(resource) || 0;
      const entry = {
        id: String(action.id || ''),
        name: action.name || '',
        type: action.type || '',
        conversions_30d: Math.round(conv * 100) / 100,
        has_attribution: conv > 0
      };
      summary.push(entry);
      if (!entry.has_attribution) stale.push(entry);
    }

    const severity = stale.length ? 'warning' : null;
    return {
      status: stale.length ? 'fail' : 'pass',
      severity,
      payload: {
        customer_id: customerId,
        window: { start, end },
        enabled_action_count: actions.length,
        stale_actions: stale,
        all_actions: summary
      }
    };
  }
});
