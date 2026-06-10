/**
 * Bulk action runner — executes one action across many environments with
 * bounded concurrency, persisting per-target results to kinsta_bulk_operations.
 *
 * Triggered explicitly by the admin clicking "Run" in the UI; never on a cron.
 * Cancellation flips status to 'cancelled' and prevents new targets from starting.
 */

import { query } from '../../../db.js';
import { wpcli } from './sshClient.js';
import { getTool } from './agentTools.js';
import { runDriftCheck } from './driftScanner.js';

const CONCURRENCY = 10;

const ACTIONS = {
  verify_tracking_install: {
    label: 'Verify tracking install',
    requires_params: false,
    mutating: false,
    async run(envId, params, ctx) {
      const tool = getTool('verify_tracking_install');
      // Use the agent tool, but with siteId resolved from envId so it can cross-ref.
      const siteRow = await query(
        'SELECT site_id FROM kinsta_environments WHERE id = $1 LIMIT 1',
        [envId]
      );
      const siteId = siteRow.rows[0]?.site_id || null;
      return tool.handler({}, { userId: ctx.userId, agentType: 'bulk', siteId, envId });
    }
  },
  plugin_list: {
    label: 'List plugins',
    requires_params: false,
    mutating: false,
    async run(envId, params, ctx) {
      const res = await wpcli(envId, 'plugin list --format=json', {
        userId: ctx.userId,
        triggeredBy: `bulk:plugin_list`
      });
      if (res.exitCode !== 0) return { error: res.stderr || 'wp-cli failed' };
      try {
        return { plugins: JSON.parse(res.stdout) };
      } catch {
        return { error: 'parse failed', stdout: res.stdout.slice(0, 1000) };
      }
    }
  },
  wpcli_read: {
    label: 'Custom WP-CLI (read-only)',
    requires_params: ['args'],
    mutating: false,
    async run(envId, params, ctx) {
      const tool = getTool('wpcli_read');
      return tool.handler({ args: params.args }, { userId: ctx.userId, agentType: 'bulk' });
    }
  },
  drift_check: {
    label: 'Run drift check',
    requires_params: false,
    mutating: false,
    async run(envId, params, ctx) {
      const siteRow = await query(
        'SELECT site_id FROM kinsta_environments WHERE id = $1 LIMIT 1',
        [envId]
      );
      const siteId = siteRow.rows[0]?.site_id;
      if (!siteId) return { error: 'Could not resolve site for env' };
      const res = await runDriftCheck(siteId, {
        userId: ctx.userId
      });
      return {
        finding_count: res.findings.length,
        baseline_existed: res.baseline_existed,
        findings_summary: res.findings.map((f) => ({
          severity: f.severity,
          category: f.category,
          summary: f.summary
        }))
      };
    }
  },
  plugin_update: {
    label: 'Update plugin (defaults to --dry-run)',
    requires_params: ['slug'],
    mutating: true,
    async run(envId, params, ctx) {
      const slug = params.slug || '';
      const dryRun = params.dry_run !== false; // default true
      const target = slug === 'all' ? '--all' : slug;
      const res = await wpcli(envId, `plugin update ${target}${dryRun ? ' --dry-run' : ''}`, {
        userId: ctx.userId,
        triggeredBy: `bulk:plugin_update${dryRun ? ':dry' : ''}`
      });
      return {
        exit_code: res.exitCode,
        dry_run: dryRun,
        stdout: (res.stdout || '').slice(0, 4000),
        stderr: (res.stderr || '').slice(0, 2000)
      };
    }
  }
};

export function listBulkActions() {
  return Object.entries(ACTIONS).map(([key, def]) => ({
    key,
    label: def.label,
    requires_params: def.requires_params || [],
    mutating: Boolean(def.mutating)
  }));
}

export async function createBulkOperation({ userId, action, params, envIds }) {
  if (!ACTIONS[action]) throw new Error(`Unknown action: ${action}`);
  if (!Array.isArray(envIds) || envIds.length === 0) throw new Error('envIds required');

  const required = ACTIONS[action].requires_params || [];
  for (const key of required) {
    if (params[key] == null || params[key] === '') {
      throw new Error(`Missing required param: ${key}`);
    }
  }

  const { rows } = await query(
    `INSERT INTO kinsta_bulk_operations
       (user_id, action, params_json, status, total_targets, result_json)
     VALUES ($1, $2, $3::jsonb, 'queued', $4, $5::jsonb)
     RETURNING *`,
    [
      userId,
      action,
      JSON.stringify(params || {}),
      envIds.length,
      JSON.stringify({ targets: Object.fromEntries(envIds.map((id) => [id, { status: 'queued' }])) })
    ]
  );
  const job = rows[0];

  // Kick off processing in the background, but only after this user click.
  setImmediate(() => {
    runJob(job.id, envIds, action, params || {}, userId).catch((err) => {
      console.error(`[bulk] job ${job.id} failed:`, err.message);
    });
  });

  return job;
}

async function isCancelled(jobId) {
  const { rows } = await query('SELECT status FROM kinsta_bulk_operations WHERE id = $1 LIMIT 1', [jobId]);
  return rows[0]?.status === 'cancelled';
}

async function runJob(jobId, envIds, action, params, userId) {
  await query(
    `UPDATE kinsta_bulk_operations SET status = 'running' WHERE id = $1 AND status = 'queued'`,
    [jobId]
  );

  let cursor = 0;
  let completed = 0;
  const targets = {};

  async function worker() {
    while (cursor < envIds.length) {
      if (await isCancelled(jobId)) return;
      const envId = envIds[cursor];
      cursor += 1;
      const startedAt = Date.now();
      let result;
      try {
        result = await ACTIONS[action].run(envId, params, { userId });
        targets[envId] = {
          status: result?.error ? 'error' : 'success',
          result,
          duration_ms: Date.now() - startedAt
        };
      } catch (err) {
        targets[envId] = {
          status: 'error',
          result: { error: err.message || 'failed' },
          duration_ms: Date.now() - startedAt
        };
      }
      completed += 1;
      // Persist progress incrementally so the UI can poll.
      await query(
        `UPDATE kinsta_bulk_operations
           SET completed_targets = $1,
               result_json = jsonb_set(result_json, '{targets}', $2::jsonb, true)
         WHERE id = $3`,
        [completed, JSON.stringify({ ...buildTargetMap(envIds, targets) }), jobId]
      ).catch((err) => console.warn('[bulk] progress update failed:', err.message));
    }
  }

  function buildTargetMap(allIds, doneMap) {
    const out = {};
    for (const id of allIds) {
      out[id] = doneMap[id] || { status: cursor > allIds.indexOf(id) ? 'running' : 'queued' };
    }
    return out;
  }

  const workers = Array.from({ length: Math.min(CONCURRENCY, envIds.length) }, () => worker());
  await Promise.all(workers);

  const cancelled = await isCancelled(jobId);
  await query(
    `UPDATE kinsta_bulk_operations
       SET status = $2,
           completed_targets = $3,
           finished_at = NOW(),
           result_json = jsonb_set(result_json, '{targets}', $4::jsonb, true)
     WHERE id = $1`,
    [
      jobId,
      cancelled ? 'cancelled' : 'completed',
      completed,
      JSON.stringify(buildTargetMap(envIds, targets))
    ]
  );
}

export async function getBulkOperation(jobId) {
  const { rows } = await query('SELECT * FROM kinsta_bulk_operations WHERE id = $1 LIMIT 1', [jobId]);
  return rows[0] || null;
}

export async function listBulkOperations({ userId, limit = 25 }) {
  const { rows } = await query(
    `SELECT id, user_id, action, status, total_targets, completed_targets, created_at, finished_at
       FROM kinsta_bulk_operations
       WHERE user_id = $1 OR $1 IS NULL
       ORDER BY created_at DESC
       LIMIT $2`,
    [userId || null, Math.max(1, Math.min(100, limit))]
  );
  return rows;
}

export async function cancelBulkOperation(jobId) {
  const { rows } = await query(
    `UPDATE kinsta_bulk_operations
       SET status = 'cancelled', finished_at = NOW()
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING *`,
    [jobId]
  );
  return rows[0] || null;
}
