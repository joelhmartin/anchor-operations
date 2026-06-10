/**
 * Email digest — Phase 6.
 *
 * Two surfaces:
 *
 *   sendRunSummary(runId)   — fired by runExecutor after the report renders.
 *                             Only sends if the run's subscription has
 *                             email_on_completion=true. Recipient is the
 *                             client_user_id's primary email.
 *
 *   sendPortfolioDigest()   — fired by Cloud Scheduler via
 *                             POST /api/ops/internal/portfolio-digest.
 *                             Sends an internal admin digest summarizing the
 *                             last 24h of runs (counts, criticals).
 *
 * Mailgun template `ops-run-summary` (managed in Mailgun UI) is referenced via
 * the existing mailgun.js helper. We pass plain text + HTML — mailgun.js
 * preserves them rather than relying on a Mailgun-side template variable.
 *
 * No PHI is included in either message body. Bodies reference run IDs and
 * counts only, plus the signed report URL.
 */

import { query } from '../../db.js';
import { sendMailgunMessageWithLogging, isMailgunConfigured } from '../mailgun.js';

async function loadRunForDigest(runId) {
  const { rows } = await query(
    `
    SELECT r.*, d.name AS definition_name, d.tier AS definition_tier
      FROM ops_runs r
      LEFT JOIN ops_run_definitions d ON d.id = r.run_definition_id
     WHERE r.id = $1
    `,
    [runId]
  );
  return rows[0] || null;
}

async function loadFindingCounts(runId) {
  const { rows } = await query(
    `
    SELECT severity, COUNT(*) AS count
      FROM ops_findings
     WHERE run_id = $1
     GROUP BY severity
    `,
    [runId]
  );
  const out = { critical: 0, warning: 0, info: 0 };
  for (const r of rows) {
    out[r.severity] = Number(r.count);
  }
  return out;
}

async function loadSubscriptionPrefs(clientUserId, runDefinitionId) {
  if (!runDefinitionId) return null;
  const { rows } = await query(
    `
    SELECT email_on_completion
      FROM client_run_subscriptions
     WHERE client_user_id = $1 AND run_definition_id = $2
     LIMIT 1
    `,
    [clientUserId, runDefinitionId]
  );
  return rows[0] || null;
}

async function loadClientPrimaryEmail(clientUserId) {
  const { rows } = await query(
    `SELECT email FROM users WHERE id = $1 LIMIT 1`,
    [clientUserId]
  );
  return rows[0]?.email || null;
}

async function loadAdminRecipients() {
  const envList = String(process.env.OPS_ADMIN_DIGEST_RECIPIENTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (envList.length > 0) return envList;

  // Fallback: any superadmin/admin user. Conservative — pick the earliest
  // admin (least churn) so the digest goes somewhere stable.
  const { rows } = await query(
    `
    SELECT email FROM users
     WHERE role IN ('admin','superadmin')
       AND email IS NOT NULL
     ORDER BY created_at ASC
     LIMIT 1
    `
  );
  return rows.map((r) => r.email).filter(Boolean);
}

function buildRunSummaryBody({ run, counts, signedUrl }) {
  const text = [
    `Operations run completed`,
    ``,
    `Run: ${run.id}`,
    `Definition: ${run.definition_name || '(custom)'} (${run.tier})`,
    `Status: ${run.status}`,
    `Findings: ${counts.critical} critical, ${counts.warning} warning, ${counts.info} info`,
    ``,
    signedUrl ? `Full report (1h link): ${signedUrl}` : `Full report: see Operations dashboard.`
  ].join('\n');

  const html = `
    <h2 style="margin:0 0 12px 0;">Operations run completed</h2>
    <table style="border-collapse:collapse;font-size:14px;">
      <tr><td style="padding:4px 8px;color:#666;">Run</td><td style="padding:4px 8px;"><code>${run.id}</code></td></tr>
      <tr><td style="padding:4px 8px;color:#666;">Definition</td><td style="padding:4px 8px;">${run.definition_name || '(custom)'} <span style="color:#888;">(${run.tier})</span></td></tr>
      <tr><td style="padding:4px 8px;color:#666;">Status</td><td style="padding:4px 8px;"><strong>${run.status}</strong></td></tr>
      <tr><td style="padding:4px 8px;color:#666;">Findings</td><td style="padding:4px 8px;">
        <span style="color:#c62828;"><strong>${counts.critical}</strong> critical</span> ·
        <span style="color:#ef6c00;"><strong>${counts.warning}</strong> warning</span> ·
        <span style="color:#1565c0;"><strong>${counts.info}</strong> info</span>
      </td></tr>
    </table>
    ${signedUrl ? `<p style="margin-top:16px;"><a href="${signedUrl}">View full report</a> (link expires in 1 hour)</p>` : ''}
  `;
  return { text, html };
}

/**
 * sendRunSummary — fire-and-log. Returns `{ skipped, reason } | { sent: true }`.
 */
export async function sendRunSummary(runId) {
  if (!runId) return { skipped: true, reason: 'no_run_id' };
  if (!isMailgunConfigured()) return { skipped: true, reason: 'mailgun_unconfigured' };

  const run = await loadRunForDigest(runId);
  if (!run) return { skipped: true, reason: 'run_not_found' };

  const sub = await loadSubscriptionPrefs(run.client_user_id, run.run_definition_id);
  if (!sub || sub.email_on_completion !== true) {
    return { skipped: true, reason: 'email_not_subscribed' };
  }

  const recipient = await loadClientPrimaryEmail(run.client_user_id);
  if (!recipient) return { skipped: true, reason: 'no_recipient_email' };

  const counts = await loadFindingCounts(runId);

  // Try to mint signed URL; tolerate failures (still send the digest).
  let signedUrl = null;
  try {
    const reporter = await import('./reportRenderer.js');
    const r = await reporter.getReportSignedUrl(runId);
    if (r?.url && !r.local) signedUrl = r.url;
  } catch (err) {
    console.warn(`[ops/digest] signed URL fetch failed: ${err.message}`);
  }

  const { text, html } = buildRunSummaryBody({ run, counts, signedUrl });
  const subject = `[Anchor] ${run.definition_name || run.tier} run — ${counts.critical}C / ${counts.warning}W / ${counts.info}I`;

  try {
    await sendMailgunMessageWithLogging(
      { to: recipient, subject, text, html },
      {
        emailType: 'ops-run-summary',
        clientId: run.client_user_id,
        metadata: { run_id: runId, tier: run.tier },
        skipBodyLogging: false // body contains no PHI
      }
    );
    return { sent: true, recipient };
  } catch (err) {
    console.warn(`[ops/digest] send failed for run ${runId}: ${err.message}`);
    return { skipped: true, reason: 'send_failed', error: err.message };
  }
}

/**
 * sendPortfolioDigest — internal admin digest summarizing the last 24h.
 */
export async function sendPortfolioDigest() {
  if (!isMailgunConfigured()) return { skipped: true, reason: 'mailgun_unconfigured' };

  const recipients = await loadAdminRecipients();
  if (recipients.length === 0) return { skipped: true, reason: 'no_admin_recipients' };

  const { rows: runRows } = await query(
    `
    SELECT r.id, r.client_user_id, r.tier, r.status, r.created_at,
           COALESCE(d.name, '(custom)') AS definition_name
      FROM ops_runs r
      LEFT JOIN ops_run_definitions d ON d.id = r.run_definition_id
     WHERE r.created_at >= NOW() - INTERVAL '24 hours'
     ORDER BY r.created_at DESC
    `
  );

  const { rows: findingRows } = await query(
    `
    SELECT run_id, severity, COUNT(*) AS count
      FROM ops_findings
     WHERE run_id IN (SELECT id FROM ops_runs WHERE created_at >= NOW() - INTERVAL '24 hours')
     GROUP BY run_id, severity
    `
  );

  const findingsByRun = {};
  for (const r of findingRows) {
    findingsByRun[r.run_id] = findingsByRun[r.run_id] || { critical: 0, warning: 0, info: 0 };
    findingsByRun[r.run_id][r.severity] = Number(r.count);
  }

  const totalRuns = runRows.length;
  const totalCritical = Object.values(findingsByRun).reduce((s, c) => s + (c.critical || 0), 0);
  const totalWarning = Object.values(findingsByRun).reduce((s, c) => s + (c.warning || 0), 0);

  const rowsHtml = runRows
    .slice(0, 50)
    .map((r) => {
      const counts = findingsByRun[r.id] || { critical: 0, warning: 0, info: 0 };
      return `<tr>
        <td style="padding:4px 8px;font-family:monospace;font-size:12px;">${String(r.id).slice(0, 8)}</td>
        <td style="padding:4px 8px;">${r.definition_name}</td>
        <td style="padding:4px 8px;">${r.tier}</td>
        <td style="padding:4px 8px;">${r.status}</td>
        <td style="padding:4px 8px;color:#c62828;">${counts.critical}</td>
        <td style="padding:4px 8px;color:#ef6c00;">${counts.warning}</td>
      </tr>`;
    })
    .join('');

  const html = `
    <h2 style="margin:0 0 8px 0;">Anchor Ops — 24h portfolio digest</h2>
    <p style="color:#555;">${totalRuns} runs · <strong style="color:#c62828;">${totalCritical} critical</strong> · <strong style="color:#ef6c00;">${totalWarning} warning</strong></p>
    <table style="width:100%;border-collapse:collapse;font-size:13px;border:1px solid #e0e0e0;">
      <thead><tr style="background:#f5f5f5;">
        <th style="text-align:left;padding:6px 8px;">Run</th>
        <th style="text-align:left;padding:6px 8px;">Definition</th>
        <th style="text-align:left;padding:6px 8px;">Tier</th>
        <th style="text-align:left;padding:6px 8px;">Status</th>
        <th style="text-align:left;padding:6px 8px;">Crit</th>
        <th style="text-align:left;padding:6px 8px;">Warn</th>
      </tr></thead>
      <tbody>${rowsHtml || '<tr><td colspan="6" style="padding:12px;color:#666;">No runs in the last 24h.</td></tr>'}</tbody>
    </table>
  `;

  const text = `Anchor Ops — 24h portfolio digest\n\n${totalRuns} runs · ${totalCritical} critical · ${totalWarning} warning`;

  try {
    await sendMailgunMessageWithLogging(
      { to: recipients, subject: `[Anchor Ops] 24h digest — ${totalCritical} critical, ${totalWarning} warning`, text, html },
      {
        emailType: 'ops-portfolio-digest',
        metadata: { total_runs: totalRuns, total_critical: totalCritical, total_warning: totalWarning },
        skipBodyLogging: false
      }
    );
    return { sent: true, recipients, total_runs: totalRuns };
  } catch (err) {
    console.warn(`[ops/digest] portfolio send failed: ${err.message}`);
    return { skipped: true, reason: 'send_failed', error: err.message };
  }
}

export default { sendRunSummary, sendPortfolioDigest };
