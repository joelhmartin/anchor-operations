/**
 * Drift detection — re-scan a site, diff against the stored scan_json
 * baseline, and persist findings. User-triggered: there is no cron.
 *
 * Findings categories:
 *   wp_version_drift   — major version jumped (or downgraded)
 *   plugin_added       — plugin appeared since baseline
 *   plugin_removed     — plugin disappeared since baseline
 *   plugin_updates_available — count of updates available now
 *   siteurl_changed    — option('home') or option('siteurl') diverged
 *   debug_enabled      — WP_DEBUG flipped on
 *   theme_changed      — active theme switched
 *   tracking_missing   — homepage no longer exposes GTM/GA4
 */

import { query } from '../../../db.js';
import { scanEnvironment } from './siteScanner.js';
import { getTool } from './agentTools.js';

function majorVersion(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : v;
}

async function fetchBaseline(siteId) {
  const { rows } = await query(
    'SELECT scan_json, baseline_accepted_at FROM kinsta_site_workspaces WHERE site_id = $1 LIMIT 1',
    [siteId]
  );
  if (!rows[0]) return null;
  return {
    scan: rows[0].scan_json || null,
    accepted_at: rows[0].baseline_accepted_at || null
  };
}

async function fetchLiveEnv(siteId) {
  const { rows } = await query(
    `SELECT id FROM kinsta_environments
       WHERE site_id = $1 AND is_live = TRUE
       ORDER BY created_at ASC LIMIT 1`,
    [siteId]
  );
  return rows[0]?.id || null;
}

function diffPlugins(oldList = [], newList = []) {
  const byName = (list) => new Map((list || []).map((p) => [p.name, p]));
  const a = byName(oldList);
  const b = byName(newList);
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const added = [...b.keys()].filter((k) => !a.has(k));
  const updates = (newList || []).filter((p) => p.update_available).map((p) => p.name);
  return { removed, added, updates };
}

function buildFindings(baseline, fresh) {
  const findings = [];

  if (baseline) {
    const oldMajor = majorVersion(baseline.wp_version);
    const newMajor = majorVersion(fresh.wp_version);
    if (oldMajor && newMajor && oldMajor !== newMajor) {
      findings.push({
        severity: 'warning',
        category: 'wp_version_drift',
        summary: `WordPress version changed from ${baseline.wp_version} to ${fresh.wp_version}`,
        evidence: { from: baseline.wp_version, to: fresh.wp_version }
      });
    }
    if (baseline.site_url && fresh.site_url && baseline.site_url !== fresh.site_url) {
      findings.push({
        severity: 'critical',
        category: 'siteurl_changed',
        summary: `siteurl changed from ${baseline.site_url} to ${fresh.site_url}`,
        evidence: { from: baseline.site_url, to: fresh.site_url }
      });
    }
    const baseTheme = baseline.theme?.active_theme || '';
    const newTheme = fresh.theme?.active_theme || '';
    if (baseTheme && newTheme && baseTheme !== newTheme) {
      findings.push({
        severity: 'warning',
        category: 'theme_changed',
        summary: `Active theme changed from ${baseTheme} to ${newTheme}`,
        evidence: { from: baseTheme, to: newTheme }
      });
    }

    const pluginDiff = diffPlugins(baseline.plugins, fresh.plugins);
    if (pluginDiff.removed.length) {
      findings.push({
        severity: 'warning',
        category: 'plugin_removed',
        summary: `${pluginDiff.removed.length} plugin(s) removed: ${pluginDiff.removed.slice(0, 5).join(', ')}${pluginDiff.removed.length > 5 ? '…' : ''}`,
        evidence: { removed: pluginDiff.removed }
      });
    }
    if (pluginDiff.added.length) {
      findings.push({
        severity: 'info',
        category: 'plugin_added',
        summary: `${pluginDiff.added.length} plugin(s) added: ${pluginDiff.added.slice(0, 5).join(', ')}${pluginDiff.added.length > 5 ? '…' : ''}`,
        evidence: { added: pluginDiff.added }
      });
    }
    if (pluginDiff.updates.length) {
      findings.push({
        severity: 'info',
        category: 'plugin_updates_available',
        summary: `${pluginDiff.updates.length} plugin update(s) available`,
        evidence: { plugins: pluginDiff.updates }
      });
    }
  }

  if (fresh.debug_flags?.wp_debug) {
    findings.push({
      severity: 'warning',
      category: 'debug_enabled',
      summary: 'WP_DEBUG is enabled in production',
      evidence: { debug_flags: fresh.debug_flags }
    });
  }

  return findings;
}

async function persistFindings(siteId, environmentId, findings) {
  if (!findings.length) return [];
  const inserted = [];
  for (const f of findings) {
    const { rows } = await query(
      `INSERT INTO kinsta_findings
         (site_id, environment_id, severity, category, summary, evidence_json)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING *`,
      [siteId, environmentId, f.severity, f.category, f.summary, JSON.stringify(f.evidence || {})]
    );
    inserted.push(rows[0]);
  }
  return inserted;
}

/**
 * Run a drift check against a single site. Re-scans the live env, diffs
 * vs baseline, and inserts a finding row per detected delta.
 *
 * Updates kinsta_site_workspaces.scan_json with the fresh scan, so the
 * baseline rolls forward. Manual claude_md edits are NOT touched.
 */
export async function runDriftCheck(siteId, { userId } = {}) {
  const envId = await fetchLiveEnv(siteId);
  if (!envId) throw new Error('Site has no live environment');

  const [baselineRecord, fresh] = await Promise.all([
    fetchBaseline(siteId),
    scanEnvironment(envId, { userId })
  ]);

  const baseline = baselineRecord?.scan || null;
  const baselineAcceptedAt = baselineRecord?.accepted_at || null;
  const isFirstScan = !baseline;

  const findings = buildFindings(baseline, fresh);

  // Tracking check always runs as part of drift (cross-site curl + GTM/GA4 verify).
  try {
    const tool = getTool('verify_tracking_install');
    const tr = await tool.handler({}, { userId, agentType: 'drift', siteId, envId });
    if (tr && !tr.error) {
      const expected = tr.expected;
      if (expected?.gtm_container_id && tr.gtm_match === false) {
        findings.push({
          severity: 'warning',
          category: 'tracking_missing',
          summary: `GTM mismatch: page has ${tr.gtm_id_found || 'none'}, expected ${expected.gtm_container_id}`,
          evidence: tr
        });
      }
      if (expected?.ga4_measurement_id && tr.ga4_match === false) {
        findings.push({
          severity: 'warning',
          category: 'tracking_missing',
          summary: `GA4 mismatch: page has ${tr.ga4_id_found || 'none'}, expected ${expected.ga4_measurement_id}`,
          evidence: tr
        });
      }
      if (expected && !tr.gtm_present && expected.gtm_container_id) {
        findings.push({
          severity: 'critical',
          category: 'tracking_missing',
          summary: 'No GTM tag detected on homepage',
          evidence: tr
        });
      }
    }
  } catch (err) {
    console.warn('[drift] tracking check failed:', err.message);
  }

  // Baseline mutation rules (Phase 0 hardening):
  //   * first scan ever — store fresh as baseline AND mark accepted, since
  //     there is nothing to drift against yet.
  //   * subsequent scans — DO NOT roll baseline forward. Just record the
  //     scan in kinsta_scan_history so admins can verify drift on re-run.
  //     Admin must explicitly accept the new baseline via acceptBaseline().
  if (isFirstScan) {
    await query(
      `UPDATE kinsta_site_workspaces
         SET scan_json = $2::jsonb,
             last_scan_at = NOW(),
             last_scan_status = 'success',
             baseline_accepted_at = COALESCE(baseline_accepted_at, NOW()),
             updated_at = NOW()
       WHERE site_id = $1`,
      [siteId, JSON.stringify(fresh)]
    );
  } else {
    await query(
      `UPDATE kinsta_site_workspaces
         SET last_scan_at = NOW(),
             last_scan_status = 'success',
             updated_at = NOW()
       WHERE site_id = $1`,
      [siteId]
    );
  }

  // Always record this scan attempt in history for auditability + re-run
  // verification.
  const diffSummary = {
    finding_count: findings.length,
    categories: findings.reduce((acc, f) => {
      acc[f.category] = (acc[f.category] || 0) + 1;
      return acc;
    }, {}),
    is_first_scan: isFirstScan
  };
  await query(
    `INSERT INTO kinsta_scan_history (workspace_site_id, baseline_snapshot, fresh_snapshot, diff_summary)
     VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb)`,
    [siteId, JSON.stringify(baseline || {}), JSON.stringify(fresh), JSON.stringify(diffSummary)]
  ).catch((err) => console.warn('[drift] scan history insert failed:', err.message));

  const persisted = await persistFindings(siteId, envId, findings);
  return {
    findings: persisted,
    scanned_at: fresh.scanned_at,
    baseline_existed: Boolean(baseline),
    baseline_accepted_at: baselineAcceptedAt,
    baseline_rolled_forward: isFirstScan
  };
}

/**
 * Admin explicitly accepts the latest scan as the new baseline. Replaces
 * scan_json with a fresh scan and stamps baseline_accepted_at.
 */
export async function acceptBaseline(siteId, { userId } = {}) {
  const envId = await fetchLiveEnv(siteId);
  if (!envId) throw new Error('Site has no live environment');
  const fresh = await scanEnvironment(envId, { userId });
  await query(
    `UPDATE kinsta_site_workspaces
       SET scan_json = $2::jsonb,
           baseline_accepted_at = NOW(),
           baseline_accepted_by = $3,
           last_scan_at = NOW(),
           last_scan_status = 'success',
           updated_at = NOW()
     WHERE site_id = $1`,
    [siteId, JSON.stringify(fresh), userId || null]
  );
  return { accepted_at: new Date().toISOString(), scanned_at: fresh.scanned_at };
}

export async function listFindings({ siteId, openOnly = true, limit = 100 }) {
  const params = [];
  let where = '1=1';
  if (siteId) {
    params.push(siteId);
    where += ` AND site_id = $${params.length}`;
  }
  if (openOnly) {
    where += ' AND resolved_at IS NULL';
  }
  params.push(Math.max(1, Math.min(500, limit)));
  const { rows } = await query(
    `SELECT * FROM kinsta_findings
       WHERE ${where}
       ORDER BY
         CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
         created_at DESC
       LIMIT $${params.length}`,
    params
  );
  return rows;
}

export async function countOpenFindingsBySite() {
  const { rows } = await query(
    `SELECT site_id,
            COUNT(*)::int AS open_count,
            SUM(CASE WHEN severity = 'critical' THEN 1 ELSE 0 END)::int AS critical_count
       FROM kinsta_findings
       WHERE resolved_at IS NULL
       GROUP BY site_id`
  );
  return rows;
}

export async function acknowledgeFinding(findingId, userId) {
  const { rows } = await query(
    `UPDATE kinsta_findings
       SET acknowledged_by = $2, acknowledged_at = NOW()
       WHERE id = $1 AND acknowledged_at IS NULL
       RETURNING *`,
    [findingId, userId]
  );
  return rows[0] || null;
}

export async function resolveFinding(findingId) {
  const { rows } = await query(
    `UPDATE kinsta_findings
       SET resolved_at = NOW()
       WHERE id = $1 AND resolved_at IS NULL
       RETURNING *`,
    [findingId]
  );
  return rows[0] || null;
}
