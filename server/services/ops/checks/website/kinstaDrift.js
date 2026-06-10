/**
 * web.kinsta.drift — wraps the legacy `runDriftCheck` so drift evidence flows
 * through the unified ops_check_results / ops_findings pipeline.
 *
 * The legacy `kinsta_findings` table continues to receive rows from
 * runDriftCheck() so existing UI keeps working during the transition. The
 * `kinsta_findings_compat` view (Phase 1) projects the new ops_findings rows
 * back so legacy readers see both surfaces.
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { runDriftCheck } from '../../operations-website/driftScanner.js';

async function resolveSiteIdForClient(clientUserId) {
  const { rows } = await query(
    `SELECT site_id FROM kinsta_site_clients
       WHERE client_user_id = $1
       ORDER BY created_at ASC
       LIMIT 1`,
    [clientUserId]
  ).catch(() => ({ rows: [] }));
  return rows[0]?.site_id || null;
}

registerCheck('web.kinsta.drift', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: ['kinsta_site'],
  handler: async (ctx) => {
    const siteId = await resolveSiteIdForClient(ctx.clientUserId);
    if (!siteId) {
      return {
        status: 'skipped',
        payload: { reason: 'no Kinsta site linked to client_user_id' }
      };
    }
    let driftResult;
    try {
      driftResult = await runDriftCheck(siteId, { userId: null });
    } catch (err) {
      return {
        status: 'error',
        severity: 'warning',
        payload: { site_id: siteId, error: err.message }
      };
    }
    const findings = driftResult.findings || [];
    const critical = findings.some((f) => f.severity === 'critical');
    const warning = findings.some((f) => f.severity === 'warning');
    const severity = critical ? 'critical' : warning ? 'warning' : null;
    return {
      status: findings.length ? 'fail' : 'pass',
      severity,
      payload: {
        site_id: siteId,
        baseline_existed: driftResult.baseline_existed,
        baseline_rolled_forward: driftResult.baseline_rolled_forward,
        finding_count: findings.length,
        // Surface a compact projection of legacy findings so the correlator
        // can hoist them into ops_findings without a second DB hop.
        legacy_findings: findings.map((f) => ({
          id: f.id,
          severity: f.severity,
          category: f.category,
          summary: f.summary,
          evidence: f.evidence_json
        })),
        scanned_at: driftResult.scanned_at
      }
    };
  }
});

/**
 * web.wp_security — cross-reference the latest drift snapshot's plugin list
 * against the WPVuln feed (services/ops/feeds/wpvuln.js / ops_vuln_feed table)
 * to surface known-vulnerable plugins.
 */
registerCheck('web.wp_security', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const siteId = await resolveSiteIdForClient(ctx.clientUserId);
    if (!siteId) {
      return {
        status: 'skipped',
        payload: { reason: 'no Kinsta site linked to client_user_id' }
      };
    }
    const { rows: snapRows } = await query(
      `SELECT scan_json FROM kinsta_site_workspaces WHERE site_id = $1 LIMIT 1`,
      [siteId]
    ).catch(() => ({ rows: [] }));
    const scan = snapRows[0]?.scan_json || null;
    if (!scan) {
      return {
        status: 'skipped',
        payload: { reason: 'no scan baseline for this site; run web.kinsta.drift first' }
      };
    }
    const plugins = Array.isArray(scan.plugins) ? scan.plugins : [];
    if (!plugins.length) {
      return { status: 'pass', payload: { site_id: siteId, plugin_count: 0, vulnerabilities: [] } };
    }
    const slugs = plugins.map((p) => p.slug || p.name).filter(Boolean);
    if (!slugs.length) {
      return { status: 'pass', payload: { site_id: siteId, plugin_count: plugins.length, vulnerabilities: [] } };
    }
    const { rows: vulnRows } = await query(
      `SELECT plugin_slug, vuln_id, severity, fixed_in, raw
         FROM ops_vuln_feed
        WHERE plugin_slug = ANY($1::text[])`,
      [slugs]
    ).catch(() => ({ rows: [] }));
    const vulns = (vulnRows || []).map((v) => {
      const installed = plugins.find((p) => (p.slug || p.name) === v.plugin_slug);
      return {
        plugin: v.plugin_slug,
        installed_version: installed?.version || null,
        vuln_id: v.vuln_id,
        severity: v.severity,
        fixed_in: v.fixed_in
      };
    });
    const critical = vulns.some((v) => v.severity === 'critical' || v.severity === 'high');
    const warning = vulns.length > 0;
    return {
      status: warning ? 'fail' : 'pass',
      severity: critical ? 'critical' : warning ? 'warning' : null,
      payload: {
        site_id: siteId,
        plugin_count: plugins.length,
        vulnerabilities: vulns
      }
    };
  }
});
