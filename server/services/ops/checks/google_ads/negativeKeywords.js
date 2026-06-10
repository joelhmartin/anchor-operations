/**
 * Google Ads — negative keyword checks (Phase 4 §6.3).
 *
 * - gads.negative_keywords.recent_changes  (change_event resource, 7d window)
 * - gads.negative_keywords.coverage         (≥1 shared neg-kw list applied)
 */

import { registerCheck } from '../registry.js';
import { withCustomerCached } from './_client.js';

function dateNDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

registerCheck('gads.negative_keywords.recent_changes', {
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

    const start = dateNDaysAgo(7);

    let rows = [];
    try {
      // change_event window must be ≤ 30d. We constrain to 7d.
      // change_event requires the WHERE clause to filter by change_date_time.
      rows = await customer.query(`
        SELECT change_event.change_date_time,
               change_event.change_resource_type,
               change_event.resource_change_operation,
               change_event.user_email,
               change_event.changed_fields,
               change_event.campaign,
               change_event.ad_group
        FROM change_event
        WHERE change_event.change_date_time >= '${start}'
          AND change_event.change_resource_type IN ('CAMPAIGN_CRITERION', 'AD_GROUP_CRITERION', 'SHARED_CRITERION')
        ORDER BY change_event.change_date_time DESC
        LIMIT 200
      `);
    } catch (err) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { customer_id: customerId, error: err.message }
      };
    }

    const events = rows.map((r) => {
      const ev = r.change_event || {};
      return {
        date: ev.change_date_time || null,
        resource_type: ev.change_resource_type || '',
        operation: ev.resource_change_operation || '',
        user: ev.user_email || '',
        changed_fields: ev.changed_fields || null,
        campaign: ev.campaign || null,
        ad_group: ev.ad_group || null
      };
    });

    return {
      status: 'pass',
      severity: null,
      payload: {
        customer_id: customerId,
        window_start: start,
        event_count: events.length,
        events
      }
    };
  }
});

registerCheck('gads.negative_keywords.coverage', {
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

    let sharedSets = [];
    let campaignAttachments = [];
    let campaigns = [];
    try {
      [sharedSets, campaignAttachments, campaigns] = await Promise.all([
        customer.query(`
          SELECT shared_set.id, shared_set.name, shared_set.type,
                 shared_set.member_count, shared_set.status
          FROM shared_set
          WHERE shared_set.type = 'NEGATIVE_KEYWORDS'
            AND shared_set.status = 'ENABLED'
        `),
        customer.query(`
          SELECT campaign_shared_set.campaign,
                 campaign_shared_set.shared_set,
                 campaign_shared_set.status
          FROM campaign_shared_set
          WHERE campaign_shared_set.status = 'ENABLED'
        `),
        customer.query(`
          SELECT campaign.id, campaign.name, campaign.status
          FROM campaign
          WHERE campaign.status = 'ENABLED'
        `)
      ]);
    } catch (err) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { customer_id: customerId, error: err.message }
      };
    }

    const sharedSetCount = sharedSets.length;
    const campaignsWithSharedSet = new Set();
    for (const row of campaignAttachments) {
      const camp = row.campaign_shared_set?.campaign;
      if (camp) campaignsWithSharedSet.add(camp);
    }

    const enabledCampaignCount = campaigns.length;
    const coveredCampaignCount = campaigns.filter((c) =>
      campaignsWithSharedSet.has(c.campaign?.resource_name)
    ).length;

    const hasAnyAppliedSharedSet = campaignsWithSharedSet.size > 0;
    const severity = sharedSetCount === 0 || !hasAnyAppliedSharedSet ? 'warning' : null;

    return {
      status: severity ? 'fail' : 'pass',
      severity,
      payload: {
        customer_id: customerId,
        shared_set_count: sharedSetCount,
        shared_sets: sharedSets.map((s) => ({
          id: String(s.shared_set?.id || ''),
          name: s.shared_set?.name || '',
          member_count: Number(s.shared_set?.member_count || 0)
        })),
        enabled_campaigns: enabledCampaignCount,
        campaigns_with_negative_list: coveredCampaignCount,
        any_shared_set_applied: hasAnyAppliedSharedSet
      }
    };
  }
});
