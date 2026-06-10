/**
 * Meta umbrella — Account-level checks (Plan §7.4).
 *
 * Read-only in v1. HIPAA gate enforced on every check.
 *
 * Single account fetch (`/act_X?fields=...`) is memoized on ctx so all six
 * account-level checks share one Graph call where possible.
 */

import { registerCheck } from '../registry.js';
import { assertNonMedical } from './_hipaaGate.js';
import { getAdAccountClient, adapterSkipOutcome } from './_client.js';

const COST_CENTS = 1;
const _accountCacheKey = '_metaAccountCache';

const ACCOUNT_FIELDS = [
  'id',
  'name',
  'account_status',
  'spend_cap',
  'amount_spent',
  'balance',
  'currency',
  'business',
  'business_country_code',
  'disable_reason',
  'capabilities',
  'attribution_spec'
].join(',');

async function loadAccount(ctx, client) {
  if (ctx && ctx[_accountCacheKey] !== undefined) return ctx[_accountCacheKey];
  let payload = null;
  try {
    const account = await client.graph(`${client.adAccountId}?fields=${ACCOUNT_FIELDS}`);
    payload = { ok: true, account };
  } catch (err) {
    payload = { ok: false, reason: `account fetch failed: ${err.message}` };
  }
  if (ctx) ctx[_accountCacheKey] = payload;
  return payload;
}

// ---------------------------------------------------------------------------
// meta.account.spending_limit — spend_cap not blocking
// ---------------------------------------------------------------------------
registerCheck('meta.account.spending_limit', {
  umbrella: 'meta',
  tier: 'daily_essential',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const acc = await loadAccount(ctx, client);
    if (!acc.ok) return { status: 'skipped', payload: { reason: acc.reason } };

    // spend_cap and amount_spent are returned in account currency minor units.
    // 0 spend_cap means "no cap" in Meta's API.
    const cap = parseInt(acc.account.spend_cap, 10) || 0;
    const spent = parseInt(acc.account.amount_spent, 10) || 0;

    let status = 'pass';
    let severity = null;
    let blocking = false;
    if (cap > 0) {
      const utilization = spent / cap;
      if (utilization >= 1) {
        status = 'fail';
        severity = 'critical';
        blocking = true;
      } else if (utilization >= 0.9) {
        status = 'fail';
        severity = 'warning';
      }
    }

    return {
      status,
      severity,
      payload: {
        spend_cap_minor: cap,
        amount_spent_minor: spent,
        currency: acc.account.currency || null,
        utilization: cap > 0 ? spent / cap : null,
        blocking
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.account.business_verification
// ---------------------------------------------------------------------------
registerCheck('meta.account.business_verification', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const acc = await loadAccount(ctx, client);
    if (!acc.ok) return { status: 'skipped', payload: { reason: acc.reason } };

    const businessId = acc.account.business?.id || null;
    if (!businessId) {
      return {
        status: 'skipped',
        payload: { reason: 'ad account is not attached to a Business Manager' },
        cost_cents: COST_CENTS
      };
    }

    let business;
    try {
      business = await client.graph(`${businessId}?fields=id,name,verification_status,is_disabled_for_integrity_reasons`);
    } catch (err) {
      return { status: 'skipped', payload: { reason: `business fetch failed: ${err.message}` } };
    }

    const verified = business.verification_status === 'verified';

    return {
      status: verified ? 'pass' : 'fail',
      severity: verified ? null : 'warning',
      payload: {
        business_id: business.id,
        business_name: business.name,
        verification_status: business.verification_status,
        is_disabled_for_integrity_reasons: !!business.is_disabled_for_integrity_reasons
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.account.domain_verification
// ---------------------------------------------------------------------------
registerCheck('meta.account.domain_verification', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const acc = await loadAccount(ctx, client);
    if (!acc.ok) return { status: 'skipped', payload: { reason: acc.reason } };

    const businessId = acc.account.business?.id || null;
    if (!businessId) {
      return {
        status: 'skipped',
        payload: { reason: 'no Business Manager linked' },
        cost_cents: COST_CENTS
      };
    }

    let domains;
    try {
      domains = await client.graph(`${businessId}/owned_domains?fields=domain_name,is_verified&limit=200`);
    } catch (err) {
      return { status: 'skipped', payload: { reason: `owned_domains fetch failed: ${err.message}` } };
    }

    const rows = domains?.data || [];
    const unverified = rows.filter((d) => d.is_verified === false);

    return {
      status: rows.length === 0 || unverified.length > 0 ? 'fail' : 'pass',
      severity: rows.length === 0 || unverified.length > 0 ? 'warning' : null,
      payload: {
        business_id: businessId,
        domain_count: rows.length,
        unverified_domains: unverified.map((d) => d.domain_name)
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.account.attribution_setting — confirm 1d-click-7d-view (or agency std)
// ---------------------------------------------------------------------------
const STANDARD_ATTRIBUTION = { click: '1d', view: '7d' };

registerCheck('meta.account.attribution_setting', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const acc = await loadAccount(ctx, client);
    if (!acc.ok) return { status: 'skipped', payload: { reason: acc.reason } };

    // attribution_spec is an array of windows; we look at the first.
    const spec = Array.isArray(acc.account.attribution_spec) && acc.account.attribution_spec[0]
      ? acc.account.attribution_spec[0]
      : null;

    if (!spec) {
      return {
        status: 'skipped',
        payload: { reason: 'no attribution_spec returned by Meta' },
        cost_cents: COST_CENTS
      };
    }

    const click = spec.click_through_window ? `${spec.click_through_window}d` : null;
    const view = spec.view_through_window ? `${spec.view_through_window}d` : null;
    const matchesStandard = click === STANDARD_ATTRIBUTION.click && view === STANDARD_ATTRIBUTION.view;

    return {
      status: matchesStandard ? 'pass' : 'fail',
      severity: matchesStandard ? null : 'warning',
      payload: {
        agency_standard: STANDARD_ATTRIBUTION,
        configured: { click, view },
        matches_standard: matchesStandard
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.account.ios14_aem_priority — Aggregated Event Measurement priorities
// ---------------------------------------------------------------------------
registerCheck('meta.account.ios14_aem_priority', {
  umbrella: 'meta',
  tier: 'weekly_deep',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    const acc = await loadAccount(ctx, client);
    if (!acc.ok) return { status: 'skipped', payload: { reason: acc.reason } };

    const businessId = acc.account.business?.id || null;
    if (!businessId) {
      return {
        status: 'skipped',
        payload: { reason: 'no Business Manager linked' },
        cost_cents: COST_CENTS
      };
    }

    // AEM priorities are surfaced through /<business_id>/aggregated_event_measurement_settings
    // when permission is granted. If the endpoint isn't available we skip — never silently pass.
    let payload;
    try {
      payload = await client.graph(`${businessId}/aggregated_event_measurement_settings?limit=200`);
    } catch (err) {
      return {
        status: 'skipped',
        payload: { reason: `aggregated_event_measurement_settings unavailable: ${err.message}` },
        cost_cents: COST_CENTS
      };
    }

    const events = payload?.data || [];
    // Healthy: at least one configured AEM event with priority 1 = Lead/Purchase.
    const top = events.find((e) => Number(e.priority) === 1);
    const hasPrimary = !!top;

    return {
      status: hasPrimary ? 'pass' : 'fail',
      severity: hasPrimary ? null : 'warning',
      payload: {
        business_id: businessId,
        configured_event_count: events.length,
        priority_one: top || null,
        all: events.map((e) => ({ event_name: e.event_name, priority: e.priority, pixel_id: e.pixel_id }))
      },
      cost_cents: COST_CENTS
    };
  }
});

// ---------------------------------------------------------------------------
// meta.account.disapproved_ads
// ---------------------------------------------------------------------------
registerCheck('meta.account.disapproved_ads', {
  umbrella: 'meta',
  tier: 'daily_essential',
  costEstimate: COST_CENTS,
  requires: ['meta'],
  handler: async (ctx) => {
    const gate = await assertNonMedical(ctx);
    if (gate.skipped) return gate.outcome;

    const client = await getAdAccountClient(ctx);
    if (!client.ok) return adapterSkipOutcome(client.reason);

    let res;
    try {
      res = await client.graph(
        `${client.adAccountId}/ads?fields=id,name,effective_status,issues_info,configured_status&limit=500&filtering=${encodeURIComponent(
          JSON.stringify([
            { field: 'effective_status', operator: 'IN', value: ['DISAPPROVED', 'WITH_ISSUES', 'PENDING_REVIEW'] }
          ])
        )}`
      );
    } catch (err) {
      return { status: 'skipped', payload: { reason: `ads fetch failed: ${err.message}` } };
    }

    const ads = res?.data || [];
    const disapproved = ads.filter((a) => a.effective_status === 'DISAPPROVED');
    const withIssues = ads.filter((a) => a.effective_status === 'WITH_ISSUES');

    let status = 'pass';
    let severity = null;
    if (disapproved.length > 0) {
      status = 'fail';
      severity = 'critical';
    } else if (withIssues.length > 0) {
      status = 'fail';
      severity = 'warning';
    }

    return {
      status,
      severity,
      payload: {
        total_flagged: ads.length,
        disapproved_count: disapproved.length,
        with_issues_count: withIssues.length,
        disapproved: disapproved.map((a) => ({ id: a.id, name: a.name, issues: a.issues_info || [] })),
        with_issues: withIssues.map((a) => ({ id: a.id, name: a.name, issues: a.issues_info || [] }))
      },
      cost_cents: COST_CENTS
    };
  }
});
