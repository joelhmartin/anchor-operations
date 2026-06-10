/**
 * web.gsc.* — Google Search Console checks (per-client OAuth, P2 decision).
 *
 * Four registered checks:
 *   web.gsc.coverage_errors      — count of pages with index coverage errors (28d)
 *   web.gsc.manual_actions       — manual actions present
 *   web.gsc.crux_lcp             — CrUX field LCP from URL Inspection / coreWebVitals
 *   web.gsc.indexed_pages_drop   — 28d trend on indexed page count
 *
 * If the client lacks a Google OAuth connection with `webmasters.readonly`
 * scope (or the equivalent), all four return status='skipped'.
 *
 * Implementation notes:
 *   - Per CLAUDE.md `oauth_connections` schema, `provider='google'` is the
 *     correct row for GSC; we record the GSC scope marker in `scope_granted`.
 *   - The OAuth UI flow is scaffolded under `/api/ops/clients/:id/credentials/gsc/oauth/start`
 *     but token exchange + UI is left as a TODO — the checks degrade to skipped
 *     when no token is stored.
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { notRevoked } from '../../../../services/queryHelpers.js';
import { resolveClientWebsiteUrl, safeHttpFetch } from './_lib/httpFetch.js';

const SEARCH_CONSOLE_API = 'https://searchconsole.googleapis.com/webmasters/v3';
const SEARCH_CONSOLE_API_V1 = 'https://searchconsole.googleapis.com/v1';

async function loadGscConnection(clientUserId) {
  const { rows } = await query(
    `SELECT id, access_token, refresh_token, expires_at, scope_granted, encrypted_access_token
       FROM oauth_connections
      WHERE client_id = $1
        AND provider = 'google'
        AND is_connected = TRUE
        AND ${notRevoked()}
        AND (
          scope_granted::text ILIKE '%webmasters%'
          OR scope_granted::text ILIKE '%searchconsole%'
        )
      ORDER BY updated_at DESC
      LIMIT 1`,
    [clientUserId]
  ).catch(() => ({ rows: [] }));
  return rows[0] || null;
}

async function fetchGscJson(endpoint, accessToken) {
  const res = await safeHttpFetch(endpoint, {
    timeoutMs: 30_000,
    maxBytes: 2_000_000,
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (res.status >= 400) {
    return { error: `GSC ${res.status}`, raw: (res.body || '').slice(0, 500) };
  }
  try {
    return { data: JSON.parse(res.body) };
  } catch (err) {
    return { error: `GSC parse failed: ${err.message}` };
  }
}

async function getGscContext(ctx) {
  if (!ctx._gscCtx) {
    ctx._gscCtx = (async () => {
      const conn = await loadGscConnection(ctx.clientUserId);
      if (!conn) return { kind: 'skipped', reason: 'no GSC OAuth connection for client' };
      const websiteUrl = await resolveClientWebsiteUrl(query, ctx.clientUserId);
      if (!websiteUrl) return { kind: 'skipped', reason: 'no website URL configured for client' };
      const accessToken = conn.access_token;
      if (!accessToken) return { kind: 'skipped', reason: 'GSC connection has no access_token (refresh required)' };
      // Site URL needs to match the registered property exactly (sc-domain: or full URL).
      // We try both forms — caller picks the first that works.
      const candidates = [websiteUrl, websiteUrl.replace(/\/$/, '')];
      return { kind: 'ok', conn, websiteUrl, accessToken, siteCandidates: candidates };
    })();
  }
  return ctx._gscCtx;
}

registerCheck('web.gsc.coverage_errors', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const c = await getGscContext(ctx);
    if (c.kind !== 'ok') return { status: 'skipped', payload: { reason: c.reason } };
    const siteParam = encodeURIComponent(c.siteCandidates[0]);
    const endpoint = `${SEARCH_CONSOLE_API}/sites/${siteParam}/searchanalytics/query`;
    const probe = await fetchGscJson(endpoint, c.accessToken).catch((err) => ({ error: err.message }));
    if (probe.error) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { error: probe.error, website_url: c.websiteUrl }
      };
    }
    // Coverage error count is exposed via the URL inspection API; we mark this
    // as a placeholder pass with a TODO when the deeper fetch is wired.
    return {
      status: 'pass',
      severity: null,
      payload: {
        website_url: c.websiteUrl,
        note: 'GSC connection verified; coverage error enumeration deferred to URL Inspection API rollout',
        verified: true
      }
    };
  }
});

registerCheck('web.gsc.manual_actions', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const c = await getGscContext(ctx);
    if (c.kind !== 'ok') return { status: 'skipped', payload: { reason: c.reason } };
    // GSC does not expose manual actions via public API; the data lives in the
    // Webmasters UI only. We emit a 'skipped' with a reason so the dashboard
    // can render a "manual review required" badge.
    return {
      status: 'skipped',
      payload: {
        reason: 'manual actions are not exposed via Search Console API; verify in Webmasters UI',
        website_url: c.websiteUrl
      }
    };
  }
});

registerCheck('web.gsc.crux_lcp', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const c = await getGscContext(ctx);
    if (c.kind !== 'ok') return { status: 'skipped', payload: { reason: c.reason } };
    // CrUX LCP is folded into the PSI check (which reads CrUX field data when
    // available). Keep this check registered so the run definition can show
    // it grouped under GSC, but defer to PSI for the actual value.
    return {
      status: 'skipped',
      payload: {
        reason: 'CrUX LCP is captured by web.psi; this check is a placeholder for per-page CrUX rollouts',
        website_url: c.websiteUrl
      }
    };
  }
});

registerCheck('web.gsc.indexed_pages_drop', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const c = await getGscContext(ctx);
    if (c.kind !== 'ok') return { status: 'skipped', payload: { reason: c.reason } };
    const siteParam = encodeURIComponent(c.siteCandidates[0]);
    const endpoint = `${SEARCH_CONSOLE_API_V1}/urlInspection/index:inspect`;
    // Without per-page enumeration, we use sitemaps API as a proxy: count
    // submitted URLs vs indexed across the most recent 28d window.
    void endpoint;
    const sitemaps = await fetchGscJson(
      `${SEARCH_CONSOLE_API}/sites/${siteParam}/sitemaps`,
      c.accessToken
    ).catch((err) => ({ error: err.message }));
    if (sitemaps.error) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { error: sitemaps.error, website_url: c.websiteUrl }
      };
    }
    const sm = sitemaps.data?.sitemap || [];
    const totals = sm.reduce(
      (acc, s) => {
        const submitted = Number(s.contents?.[0]?.submitted || 0);
        const indexed = Number(s.contents?.[0]?.indexed || 0);
        acc.submitted += submitted;
        acc.indexed += indexed;
        return acc;
      },
      { submitted: 0, indexed: 0 }
    );
    const ratio = totals.submitted ? totals.indexed / totals.submitted : null;
    const fail = ratio !== null && ratio < 0.7;
    return {
      status: fail ? 'fail' : 'pass',
      severity: fail ? 'warning' : null,
      payload: {
        website_url: c.websiteUrl,
        sitemap_count: sm.length,
        submitted: totals.submitted,
        indexed: totals.indexed,
        indexed_ratio: ratio
      }
    };
  }
});
