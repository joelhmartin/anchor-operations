/**
 * web.tracking_install — homepage GTM/GA4/Meta Pixel verification.
 *
 * Re-implementation of the legacy `verify_tracking_install` AI tool, ported
 * here so the check runs as part of scheduled ops runs (not just inside the
 * AI assistant). Uses the SSRF-guarded fetch helper and cross-references
 * tracking_configs for expected IDs.
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { resolveClientWebsiteUrl, safeHttpFetch } from './_lib/httpFetch.js';

registerCheck('web.tracking_install', {
  umbrella: 'website',
  tier: 'daily_essential',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const websiteUrl = await resolveClientWebsiteUrl(query, ctx.clientUserId);
    if (!websiteUrl) {
      return { status: 'skipped', payload: { reason: 'no website URL configured for client' } };
    }

    let res;
    try {
      res = await safeHttpFetch(websiteUrl, { timeoutMs: 12_000, maxBytes: 750_000, signal: ctx.signal });
    } catch (err) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { website_url: websiteUrl, error: err.message }
      };
    }

    const head = (res.body || '').slice(0, 200_000);
    const gtmMatch = head.match(/GTM-[A-Z0-9]+/);
    const ga4Match = head.match(/G-[A-Z0-9]{6,}/);
    const fbqMatch = head.match(/fbq\(['"]init['"],\s*['"](\d+)['"]/);

    // Cross-ref against tracking_configs for this client.
    const cfgRes = await query(
      `SELECT gtm_container_id, ga4_measurement_id, meta_pixel_id, client_type
         FROM tracking_configs
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 1`,
      [ctx.clientUserId]
    ).catch(() => ({ rows: [] }));
    const expected = cfgRes.rows[0] || null;

    const gtmMatches = expected?.gtm_container_id ? gtmMatch?.[0] === expected.gtm_container_id : null;
    const ga4Matches = expected?.ga4_measurement_id ? ga4Match?.[0] === expected.ga4_measurement_id : null;

    const issues = [];
    if (expected?.gtm_container_id && !gtmMatch) {
      issues.push({ kind: 'gtm_missing', summary: 'No GTM tag detected on homepage', severity: 'critical' });
    } else if (expected?.gtm_container_id && gtmMatches === false) {
      issues.push({
        kind: 'gtm_mismatch',
        summary: `GTM mismatch: page has ${gtmMatch?.[0]}, expected ${expected.gtm_container_id}`,
        severity: 'warning'
      });
    }
    if (expected?.ga4_measurement_id && !ga4Match) {
      issues.push({ kind: 'ga4_missing', summary: 'No GA4 tag detected on homepage', severity: 'warning' });
    } else if (expected?.ga4_measurement_id && ga4Matches === false) {
      issues.push({
        kind: 'ga4_mismatch',
        summary: `GA4 mismatch: page has ${ga4Match?.[0]}, expected ${expected.ga4_measurement_id}`,
        severity: 'warning'
      });
    }

    const severity = issues.some((i) => i.severity === 'critical')
      ? 'critical'
      : issues.length
        ? 'warning'
        : null;

    return {
      status: issues.length ? 'fail' : 'pass',
      severity,
      payload: {
        website_url: websiteUrl,
        http_status: res.status,
        gtm_present: Boolean(gtmMatch),
        gtm_id_found: gtmMatch?.[0] || null,
        ga4_present: Boolean(ga4Match),
        ga4_id_found: ga4Match?.[0] || null,
        fb_pixel_present: Boolean(fbqMatch),
        fb_pixel_id_found: fbqMatch?.[1] || null,
        expected: expected
          ? {
              gtm_container_id: expected.gtm_container_id,
              ga4_measurement_id: expected.ga4_measurement_id,
              meta_pixel_id: expected.meta_pixel_id,
              client_type: expected.client_type
            }
          : null,
        gtm_match: gtmMatches,
        ga4_match: ga4Matches,
        issues
      }
    };
  }
});
