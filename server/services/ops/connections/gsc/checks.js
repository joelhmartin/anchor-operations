/**
 * GSC check implementations (north-star §6.8).
 * Each check is a factory(deps) that returns an async handler(ctx).
 * Default registrations at the bottom call registerCheck with umbrella:'website'
 * so the existing executor runs them immediately. F1 will add serviceCategory/provider
 * when the capability gate lands.
 *
 * Dep injection pattern: all network + auth calls are injectable so tests
 * run with zero network. Production handlers are built with default deps.
 *
 * Drop checks use two-period comparison (current 7d vs prior 7d) so they
 * work without F3 baselines.
 */
import { registerCheck } from '../../checks/registry.js';
import { resolveGscToken as defaultResolveToken } from './auth.js';
import { getMatchedSite as defaultGetMatchedSite, listSites as defaultListSites } from './inventory.js';
import { querySearchAnalytics as defaultQueryAnalytics } from './snapshot.js';

const SITEMAPS_BASE = 'https://www.googleapis.com/webmasters/v3/sites';
const INSPECTION_ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function subtractDays(isoDate, days) {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function dropPct(current, prior) {
  if (!prior) return 0;
  return Math.round(((prior - current) / prior) * 100);
}

function sumClicks(rows) {
  return (rows || []).reduce((s, r) => s + (r.clicks || 0), 0);
}

function sumImpressions(rows) {
  return (rows || []).reduce((s, r) => s + (r.impressions || 0), 0);
}

// ---------------------------------------------------------------------------
// connection_health
// ---------------------------------------------------------------------------

export function makeConnectionHealthCheck({
  resolveToken = defaultResolveToken,
  listSites = defaultListSites
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials configured (GA4_SERVICE_ACCOUNT_KEY / ADC / OAuth)' } };
    try {
      const sites = await listSites(token, { signal: ctx.signal });
      return { status: 'pass', payload: { site_count: sites.length } };
    } catch (err) {
      return { status: 'error', severity: 'critical', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// site_access_missing
// ---------------------------------------------------------------------------

export function makeSiteAccessMissingCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  listSites = defaultListSites
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property for client' } };
    try {
      const sites = await listSites(token, { signal: ctx.signal });
      const accessible = new Set(sites.map((s) => s.siteUrl));
      if (accessible.has(matched.site_url)) {
        return { status: 'pass', payload: { site_url: matched.site_url } };
      }
      return {
        status: 'fail', severity: 'critical',
        payload: { site_url: matched.site_url, reason: 'Matched GSC property not accessible with current credentials' }
      };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// click_drop  (threshold: >20% drop in 7d clicks)
// ---------------------------------------------------------------------------

export function makeClickDropCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endCurrent = today();
    const startCurrent = subtractDays(endCurrent, 6);
    const endPrior = subtractDays(endCurrent, 7);
    const startPrior = subtractDays(endCurrent, 13);

    try {
      const [cur, prior] = await Promise.all([
        queryAnalytics(token, matched.site_url, { startDate: startCurrent, endDate: endCurrent, rowLimit: 1 }, { signal: ctx.signal }),
        queryAnalytics(token, matched.site_url, { startDate: startPrior,   endDate: endPrior,   rowLimit: 1 }, { signal: ctx.signal })
      ]);
      const curClicks   = sumClicks(cur.rows);
      const priorClicks = sumClicks(prior.rows);
      const pct = dropPct(curClicks, priorClicks);
      if (pct > 20) {
        return { status: 'fail', severity: 'warning', payload: { current_clicks: curClicks, prior_clicks: priorClicks, click_drop_pct: pct } };
      }
      return { status: 'pass', payload: { current_clicks: curClicks, prior_clicks: priorClicks, click_drop_pct: pct } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// impression_drop  (threshold: >25% drop in 7d impressions)
// ---------------------------------------------------------------------------

export function makeImpressionDropCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endCurrent = today();
    const startCurrent = subtractDays(endCurrent, 6);
    const endPrior = subtractDays(endCurrent, 7);
    const startPrior = subtractDays(endCurrent, 13);

    try {
      const [cur, prior] = await Promise.all([
        queryAnalytics(token, matched.site_url, { startDate: startCurrent, endDate: endCurrent, rowLimit: 1 }, { signal: ctx.signal }),
        queryAnalytics(token, matched.site_url, { startDate: startPrior,   endDate: endPrior,   rowLimit: 1 }, { signal: ctx.signal })
      ]);
      const curImp   = sumImpressions(cur.rows);
      const priorImp = sumImpressions(prior.rows);
      const pct = dropPct(curImp, priorImp);
      if (pct > 25) {
        return { status: 'fail', severity: 'warning', payload: { current_impressions: curImp, prior_impressions: priorImp, impression_drop_pct: pct } };
      }
      return { status: 'pass', payload: { current_impressions: curImp, prior_impressions: priorImp, impression_drop_pct: pct } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// page_decline  (threshold: any page drops >30% in clicks week-over-week)
// ---------------------------------------------------------------------------

export function makePageDeclineCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endCurrent = today();
    const startCurrent = subtractDays(endCurrent, 6);
    const endPrior = subtractDays(endCurrent, 7);
    const startPrior = subtractDays(endCurrent, 13);

    try {
      const [cur, prior] = await Promise.all([
        queryAnalytics(token, matched.site_url, { startDate: startCurrent, endDate: endCurrent, dimensions: ['page'], rowLimit: 1000 }, { signal: ctx.signal }),
        queryAnalytics(token, matched.site_url, { startDate: startPrior,   endDate: endPrior,   dimensions: ['page'], rowLimit: 1000 }, { signal: ctx.signal })
      ]);
      const priorMap = new Map((prior.rows || []).map((r) => [r.keys[0], r.clicks || 0]));
      const curMap   = new Map((cur.rows   || []).map((r) => [r.keys[0], r.clicks || 0]));
      const declining = [];
      for (const [url, priorClicks] of priorMap) {
        if (priorClicks >= 10) {
          const currentClicks = curMap.get(url) || 0;
          const pct = dropPct(currentClicks, priorClicks);
          if (pct > 30) declining.push({ url, current_clicks: currentClicks, prior_clicks: priorClicks, drop_pct: pct });
        }
      }
      if (declining.length) {
        declining.sort((a, b) => b.drop_pct - a.drop_pct);
        return { status: 'fail', severity: 'warning', payload: { declining_pages: declining.slice(0, 20) } };
      }
      return { status: 'pass', payload: { pages_checked: priorMap.size } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// query_decline  (threshold: any query drops >30% in clicks week-over-week)
// ---------------------------------------------------------------------------

export function makeQueryDeclineCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endCurrent = today();
    const startCurrent = subtractDays(endCurrent, 6);
    const endPrior = subtractDays(endCurrent, 7);
    const startPrior = subtractDays(endCurrent, 13);

    try {
      const [cur, prior] = await Promise.all([
        queryAnalytics(token, matched.site_url, { startDate: startCurrent, endDate: endCurrent, dimensions: ['query'], rowLimit: 1000 }, { signal: ctx.signal }),
        queryAnalytics(token, matched.site_url, { startDate: startPrior,   endDate: endPrior,   dimensions: ['query'], rowLimit: 1000 }, { signal: ctx.signal })
      ]);
      const priorMap = new Map((prior.rows || []).map((r) => [r.keys[0], r.clicks || 0]));
      const curMap   = new Map((cur.rows   || []).map((r) => [r.keys[0], r.clicks || 0]));
      const declining = [];
      for (const [q, priorClicks] of priorMap) {
        if (priorClicks >= 5) {
          const currentClicks = curMap.get(q) || 0;
          const pct = dropPct(currentClicks, priorClicks);
          if (pct > 30) declining.push({ query: q, current_clicks: currentClicks, prior_clicks: priorClicks, drop_pct: pct });
        }
      }
      if (declining.length) {
        declining.sort((a, b) => b.drop_pct - a.drop_pct);
        return { status: 'fail', severity: 'warning', payload: { declining_queries: declining.slice(0, 20) } };
      }
      return { status: 'pass', payload: { queries_checked: priorMap.size } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// query_opportunity  (impressions>500, CTR<0.05, position 5-20 → advisory)
// ---------------------------------------------------------------------------

export function makeQueryOpportunityCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endDate = today();
    const startDate = subtractDays(endDate, 27);

    try {
      const data = await queryAnalytics(token, matched.site_url, { startDate, endDate, dimensions: ['query'], rowLimit: 5000 }, { signal: ctx.signal });
      const opps = (data.rows || [])
        .filter((r) => r.impressions >= 500 && r.ctr < 0.05 && r.position >= 5 && r.position <= 20)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 20)
        .map((r) => ({ query: r.keys[0], impressions: r.impressions, clicks: r.clicks, ctr: r.ctr, position: r.position }));
      return { status: 'pass', payload: { opportunities: opps, total_opportunities: opps.length } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// page_indexing_issue  (sitemap submitted vs indexed ratio < 0.7)
// ---------------------------------------------------------------------------

export function makePageIndexingIssueCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  fetchSitemaps = null
} = {}) {
  const defaultFetchSitemaps = async (token, siteUrl, signal) => {
    const url = `${SITEMAPS_BASE}/${encodeURIComponent(siteUrl)}/sitemaps`;
    const res = await globalThis.fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      ...(signal ? { signal } : {})
    });
    if (!res.ok) throw new Error(`GSC sitemaps ${res.status}`);
    return res.json();
  };

  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const fetcher = fetchSitemaps || defaultFetchSitemaps;
    try {
      const data = await fetcher(token, matched.site_url, ctx.signal);
      const sitemaps = data.sitemap || [];
      const totals = sitemaps.reduce((acc, s) => {
        acc.submitted += Number(s.contents?.[0]?.submitted || 0);
        acc.indexed   += Number(s.contents?.[0]?.indexed   || 0);
        return acc;
      }, { submitted: 0, indexed: 0 });

      if (!totals.submitted) {
        return { status: 'skipped', payload: { reason: 'no sitemaps submitted to GSC' } };
      }
      const ratio = totals.indexed / totals.submitted;
      if (ratio < 0.7) {
        return {
          status: 'fail', severity: 'warning',
          payload: { submitted: totals.submitted, indexed: totals.indexed, indexed_ratio: ratio, site_url: matched.site_url }
        };
      }
      return { status: 'pass', payload: { submitted: totals.submitted, indexed: totals.indexed, indexed_ratio: ratio } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// canonical_mismatch  (URL inspection on top 10 pages by impressions)
// ---------------------------------------------------------------------------

export function makeCanonicalMismatchCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics,
  inspectUrl = null
} = {}) {
  const defaultInspectUrl = async (token, inspectionUrl, siteUrl, signal) => {
    const res = await globalThis.fetch(INSPECTION_ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ inspectionUrl, siteUrl }),
      ...(signal ? { signal } : {})
    });
    if (!res.ok) throw new Error(`GSC urlInspection ${res.status}`);
    return res.json();
  };

  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endDate = today();
    const startDate = subtractDays(endDate, 27);
    const inspector = inspectUrl || defaultInspectUrl;

    try {
      const data = await queryAnalytics(token, matched.site_url, { startDate, endDate, dimensions: ['page'], rowLimit: 10 }, { signal: ctx.signal });
      const topPages = (data.rows || []).slice(0, 10).map((r) => r.keys[0]);
      const mismatches = [];

      for (const pageUrl of topPages) {
        try {
          const inspection = await inspector(token, pageUrl, matched.site_url, ctx.signal);
          const result = inspection.inspectionResult?.indexStatusResult;
          if (result) {
            const googleCanonical = result.googleCanonical || result.userCanonical;
            if (googleCanonical && googleCanonical !== pageUrl) {
              mismatches.push({ url: pageUrl, google_canonical: googleCanonical });
            }
          }
        } catch {
          // single page inspection failure is non-fatal
        }
      }

      if (mismatches.length) {
        return { status: 'fail', severity: 'warning', payload: { mismatches, pages_inspected: topPages.length } };
      }
      return { status: 'pass', payload: { pages_inspected: topPages.length } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// device_specific_drop  (threshold: any device drops >25% while aggregate stable)
// ---------------------------------------------------------------------------

export function makeDeviceSpecificDropCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endCurrent = today();
    const startCurrent = subtractDays(endCurrent, 6);
    const endPrior = subtractDays(endCurrent, 7);
    const startPrior = subtractDays(endCurrent, 13);

    try {
      const [cur, prior] = await Promise.all([
        queryAnalytics(token, matched.site_url, { startDate: startCurrent, endDate: endCurrent, dimensions: ['device'], rowLimit: 10 }, { signal: ctx.signal }),
        queryAnalytics(token, matched.site_url, { startDate: startPrior,   endDate: endPrior,   dimensions: ['device'], rowLimit: 10 }, { signal: ctx.signal })
      ]);

      const priorMap = new Map((prior.rows || []).map((r) => [r.keys[0], r.clicks || 0]));
      const curMap   = new Map((cur.rows   || []).map((r) => [r.keys[0], r.clicks || 0]));
      const affected = [];
      for (const [device, priorClicks] of priorMap) {
        if (priorClicks >= 10) {
          const currentClicks = curMap.get(device) || 0;
          const pct = dropPct(currentClicks, priorClicks);
          if (pct > 25) affected.push({ device, current_clicks: currentClicks, prior_clicks: priorClicks, drop_pct: pct });
        }
      }

      // Only flag if total clicks did NOT drop comparably (device-specific anomaly)
      if (affected.length) {
        const totalCur   = sumClicks(cur.rows);
        const totalPrior = sumClicks(prior.rows);
        const aggregatePct = dropPct(totalCur, totalPrior);
        if (aggregatePct < 15) {
          // Aggregate is stable — device drop is device-specific
          return { status: 'fail', severity: 'warning', payload: { affected_devices: affected.map((a) => a.device), devices: affected } };
        }
      }
      return { status: 'pass', payload: { devices_checked: (cur.rows || []).length } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// zero_click_high_impression_pages  (impressions>1000, clicks=0 → fail/warning)
// ---------------------------------------------------------------------------

export function makeZeroClickHighImpressionCheck({
  resolveToken = defaultResolveToken,
  getMatchedSite = defaultGetMatchedSite,
  queryAnalytics = defaultQueryAnalytics
} = {}) {
  return async (ctx) => {
    const token = await resolveToken({ env: process.env }).catch(() => null);
    if (!token) return { status: 'skipped', payload: { reason: 'no GSC credentials' } };
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return { status: 'skipped', payload: { reason: 'no matched GSC property' } };

    const endDate = today();
    const startDate = subtractDays(endDate, 27);

    try {
      const data = await queryAnalytics(token, matched.site_url, { startDate, endDate, dimensions: ['page'], rowLimit: 5000 }, { signal: ctx.signal });
      const zero = (data.rows || [])
        .filter((r) => (r.impressions || 0) >= 1000 && (r.clicks || 0) === 0)
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 20)
        .map((r) => ({ url: r.keys[0], impressions: r.impressions, position: r.position }));

      if (zero.length) {
        return { status: 'fail', severity: 'warning', payload: { pages: zero, total_zero_click_pages: zero.length } };
      }
      return { status: 'pass', payload: { pages_checked: (data.rows || []).length } };
    } catch (err) {
      return { status: 'error', severity: 'warning', payload: { error: err.message } };
    }
  };
}

// ---------------------------------------------------------------------------
// Default registrations — umbrella:'website' keeps executor running them now.
// F1's registry shim will translate to serviceCategory:'organic_search' when it lands.
// ---------------------------------------------------------------------------

const TIER = 'weekly_deep';

registerCheck('gsc.connection_health',             { umbrella: 'website', tier: 'daily_essential', costEstimate: 0, requires: [], handler: makeConnectionHealthCheck() });
registerCheck('gsc.site_access_missing',           { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeSiteAccessMissingCheck() });
registerCheck('gsc.click_drop',                    { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeClickDropCheck() });
registerCheck('gsc.impression_drop',               { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeImpressionDropCheck() });
registerCheck('gsc.page_decline',                  { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makePageDeclineCheck() });
registerCheck('gsc.query_decline',                 { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeQueryDeclineCheck() });
registerCheck('gsc.query_opportunity',             { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeQueryOpportunityCheck() });
registerCheck('gsc.page_indexing_issue',           { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makePageIndexingIssueCheck() });
registerCheck('gsc.canonical_mismatch',            { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeCanonicalMismatchCheck() });
registerCheck('gsc.device_specific_drop',          { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeDeviceSpecificDropCheck() });
registerCheck('gsc.zero_click_high_impression_pages', { umbrella: 'website', tier: TIER, costEstimate: 0, requires: [], handler: makeZeroClickHighImpressionCheck() });
