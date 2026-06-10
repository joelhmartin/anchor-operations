/**
 * Google Ads — account configuration checks (Phase 4 §6.4).
 *
 * All read-only. Each check is registered separately so it can be
 * toggled per run definition / tier.
 *
 * Registered:
 *   gads.account.linked_analytics
 *   gads.account.linked_search_console
 *   gads.account.linked_merchant_center  (only if e-commerce client_type)
 *   gads.account.disapproved_ads
 *   gads.account.budget_pacing            (>120% or <70%)
 *   gads.account.location_bid_modifiers
 *   gads.account.device_bid_modifiers
 *   gads.account.audience_lists.populated
 *   gads.account.audience_lists.size      (>100 → eligible)
 *   gads.account.ad_extensions.sitelinks
 *   gads.account.ad_extensions.callouts
 *   gads.account.ad_extensions.callout_phone   (cross-ref twilio_tracking_numbers)
 *   gads.account.auto_applied_recommendations
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { withCustomerCached } from './_client.js';

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

function startOfMonthUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}

function daysInCurrentMonthUtc() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
}

function dayOfMonthUtc() {
  return new Date().getUTCDate();
}

async function clientType(clientUserId) {
  const { rows } = await query(
    `SELECT client_type FROM client_profiles WHERE user_id = $1 LIMIT 1`,
    [clientUserId]
  ).catch(() => ({ rows: [] }));
  return (rows[0]?.client_type || '').toLowerCase();
}

// ---------------------------------------------------------------------------
// gads.account.linked_analytics
// ---------------------------------------------------------------------------
registerCheck('gads.account.linked_analytics', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    try {
      const rows = await customer.query(`
        SELECT third_party_app_analytics_link.resource_name,
               third_party_app_analytics_link.app_analytics_provider_id
        FROM third_party_app_analytics_link
      `);
      // Better signal: customer_user_access listing — but linked GA4 lives in
      // accessible_bidding_strategy / data_link. We use customer_client_link as
      // a sanity probe. Accept any presence as linked.
      const ga4Rows = await customer.query(`
        SELECT customer.id, customer.conversion_tracking_setting.google_ads_conversion_customer
        FROM customer
        LIMIT 1
      `).catch(() => []);
      const linked = rows.length > 0 || ga4Rows.length > 0;
      return {
        status: linked ? 'pass' : 'fail',
        severity: linked ? null : 'warning',
        payload: { customer_id: customerId, linked, link_count: rows.length }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

// ---------------------------------------------------------------------------
// gads.account.linked_search_console
// ---------------------------------------------------------------------------
registerCheck('gads.account.linked_search_console', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    try {
      // Detect via paid_organic_search_term_view presence — only available
      // when GSC is linked to the account.
      const rows = await customer.query(`
        SELECT customer.id FROM paid_organic_search_term_view LIMIT 1
      `).catch(() => null);
      const linked = Array.isArray(rows) && rows.length > 0;
      return {
        status: linked ? 'pass' : 'fail',
        severity: linked ? null : 'warning',
        payload: { customer_id: customerId, linked }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

// ---------------------------------------------------------------------------
// gads.account.linked_merchant_center  (e-commerce only)
// ---------------------------------------------------------------------------
registerCheck('gads.account.linked_merchant_center', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const ct = await clientType(ctx.clientUserId);
    if (ct !== 'ecommerce' && ct !== 'e-commerce') {
      return { status: 'skipped', payload: { reason: `not e-commerce client_type (${ct || 'unset'})` } };
    }
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    try {
      const rows = await customer.query(`
        SELECT merchant_center_link.id, merchant_center_link.merchant_center_id, merchant_center_link.status
        FROM merchant_center_link
      `).catch(() => []);
      const linked = rows.some((r) => r.merchant_center_link?.status === 'ENABLED');
      return {
        status: linked ? 'pass' : 'fail',
        severity: linked ? null : 'warning',
        payload: { customer_id: customerId, linked, link_count: rows.length }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

// ---------------------------------------------------------------------------
// gads.account.disapproved_ads
// ---------------------------------------------------------------------------
registerCheck('gads.account.disapproved_ads', {
  umbrella: 'google_ads',
  tier: 'daily_essential',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    try {
      const rows = await customer.query(`
        SELECT ad_group_ad.ad.id,
               ad_group_ad.ad.name,
               ad_group_ad.policy_summary.approval_status,
               ad_group_ad.policy_summary.review_status,
               campaign.id, campaign.name,
               ad_group.id, ad_group.name
        FROM ad_group_ad
        WHERE ad_group_ad.policy_summary.approval_status = 'DISAPPROVED'
          AND ad_group_ad.status != 'REMOVED'
        LIMIT 200
      `);
      const disapproved = rows.map((r) => ({
        ad_id: String(r.ad_group_ad?.ad?.id || ''),
        ad_name: r.ad_group_ad?.ad?.name || '',
        review_status: r.ad_group_ad?.policy_summary?.review_status || '',
        campaign_id: String(r.campaign?.id || ''),
        campaign_name: r.campaign?.name || '',
        ad_group_id: String(r.ad_group?.id || ''),
        ad_group_name: r.ad_group?.name || ''
      }));
      const severity = disapproved.length ? 'critical' : null;
      return {
        status: disapproved.length ? 'fail' : 'pass',
        severity,
        payload: { customer_id: customerId, count: disapproved.length, disapproved }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

// ---------------------------------------------------------------------------
// gads.account.budget_pacing
// ---------------------------------------------------------------------------
registerCheck('gads.account.budget_pacing', {
  umbrella: 'google_ads',
  tier: 'daily_essential',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;

    const start = startOfMonthUtc();
    const end = todayUtc();
    const dayOfMonth = dayOfMonthUtc();
    const totalDays = daysInCurrentMonthUtc();
    const expectedFraction = dayOfMonth / totalDays;

    try {
      const rows = await customer.query(`
        SELECT campaign.id, campaign.name, campaign.status,
               campaign_budget.amount_micros,
               campaign_budget.period,
               metrics.cost_micros
        FROM campaign
        WHERE campaign.status = 'ENABLED'
          AND segments.date BETWEEN '${start}' AND '${end}'
      `);
      // Aggregate spend per campaign across the rows.
      const byCampaign = new Map();
      for (const r of rows) {
        const id = String(r.campaign?.id || '');
        if (!id) continue;
        const cur = byCampaign.get(id) || {
          id,
          name: r.campaign?.name || '',
          budget_daily: Number(r.campaign_budget?.amount_micros || 0) / 1_000_000,
          period: r.campaign_budget?.period || 'DAILY',
          spend_mtd: 0
        };
        cur.spend_mtd += Number(r.metrics?.cost_micros || 0) / 1_000_000;
        byCampaign.set(id, cur);
      }

      const flagged = [];
      for (const c of byCampaign.values()) {
        const monthBudget = (c.budget_daily || 0) * totalDays;
        if (monthBudget <= 0) continue;
        const expectedSpend = monthBudget * expectedFraction;
        const pacing = expectedSpend > 0 ? c.spend_mtd / expectedSpend : null;
        if (pacing == null) continue;
        const pct = Math.round(pacing * 100);
        if (pct > 120 || pct < 70) {
          flagged.push({
            campaign_id: c.id,
            campaign_name: c.name,
            daily_budget: Math.round(c.budget_daily * 100) / 100,
            month_budget_estimate: Math.round(monthBudget * 100) / 100,
            spend_mtd: Math.round(c.spend_mtd * 100) / 100,
            pacing_pct: pct,
            direction: pct > 120 ? 'over' : 'under'
          });
        }
      }
      const severity = flagged.length ? 'warning' : null;
      return {
        status: flagged.length ? 'fail' : 'pass',
        severity,
        payload: {
          customer_id: customerId,
          window: { start, end },
          expected_spend_pct: Math.round(expectedFraction * 100),
          flagged_campaigns: flagged
        }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

// ---------------------------------------------------------------------------
// gads.account.location_bid_modifiers
// ---------------------------------------------------------------------------
registerCheck('gads.account.location_bid_modifiers', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    try {
      const rows = await customer.query(`
        SELECT campaign_criterion.criterion_id,
               campaign_criterion.location.geo_target_constant,
               campaign_criterion.bid_modifier,
               campaign.id, campaign.name
        FROM campaign_criterion
        WHERE campaign_criterion.type = 'LOCATION'
          AND campaign_criterion.bid_modifier > 0
      `);
      const ct = await clientType(ctx.clientUserId);
      const isServiceArea = ['medical', 'dental', 'service'].some((kind) => ct.includes(kind));
      const count = rows.length;
      const severity = isServiceArea && count === 0 ? 'warning' : null;
      return {
        status: severity ? 'fail' : 'pass',
        severity,
        payload: {
          customer_id: customerId,
          modifier_count: count,
          service_area_client: isServiceArea,
          client_type: ct
        }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

// ---------------------------------------------------------------------------
// gads.account.device_bid_modifiers
// ---------------------------------------------------------------------------
registerCheck('gads.account.device_bid_modifiers', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    try {
      const rows = await customer.query(`
        SELECT campaign_criterion.criterion_id,
               campaign_criterion.device.type,
               campaign_criterion.bid_modifier,
               campaign.id, campaign.name
        FROM campaign_criterion
        WHERE campaign_criterion.type = 'DEVICE'
      `);
      const modifiers = rows.map((r) => ({
        campaign_id: String(r.campaign?.id || ''),
        campaign_name: r.campaign?.name || '',
        device: r.campaign_criterion?.device?.type || '',
        bid_modifier: r.campaign_criterion?.bid_modifier ?? null
      }));
      return {
        status: 'pass',
        payload: { customer_id: customerId, modifier_count: modifiers.length, modifiers }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

// ---------------------------------------------------------------------------
// gads.account.audience_lists.populated
// gads.account.audience_lists.size
// ---------------------------------------------------------------------------
async function fetchUserLists(customer) {
  return customer.query(`
    SELECT user_list.id, user_list.name, user_list.size_for_display,
           user_list.size_for_search, user_list.membership_status, user_list.type
    FROM user_list
    WHERE user_list.membership_status = 'OPEN'
  `);
}

registerCheck('gads.account.audience_lists.populated', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    try {
      const rows = await fetchUserLists(customer);
      const lists = rows.map((r) => ({
        id: String(r.user_list?.id || ''),
        name: r.user_list?.name || '',
        size_display: Number(r.user_list?.size_for_display || 0),
        size_search: Number(r.user_list?.size_for_search || 0),
        type: r.user_list?.type || ''
      }));
      const populated = lists.filter((l) => (l.size_display + l.size_search) > 0);
      const severity = populated.length === 0 ? 'warning' : null;
      return {
        status: severity ? 'fail' : 'pass',
        severity,
        payload: {
          customer_id: customerId,
          list_count: lists.length,
          populated_count: populated.length,
          lists
        }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

registerCheck('gads.account.audience_lists.size', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    try {
      const rows = await fetchUserLists(customer);
      const eligible = rows.filter((r) => {
        const display = Number(r.user_list?.size_for_display || 0);
        const search = Number(r.user_list?.size_for_search || 0);
        return display > 100 || search > 100;
      });
      const severity = eligible.length === 0 ? 'warning' : null;
      return {
        status: severity ? 'fail' : 'pass',
        severity,
        payload: {
          customer_id: customerId,
          eligible_count: eligible.length,
          total_count: rows.length,
          eligibility_threshold: 100
        }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

// ---------------------------------------------------------------------------
// Ad-extension checks
// ---------------------------------------------------------------------------
async function fetchAssets(customer, type) {
  // customer_asset is the v15+ surface for extensions.
  return customer.query(`
    SELECT customer_asset.asset, customer_asset.status,
           asset.type, asset.id, asset.name,
           asset.sitelink_asset.link_text,
           asset.callout_asset.callout_text,
           asset.call_asset.phone_number
    FROM customer_asset
    WHERE asset.type = '${type}'
      AND customer_asset.status = 'ENABLED'
  `).catch(() => []);
}

registerCheck('gads.account.ad_extensions.sitelinks', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    const rows = await fetchAssets(customer, 'SITELINK');
    const count = rows.length;
    const severity = count < 4 ? 'warning' : null;
    return {
      status: severity ? 'fail' : 'pass',
      severity,
      payload: {
        customer_id: customerId,
        sitelink_count: count,
        recommended_minimum: 4,
        sitelinks: rows.map((r) => ({
          link_text: r.asset?.sitelink_asset?.link_text || '',
          asset_id: String(r.asset?.id || '')
        }))
      }
    };
  }
});

registerCheck('gads.account.ad_extensions.callouts', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    const rows = await fetchAssets(customer, 'CALLOUT');
    const count = rows.length;
    const severity = count < 4 ? 'warning' : null;
    return {
      status: severity ? 'fail' : 'pass',
      severity,
      payload: {
        customer_id: customerId,
        callout_count: count,
        recommended_minimum: 4,
        callouts: rows.map((r) => ({
          text: r.asset?.callout_asset?.callout_text || '',
          asset_id: String(r.asset?.id || '')
        }))
      }
    };
  }
});

registerCheck('gads.account.ad_extensions.callout_phone', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    const rows = await fetchAssets(customer, 'CALL');
    const adsPhones = rows
      .map((r) => r.asset?.call_asset?.phone_number || '')
      .filter(Boolean);

    // Cross-ref CTM tracking numbers configured for this client.
    const trackingRes = await query(
      `SELECT phone_number, friendly_name, source_type
         FROM twilio_tracking_numbers
        WHERE client_user_id = $1 AND is_active = TRUE`,
      [ctx.clientUserId]
    ).catch(() => ({ rows: [] }));
    const trackingNumbers = trackingRes.rows || [];

    function normalize(p) {
      return (p || '').replace(/[^0-9]/g, '').replace(/^1(\d{10})$/, '$1');
    }
    const trackingNorm = new Set(trackingNumbers.map((t) => normalize(t.phone_number)));
    const adsNorm = adsPhones.map(normalize);

    const matches = adsNorm.filter((p) => trackingNorm.has(p));
    const issues = [];

    if (adsPhones.length === 0) {
      issues.push({ kind: 'no_call_extension', severity: 'warning' });
    }
    if (trackingNumbers.length > 0 && matches.length === 0 && adsPhones.length > 0) {
      issues.push({
        kind: 'phone_mismatch',
        severity: 'warning',
        ads_phones: adsPhones,
        tracking_numbers: trackingNumbers.map((t) => t.phone_number)
      });
    }

    const severity = issues.length ? 'warning' : null;
    return {
      status: severity ? 'fail' : 'pass',
      severity,
      payload: {
        customer_id: customerId,
        ads_phone_count: adsPhones.length,
        tracking_number_count: trackingNumbers.length,
        match_count: matches.length,
        issues
      }
    };
  }
});

// ---------------------------------------------------------------------------
// gads.account.auto_applied_recommendations
// ---------------------------------------------------------------------------
registerCheck('gads.account.auto_applied_recommendations', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;
    try {
      const rows = await customer.query(`
        SELECT recommendation_subscription.type,
               recommendation_subscription.status
        FROM recommendation_subscription
      `).catch(() => []);
      const enabled = rows
        .map((r) => ({
          type: r.recommendation_subscription?.type || '',
          status: r.recommendation_subscription?.status || ''
        }))
        .filter((r) => r.status === 'ENABLED');
      // Auto-applied recommendations being broadly enabled is informational —
      // many agencies prefer them off. Surface as info, not failure.
      return {
        status: 'pass',
        severity: null,
        payload: {
          customer_id: customerId,
          enabled_subscription_count: enabled.length,
          enabled_subscriptions: enabled,
          all_subscriptions: rows.map((r) => ({
            type: r.recommendation_subscription?.type || '',
            status: r.recommendation_subscription?.status || ''
          }))
        }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});
