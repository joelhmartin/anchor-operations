/**
 * Report renderer — Phase 6.
 *
 * Renders an HTML run report and uploads it to GCS, then upserts an
 * `ops_reports` row with the storage URI. Sections (per plan §8.2):
 *
 *   1. Executive summary  — counts by severity, key correlations
 *   2. Cross-platform correlations  — prominent (category LIKE 'correlation.%')
 *   3. Per-umbrella detail  — collapsed with <details>
 *   4. Trend graph  — inline SVG, severity counts over the last 5 runs of the
 *                     same definition
 *
 * GCS bucket: `anchor-hub-ops-reports` (env-overridable). If credentials are
 * unavailable in dev, falls back to writing to `/tmp/ops-reports/<run_id>.html`
 * with a clear TODO and storage_uri='file://...'.
 *
 * Signed URLs (1 h TTL) are minted on demand by `getReportSignedUrl(runId)`.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { query } from '../../db.js';

const BUCKET_NAME = process.env.OPS_REPORTS_BUCKET || 'anchor-hub-ops-reports';
const SIGNED_URL_TTL_MS = 60 * 60 * 1000; // 1h

// --- GCS lazy loader -------------------------------------------------------

let gcsClientPromise = null;
async function getGcsClient() {
  if (!gcsClientPromise) {
    gcsClientPromise = import('@google-cloud/storage')
      .then(({ Storage }) => new Storage())
      .catch((err) => {
        console.warn(`[ops/report] @google-cloud/storage unavailable: ${err.message}`);
        gcsClientPromise = null;
        throw err;
      });
  }
  return gcsClientPromise;
}

// --- HTML helpers ----------------------------------------------------------

function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function severityBadge(severity) {
  const color =
    severity === 'critical' ? '#c62828' : severity === 'warning' ? '#ef6c00' : severity === 'info' ? '#1565c0' : '#616161';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${color};color:#fff;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(severity || 'info')}</span>`;
}

function statusBadge(status) {
  const color =
    status === 'pass' ? '#2e7d32' : status === 'fail' ? '#c62828' : status === 'error' ? '#ef6c00' : status === 'skipped' ? '#9e9e9e' : '#1565c0';
  return `<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:${color};color:#fff;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;">${escapeHtml(status || '—')}</span>`;
}

// --- Data loaders ----------------------------------------------------------

async function loadRun(runId) {
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

async function loadCheckResults(runId) {
  const { rows } = await query(
    `SELECT * FROM ops_check_results WHERE run_id = $1 ORDER BY umbrella, check_id`,
    [runId]
  );
  return rows;
}

async function loadFindings(runId) {
  const { rows } = await query(
    `SELECT * FROM ops_findings WHERE run_id = $1 ORDER BY severity, category`,
    [runId]
  );
  return rows;
}

async function loadTrend(run) {
  // Last 5 runs (incl. current) for the same client + definition.
  if (!run.run_definition_id) return [];
  const { rows } = await query(
    `
    SELECT r.id, r.created_at, r.status,
           SUM(CASE WHEN f.severity = 'critical' THEN 1 ELSE 0 END) AS critical_count,
           SUM(CASE WHEN f.severity = 'warning'  THEN 1 ELSE 0 END) AS warning_count,
           SUM(CASE WHEN f.severity = 'info'     THEN 1 ELSE 0 END) AS info_count
      FROM ops_runs r
      LEFT JOIN ops_findings f ON f.run_id = r.id
     WHERE r.client_user_id = $1
       AND r.run_definition_id = $2
       AND r.created_at >= NOW() - INTERVAL '90 days'
     GROUP BY r.id, r.created_at, r.status
     ORDER BY r.created_at DESC
     LIMIT 5
    `,
    [run.client_user_id, run.run_definition_id]
  );
  return rows.reverse(); // oldest -> newest for plotting
}

// --- SVG trend graph -------------------------------------------------------

function renderTrendSvg(trend) {
  if (!trend || trend.length === 0) {
    return '<p style="color:#666;font-size:13px;">No trend data yet.</p>';
  }
  const W = 560;
  const H = 160;
  const PAD = 28;
  const max = Math.max(
    1,
    ...trend.map(
      (r) => Number(r.critical_count || 0) + Number(r.warning_count || 0) + Number(r.info_count || 0)
    )
  );
  const barW = (W - PAD * 2) / trend.length - 8;
  let bars = '';
  trend.forEach((r, idx) => {
    const x = PAD + idx * ((W - PAD * 2) / trend.length);
    const total = Number(r.critical_count || 0) + Number(r.warning_count || 0) + Number(r.info_count || 0);
    const segHeight = (count) => ((H - PAD * 2) * Number(count || 0)) / max;
    let yCursor = H - PAD;

    const drawSeg = (count, color) => {
      const h = segHeight(count);
      if (h <= 0) return '';
      yCursor -= h;
      return `<rect x="${x.toFixed(1)}" y="${yCursor.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}"/>`;
    };

    bars += drawSeg(r.info_count, '#1565c0');
    bars += drawSeg(r.warning_count, '#ef6c00');
    bars += drawSeg(r.critical_count, '#c62828');

    const label = new Date(r.created_at).toISOString().slice(5, 10);
    bars += `<text x="${(x + barW / 2).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#555">${escapeHtml(label)}</text>`;
    bars += `<text x="${(x + barW / 2).toFixed(1)}" y="${PAD - 6}" text-anchor="middle" font-size="10" fill="#555">${total}</text>`;
  });
  return `
    <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="background:#fafafa;border:1px solid #e0e0e0;border-radius:6px;">
      ${bars}
    </svg>
  `;
}

// --- HTML composition ------------------------------------------------------

function renderExecutiveSummary({ run, findings }) {
  const critical = findings.filter((f) => f.severity === 'critical').length;
  const warning = findings.filter((f) => f.severity === 'warning').length;
  const info = findings.filter((f) => f.severity === 'info').length;
  const correlations = findings.filter((f) => (f.category || '').startsWith('correlation.'));

  const correlationsList = correlations
    .slice(0, 5)
    .map((f) => `<li>${severityBadge(f.severity)} ${escapeHtml(f.summary)}</li>`)
    .join('') || '<li style="color:#666;">No cross-platform correlations matched.</li>';

  return `
    <section>
      <h2 style="margin:0 0 12px 0;">Executive summary</h2>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px;">
        <div><strong>Status:</strong> ${escapeHtml(run.status)}</div>
        <div><strong>Tier:</strong> ${escapeHtml(run.tier || '—')}</div>
        <div><strong>Definition:</strong> ${escapeHtml(run.definition_name || '—')}</div>
        <div><strong>Duration:</strong> ${run.duration_ms ? `${run.duration_ms} ms` : '—'}</div>
        <div><strong>Cost:</strong> ${run.cost_estimate_cents || 0}¢</div>
      </div>
      <div style="display:flex;gap:12px;margin-bottom:16px;">
        <div style="padding:8px 14px;background:#fbe9e7;border-radius:6px;"><strong>${critical}</strong> critical</div>
        <div style="padding:8px 14px;background:#fff3e0;border-radius:6px;"><strong>${warning}</strong> warning</div>
        <div style="padding:8px 14px;background:#e3f2fd;border-radius:6px;"><strong>${info}</strong> info</div>
      </div>
      <h3 style="margin:0 0 8px 0;">Key correlations</h3>
      <ul style="margin:0;padding-left:18px;">${correlationsList}</ul>
    </section>
  `;
}

function renderCorrelations(findings) {
  const correlations = findings.filter((f) => (f.category || '').startsWith('correlation.'));
  if (correlations.length === 0) {
    return `
      <section style="margin-top:24px;">
        <h2 style="margin:0 0 12px 0;">Cross-platform correlations</h2>
        <p style="color:#666;">No multi-platform issues detected this run.</p>
      </section>
    `;
  }
  const items = correlations
    .map(
      (f) => `
      <div style="padding:12px;border:1px solid #e0e0e0;border-radius:8px;margin-bottom:10px;background:#fff;">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
          ${severityBadge(f.severity)}
          <strong>${escapeHtml(f.category)}</strong>
        </div>
        <div style="font-size:14px;line-height:1.5;">${escapeHtml(f.summary)}</div>
      </div>
    `
    )
    .join('');
  return `
    <section style="margin-top:24px;">
      <h2 style="margin:0 0 12px 0;">Cross-platform correlations</h2>
      ${items}
    </section>
  `;
}

function renderUmbrellaDetail(checkResults) {
  const groups = {};
  for (const c of checkResults) {
    const key = c.umbrella || 'unknown';
    groups[key] = groups[key] || [];
    groups[key].push(c);
  }
  const sections = Object.entries(groups)
    .map(([umbrella, rows]) => {
      const items = rows
        .map(
          (r) => `
          <tr>
            <td style="padding:6px 8px;font-family:monospace;font-size:12px;">${escapeHtml(r.check_id)}</td>
            <td style="padding:6px 8px;">${statusBadge(r.status)}</td>
            <td style="padding:6px 8px;">${r.severity ? severityBadge(r.severity) : ''}</td>
            <td style="padding:6px 8px;font-size:12px;color:#555;">${r.duration_ms || '—'} ms</td>
          </tr>
        `
        )
        .join('');
      return `
      <details style="margin-bottom:8px;">
        <summary style="cursor:pointer;font-weight:600;padding:6px 0;">${escapeHtml(umbrella)} <span style="color:#888;font-weight:400;">(${rows.length})</span></summary>
        <table style="width:100%;border-collapse:collapse;margin-top:8px;">
          <thead><tr>
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e0e0e0;">Check</th>
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e0e0e0;">Status</th>
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e0e0e0;">Severity</th>
            <th style="text-align:left;padding:6px 8px;border-bottom:1px solid #e0e0e0;">Duration</th>
          </tr></thead>
          <tbody>${items}</tbody>
        </table>
      </details>
    `;
    })
    .join('');
  return `
    <section style="margin-top:24px;">
      <h2 style="margin:0 0 12px 0;">Per-umbrella detail</h2>
      ${sections || '<p style="color:#666;">No checks ran.</p>'}
    </section>
  `;
}

function renderTrend(trend) {
  return `
    <section style="margin-top:24px;">
      <h2 style="margin:0 0 12px 0;">Trend (last 5 runs)</h2>
      ${renderTrendSvg(trend)}
      <p style="color:#666;font-size:12px;margin-top:6px;">Stacked: critical (red) / warning (orange) / info (blue).</p>
    </section>
  `;
}

function composeHtml({ run, findings, checkResults, trend }) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Ops Run Report — ${escapeHtml(run.id)}</title>
</head>
<body style="font-family:-apple-system,Segoe UI,sans-serif;color:#222;background:#f5f5f5;margin:0;padding:24px;">
  <div style="max-width:780px;margin:0 auto;background:#fff;padding:28px;border-radius:10px;box-shadow:0 1px 4px rgba(0,0,0,0.06);">
    <header style="margin-bottom:24px;">
      <div style="font-size:12px;color:#888;letter-spacing:0.06em;text-transform:uppercase;">Anchor Operations Report</div>
      <h1 style="margin:4px 0 0 0;">Run ${escapeHtml(String(run.id).slice(0, 8))}</h1>
      <div style="color:#666;font-size:13px;margin-top:4px;">Generated ${new Date().toISOString()}</div>
    </header>
    ${renderExecutiveSummary({ run, findings })}
    ${renderCorrelations(findings)}
    ${renderTrend(trend)}
    ${renderUmbrellaDetail(checkResults)}
  </div>
</body>
</html>`;
}

// --- Storage ---------------------------------------------------------------

async function uploadToGcs(runId, html) {
  const storage = await getGcsClient();
  const bucket = storage.bucket(BUCKET_NAME);
  const file = bucket.file(`${runId}.html`);
  await file.save(html, {
    contentType: 'text/html; charset=utf-8',
    resumable: false,
    metadata: { metadata: { run_id: runId } }
  });
  return `gs://${BUCKET_NAME}/${runId}.html`;
}

async function writeLocalFallback(runId, html) {
  const dir = path.join(os.tmpdir(), 'ops-reports');
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${runId}.html`);
  await fs.writeFile(filePath, html, 'utf8');
  // TODO(phase-8): remove local fallback once GCS creds are guaranteed in
  // every environment. The endpoint at GET /api/ops/runs/:id/report serves
  // the local file inline only when storage_uri starts with file://.
  return `file://${filePath}`;
}

// --- Public API ------------------------------------------------------------

/**
 * Render and persist a run report. Returns the upserted `ops_reports` row.
 */
export async function render(runId) {
  if (!runId) throw new Error('reportRenderer.render: runId required');

  const run = await loadRun(runId);
  if (!run) {
    console.warn(`[ops/report] run ${runId} not found; skipping render`);
    return null;
  }

  const [findings, checkResults, trend] = await Promise.all([
    loadFindings(runId),
    loadCheckResults(runId),
    loadTrend(run)
  ]);

  const html = composeHtml({ run, findings, checkResults, trend });
  const sizeBytes = Buffer.byteLength(html, 'utf8');

  let storageUri;
  try {
    storageUri = await uploadToGcs(runId, html);
  } catch (err) {
    console.warn(`[ops/report] GCS upload failed for run ${runId}: ${err.message}; using local fallback`);
    storageUri = await writeLocalFallback(runId, html);
  }

  const { rows } = await query(
    `
    INSERT INTO ops_reports (run_id, format, storage_uri, size_bytes, rendered_at)
    VALUES ($1, 'html', $2, $3, NOW())
    ON CONFLICT (run_id) DO UPDATE
      SET format = EXCLUDED.format,
          storage_uri = EXCLUDED.storage_uri,
          size_bytes = EXCLUDED.size_bytes,
          rendered_at = EXCLUDED.rendered_at
    RETURNING *
    `,
    [runId, storageUri, sizeBytes]
  );
  return rows[0] || null;
}

// Back-compat alias used by older executor revisions.
export const renderReport = render;

/**
 * Mint a 1h signed URL for a previously-rendered report. Returns
 * `{ url, expires_at }` for `gs://` reports, or `{ url: 'local:<path>' }` for
 * local-dev fallback (endpoint streams the file directly in dev).
 */
export async function getReportSignedUrl(runId) {
  const { rows } = await query(`SELECT storage_uri FROM ops_reports WHERE run_id = $1`, [runId]);
  if (rows.length === 0) return null;
  const uri = rows[0].storage_uri || '';

  if (uri.startsWith('gs://')) {
    const match = uri.match(/^gs:\/\/([^/]+)\/(.+)$/);
    if (!match) return { url: null, error: 'invalid gs uri' };
    const [, bucketName, objectName] = match;
    try {
      const storage = await getGcsClient();
      const expires = Date.now() + SIGNED_URL_TTL_MS;
      const [url] = await storage
        .bucket(bucketName)
        .file(objectName)
        .getSignedUrl({ action: 'read', expires });
      return { url, expires_at: new Date(expires).toISOString() };
    } catch (err) {
      console.warn(`[ops/report] signed URL failed: ${err.message}`);
      return { url: null, error: err.message };
    }
  }

  if (uri.startsWith('file://')) {
    return { url: uri, local: true };
  }

  return { url: null, error: 'unsupported storage_uri' };
}

export default { render, renderReport, getReportSignedUrl };
