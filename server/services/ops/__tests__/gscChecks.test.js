import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeConnectionHealthCheck,
  makeSiteAccessMissingCheck,
  makeClickDropCheck,
  makeImpressionDropCheck,
  makePageDeclineCheck,
  makeQueryDeclineCheck,
  makeQueryOpportunityCheck,
  makePageIndexingIssueCheck,
  makeDeviceSpecificDropCheck,
  makeZeroClickHighImpressionCheck
} from '../connections/gsc/checks.js';

const SITE = { site_url: 'sc-domain:example.com' };
const CTX  = { clientUserId: 'cuid-1', signal: null, config: {} };

// ── connection_health ────────────────────────────────────────────────────────

test('gsc.connection_health: pass when sites accessible', async () => {
  const h = makeConnectionHealthCheck({
    resolveToken: async () => 'tok',
    listSites: async () => [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }]
  });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
  assert.equal(r.payload.site_count, 1);
});

test('gsc.connection_health: skipped when no token', async () => {
  const h = makeConnectionHealthCheck({ resolveToken: async () => null, listSites: async () => [] });
  const r = await h(CTX);
  assert.equal(r.status, 'skipped');
  assert.ok(r.payload.reason);
});

test('gsc.connection_health: skipped (not error/critical) when listSites returns 403', async () => {
  const err403 = Object.assign(new Error('GSC sites.list 403'), { status: 403 });
  const h = makeConnectionHealthCheck({
    resolveToken: async () => 'tok',
    listSites: async () => { throw err403; }
  });
  const r = await h(CTX);
  assert.equal(r.status, 'skipped');
  assert.ok(r.payload.reason.includes('40x'), 'reason should mention 40x');
});

test('gsc.connection_health: skipped (not error/critical) when listSites returns 401', async () => {
  const err401 = Object.assign(new Error('GSC sites.list 401'), { status: 401 });
  const h = makeConnectionHealthCheck({
    resolveToken: async () => 'tok',
    listSites: async () => { throw err401; }
  });
  const r = await h(CTX);
  assert.equal(r.status, 'skipped');
  assert.ok(r.payload.reason.includes('40x'), 'reason should mention 40x');
});

test('gsc.connection_health: error/warning (not critical) on non-auth listSites failure', async () => {
  const h = makeConnectionHealthCheck({
    resolveToken: async () => 'tok',
    listSites: async () => { throw new Error('network timeout'); }
  });
  const r = await h(CTX);
  assert.equal(r.status, 'error');
  assert.equal(r.severity, 'warning');
  assert.ok(r.payload.error, 'should include error message');
});

// ── site_access_missing ──────────────────────────────────────────────────────

test('gsc.site_access_missing: pass when matched site accessible', async () => {
  const h = makeSiteAccessMissingCheck({
    resolveToken: async () => 'tok',
    getMatchedSite: async () => SITE,
    listSites: async () => [{ siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' }]
  });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
});

test('gsc.site_access_missing: fail when matched site not in accessible list', async () => {
  const h = makeSiteAccessMissingCheck({
    resolveToken: async () => 'tok',
    getMatchedSite: async () => SITE,
    listSites: async () => [{ siteUrl: 'sc-domain:other.com', permissionLevel: 'siteOwner' }]
  });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'critical');
});

// ── click_drop ───────────────────────────────────────────────────────────────

test('gsc.click_drop: fail when current 7d clicks < 80% of prior 7d', async () => {
  let callNum = 0;
  const queryAnalytics = async () => {
    callNum += 1;
    // First call = current period (low clicks), second = prior period (high clicks)
    const clicks = callNum === 1 ? 400 : 1000;
    return { rows: [{ clicks, impressions: 10000, ctr: clicks / 10000, position: 8 }] };
  };
  const h = makeClickDropCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.ok(r.payload.click_drop_pct >= 60);
  assert.ok(r.payload.current_clicks === 400);
  assert.ok(r.payload.prior_clicks === 1000);
});

test('gsc.click_drop: pass when clicks stable', async () => {
  const queryAnalytics = async () => ({ rows: [{ clicks: 950, impressions: 10000, ctr: 0.095, position: 7 }] });
  const h = makeClickDropCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
});

// ── impression_drop ──────────────────────────────────────────────────────────

test('gsc.impression_drop: fail when current 7d impressions < 75% of prior', async () => {
  let n = 0;
  const queryAnalytics = async () => ({ rows: [{ clicks: 100, impressions: ++n === 1 ? 5000 : 20000, ctr: 0.02, position: 10 }] });
  const h = makeImpressionDropCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.ok(r.payload.impression_drop_pct >= 75);
});

// ── page_decline ─────────────────────────────────────────────────────────────

test('gsc.page_decline: fail when a page drops > 30% in clicks', async () => {
  let n = 0;
  const queryAnalytics = async () => {
    n += 1;
    const clicks = n === 1 ? 100 : 500;
    return { rows: [{ keys: ['/blog/seo-tips'], clicks, impressions: 5000, ctr: clicks / 5000, position: 8 }] };
  };
  const h = makePageDeclineCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.ok(r.payload.declining_pages.length >= 1);
  assert.equal(r.payload.declining_pages[0].url, '/blog/seo-tips');
  assert.ok(r.payload.declining_pages[0].drop_pct >= 80);
});

test('gsc.page_decline: detects page that disappears entirely from current results', async () => {
  let n = 0;
  const queryAnalytics = async () => {
    n += 1;
    // current (n=1): page gone (zero rows); prior (n=2): 200 clicks
    if (n === 1) return { rows: [] };
    return { rows: [{ keys: ['/dropped/'], clicks: 200, impressions: 5000, ctr: 0.04, position: 6 }] };
  };
  const h = makePageDeclineCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.payload.declining_pages[0].url, '/dropped/');
  assert.equal(r.payload.declining_pages[0].current_clicks, 0);
  assert.equal(r.payload.declining_pages[0].drop_pct, 100);
});

// ── query_decline ─────────────────────────────────────────────────────────────

test('gsc.query_decline: fail when a query drops > 30% in clicks', async () => {
  let n = 0;
  const queryAnalytics = async () => {
    n += 1;
    const clicks = n === 1 ? 50 : 300;
    return { rows: [{ keys: ['seo agency'], clicks, impressions: 3000, ctr: clicks / 3000, position: 5 }] };
  };
  const h = makeQueryDeclineCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.ok(r.payload.declining_queries[0].query === 'seo agency');
});

// ── query_opportunity ─────────────────────────────────────────────────────────

test('gsc.query_opportunity: pass with opportunities array when queries qualify', async () => {
  const queryAnalytics = async () => ({
    rows: [
      { keys: ['digital marketing agency'], clicks: 20, impressions: 3000, ctr: 0.007, position: 11.5 },
      { keys: ['seo near me'],              clicks: 300, impressions: 8000, ctr: 0.038, position: 3.0 }  // not qualifying (high CTR)
    ]
  });
  const h = makeQueryOpportunityCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
  assert.equal(r.payload.opportunities.length, 1);
  assert.equal(r.payload.opportunities[0].query, 'digital marketing agency');
  assert.ok(r.payload.opportunities[0].impressions === 3000);
  assert.ok(r.payload.opportunities[0].position === 11.5);
});

// ── page_indexing_issue ───────────────────────────────────────────────────────

test('gsc.page_indexing_issue: fail when indexed_ratio < 0.7', async () => {
  const fetchSitemaps = async () => ({
    siteEntry: [],
    sitemap: [{ contents: [{ submitted: '100', indexed: '60' }] }]
  });
  const h = makePageIndexingIssueCheck({
    resolveToken: async () => 'tok',
    getMatchedSite: async () => SITE,
    fetchSitemaps
  });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.ok(r.payload.indexed_ratio < 0.7);
  assert.equal(r.payload.submitted, 100);
  assert.equal(r.payload.indexed, 60);
});

test('gsc.page_indexing_issue: pass when indexed_ratio >= 0.7', async () => {
  const fetchSitemaps = async () => ({
    sitemap: [{ contents: [{ submitted: '100', indexed: '90' }] }]
  });
  const h = makePageIndexingIssueCheck({
    resolveToken: async () => 'tok',
    getMatchedSite: async () => SITE,
    fetchSitemaps
  });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
});

// ── device_specific_drop ──────────────────────────────────────────────────────

test('gsc.device_specific_drop: fail when mobile drops while desktop stable', async () => {
  let n = 0;
  const queryAnalytics = async () => {
    n += 1;
    // current (n=1): mobile low, desktop dominates and stays stable
    // prior  (n=2): mobile high, desktop same
    // aggregate drop = (5100 - 5500) / 5500 = ~7% < 15% threshold → device-specific
    const mobileClicks  = n === 1 ? 100 : 500;
    const desktopClicks = 5000;
    return {
      rows: [
        { keys: ['MOBILE'],  clicks: mobileClicks,  impressions: 10000, ctr: mobileClicks / 10000,  position: 15 },
        { keys: ['DESKTOP'], clicks: desktopClicks, impressions: 80000, ctr: desktopClicks / 80000, position: 12 }
      ]
    };
  };
  const h = makeDeviceSpecificDropCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.ok(r.payload.affected_devices.includes('MOBILE'));
});

// ── zero_click_high_impression ────────────────────────────────────────────────

test('gsc.zero_click_high_impression_pages: fail when pages have high impressions + 0 clicks', async () => {
  const queryAnalytics = async () => ({
    rows: [
      { keys: ['/landing/'], clicks: 0, impressions: 2500, ctr: 0, position: 3.2 },
      { keys: ['/about/'],   clicks: 50, impressions: 1500, ctr: 0.033, position: 5.1 }
    ]
  });
  const h = makeZeroClickHighImpressionCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warning');
  assert.equal(r.payload.pages.length, 1);
  assert.equal(r.payload.pages[0].url, '/landing/');
  assert.equal(r.payload.pages[0].impressions, 2500);
});

test('gsc.zero_click_high_impression_pages: pass when no qualifying pages', async () => {
  const queryAnalytics = async () => ({
    rows: [{ keys: ['/about/'], clicks: 50, impressions: 1500, ctr: 0.033, position: 5.1 }]
  });
  const h = makeZeroClickHighImpressionCheck({ resolveToken: async () => 'tok', getMatchedSite: async () => SITE, queryAnalytics });
  const r = await h(CTX);
  assert.equal(r.status, 'pass');
});
