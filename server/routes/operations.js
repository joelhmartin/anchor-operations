/**
 * Operations (Kinsta) routes — admin-only.
 *
 * All endpoints under /api/operations/*. SSH passwords are NEVER returned
 * to the client; serializers strip ssh_password_encrypted explicitly.
 */

import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { query } from '../db.js';
import {
  listAllSites,
  getSshPassword,
  pickKinstaEnvironmentSummary
} from '../services/ops/operations-website/kinstaApi.js';
import { execCommand } from '../services/ops/operations-website/sshClient.js';
import { scanSite } from '../services/ops/operations-website/siteScanner.js';
import {
  cancelBulkOperation,
  createBulkOperation,
  getBulkOperation,
  listBulkActions,
  listBulkOperations
} from '../services/ops/operations-website/bulkRunner.js';
import {
  acceptBaseline,
  acknowledgeFinding,
  countOpenFindingsBySite,
  listFindings,
  resolveFinding,
  runDriftCheck
} from '../services/ops/operations-website/driftScanner.js';
import { encrypt } from '../services/security/encryption.js';
import { checkRateLimit, recordAttempt } from '../services/security/rateLimit.js';
import { activeOnly } from '../services/queryHelpers.js';

const router = express.Router();

/**
 * Per-user rate limiter middleware. Uses the user id (always present after
 * requireAuth) as the identifier so admins are throttled individually rather
 * than as a single IP.
 */
function userRateLimit(limitType) {
  return async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) return next();
    try {
      const check = await checkRateLimit(limitType, userId);
      if (!check.allowed) {
        return res.status(429).json({
          message: 'Too many operations requests. Please slow down.',
          retryAfter: check.retryAfter,
          code: 'RATE_LIMIT_EXCEEDED'
        });
      }
      await recordAttempt(limitType, userId);
    } catch (err) {
      console.warn('[operations] rate limit check failed:', err.message);
    }
    next();
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireAuth);
router.use(requireAdmin);

// ---------------- helpers ----------------

function serializeEnvironment(row) {
  if (!row) return null;
  return {
    id: row.id,
    site_id: row.site_id,
    kinsta_environment_id: row.kinsta_environment_id,
    environment_name: row.environment_name,
    is_live: row.is_live,
    primary_domain: row.primary_domain,
    ssh_host: row.ssh_host,
    ssh_ip: row.ssh_ip,
    ssh_port: row.ssh_port,
    ssh_username: row.ssh_username,
    ssh_password_present: Boolean(row.ssh_password_encrypted),
    ssh_password_fetched_at: row.ssh_password_fetched_at,
    metadata: row.metadata || {},
    read_only: Boolean(row.metadata?.read_only),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function serializeSite(row) {
  if (!row) return null;
  return {
    id: row.id,
    kinsta_site_id: row.kinsta_site_id,
    site_name: row.site_name,
    display_name: row.display_name,
    archived_at: row.archived_at,
    metadata: row.metadata || {},
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function badUuid(res, name) {
  return res.status(400).json({ message: `Invalid ${name}` });
}

// ---------------- sites ----------------

router.get('/sites', async (req, res) => {
  try {
    const search = req.query.q ? `%${String(req.query.q).toLowerCase()}%` : null;
    const clientUserId = req.query.client_user_id ? String(req.query.client_user_id) : null;
    if (clientUserId && !UUID_RE.test(clientUserId)) return badUuid(res, 'client_user_id');

    const params = [];
    let where = activeOnly('s');
    if (search) {
      params.push(search);
      where += ` AND (LOWER(s.site_name) LIKE $${params.length} OR LOWER(COALESCE(s.display_name,'')) LIKE $${params.length})`;
    }
    if (clientUserId) {
      params.push(clientUserId);
      where += ` AND s.id IN (SELECT site_id FROM kinsta_site_clients WHERE client_user_id = $${params.length})`;
    }

    const { rows } = await query(
      `SELECT
         s.*,
         (
           SELECT COUNT(*)::int FROM kinsta_environments e WHERE e.site_id = s.id
         ) AS environment_count,
         (
           SELECT primary_domain FROM kinsta_environments
           WHERE site_id = s.id AND is_live = TRUE
           ORDER BY created_at ASC LIMIT 1
         ) AS primary_domain,
         w.last_scan_at,
         w.last_scan_status,
         (
           SELECT COUNT(*)::int FROM kinsta_site_clients ksc WHERE ksc.site_id = s.id
         ) AS linked_client_count
       FROM kinsta_sites s
       LEFT JOIN kinsta_site_workspaces w ON w.site_id = s.id
       WHERE ${where}
       ORDER BY s.site_name ASC`,
      params
    );

    res.json({
      sites: rows.map((row) => ({
        ...serializeSite(row),
        environment_count: row.environment_count,
        primary_domain: row.primary_domain,
        last_scan_at: row.last_scan_at,
        last_scan_status: row.last_scan_status,
        linked_client_count: row.linked_client_count
      }))
    });
  } catch (err) {
    console.error('[operations] list sites failed:', err);
    res.status(500).json({ message: 'Failed to list sites' });
  }
});

router.get('/sites/:siteId', async (req, res) => {
  const { siteId } = req.params;
  if (!UUID_RE.test(siteId)) return badUuid(res, 'siteId');
  try {
    const siteRes = await query('SELECT * FROM kinsta_sites WHERE id = $1 LIMIT 1', [siteId]);
    const site = siteRes.rows[0];
    if (!site) return res.status(404).json({ message: 'Site not found' });

    const [envs, workspace, links] = await Promise.all([
      query(
        `SELECT * FROM kinsta_environments WHERE site_id = $1 ORDER BY is_live DESC, environment_name ASC`,
        [siteId]
      ),
      query('SELECT * FROM kinsta_site_workspaces WHERE site_id = $1 LIMIT 1', [siteId]),
      query(
        `SELECT ksc.id, ksc.client_user_id, ksc.relationship, ksc.notes, ksc.created_at,
                u.email, u.first_name, u.last_name
         FROM kinsta_site_clients ksc
         LEFT JOIN users u ON u.id = ksc.client_user_id
         WHERE ksc.site_id = $1
         ORDER BY ksc.created_at ASC`,
        [siteId]
      )
    ]);

    res.json({
      site: serializeSite(site),
      environments: envs.rows.map(serializeEnvironment),
      workspace: workspace.rows[0]
        ? {
            site_id: workspace.rows[0].site_id,
            claude_md: workspace.rows[0].claude_md,
            scan_json: workspace.rows[0].scan_json,
            agent_prefs: workspace.rows[0].agent_prefs,
            last_scan_at: workspace.rows[0].last_scan_at,
            last_scan_status: workspace.rows[0].last_scan_status,
            last_scan_error: workspace.rows[0].last_scan_error,
            updated_at: workspace.rows[0].updated_at
          }
        : null,
      linked_clients: links.rows
    });
  } catch (err) {
    console.error('[operations] get site failed:', err);
    res.status(500).json({ message: 'Failed to load site' });
  }
});

router.post('/sites/sync', async (req, res) => {
  try {
    const sites = await listAllSites();
    let upsertedSites = 0;
    let upsertedEnvs = 0;

    for (const site of sites) {
      const siteUpsert = await query(
        `INSERT INTO kinsta_sites (kinsta_site_id, site_name, metadata, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (kinsta_site_id)
         DO UPDATE SET site_name = EXCLUDED.site_name, updated_at = NOW()
         RETURNING id`,
        [site.id, site.name || site.display_name || site.id, JSON.stringify({})]
      );
      const internalSiteId = siteUpsert.rows[0].id;
      upsertedSites += 1;

      const envs = site.environments || [];
      for (const env of envs) {
        const summary = pickKinstaEnvironmentSummary(env);
        if (!summary.kinsta_environment_id) continue;
        await query(
          `INSERT INTO kinsta_environments
             (site_id, kinsta_environment_id, environment_name, is_live, primary_domain,
              ssh_host, ssh_ip, ssh_port, ssh_username, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
           ON CONFLICT (kinsta_environment_id)
           DO UPDATE SET
             environment_name = EXCLUDED.environment_name,
             is_live = EXCLUDED.is_live,
             primary_domain = EXCLUDED.primary_domain,
             ssh_host = EXCLUDED.ssh_host,
             ssh_ip = EXCLUDED.ssh_ip,
             ssh_port = EXCLUDED.ssh_port,
             ssh_username = EXCLUDED.ssh_username,
             updated_at = NOW()`,
          [
            internalSiteId,
            summary.kinsta_environment_id,
            summary.environment_name,
            summary.is_live,
            summary.primary_domain,
            summary.ssh_host,
            summary.ssh_ip,
            summary.ssh_port,
            summary.ssh_username
          ]
        );
        upsertedEnvs += 1;
      }
    }

    // Queue background scans for any live envs whose site has no workspace yet.
    const unscanned = await query(
      `SELECT e.site_id
         FROM kinsta_environments e
         LEFT JOIN kinsta_site_workspaces w ON w.site_id = e.site_id
         WHERE e.is_live = TRUE AND w.site_id IS NULL`
    );
    for (const row of unscanned.rows) {
      setImmediate(() => {
        scanSite(row.site_id, { userId: req.user.id }).catch((err) => {
          console.warn(`[operations] background scan ${row.site_id} failed:`, err.message);
        });
      });
    }

    res.json({
      sites: upsertedSites,
      environments: upsertedEnvs,
      background_scans_queued: unscanned.rowCount
    });
  } catch (err) {
    console.error('[operations] sync failed:', err);
    res.status(500).json({ message: 'Sync failed', error: err.message });
  }
});

// ---------------- workspace ----------------

router.get('/sites/:siteId/workspace', async (req, res) => {
  const { siteId } = req.params;
  if (!UUID_RE.test(siteId)) return badUuid(res, 'siteId');
  try {
    const { rows } = await query(
      'SELECT * FROM kinsta_site_workspaces WHERE site_id = $1 LIMIT 1',
      [siteId]
    );
    if (!rows[0]) {
      return res.json({
        site_id: siteId,
        claude_md: '',
        scan_json: {},
        agent_prefs: {},
        last_scan_at: null,
        last_scan_status: null,
        last_scan_error: null,
        updated_at: null
      });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[operations] get workspace failed:', err);
    res.status(500).json({ message: 'Failed to load workspace' });
  }
});

router.put('/sites/:siteId/workspace', async (req, res) => {
  const { siteId } = req.params;
  if (!UUID_RE.test(siteId)) return badUuid(res, 'siteId');
  const { claude_md, agent_prefs } = req.body || {};
  if (typeof claude_md !== 'string') {
    return res.status(400).json({ message: 'claude_md must be a string' });
  }
  if (claude_md.length > 200_000) {
    return res.status(400).json({ message: 'claude_md exceeds 200,000 chars' });
  }
  try {
    const siteCheck = await query('SELECT id FROM kinsta_sites WHERE id = $1 LIMIT 1', [siteId]);
    if (!siteCheck.rows[0]) return res.status(404).json({ message: 'Site not found' });

    const prefs = agent_prefs && typeof agent_prefs === 'object' ? agent_prefs : {};
    const { rows } = await query(
      `INSERT INTO kinsta_site_workspaces (site_id, claude_md, agent_prefs, updated_at)
       VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (site_id)
       DO UPDATE SET claude_md = EXCLUDED.claude_md, agent_prefs = EXCLUDED.agent_prefs, updated_at = NOW()
       RETURNING *`,
      [siteId, claude_md, JSON.stringify(prefs)]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('[operations] save workspace failed:', err);
    res.status(500).json({ message: 'Failed to save workspace' });
  }
});

router.post('/sites/:siteId/scan', async (req, res) => {
  const { siteId } = req.params;
  if (!UUID_RE.test(siteId)) return badUuid(res, 'siteId');
  try {
    const workspace = await scanSite(siteId, { userId: req.user.id });
    res.json(workspace);
  } catch (err) {
    console.error('[operations] scan failed:', err);
    res.status(500).json({ message: err.message || 'Scan failed' });
  }
});

// ---------------- site ↔ client linkage ----------------

router.post('/sites/:siteId/clients', async (req, res) => {
  const { siteId } = req.params;
  if (!UUID_RE.test(siteId)) return badUuid(res, 'siteId');
  const { client_user_id, relationship = 'primary', notes } = req.body || {};
  if (!UUID_RE.test(String(client_user_id || ''))) return badUuid(res, 'client_user_id');
  if (!['primary', 'staging', 'microsite'].includes(relationship)) {
    return res.status(400).json({ message: 'Invalid relationship' });
  }
  try {
    const { rows } = await query(
      `INSERT INTO kinsta_site_clients (site_id, client_user_id, relationship, notes, created_by)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (site_id, client_user_id, relationship) DO UPDATE
         SET notes = EXCLUDED.notes
       RETURNING *`,
      [siteId, client_user_id, relationship, notes || null, req.user.id]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[operations] link client failed:', err);
    res.status(500).json({ message: 'Failed to link client' });
  }
});

router.delete('/sites/:siteId/clients/:linkId', async (req, res) => {
  const { siteId, linkId } = req.params;
  if (!UUID_RE.test(siteId)) return badUuid(res, 'siteId');
  if (!UUID_RE.test(linkId)) return badUuid(res, 'linkId');
  try {
    const { rowCount } = await query(
      'DELETE FROM kinsta_site_clients WHERE id = $1 AND site_id = $2',
      [linkId, siteId]
    );
    if (!rowCount) return res.status(404).json({ message: 'Link not found' });
    res.status(204).end();
  } catch (err) {
    console.error('[operations] unlink client failed:', err);
    res.status(500).json({ message: 'Failed to unlink client' });
  }
});

// Sites linked to a given client (with link metadata).
router.get('/clients/:clientId/sites', async (req, res) => {
  const { clientId } = req.params;
  if (!UUID_RE.test(clientId)) return badUuid(res, 'clientId');
  try {
    const { rows } = await query(
      `SELECT
         ksc.id AS link_id,
         ksc.relationship,
         ksc.notes,
         ksc.created_at AS linked_at,
         s.id AS site_id,
         s.site_name,
         s.display_name,
         (
           SELECT primary_domain FROM kinsta_environments
           WHERE site_id = s.id AND is_live = TRUE
           ORDER BY created_at ASC LIMIT 1
         ) AS primary_domain
       FROM kinsta_site_clients ksc
       JOIN kinsta_sites s ON s.id = ksc.site_id
       WHERE ksc.client_user_id = $1 AND ${activeOnly('s')}
       ORDER BY s.site_name ASC`,
      [clientId]
    );
    res.json({ sites: rows });
  } catch (err) {
    console.error('[operations] client sites failed:', err);
    res.status(500).json({ message: 'Failed to load sites for client' });
  }
});

// ---------------- environments ----------------

router.get('/environments/:envId', async (req, res) => {
  const { envId } = req.params;
  if (!UUID_RE.test(envId)) return badUuid(res, 'envId');
  try {
    const { rows } = await query('SELECT * FROM kinsta_environments WHERE id = $1 LIMIT 1', [envId]);
    if (!rows[0]) return res.status(404).json({ message: 'Environment not found' });
    res.json(serializeEnvironment(rows[0]));
  } catch (err) {
    console.error('[operations] get env failed:', err);
    res.status(500).json({ message: 'Failed to load environment' });
  }
});

router.put('/environments/:envId/read-only', async (req, res) => {
  const { envId } = req.params;
  if (!UUID_RE.test(envId)) return badUuid(res, 'envId');
  const readOnly = Boolean(req.body?.read_only);
  try {
    const { rows } = await query(
      `UPDATE kinsta_environments
         SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{read_only}', to_jsonb($2::boolean), true),
             updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [envId, readOnly]
    );
    if (!rows[0]) return res.status(404).json({ message: 'Environment not found' });
    res.json(serializeEnvironment(rows[0]));
  } catch (err) {
    console.error('[operations] toggle read-only failed:', err);
    res.status(500).json({ message: err.message || 'Toggle failed' });
  }
});

router.post('/environments/:envId/credentials/refresh', async (req, res) => {
  const { envId } = req.params;
  if (!UUID_RE.test(envId)) return badUuid(res, 'envId');
  try {
    const lookup = await query(
      'SELECT id, kinsta_environment_id FROM kinsta_environments WHERE id = $1 LIMIT 1',
      [envId]
    );
    const env = lookup.rows[0];
    if (!env) return res.status(404).json({ message: 'Environment not found' });

    const fresh = await getSshPassword(env.kinsta_environment_id);
    if (!fresh) return res.status(502).json({ message: 'Kinsta did not return a password' });

    const encrypted = encrypt(fresh);
    if (!encrypted) return res.status(500).json({ message: 'Failed to encrypt password' });

    await query(
      `UPDATE kinsta_environments
         SET ssh_password_encrypted = $1,
             ssh_password_fetched_at = NOW(),
             updated_at = NOW()
       WHERE id = $2`,
      [encrypted, env.id]
    );
    res.json({ ok: true, fetched_at: new Date().toISOString() });
  } catch (err) {
    console.error('[operations] refresh creds failed:', err);
    res.status(500).json({ message: 'Failed to refresh credentials' });
  }
});

router.post('/environments/:envId/exec', userRateLimit('operations_exec_user'), async (req, res) => {
  const { envId } = req.params;
  if (!UUID_RE.test(envId)) return badUuid(res, 'envId');
  const { command, timeoutMs } = req.body || {};
  if (!command || typeof command !== 'string') {
    return res.status(400).json({ message: 'command (string) required' });
  }
  if (command.length > 4000) {
    return res.status(400).json({ message: 'command too long' });
  }
  try {
    const result = await execCommand(envId, command, {
      userId: req.user.id,
      timeoutMs: Number(timeoutMs) > 0 ? Math.min(Number(timeoutMs), 120_000) : undefined,
      triggeredBy: 'manual'
    });
    res.json(result);
  } catch (err) {
    console.error('[operations] exec failed:', err);
    res.status(500).json({ message: err.message || 'Exec failed' });
  }
});

router.get('/environments/:envId/commands', async (req, res) => {
  const { envId } = req.params;
  if (!UUID_RE.test(envId)) return badUuid(res, 'envId');
  const limit = Math.max(1, Math.min(100, Number(req.query.limit) || 25));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  try {
    const { rows } = await query(
      `SELECT id, environment_id, user_id, channel, command_summary,
              exit_code, duration_ms, triggered_by, created_at
         FROM kinsta_ssh_command_log
         WHERE environment_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
      [envId, limit, offset]
    );
    res.json({ commands: rows, limit, offset });
  } catch (err) {
    console.error('[operations] list commands failed:', err);
    res.status(500).json({ message: 'Failed to list commands' });
  }
});

// ---------------- drift findings ----------------

router.post('/sites/:siteId/drift-baseline/accept', async (req, res) => {
  const { siteId } = req.params;
  if (!UUID_RE.test(siteId)) return badUuid(res, 'siteId');
  try {
    const result = await acceptBaseline(siteId, { userId: req.user.id });
    res.json(result);
  } catch (err) {
    console.error('[operations] accept baseline failed:', err);
    res.status(500).json({ message: err.message || 'Accept baseline failed' });
  }
});

router.post('/sites/:siteId/drift-check', async (req, res) => {
  const { siteId } = req.params;
  if (!UUID_RE.test(siteId)) return badUuid(res, 'siteId');
  try {
    const result = await runDriftCheck(siteId, { userId: req.user.id });
    res.json(result);
  } catch (err) {
    console.error('[operations] drift check failed:', err);
    res.status(500).json({ message: err.message || 'Drift check failed' });
  }
});

// ---------------- findings (DEPRECATED) ----------------
//
// These endpoints predate the unified ops_findings model introduced in
// Phase 1 of the Operations rebuild. They still query `kinsta_findings`
// (which is now also exposed via the `kinsta_findings_compat` view) so
// existing UI keeps working, but new callers should use:
//   GET /api/ops/findings?client_user_id=...&open=true
// for the cross-platform feed (covers website + google_ads + meta).
// We surface a Deprecation header + a one-shot warn line per process.
let _opsFindingsDeprecationWarned = false;
function deprecateLegacyFindings(req, res, next) {
  res.set('Deprecation', 'true');
  res.set('Link', '</api/ops/findings>; rel="successor-version"');
  if (!_opsFindingsDeprecationWarned) {
    _opsFindingsDeprecationWarned = true;
    console.warn(
      '[operations] /api/operations/findings* is deprecated. Use /api/ops/findings (Phase 1 unified ops_findings) for cross-platform results.'
    );
  }
  next();
}

router.get('/sites/:siteId/findings', deprecateLegacyFindings, async (req, res) => {
  const { siteId } = req.params;
  if (!UUID_RE.test(siteId)) return badUuid(res, 'siteId');
  try {
    const findings = await listFindings({
      siteId,
      openOnly: req.query.open !== '0'
    });
    res.json({ findings });
  } catch (err) {
    console.error('[operations] list findings failed:', err);
    res.status(500).json({ message: 'Failed to list findings' });
  }
});

router.get('/findings', deprecateLegacyFindings, async (req, res) => {
  try {
    const findings = await listFindings({
      siteId: null,
      openOnly: req.query.open !== '0',
      limit: Number(req.query.limit) || 200
    });
    res.json({ findings });
  } catch (err) {
    console.error('[operations] list all findings failed:', err);
    res.status(500).json({ message: 'Failed to list findings' });
  }
});

router.get('/findings/counts', deprecateLegacyFindings, async (req, res) => {
  try {
    res.json({ counts: await countOpenFindingsBySite() });
  } catch (err) {
    console.error('[operations] finding counts failed:', err);
    res.status(500).json({ message: 'Failed to count findings' });
  }
});

router.post('/findings/:findingId/acknowledge', async (req, res) => {
  const { findingId } = req.params;
  if (!UUID_RE.test(findingId)) return badUuid(res, 'findingId');
  try {
    const f = await acknowledgeFinding(findingId, req.user.id);
    if (!f) return res.status(404).json({ message: 'Finding not found or already acknowledged' });
    res.json(f);
  } catch (err) {
    res.status(500).json({ message: err.message || 'Acknowledge failed' });
  }
});

router.post('/findings/:findingId/resolve', async (req, res) => {
  const { findingId } = req.params;
  if (!UUID_RE.test(findingId)) return badUuid(res, 'findingId');
  try {
    const f = await resolveFinding(findingId);
    if (!f) return res.status(404).json({ message: 'Finding not found or already resolved' });
    res.json(f);
  } catch (err) {
    res.status(500).json({ message: err.message || 'Resolve failed' });
  }
});

// ---------------- bulk actions ----------------

router.get('/bulk/actions', (req, res) => {
  res.json({ actions: listBulkActions() });
});

router.get('/bulk', async (req, res) => {
  try {
    const all = req.query.all === '1';
    const jobs = await listBulkOperations({
      userId: all ? null : req.user.id,
      limit: Number(req.query.limit) || 25
    });
    res.json({ jobs });
  } catch (err) {
    console.error('[operations] list bulk failed:', err);
    res.status(500).json({ message: 'Failed to list bulk jobs' });
  }
});

router.post('/bulk', async (req, res) => {
  const { action, params = {}, env_ids: rawEnvIds, site_ids: rawSiteIds } = req.body || {};
  if (!action || typeof action !== 'string') return res.status(400).json({ message: 'action required' });

  let envIds = Array.isArray(rawEnvIds) ? rawEnvIds.map(String) : [];
  if (Array.isArray(rawSiteIds) && rawSiteIds.length) {
    for (const id of rawSiteIds) {
      if (!UUID_RE.test(String(id))) return badUuid(res, 'site_ids');
    }
    const { rows } = await query(
      `SELECT DISTINCT ON (site_id) id, site_id
         FROM kinsta_environments
        WHERE site_id = ANY($1::uuid[]) AND is_live = TRUE
        ORDER BY site_id, created_at ASC`,
      [rawSiteIds]
    );
    envIds = envIds.concat(rows.map((r) => r.id));
  }

  if (envIds.length === 0) return res.status(400).json({ message: 'env_ids[] or site_ids[] required' });
  for (const id of envIds) {
    if (!UUID_RE.test(String(id))) return badUuid(res, 'env_ids');
  }
  if (envIds.length > 200) return res.status(400).json({ message: 'Max 200 envs per job' });

  try {
    const job = await createBulkOperation({ userId: req.user.id, action, params, envIds });
    res.status(201).json(job);
  } catch (err) {
    res.status(400).json({ message: err.message || 'Bulk create failed' });
  }
});

router.get('/bulk/:jobId', async (req, res) => {
  const { jobId } = req.params;
  if (!UUID_RE.test(jobId)) return badUuid(res, 'jobId');
  try {
    const job = await getBulkOperation(jobId);
    if (!job) return res.status(404).json({ message: 'Job not found' });
    res.json(job);
  } catch (err) {
    console.error('[operations] get bulk failed:', err);
    res.status(500).json({ message: 'Failed to load job' });
  }
});

router.post('/bulk/:jobId/cancel', async (req, res) => {
  const { jobId } = req.params;
  if (!UUID_RE.test(jobId)) return badUuid(res, 'jobId');
  try {
    const job = await cancelBulkOperation(jobId);
    if (!job) return res.status(404).json({ message: 'Job not found or already finished' });
    res.json(job);
  } catch (err) {
    console.error('[operations] cancel bulk failed:', err);
    res.status(500).json({ message: 'Failed to cancel job' });
  }
});

// ---------------- AI assistant (DECOMMISSIONED) ----------------
//
// The legacy `/api/operations/assistant/chat` endpoint was decommissioned in
// Phase 10 of the Operations rebuild (2026-05-05). All AI chat now goes
// through the supervisor at `POST /api/ops/chat`. The Site drawer's inline
// assistant was replaced with a notice that points users to the new AI Chat
// tab in Operations.
//
// Returns 410 Gone so any stale callers learn fast.
router.post('/assistant/chat', userRateLimit('operations_assistant_user'), (req, res) => {
  res.set('Deprecation', 'true');
  res.set('Link', '</api/ops/chat>; rel="successor-version"');
  res.status(410).json({
    message:
      'The legacy operations assistant has been replaced. Use POST /api/ops/chat (per-client supervisor) instead.',
    successor: '/api/ops/chat'
  });
});

export default router;
