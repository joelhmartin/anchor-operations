/**
 * WPVuln feed refresh — Phase 3.
 *
 * Pulls plugin vulnerability data into `ops_vuln_feed` so the
 * `web.wp_security` check can cross-reference scanned plugin slugs without an
 * external API call per run.
 *
 * Sources:
 *   - WPScan API (preferred, requires `WPSCAN_API_TOKEN`)
 *   - Falls back to a no-op refresh if no token is configured; the table
 *     simply stays empty and downstream checks gracefully degrade.
 *
 * Refresh strategy: caller (Phase 8 scheduler) triggers `refreshWpVulnFeed()`
 * once per day. Re-runs are idempotent thanks to the `(plugin_slug, vuln_id)`
 * UNIQUE constraint.
 */

import { query } from '../../../db.js';
import { safeHttpFetch } from '../checks/website/_lib/httpFetch.js';

const WPSCAN_PLUGINS_API = 'https://wpscan.com/api/v3/plugins/';

export async function refreshWpVulnFeed({ slugs = [] } = {}) {
  const token = process.env.WPSCAN_API_TOKEN;
  if (!token) {
    return { ok: false, reason: 'WPSCAN_API_TOKEN not configured', inserted: 0 };
  }
  const targetSlugs = slugs.length ? slugs : await getDistinctScannedSlugs();
  let inserted = 0;
  for (const slug of targetSlugs) {
    try {
      const res = await safeHttpFetch(`${WPSCAN_PLUGINS_API}${encodeURIComponent(slug)}`, {
        timeoutMs: 20_000,
        maxBytes: 500_000,
        headers: { Authorization: `Token token=${token}` }
      });
      if (res.status === 404) continue;
      if (res.status >= 400) continue;
      const data = JSON.parse(res.body);
      const entries = (data?.[slug]?.vulnerabilities || []).map((v) => ({
        plugin_slug: slug,
        vuln_id: String(v.id || v.identifier || `${slug}:${v.title || 'unknown'}`),
        severity: v.cvss?.severity || null,
        fixed_in: v.fixed_in || null,
        raw: v
      }));
      for (const e of entries) {
        await query(
          `INSERT INTO ops_vuln_feed (plugin_slug, vuln_id, severity, fixed_in, raw, fetched_at)
           VALUES ($1, $2, $3, $4, $5::jsonb, NOW())
           ON CONFLICT (plugin_slug, vuln_id) DO UPDATE
             SET severity = EXCLUDED.severity,
                 fixed_in = EXCLUDED.fixed_in,
                 raw = EXCLUDED.raw,
                 fetched_at = NOW()`,
          [e.plugin_slug, e.vuln_id, e.severity, e.fixed_in, JSON.stringify(e.raw)]
        );
        inserted += 1;
      }
    } catch (err) {
      console.warn(`[wpvuln] refresh ${slug} failed: ${err.message}`);
    }
  }
  return { ok: true, inserted, slugs: targetSlugs.length };
}

async function getDistinctScannedSlugs() {
  const { rows } = await query(
    `SELECT DISTINCT (jsonb_array_elements(scan_json->'plugins')->>'slug') AS slug
       FROM kinsta_site_workspaces
      WHERE scan_json IS NOT NULL`
  ).catch(() => ({ rows: [] }));
  return (rows || []).map((r) => r.slug).filter(Boolean);
}
