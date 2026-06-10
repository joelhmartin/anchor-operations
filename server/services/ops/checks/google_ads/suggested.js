/**
 * Google Ads — suggested additional checks (Phase 4 §6.6).
 *
 * Registered:
 *   gads.account.smart_bidding.adoption       (% campaigns on Maximize Conv /
 *                                              Target CPA / Target ROAS)
 *   gads.search_terms.brand_competitors        (competitor brands in top-20
 *                                              search terms by impressions)
 *   gads.account.url_options.tracking_template (UTM params present)
 *   gads.account.final_url_suffix
 *   gads.account.experiments.active            (running > 60d without conclusion)
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { withCustomerCached } from './_client.js';

function dateNDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

const SMART_BIDDING_STRATEGIES = new Set([
  'MAXIMIZE_CONVERSIONS',
  'MAXIMIZE_CONVERSION_VALUE',
  'TARGET_CPA',
  'TARGET_ROAS',
  'TARGET_IMPRESSION_SHARE'
]);

// ---------------------------------------------------------------------------
// gads.account.smart_bidding.adoption
// ---------------------------------------------------------------------------
registerCheck('gads.account.smart_bidding.adoption', {
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
        SELECT campaign.id, campaign.name, campaign.bidding_strategy_type
        FROM campaign
        WHERE campaign.status = 'ENABLED'
      `);
      const total = rows.length;
      const smart = rows.filter((r) =>
        SMART_BIDDING_STRATEGIES.has(r.campaign?.bidding_strategy_type)
      ).length;
      const pct = total > 0 ? Math.round((smart / total) * 1000) / 10 : 0;
      const severity = total > 0 && pct < 50 ? 'warning' : null;
      return {
        status: severity ? 'fail' : 'pass',
        severity,
        payload: {
          customer_id: customerId,
          enabled_campaign_count: total,
          smart_bidding_count: smart,
          adoption_pct: pct
        }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

// ---------------------------------------------------------------------------
// gads.search_terms.brand_competitors
// ---------------------------------------------------------------------------
async function clientCompanyTerms(clientUserId) {
  const { rows } = await query(
    `SELECT company_name, business_name, website_url
       FROM client_profiles
      WHERE user_id = $1
      LIMIT 1`,
    [clientUserId]
  ).catch(() => ({ rows: [] }));
  const profile = rows[0] || {};
  const terms = [profile.company_name, profile.business_name]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase().split(/\s+/).filter((p) => p.length > 2))
    .flat();
  // Add domain hostname stem.
  if (profile.website_url) {
    try {
      const host = new URL(profile.website_url).hostname.replace(/^www\./, '');
      const stem = host.split('.')[0];
      if (stem && stem.length > 2) terms.push(stem.toLowerCase());
    } catch {
      /* ignore */
    }
  }
  return Array.from(new Set(terms));
}

registerCheck('gads.search_terms.brand_competitors', {
  umbrella: 'google_ads',
  tier: 'weekly_deep',
  costEstimate: 1,
  requires: ['google_ads'],
  handler: async (ctx) => {
    const resolved = await withCustomerCached(ctx);
    if (resolved.skipped) return { status: 'skipped', payload: { reason: resolved.reason } };
    const { customer, customerId } = resolved;

    const ownTerms = await clientCompanyTerms(ctx.clientUserId);
    const start = dateNDaysAgo(30);
    const today = new Date().toISOString().slice(0, 10);

    let rows = [];
    try {
      rows = await customer.query(`
        SELECT search_term_view.search_term,
               metrics.impressions,
               metrics.clicks,
               metrics.cost_micros
        FROM search_term_view
        WHERE segments.date BETWEEN '${start}' AND '${today}'
        ORDER BY metrics.impressions DESC
        LIMIT 20
      `);
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }

    // Heuristic: a search term is a "competitor brand" candidate if it does
    // NOT contain any of the client's own brand tokens AND looks like a brand
    // name (single token of length ≥ 4, no obviously-generic stop words).
    const stops = new Set(['near', 'best', 'cheap', 'free', 'open', 'store', 'shop', 'reviews', 'price', 'cost']);
    const candidates = [];
    for (const r of rows) {
      const term = (r.search_term_view?.search_term || '').toLowerCase().trim();
      if (!term) continue;
      const tokens = term.split(/\s+/);
      const isBrand = tokens.length === 1 && tokens[0].length >= 4 && !stops.has(tokens[0]);
      const isOwn = ownTerms.some((own) => term.includes(own));
      if (isBrand && !isOwn) {
        candidates.push({
          search_term: term,
          impressions: Number(r.metrics?.impressions || 0),
          clicks: Number(r.metrics?.clicks || 0),
          spend: Math.round((Number(r.metrics?.cost_micros || 0) / 1_000_000) * 100) / 100
        });
      }
    }

    const severity = candidates.length ? 'warning' : null;
    return {
      status: severity ? 'fail' : 'pass',
      severity,
      payload: {
        customer_id: customerId,
        own_brand_tokens: ownTerms,
        candidate_count: candidates.length,
        candidates,
        method: 'heuristic_single_token_brand'
      }
    };
  }
});

// ---------------------------------------------------------------------------
// gads.account.url_options.tracking_template
// ---------------------------------------------------------------------------
function looksLikeUtm(template) {
  if (!template) return false;
  return /utm_source=|utm_medium=|utm_campaign=/i.test(template);
}

registerCheck('gads.account.url_options.tracking_template', {
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
        SELECT customer.tracking_url_template
        FROM customer
        LIMIT 1
      `);
      const template = rows[0]?.customer?.tracking_url_template || '';
      const hasUtms = looksLikeUtm(template);
      const severity = template ? (hasUtms ? null : 'warning') : 'warning';
      return {
        status: severity ? 'fail' : 'pass',
        severity,
        payload: {
          customer_id: customerId,
          tracking_url_template: template || null,
          has_utm_params: hasUtms
        }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

// ---------------------------------------------------------------------------
// gads.account.final_url_suffix
// ---------------------------------------------------------------------------
registerCheck('gads.account.final_url_suffix', {
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
        SELECT customer.final_url_suffix
        FROM customer
        LIMIT 1
      `);
      const suffix = rows[0]?.customer?.final_url_suffix || '';
      // Informational — we surface the value but don't fail without one.
      return {
        status: 'pass',
        severity: null,
        payload: {
          customer_id: customerId,
          final_url_suffix: suffix || null
        }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});

// ---------------------------------------------------------------------------
// gads.account.experiments.active
// ---------------------------------------------------------------------------
registerCheck('gads.account.experiments.active', {
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
        SELECT experiment.resource_name, experiment.name, experiment.status,
               experiment.start_date, experiment.end_date
        FROM experiment
        WHERE experiment.status IN ('RUNNING', 'ENABLED')
      `).catch(() => []);

      const cutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
      const stale = [];
      for (const row of rows) {
        const exp = row.experiment || {};
        const start = exp.start_date ? Date.parse(exp.start_date) : null;
        if (start && start < cutoff) {
          stale.push({
            name: exp.name || '',
            status: exp.status || '',
            start_date: exp.start_date || null,
            end_date: exp.end_date || null,
            age_days: Math.floor((Date.now() - start) / (1000 * 60 * 60 * 24))
          });
        }
      }

      const severity = stale.length ? 'warning' : null;
      return {
        status: severity ? 'fail' : 'pass',
        severity,
        payload: {
          customer_id: customerId,
          active_experiment_count: rows.length,
          stale_count: stale.length,
          stale,
          stale_threshold_days: 60
        }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { customer_id: customerId, error: err.message } };
    }
  }
});
