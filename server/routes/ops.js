/**
 * Operations rebuild router — Phase 1.
 *
 * Mounted at /api/ops. Admin-gated. Phase 1 covers the read/write surface for
 * runs, findings, run definitions, client subscriptions, and credentials.
 * Manual run triggers insert status='queued' rows only — actual orchestration
 * (Pub/Sub fanout, Cloud Run Job worker) lands in Phase 2.
 *
 * The legacy /api/operations router (Kinsta-specific) stays mounted alongside
 * during the transition.
 */

import express from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { query } from '../db.js';
import { clientLabelSelect, clientLabelJoins } from '../services/clientLabel.js';
import { putCredential, validateCredential, deleteCredential, listCredentialsForClient } from '../services/ops/credentialStore.js';
import { enqueueRun, publishCancelSignal, cancelLocal } from '../services/ops/runQueue.js';
import { checkBudget } from '../services/ops/budgetGuard.js';
import { recomputeForFinding, recomputeAllOpen } from '../services/ops/attentionScore.js';
import { logSecurityEvent, SecurityEventTypes, SecurityEventCategories } from '../services/security/audit.js';
import { handleFanoutRequest, authorizeFanoutRequest, fanOutBulkSchedule, computeNextRunAt } from '../services/ops/scheduleFanout.js';
import { getReportSignedUrl } from '../services/ops/reportRenderer.js';
import { sendPortfolioDigest } from '../services/ops/emailDigest.js';
import { executeApproval, rejectApproval } from '../services/ops/agents/supervisor.js';
import { runClaudeChatTurn, listThreads, loadThread } from '../services/ops/agents/claudeSupervisor.js';
import { checkRateLimit, recordAttempt } from '../services/security/rateLimit.js';
import { listAllChecks } from '../services/ops/checks/registry.js';
import { listOpsClientRoster, opsClientExistsExpression, opsClientLabelExpression } from '../services/ops/clientRoster.js';
import {
  listSkills,
  getSkill,
  listVersions,
  createSkill,
  saveNewVersion,
  archiveSkill,
  listPendingSuggestions,
  approveSuggestion,
  rejectSuggestion
} from '../services/ops/skills/store.js';
import {
  listRecipes,
  getRecipe,
  createRecipe,
  updateRecipe,
  archiveRecipe
} from '../services/ops/skills/recipes.js';
import multer from 'multer';
import { storeFile } from '../services/fileStorage.js';
import { createPost as blogCreate, updatePost as blogUpdate, cancelPost as blogCancel, deletePost as blogDelete, listPosts as blogList, listClientWpSites } from '../services/ops/blog/blogStore.js';

const blogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const router = express.Router();

// `/internal/*` routes are invoked by Cloud Scheduler with an OIDC bearer; they
// must NOT pass through the admin requireAuth middleware. Mount them before the
// router-level `use(requireAuth)` below.
router.post('/internal/fanout', handleFanoutRequest);
router.post('/internal/portfolio-digest', async (req, res) => {
  const ok = await authorizeFanoutRequest(req, res);
  if (!ok) return;
  try {
    const result = await sendPortfolioDigest();
    res.json(result);
  } catch (err) {
    console.warn(`[ops] portfolio-digest failed: ${err?.message || err}`);
    res.status(500).json({ message: 'portfolio digest failed' });
  }
});

router.post('/internal/attention-recompute', async (req, res) => {
  const ok = await authorizeFanoutRequest(req, res);
  if (!ok) return;
  try {
    const updated = await recomputeAllOpen();
    res.json({ updated });
  } catch (err) {
    console.warn(`[ops] attention-recompute failed: ${err?.message || err}`);
    res.status(500).json({ message: 'attention recompute failed' });
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.use(requireAuth);
router.use(requireAdmin);

function badUuid(res, name) {
  return res.status(400).json({ message: `Invalid ${name}` });
}

function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

async function isOperationsClient(clientUserId) {
  const { rows } = await query(`SELECT 1 WHERE ${opsClientExistsExpression('$1::uuid')} LIMIT 1`, [clientUserId]);
  return rows.length > 0;
}

// ---------------- runs ----------------

router.get('/runs', async (req, res) => {
  try {
    const { client_user_id, status, tier, from, to, limit } = req.query;
    const conds = [opsClientExistsExpression('client_user_id')];
    const params = [];

    if (client_user_id) {
      if (!isUuid(client_user_id)) return badUuid(res, 'client_user_id');
      params.push(client_user_id);
      conds.push(`client_user_id = $${params.length}`);
    }
    if (status) {
      params.push(String(status));
      conds.push(`status = $${params.length}`);
    }
    if (tier) {
      params.push(String(tier));
      conds.push(`tier = $${params.length}`);
    }
    if (from) {
      const d = new Date(String(from));
      if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'Invalid from date' });
      params.push(d.toISOString());
      conds.push(`created_at >= $${params.length}`);
    }
    if (to) {
      const d = new Date(String(to));
      if (Number.isNaN(d.getTime())) return res.status(400).json({ message: 'Invalid to date' });
      params.push(d.toISOString());
      conds.push(`created_at <= $${params.length}`);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    params.push(cap);

    const { rows } = await query(`SELECT * FROM ops_runs ${where} ORDER BY created_at DESC LIMIT $${params.length}`, params);
    res.json(rows);
  } catch (err) {
    console.error('[ops] GET /runs failed:', err);
    res.status(500).json({ message: 'Failed to list runs' });
  }
});

router.post('/runs', async (req, res) => {
  try {
    const { client_user_id, run_definition_id, tier, trigger = 'manual', metadata = {} } = req.body || {};

    if (!isUuid(client_user_id)) return badUuid(res, 'client_user_id');
    if (!(await isOperationsClient(client_user_id))) {
      return res.status(404).json({ message: 'Client account not found' });
    }
    if (run_definition_id && !isUuid(run_definition_id)) {
      return badUuid(res, 'run_definition_id');
    }

    let resolvedTier = tier;
    if (run_definition_id) {
      const def = await query('SELECT tier FROM ops_run_definitions WHERE id = $1', [run_definition_id]);
      if (def.rows.length === 0) {
        return res.status(404).json({ message: 'run_definition_id not found' });
      }
      resolvedTier = resolvedTier || def.rows[0].tier;
    }
    if (!resolvedTier) {
      return res.status(400).json({ message: 'tier is required when run_definition_id is omitted' });
    }

    const triggeredBy = trigger === 'manual' ? req.user?.id || null : null;

    // Phase 8 §10.3: manual triggers bypass the monthly cap (admin override)
    // but emit an audit event so the override is auditable. Pass the tier so
    // the budget gate projects the pending run's estimated cost — the audit
    // fires for "would land over cap" cases, not only "already at cap".
    if (trigger === 'manual') {
      try {
        const budget = await checkBudget(client_user_id, { tier: resolvedTier });
        if (!budget.allowed) {
          await logSecurityEvent({
            userId: req.user?.id,
            eventType: SecurityEventTypes.OPERATIONS_RUN_MANUAL_OVERRIDE_BUDGET,
            eventCategory: SecurityEventCategories.OPERATIONS,
            success: true,
            details: {
              client_user_id,
              run_definition_id: run_definition_id || null,
              tier: resolvedTier,
              cap_cents: budget.capCents,
              spend_cents: budget.spendCents,
              estimate_cents: budget.estimateCents,
              projected_cents: budget.spendCents + budget.estimateCents
            }
          });
        }
      } catch (err) {
        console.warn(`[ops] budget check on manual trigger failed: ${err?.message || err}`);
      }
    }

    const { rows } = await query(
      `
      INSERT INTO ops_runs
        (client_user_id, run_definition_id, tier, status, trigger, triggered_by, metadata)
      VALUES ($1, $2, $3, 'queued', $4, $5, $6)
      RETURNING *
      `,
      [client_user_id, run_definition_id || null, resolvedTier, trigger, triggeredBy, metadata]
    );

    // Enqueue for execution. In production this publishes to Pub/Sub; in dev
    // it pushes onto the in-memory worker. Errors are warned, not thrown — the
    // queued row exists either way and can be retried by re-posting.
    const enqueueResult = await enqueueRun(rows[0].id);
    res.status(201).json({ ...rows[0], _enqueue: enqueueResult });
  } catch (err) {
    console.error('[ops] POST /runs failed:', err);
    res.status(500).json({ message: 'Failed to create run' });
  }
});

router.get('/runs/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'run id');
  try {
    const { rows } = await query('SELECT * FROM ops_runs WHERE id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Run not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[ops] GET /runs/:id failed:', err);
    res.status(500).json({ message: 'Failed to load run' });
  }
});

router.post('/runs/:id/cancel', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'run id');
  try {
    const { rows } = await query(
      `
      UPDATE ops_runs
         SET status = 'cancelled',
             finished_at = COALESCE(finished_at, NOW())
       WHERE id = $1 AND status IN ('queued', 'running')
       RETURNING *
      `,
      [req.params.id]
    );
    if (rows.length === 0) {
      return res.status(409).json({ message: 'Run not cancellable' });
    }
    // Phase 8: cooperative cancellation. In dev/local mode the in-process
    // worker holds an AbortController; calling cancelLocal aborts the in-flight
    // run between checks. In production we additionally publish to
    // ops.run.cancel — the Cloud Run Job worker subscribes and aborts there.
    const localAborted = cancelLocal(req.params.id);
    const signalResult = await publishCancelSignal(req.params.id);
    res.json({ ...rows[0], _cancel_local: localAborted, _cancel_signal: signalResult });
  } catch (err) {
    console.error('[ops] POST /runs/:id/cancel failed:', err);
    res.status(500).json({ message: 'Failed to cancel run' });
  }
});

router.get('/runs/:id/report', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'run id');
  try {
    const { rows } = await query('SELECT * FROM ops_reports WHERE run_id = $1', [req.params.id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Report not found' });
    const report = rows[0];
    let signed = null;
    try {
      signed = await getReportSignedUrl(req.params.id);
    } catch (err) {
      console.warn(`[ops] signed URL mint failed: ${err?.message || err}`);
    }
    res.json({ ...report, signed_url: signed?.url || null, signed_url_expires_at: signed?.expires_at || null });
  } catch (err) {
    console.error('[ops] GET /runs/:id/report failed:', err);
    res.status(500).json({ message: 'Failed to load report' });
  }
});

router.get('/runs/:id/check-results', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'run id');
  try {
    const { rows } = await query(`SELECT * FROM ops_check_results WHERE run_id = $1 ORDER BY created_at ASC`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    console.error('[ops] GET /runs/:id/check-results failed:', err);
    res.status(500).json({ message: 'Failed to load check results' });
  }
});

router.get('/runs/:id/findings', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'run id');
  try {
    const { rows } = await query(`SELECT * FROM ops_findings WHERE run_id = $1 ORDER BY created_at DESC`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    console.error('[ops] GET /runs/:id/findings failed:', err);
    res.status(500).json({ message: 'Failed to load findings' });
  }
});

// ---------------- findings (cross-run) ----------------

const DISCOVERY_STATUSES = new Set(['open', 'investigating', 'blocked', 'resolved', 'ignored']);

router.get('/findings', async (req, res) => {
  try {
    const { client_user_id, severity, category, open, status } = req.query;
    const conds = [opsClientExistsExpression('client_user_id')];
    const params = [];

    if (client_user_id) {
      if (!isUuid(client_user_id)) return badUuid(res, 'client_user_id');
      params.push(client_user_id);
      conds.push(`client_user_id = $${params.length}`);
    }
    if (severity) {
      params.push(String(severity));
      conds.push(`severity = $${params.length}`);
    }
    if (category) {
      params.push(String(category));
      conds.push(`category = $${params.length}`);
    }
    if (status) {
      const value = String(status);
      if (!DISCOVERY_STATUSES.has(value)) {
        return res.status(400).json({ message: 'Invalid status' });
      }
      params.push(value);
      conds.push(`status = $${params.length}`);
    }
    if (open === 'true' || open === '1') {
      conds.push(`resolved_at IS NULL`);
    }

    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const { rows } = await query(`SELECT * FROM ops_findings ${where} ORDER BY created_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch (err) {
    console.error('[ops] GET /findings failed:', err);
    res.status(500).json({ message: 'Failed to list findings' });
  }
});

router.post('/findings/:id/acknowledge', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'finding id');
  try {
    const { rows } = await query(
      `
      UPDATE ops_findings
         SET acknowledged_at = NOW(),
             acknowledged_by = $2,
             status = CASE WHEN status = 'open' THEN 'investigating' ELSE status END
       WHERE id = $1
       RETURNING *
      `,
      [req.params.id, req.user?.id || null]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Finding not found' });
    try {
      await recomputeForFinding(req.params.id);
    } catch {
      /* non-fatal */
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[ops] POST /findings/:id/acknowledge failed:', err);
    res.status(500).json({ message: 'Failed to acknowledge finding' });
  }
});

router.post('/findings/:id/resolve', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'finding id');
  const { resolution_note = null } = req.body || {};
  try {
    const { rows } = await query(
      `
      UPDATE ops_findings
         SET resolved_at = NOW(),
             resolved_by = $2,
             resolution_note = $3,
             status = 'resolved'
       WHERE id = $1
       RETURNING *
      `,
      [req.params.id, req.user?.id || null, resolution_note]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Finding not found' });
    try {
      await recomputeForFinding(req.params.id);
    } catch {
      /* non-fatal */
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[ops] POST /findings/:id/resolve failed:', err);
    res.status(500).json({ message: 'Failed to resolve finding' });
  }
});

// ---------------- Discovery state machine (Command Center pivot) ----------------

router.put('/findings/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'finding id');
  const { status, owner_user_id, business_impact, recommended_action_json } = req.body || {};

  const sets = [];
  const params = [];
  if (status !== undefined) {
    if (!DISCOVERY_STATUSES.has(String(status))) {
      return res.status(400).json({ message: 'Invalid status' });
    }
    params.push(String(status));
    sets.push(`status = $${params.length}`);
    if (status === 'resolved') {
      sets.push(`resolved_at = COALESCE(resolved_at, NOW())`);
    } else if (status === 'ignored') {
      sets.push(`resolved_at = COALESCE(resolved_at, NOW())`);
    }
  }
  if (owner_user_id !== undefined) {
    if (owner_user_id !== null && !isUuid(owner_user_id)) {
      return badUuid(res, 'owner_user_id');
    }
    params.push(owner_user_id);
    sets.push(`owner_user_id = $${params.length}`);
  }
  if (business_impact !== undefined) {
    params.push(business_impact == null ? null : String(business_impact).slice(0, 500));
    sets.push(`business_impact = $${params.length}`);
  }
  if (recommended_action_json !== undefined) {
    params.push(recommended_action_json == null ? null : recommended_action_json);
    sets.push(`recommended_action_json = $${params.length}`);
  }
  if (sets.length === 0) {
    return res.status(400).json({ message: 'Nothing to update' });
  }

  try {
    const before = await query(`SELECT status, owner_user_id FROM ops_findings WHERE id = $1`, [req.params.id]);
    if (before.rows.length === 0) return res.status(404).json({ message: 'Finding not found' });
    const prevStatus = before.rows[0].status;
    const prevOwner = before.rows[0].owner_user_id;

    params.push(req.params.id);
    const { rows } = await query(`UPDATE ops_findings SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);

    try {
      await recomputeForFinding(req.params.id);
    } catch {
      /* non-fatal */
    }

    if (status !== undefined && status !== prevStatus) {
      await logSecurityEvent({
        userId: req.user?.id || null,
        eventType: SecurityEventTypes.OPERATIONS_DISCOVERY_STATUS_CHANGE,
        eventCategory: SecurityEventCategories.OPERATIONS,
        success: true,
        details: { findingId: req.params.id, from: prevStatus, to: status }
      });
    }
    if (owner_user_id !== undefined && (owner_user_id || null) !== (prevOwner || null)) {
      await logSecurityEvent({
        userId: req.user?.id || null,
        eventType: SecurityEventTypes.OPERATIONS_DISCOVERY_ASSIGNED,
        eventCategory: SecurityEventCategories.OPERATIONS,
        success: true,
        details: { findingId: req.params.id, from: prevOwner || null, to: owner_user_id || null }
      });
    }
    res.json(rows[0]);
  } catch (err) {
    console.error('[ops] PUT /findings/:id failed:', err);
    res.status(500).json({ message: 'Failed to update finding' });
  }
});

router.post('/findings/:id/assign', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'finding id');
  const { owner_user_id } = req.body || {};
  if (owner_user_id !== null && !isUuid(owner_user_id)) {
    return badUuid(res, 'owner_user_id');
  }
  try {
    const { rows } = await query(`UPDATE ops_findings SET owner_user_id = $2 WHERE id = $1 RETURNING *`, [req.params.id, owner_user_id]);
    if (rows.length === 0) return res.status(404).json({ message: 'Finding not found' });
    await logSecurityEvent({
      userId: req.user?.id || null,
      eventType: SecurityEventTypes.OPERATIONS_DISCOVERY_ASSIGNED,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { findingId: req.params.id, ownerUserId: owner_user_id }
    });
    res.json(rows[0]);
  } catch (err) {
    console.error('[ops] POST /findings/:id/assign failed:', err);
    res.status(500).json({ message: 'Failed to assign finding' });
  }
});

router.post('/findings/:id/ignore', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'finding id');
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ message: 'reason required' });
  try {
    const { rows } = await query(
      `
      UPDATE ops_findings
         SET status = 'ignored',
             resolved_at = COALESCE(resolved_at, NOW()),
             resolution_note = $2
       WHERE id = $1
       RETURNING *
      `,
      [req.params.id, reason.slice(0, 500)]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Finding not found' });
    try {
      await recomputeForFinding(req.params.id);
    } catch {
      /* non-fatal */
    }
    await logSecurityEvent({
      userId: req.user?.id || null,
      eventType: SecurityEventTypes.OPERATIONS_DISCOVERY_IGNORED,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { findingId: req.params.id, reason: reason.slice(0, 500) }
    });
    res.json(rows[0]);
  } catch (err) {
    console.error('[ops] POST /findings/:id/ignore failed:', err);
    res.status(500).json({ message: 'Failed to ignore finding' });
  }
});

router.post('/findings/bulk-status', async (req, res) => {
  const { ids = [], status, note = null } = req.body || {};
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'ids[] required' });
  }
  if (!DISCOVERY_STATUSES.has(String(status))) {
    return res.status(400).json({ message: 'Invalid status' });
  }
  for (const id of ids) {
    if (!isUuid(id)) return badUuid(res, 'finding id');
  }
  const setResolved = status === 'resolved' || status === 'ignored';
  try {
    // Capture prior status per id so the audit event records the actual transitions
    // rather than just an aggregate count.
    const prior = await query(`SELECT id, status FROM ops_findings WHERE id = ANY($1::uuid[])`, [ids]);
    const priorById = new Map(prior.rows.map((r) => [r.id, r.status]));

    const { rows } = await query(
      `
      UPDATE ops_findings
         SET status = $2,
             resolved_at = CASE WHEN $3::boolean THEN COALESCE(resolved_at, NOW()) ELSE resolved_at END,
             resolution_note = COALESCE(NULLIF($4::text, ''), resolution_note)
       WHERE id = ANY($1::uuid[])
       RETURNING id, status
      `,
      [ids, status, setResolved, note ? String(note).slice(0, 500) : '']
    );
    for (const r of rows) {
      try {
        await recomputeForFinding(r.id);
      } catch {
        /* non-fatal */
      }
    }
    const transitions = rows.map((r) => ({
      id: r.id,
      from: priorById.get(r.id) || null,
      to: r.status
    }));
    await logSecurityEvent({
      userId: req.user?.id || null,
      eventType: SecurityEventTypes.OPERATIONS_DISCOVERY_STATUS_CHANGE,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { count: rows.length, status, bulk: true, transitions }
    });
    res.json({ updated: rows.length });
  } catch (err) {
    console.error('[ops] POST /findings/bulk-status failed:', err);
    res.status(500).json({ message: 'Failed to update findings' });
  }
});

// ---------------- Command Center aggregate ----------------

router.get('/command-center', async (req, res) => {
  try {
    const [discoveries, kpiRows, activity] = await Promise.all([
      query(
        `
        SELECT id, run_id, client_user_id, severity, category, summary,
               status, attention_score, business_impact, affected_platforms,
               recommended_action_json, proposed_plan_json, owner_user_id,
               acknowledged_at, created_at
          FROM ops_findings
         WHERE status IN ('open','investigating')
           AND ${opsClientExistsExpression('client_user_id')}
         ORDER BY attention_score DESC NULLS LAST, created_at DESC
         LIMIT 25
        `
      ),
      query(
        `
        SELECT
          (SELECT COUNT(DISTINCT client_user_id)::int FROM ops_findings
            WHERE severity = 'critical'
              AND status IN ('open','investigating')
              AND ${opsClientExistsExpression('client_user_id')}) AS clients_at_risk,
          (SELECT COUNT(*)::int FROM ops_tool_approvals
            WHERE executed_at IS NULL AND approved_at IS NULL) AS approvals_waiting,
          (SELECT COUNT(*)::int FROM ops_findings
            WHERE created_at > NOW() - INTERVAL '24 hours'
              AND ${opsClientExistsExpression('client_user_id')}) AS changes_24h,
          (SELECT COUNT(*)::int FROM ops_runs
            WHERE status = 'running'
              AND started_at < NOW() - INTERVAL '1 hour'
              AND ${opsClientExistsExpression('client_user_id')}) AS automation_stuck
        `
      ),
      query(
        `
        SELECT event_type, success, created_at, details
          FROM security_audit_log
         WHERE event_type LIKE 'operations.%'
         ORDER BY created_at DESC
         LIMIT 10
        `
      ).catch((err) => {
        console.warn('[ops] command-center activity query failed:', err?.message || err);
        return { rows: [] };
      })
    ]);

    res.json({
      discoveries: discoveries.rows,
      kpis: kpiRows.rows[0] || {
        clients_at_risk: 0,
        approvals_waiting: 0,
        changes_24h: 0,
        automation_stuck: 0
      },
      activity: activity.rows
    });
  } catch (err) {
    console.error('[ops] GET /command-center failed:', err);
    res.status(500).json({ message: 'Failed to load command center' });
  }
});

// ---------------- Operations client roster ----------------

router.get('/clients', async (_req, res) => {
  try {
    const clients = await listOpsClientRoster();
    res.json({ clients });
  } catch (err) {
    console.error('[ops] GET /clients failed:', err);
    res.status(500).json({ message: 'Failed to load operations clients' });
  }
});

// ---------------- run definitions ----------------

router.get('/run-definitions', async (req, res) => {
  try {
    const { rows } = await query(`SELECT * FROM ops_run_definitions ORDER BY tier, name`);
    res.json(rows);
  } catch (err) {
    console.error('[ops] GET /run-definitions failed:', err);
    res.status(500).json({ message: 'Failed to list run definitions' });
  }
});

router.post('/run-definitions', async (req, res) => {
  const { name, description = null, tier, umbrellas = [], check_set = [], default_for_new_clients = false } = req.body || {};

  if (!name || !tier) {
    return res.status(400).json({ message: 'name and tier are required' });
  }
  if (!Array.isArray(umbrellas) || !Array.isArray(check_set)) {
    return res.status(400).json({ message: 'umbrellas and check_set must be arrays' });
  }

  try {
    const { rows } = await query(
      `
      INSERT INTO ops_run_definitions
        (name, description, tier, umbrellas, check_set, default_for_new_clients)
      VALUES ($1, $2, $3, $4, $5, $6)
      RETURNING *
      `,
      [name, description, tier, umbrellas, check_set, Boolean(default_for_new_clients)]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error('[ops] POST /run-definitions failed:', err);
    res.status(500).json({ message: 'Failed to create run definition' });
  }
});

router.put('/run-definitions/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'definition id');
  const { name, description, tier, umbrellas, check_set, default_for_new_clients } = req.body || {};

  const sets = [];
  const params = [req.params.id];

  function addSet(col, value) {
    if (value === undefined) return;
    params.push(value);
    sets.push(`${col} = $${params.length}`);
  }

  addSet('name', name);
  addSet('description', description);
  addSet('tier', tier);
  if (umbrellas !== undefined) {
    if (!Array.isArray(umbrellas)) return res.status(400).json({ message: 'umbrellas must be an array' });
    addSet('umbrellas', umbrellas);
  }
  if (check_set !== undefined) {
    if (!Array.isArray(check_set)) return res.status(400).json({ message: 'check_set must be an array' });
    addSet('check_set', check_set);
  }
  if (default_for_new_clients !== undefined) addSet('default_for_new_clients', Boolean(default_for_new_clients));
  sets.push(`updated_at = NOW()`);

  if (sets.length === 1) {
    return res.status(400).json({ message: 'No updatable fields provided' });
  }

  try {
    const { rows } = await query(`UPDATE ops_run_definitions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    if (rows.length === 0) return res.status(404).json({ message: 'Run definition not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[ops] PUT /run-definitions/:id failed:', err);
    res.status(500).json({ message: 'Failed to update run definition' });
  }
});

// ===== Skills =====

router.get('/skills', async (req, res) => {
  try {
    const skills = await listSkills({ umbrella: req.query.umbrella || undefined });
    res.json({ skills });
  } catch (e) {
    res.status(500).json({ error: 'list_failed', message: e.message });
  }
});

router.get('/skills/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'skill id');
  try {
    const skill = await getSkill(req.params.id);
    if (!skill) return res.status(404).json({ error: 'not_found' });
    res.json({ skill });
  } catch (e) {
    res.status(500).json({ error: 'get_failed', message: e.message });
  }
});

router.get('/skills/:id/versions', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'skill id');
  try {
    res.json({ versions: await listVersions(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: 'list_versions_failed', message: e.message });
  }
});

router.post('/skills', async (req, res) => {
  const { slug, umbrella, title, prompt_md, collectors, cost_estimate_cents, model } = req.body || {};
  if (!slug || !umbrella || !title || typeof prompt_md !== 'string') {
    return res.status(400).json({ error: 'missing_fields' });
  }
  try {
    const skill = await createSkill({
      slug,
      umbrella,
      title,
      promptMd: prompt_md,
      collectors: Array.isArray(collectors) ? collectors : [],
      costEstimateCents: cost_estimate_cents || 0,
      model: model || null,
      createdBy: req.user.id
    });
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_SKILL_CREATE,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { skill_id: skill.id, slug: skill.slug, umbrella: skill.umbrella }
    });
    res.status(201).json({ skill });
  } catch (e) {
    res.status(400).json({ error: 'invalid', message: e.message });
  }
});

router.put('/skills/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'skill id');
  const { prompt_md, collectors, edit_reason, model } = req.body || {};
  if (typeof prompt_md !== 'string' || !Array.isArray(collectors)) {
    return res.status(400).json({ error: 'invalid_body' });
  }
  try {
    const version = await saveNewVersion(req.params.id, {
      promptMd: prompt_md,
      collectors,
      // Only forward `model` if the client sent the field, so omitting it
      // preserves the prior model. Sending model: '' clears the override.
      ...(Object.prototype.hasOwnProperty.call(req.body || {}, 'model') ? { model: model || null } : {}),
      editedByUserId: req.user.id,
      editReason: edit_reason || null
    });
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_SKILL_VERSION_SAVE,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { skill_id: req.params.id, version }
    });
    res.json({ version });
  } catch (e) {
    res.status(400).json({ error: 'invalid', message: e.message });
  }
});

router.delete('/skills/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'skill id');
  try {
    await archiveSkill(req.params.id);
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_SKILL_ARCHIVE,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { skill_id: req.params.id }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'archive_failed', message: e.message });
  }
});

router.get('/skills/:id/suggestions', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'skill id');
  try {
    res.json({ suggestions: await listPendingSuggestions(req.params.id) });
  } catch (e) {
    res.status(500).json({ error: 'list_suggestions_failed', message: e.message });
  }
});

router.post('/skills/:id/suggestions/:sid/approve', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'skill id');
  if (!isUuid(req.params.sid)) return badUuid(res, 'suggestion id');
  try {
    const out = await approveSuggestion(req.params.sid, req.user.id, req.body?.note || null);
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_SKILL_SUGGESTION_APPROVE,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { skill_id: req.params.id, suggestion_id: req.params.sid }
    });
    res.json(out);
  } catch (e) {
    res.status(400).json({ error: 'invalid', message: e.message });
  }
});

router.post('/skills/:id/suggestions/:sid/reject', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'skill id');
  if (!isUuid(req.params.sid)) return badUuid(res, 'suggestion id');
  try {
    await rejectSuggestion(req.params.sid, req.user.id, req.body?.note || null);
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_SKILL_SUGGESTION_REJECT,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { skill_id: req.params.id, suggestion_id: req.params.sid }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'reject_failed', message: e.message });
  }
});

// ===== Recipes =====

router.get('/recipes', async (req, res) => {
  try {
    const recipes = await listRecipes({ umbrella: req.query.umbrella || undefined });
    res.json({ recipes });
  } catch (e) {
    res.status(500).json({ error: 'list_failed', message: e.message });
  }
});

router.get('/recipes/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'recipe id');
  try {
    const recipe = await getRecipe(req.params.id);
    if (!recipe) return res.status(404).json({ error: 'not_found' });
    res.json({ recipe });
  } catch (e) {
    res.status(500).json({ error: 'get_failed', message: e.message });
  }
});

router.post('/recipes', async (req, res) => {
  const { slug, umbrella, title, recipe_md } = req.body || {};
  if (!slug || !umbrella || !title || typeof recipe_md !== 'string') {
    return res.status(400).json({ error: 'missing_fields' });
  }
  try {
    const recipe = await createRecipe({
      slug, umbrella, title, recipeMd: recipe_md, source: 'user', approvedByUserId: req.user.id
    });
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_RECIPE_CREATE,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { recipe_id: recipe.id, slug: recipe.slug, umbrella: recipe.umbrella }
    });
    res.status(201).json({ recipe });
  } catch (e) {
    res.status(400).json({ error: 'invalid', message: e.message });
  }
});

router.put('/recipes/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'recipe id');
  const { title, recipe_md } = req.body || {};
  try {
    const updated = await updateRecipe(req.params.id, {
      title,
      recipeMd: recipe_md
    });
    if (!updated) return res.status(404).json({ error: 'not_found' });
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_RECIPE_UPDATE,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { recipe_id: req.params.id }
    });
    res.json({ recipe: updated });
  } catch (e) {
    res.status(400).json({ error: 'invalid', message: e.message });
  }
});

router.delete('/recipes/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'recipe id');
  try {
    await archiveRecipe(req.params.id);
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_RECIPE_ARCHIVE,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { recipe_id: req.params.id }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'archive_failed', message: e.message });
  }
});

// ---------------- client subscriptions ----------------

router.get('/clients/:id/subscriptions', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'client id');
  try {
    const { rows } = await query(
      `
      SELECT s.*, d.name AS definition_name, d.tier AS definition_tier
        FROM client_run_subscriptions s
        JOIN ops_run_definitions d ON d.id = s.run_definition_id
       WHERE s.client_user_id = $1
       ORDER BY d.tier, d.name
      `,
      [req.params.id]
    );
    res.json(rows);
  } catch (err) {
    console.error('[ops] GET /clients/:id/subscriptions failed:', err);
    res.status(500).json({ message: 'Failed to list subscriptions' });
  }
});

router.put('/clients/:id/subscriptions', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'client id');
  const { subscriptions } = req.body || {};
  if (!Array.isArray(subscriptions)) {
    return res.status(400).json({ message: 'subscriptions must be an array' });
  }

  for (const s of subscriptions) {
    if (!s || !isUuid(s.run_definition_id)) {
      return res.status(400).json({ message: 'each subscription needs a valid run_definition_id' });
    }
  }

  try {
    for (const s of subscriptions) {
      await query(
        `
        INSERT INTO client_run_subscriptions
          (client_user_id, run_definition_id, enabled, schedule_cron, rotation_group, email_on_completion)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (client_user_id, run_definition_id) DO UPDATE
          SET enabled = EXCLUDED.enabled,
              schedule_cron = EXCLUDED.schedule_cron,
              rotation_group = EXCLUDED.rotation_group,
              email_on_completion = EXCLUDED.email_on_completion,
              updated_at = NOW()
        `,
        [
          req.params.id,
          s.run_definition_id,
          s.enabled !== false,
          s.schedule_cron || null,
          Number.isInteger(s.rotation_group) && s.rotation_group >= 1 && s.rotation_group <= 7 ? s.rotation_group : null,
          Boolean(s.email_on_completion)
        ]
      );
    }
    const { rows } = await query(`SELECT * FROM client_run_subscriptions WHERE client_user_id = $1`, [req.params.id]);
    res.json(rows);
  } catch (err) {
    console.error('[ops] PUT /clients/:id/subscriptions failed:', err);
    res.status(500).json({ message: 'Failed to update subscriptions' });
  }
});

// ---------------- credentials ----------------

router.get('/clients/:id/credentials', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'client id');
  try {
    const list = await listCredentialsForClient(req.params.id);
    res.json(list);
  } catch (err) {
    console.error('[ops] GET /clients/:id/credentials failed:', err);
    res.status(500).json({ message: 'Failed to list credentials' });
  }
});

router.put('/clients/:id/credentials/:platform', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'client id');
  const platform = String(req.params.platform || '').trim();
  if (!platform) return res.status(400).json({ message: 'platform required' });

  const { account_id, source, secret, scope_metadata } = req.body || {};
  if (!account_id) return res.status(400).json({ message: 'account_id required' });
  if (!source) return res.status(400).json({ message: 'source required' });

  try {
    const row = await putCredential({
      clientUserId: req.params.id,
      platform,
      accountId: String(account_id),
      source,
      secret: secret || null,
      scopeMetadata: scope_metadata || {}
    });
    res.json(row);
  } catch (err) {
    console.error('[ops] PUT /clients/:id/credentials/:platform failed:', err.message);
    res.status(400).json({ message: err.message });
  }
});

router.delete('/clients/:id/credentials/:credentialId', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'client id');
  if (!isUuid(req.params.credentialId)) return badUuid(res, 'credential id');
  try {
    await deleteCredential(req.params.credentialId);
    res.status(204).end();
  } catch (err) {
    console.error('[ops] DELETE credential failed:', err);
    res.status(500).json({ message: 'Failed to delete credential' });
  }
});

// ---------------- GSC OAuth scaffold (Phase 3) ----------------
//
// The actual Google OAuth flow (token exchange, refresh, scope upgrade) lives
// in the existing OAuth infra used for Ads / GA / Mailgun. These endpoints
// are placeholders so the website-checks specialist can register them as
// real endpoints when the OAuth flow is wired in Phase 8.
router.get('/clients/:id/credentials/gsc/oauth/start', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'client id');
  res.status(501).json({
    message:
      'GSC OAuth start is scaffolded but not yet wired. Use the existing Google OAuth flow with scope https://www.googleapis.com/auth/webmasters.readonly and persist into oauth_connections (provider="google", scope_granted contains "webmasters.readonly").'
  });
});

router.get('/clients/:id/credentials/gsc/oauth/callback', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'client id');
  res.status(501).json({
    message: 'GSC OAuth callback is scaffolded but not yet wired. See note on /start.'
  });
});

router.post('/clients/:id/credentials/:credentialId/validate', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'client id');
  if (!isUuid(req.params.credentialId)) return badUuid(res, 'credential id');

  // Phase 1 records the result; per-platform validators land in later phases.
  const { ok = false, error = null } = req.body || {};
  try {
    const row = await validateCredential(req.params.credentialId, { ok: Boolean(ok), error });
    if (!row) return res.status(404).json({ message: 'Credential not found' });
    res.json(row);
  } catch (err) {
    console.error('[ops] validate credential failed:', err);
    res.status(500).json({ message: 'Failed to validate credential' });
  }
});

// ---------------- Phase 9: command-center aggregates ----------------

// GET /overview — KPI strip + 7-day trend
router.get('/overview', async (req, res) => {
  try {
    const sevenDaysAgo = `NOW() - INTERVAL '7 days'`;
    const monthStart = `date_trunc('month', NOW())`;

    const [runs7d, criticalOpen, throttledMtd, activeSubs, mtdSpend, trend] = await Promise.all([
      query(`SELECT COUNT(*)::int AS c FROM ops_runs WHERE created_at >= ${sevenDaysAgo}`),
      query(
        `SELECT COUNT(*)::int AS c FROM ops_findings
         WHERE severity = 'critical' AND resolved_at IS NULL`
      ),
      query(
        `SELECT COUNT(*)::int AS c FROM ops_runs
         WHERE status = 'budget_exceeded' AND created_at >= ${monthStart}`
      ),
      query(
        `SELECT COUNT(DISTINCT client_user_id)::int AS c
         FROM client_run_subscriptions
         WHERE enabled = TRUE`
      ),
      query(
        `SELECT COALESCE(SUM(cost_estimate_cents), 0)::int AS c
         FROM ops_runs
         WHERE created_at >= ${monthStart}`
      ),
      query(
        `
        SELECT
          date_trunc('day', r.created_at)::date AS day,
          COUNT(*)::int AS run_count,
          COALESCE(SUM(CASE WHEN f.severity = 'critical' THEN 1 ELSE 0 END), 0)::int AS critical,
          COALESCE(SUM(CASE WHEN f.severity = 'warning' THEN 1 ELSE 0 END), 0)::int AS warning,
          COALESCE(SUM(CASE WHEN f.severity = 'info' THEN 1 ELSE 0 END), 0)::int AS info
        FROM ops_runs r
        LEFT JOIN ops_findings f ON f.run_id = r.id
        WHERE r.created_at >= ${sevenDaysAgo}
        GROUP BY 1
        ORDER BY 1 ASC
        `
      )
    ]);

    res.json({
      runs_last_7d: runs7d.rows[0]?.c || 0,
      critical_findings_open: criticalOpen.rows[0]?.c || 0,
      runs_throttled_mtd: throttledMtd.rows[0]?.c || 0,
      active_subscribed_clients: activeSubs.rows[0]?.c || 0,
      mtd_cost_cents: mtdSpend.rows[0]?.c || 0,
      trend: trend.rows
    });
  } catch (err) {
    console.error('[ops] GET /overview failed:', err);
    res.status(500).json({ message: 'Failed to load overview' });
  }
});

// GET /cost-summary?month=YYYY-MM — per-client MTD spend with caps + tier/subagent breakdown
router.get('/cost-summary', async (req, res) => {
  try {
    const month = String(req.query.month || '').trim();
    let monthExpr;
    let monthParams = [];
    if (/^\d{4}-\d{2}$/.test(month)) {
      monthExpr = `date_trunc('month', $1::date)`;
      monthParams = [`${month}-01`];
    } else {
      monthExpr = `date_trunc('month', NOW())`;
    }

    const sql = `
      SELECT
        r.client_user_id,
        ${clientLabelSelect('client_name')},
        cp.ops_monthly_cap_cents AS cap_cents,
        COALESCE(SUM(r.cost_estimate_cents), 0)::int AS mtd_cents,
        COUNT(*)::int AS runs_count,
        COALESCE(jsonb_object_agg(r.tier, r.cost_estimate_cents) FILTER (WHERE r.tier IS NOT NULL), '{}'::jsonb) AS by_tier_raw,
        COALESCE(SUM(r.cost_estimate_cents) FILTER (WHERE r.tier = 'daily_essential'), 0)::int AS daily_cents,
        COALESCE(SUM(r.cost_estimate_cents) FILTER (WHERE r.tier = 'weekly_deep'), 0)::int AS weekly_cents,
        COALESCE(SUM(r.cost_estimate_cents) FILTER (WHERE r.tier = 'monthly_audit'), 0)::int AS monthly_cents,
        jsonb_agg(r.token_usage_json) AS token_usage_rows
      FROM ops_runs r
      LEFT JOIN users u ON u.id = r.client_user_id
      ${clientLabelJoins('r.client_user_id')}
      WHERE r.created_at >= ${monthExpr}
        AND r.created_at < (${monthExpr} + INTERVAL '1 month')
      GROUP BY r.client_user_id, cp.client_identifier_value, ba.business_name, u.first_name, u.last_name, u.email, cp.ops_monthly_cap_cents
      ORDER BY mtd_cents DESC
    `;

    const { rows } = await query(sql, monthParams);

    // Reduce by_subagent across rows in app code (simpler than JSONB merge SQL).
    const shaped = rows.map((r) => {
      const bySubagent = {};
      for (const usage of r.token_usage_rows || []) {
        const sub = usage?.by_subagent || {};
        for (const [name, val] of Object.entries(sub)) {
          const cents = typeof val === 'number' ? val : val?.cost_cents || 0;
          bySubagent[name] = (bySubagent[name] || 0) + cents;
        }
      }
      return {
        client_user_id: r.client_user_id,
        client_name: r.client_name || r.client_user_id?.slice(0, 8),
        mtd_cents: r.mtd_cents,
        cap_cents: r.cap_cents,
        runs_count: r.runs_count,
        by_tier: {
          daily_essential: r.daily_cents,
          weekly_deep: r.weekly_cents,
          monthly_audit: r.monthly_cents
        },
        by_subagent: bySubagent
      };
    });

    res.json(shaped);
  } catch (err) {
    console.error('[ops] GET /cost-summary failed:', err);
    res.status(500).json({ message: 'Failed to load cost summary' });
  }
});

// PUT /clients/:clientUserId/cap — edit per-client monthly cap
router.put('/clients/:clientUserId/cap', async (req, res) => {
  if (!isUuid(req.params.clientUserId)) return badUuid(res, 'client id');
  const { ops_monthly_cap_cents } = req.body || {};
  const cap = parseInt(ops_monthly_cap_cents, 10);
  if (!Number.isFinite(cap) || cap < 0 || cap > 100000) {
    return res.status(400).json({ message: 'ops_monthly_cap_cents must be 0..100000' });
  }
  try {
    const { rows } = await query(
      `UPDATE client_profiles SET ops_monthly_cap_cents = $2 WHERE user_id = $1 RETURNING user_id, ops_monthly_cap_cents`,
      [req.params.clientUserId, cap]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'Client profile not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[ops] PUT /clients/:id/cap failed:', err);
    res.status(500).json({ message: 'Failed to update cap' });
  }
});

// ---------------- AI chat (Phase 7 — supervisor + sub-agents) ----------------

function chatRateLimit(limitType) {
  return async (req, res, next) => {
    const userId = req.user?.id;
    if (!userId) return next();
    try {
      const verdict = await checkRateLimit(limitType, userId);
      if (!verdict.allowed) {
        return res.status(429).json({
          message: 'Too many chat requests. Please slow down.',
          retryAfter: verdict.retryAfter,
          code: 'RATE_LIMIT_EXCEEDED'
        });
      }
      await recordAttempt(limitType, userId);
    } catch (err) {
      console.warn('[ops] chat rate limit check failed:', err.message);
    }
    next();
  };
}

router.post('/chat', chatRateLimit('operations_assistant_user'), async (req, res) => {
  const { client_user_id, thread_id = null, prompt = '', model_id = null } = req.body || {};
  if (thread_id && !isUuid(thread_id)) return badUuid(res, 'thread_id');
  if (client_user_id && !isUuid(client_user_id)) return badUuid(res, 'client_user_id');
  if (client_user_id && !(await isOperationsClient(client_user_id))) {
    return res.status(404).json({ message: 'Client account not found' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  req.on('close', () => { /* client aborted; loop finishes its current hop then no-op */ });

  try {
    const result = await runClaudeChatTurn({
      clientUserId: client_user_id || null,
      userId: req.user.id,
      threadId: thread_id,
      prompt: String(prompt || ''),
      modelId: model_id,
      onEvent: (evt) => send(evt.type, evt)
    });
    let pendingApproval = null;
    if (result.pendingApprovalId) {
      const { rows } = await query(`SELECT id, tool_name, args_json, created_at FROM ops_tool_approvals WHERE id = $1`, [result.pendingApprovalId]);
      pendingApproval = rows[0] || null;
    }
    send('done', { threadId: result.threadId, status: result.status, text: result.text, pendingApproval, costSummary: result.costSummary });
  } catch (err) {
    console.error('[ops] POST /chat (stream) failed:', err);
    send('error', { message: err.message || 'Chat failed' });
  } finally {
    res.end();
  }
});

router.get('/chat/threads', async (req, res) => {
  const clientUserId = req.query.clientUserId && isUuid(req.query.clientUserId) ? req.query.clientUserId : null;
  try {
    res.json({ threads: await listThreads(clientUserId) });
  } catch (err) {
    console.error('[ops] GET /chat/threads failed:', err);
    res.status(500).json({ message: 'Failed to load threads' });
  }
});

router.get('/chat/threads/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'thread id');
  try {
    const data = await loadThread(req.params.id);
    if (!data) return res.status(404).json({ message: 'Thread not found' });
    res.json(data);
  } catch (err) {
    console.error('[ops] GET /chat/threads/:id failed:', err);
    res.status(500).json({ message: 'Failed to load thread' });
  }
});

router.post('/chat/approve', async (req, res) => {
  const { approval_id } = req.body || {};
  if (!isUuid(approval_id)) return badUuid(res, 'approval_id');
  try {
    const result = await executeApproval({ approvalId: approval_id, userId: req.user.id });
    res.json(result);
  } catch (err) {
    console.error('[ops] POST /chat/approve failed:', err);
    res.status(500).json({ message: err.message || 'Approval failed' });
  }
});

router.post('/chat/reject', async (req, res) => {
  const { approval_id, reason = null } = req.body || {};
  if (!isUuid(approval_id)) return badUuid(res, 'approval_id');
  try {
    const result = await rejectApproval({ approvalId: approval_id, userId: req.user.id, reason });
    res.json(result);
  } catch (err) {
    console.error('[ops] POST /chat/reject failed:', err);
    res.status(500).json({ message: err.message || 'Reject failed' });
  }
});

router.get('/chat/approvals/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'approval id');
  try {
    const { rows } = await query(`SELECT * FROM ops_tool_approvals WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ message: 'Approval not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('[ops] GET approval failed:', err);
    res.status(500).json({ message: 'Failed to load approval' });
  }
});

// ===== Bulk schedules =====

router.get('/bulk/schedules', async (req, res) => {
  try {
    const { rows } = await query('SELECT * FROM ops_bulk_schedules ORDER BY name');
    res.json({ schedules: rows });
  } catch (e) {
    res.status(500).json({ error: 'list_failed', message: e.message });
  }
});

router.post('/bulk/schedules', async (req, res) => {
  const {
    name,
    skill_ids,
    cadence,
    day_of_week,
    day_of_month,
    hour_local,
    timezone,
    enabled
  } = req.body || {};
  if (
    !name ||
    !Array.isArray(skill_ids) || skill_ids.length === 0 ||
    !['daily', 'weekly', 'monthly'].includes(cadence)
  ) {
    return res.status(400).json({ error: 'invalid' });
  }
  const tz = timezone || 'America/Chicago';
  const hr = hour_local ?? 8;
  const next = computeNextRunAt(
    {
      cadence,
      day_of_week: day_of_week ?? null,
      day_of_month: day_of_month ?? null,
      hour_local: hr,
      timezone: tz
    },
    new Date()
  );
  try {
    const { rows } = await query(`
      INSERT INTO ops_bulk_schedules
        (name, skill_ids, cadence, day_of_week, day_of_month, hour_local, timezone, enabled, created_by, next_run_at)
      VALUES ($1, $2::uuid[], $3, $4, $5, $6, $7, COALESCE($8, true), $9, $10)
      RETURNING *
    `, [
      name,
      skill_ids,
      cadence,
      day_of_week ?? null,
      day_of_month ?? null,
      hr,
      tz,
      enabled,
      req.user.id,
      next
    ]);
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_BULK_SCHEDULE_CREATE,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { schedule_id: rows[0].id, name: rows[0].name }
    });
    res.status(201).json({ schedule: rows[0] });
  } catch (e) {
    res.status(400).json({ error: 'invalid', message: e.message });
  }
});

router.put('/bulk/schedules/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'schedule id');
  const fields = ['name', 'cadence', 'day_of_week', 'day_of_month', 'hour_local', 'timezone', 'enabled'];
  const sets = [];
  const params = [req.params.id];
  for (const f of fields) {
    if (f in (req.body || {})) {
      params.push(req.body[f]);
      sets.push(`${f} = $${params.length}`);
    }
  }
  if (Array.isArray(req.body?.skill_ids)) {
    params.push(req.body.skill_ids);
    sets.push(`skill_ids = $${params.length}::uuid[]`);
  }
  if (sets.length === 0) return res.status(400).json({ error: 'no fields to update' });
  sets.push('updated_at = now()');
  try {
    const { rows } = await query(
      `UPDATE ops_bulk_schedules SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    );
    if (!rows[0]) return res.status(404).json({ error: 'not_found' });
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_BULK_SCHEDULE_UPDATE,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { schedule_id: req.params.id }
    });
    res.json({ schedule: rows[0] });
  } catch (e) {
    res.status(400).json({ error: 'invalid', message: e.message });
  }
});

router.delete('/bulk/schedules/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'schedule id');
  try {
    await query('DELETE FROM ops_bulk_schedules WHERE id = $1', [req.params.id]);
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_BULK_SCHEDULE_DELETE,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { schedule_id: req.params.id }
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'delete_failed', message: e.message });
  }
});

router.post('/bulk/schedules/:id/run-now', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'schedule id');
  try {
    const out = await fanOutBulkSchedule(req.params.id, {
      triggeredByUserId: req.user.id,
      trigger: 'manual'
    });
    if (!out) return res.status(404).json({ error: 'schedule not found or disabled' });
    await logSecurityEvent({
      userId: req.user.id,
      eventType: SecurityEventTypes.OPERATIONS_BULK_SCHEDULE_RUN_NOW,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { schedule_id: req.params.id, enqueued: out?.enqueued, skipped: out?.skipped }
    });
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: 'run_failed', message: e.message });
  }
});

// ===== Bulk runs =====

router.get('/bulk/runs', async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const { rows } = await query(`
      SELECT b.*, s.name AS schedule_name
        FROM ops_bulk_runs b
        LEFT JOIN ops_bulk_schedules s ON s.id = b.bulk_schedule_id
       ORDER BY b.started_at DESC
       LIMIT $1 OFFSET $2
    `, [limit, offset]);
    const { rows: countRows } = await query('SELECT COUNT(*)::int AS total FROM ops_bulk_runs');
    res.json({ runs: rows, total: countRows[0].total });
  } catch (e) {
    res.status(500).json({ error: 'list_failed', message: e.message });
  }
});

router.get('/bulk/runs/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'bulk run id');
  try {
    const clientLabel = opsClientLabelExpression();
    const { rows: parent } = await query(`
      SELECT b.*, s.name AS schedule_name
        FROM ops_bulk_runs b
        LEFT JOIN ops_bulk_schedules s ON s.id = b.bulk_schedule_id
       WHERE b.id = $1
    `, [req.params.id]);
    if (!parent[0]) return res.status(404).json({ error: 'not_found' });
    const { rows: children } = await query(`
      SELECT r.id, r.client_user_id, r.skill_id, r.skill_version_number, r.status,
             r.cost_estimate_cents AS cost_cents, r.started_at, r.finished_at,
             (SELECT COUNT(*) FROM ops_findings f WHERE f.run_id = r.id) AS findings_count,
             ${clientLabel} AS client_name,
             u.email AS client_email
        FROM ops_runs r
        LEFT JOIN users u ON u.id = r.client_user_id
        ${clientLabelJoins('r.client_user_id')}
       WHERE r.bulk_run_id = $1
         AND ${opsClientExistsExpression('r.client_user_id')}
       ORDER BY client_name NULLS LAST, r.started_at
    `, [req.params.id]);
    res.json({ run: parent[0], children });
  } catch (e) {
    res.status(500).json({ error: 'get_failed', message: e.message });
  }
});

// ===== Checks registry =====

router.get('/checks', async (req, res) => {
  try {
    const checks = listAllChecks().map((c) => ({
      check_id: c.checkId,
      umbrella: c.umbrella,
      tier: c.tier,
      cost_estimate_cents: c.costEstimate,
      requires: c.requires
    }));
    res.json({ checks });
  } catch (e) {
    res.status(500).json({ error: 'list_checks_failed', message: e.message });
  }
});

// ── Blog publishing ───────────────────────────────────────────────────────
router.get('/blog/sites/:clientId', async (req, res) => {
  if (!isUuid(req.params.clientId)) return badUuid(res, 'clientId');
  try { res.json({ sites: await listClientWpSites(req.params.clientId) }); }
  catch (err) { console.error('[ops] GET /blog/sites failed:', err); res.status(500).json({ message: 'Failed to load WordPress sites' }); }
});

router.get('/blog/posts', async (req, res) => {
  const clientId = req.query.clientId && isUuid(req.query.clientId) ? req.query.clientId : null;
  try { res.json({ posts: await blogList(clientId) }); }
  catch (err) { console.error('[ops] GET /blog/posts failed:', err); res.status(500).json({ message: 'Failed to load posts' }); }
});

router.post('/blog/posts', async (req, res) => {
  const b = req.body || {};
  if (!isUuid(b.client_user_id)) return badUuid(res, 'client_user_id');
  if (!(await isOperationsClient(b.client_user_id))) return res.status(404).json({ message: 'Client not found' });
  const action = b.action || 'draft'; // draft | schedule | publish_now
  let status = 'draft';
  let scheduledFor = null;
  if (action === 'schedule') { status = 'scheduled'; scheduledFor = b.scheduled_for || null; }
  else if (action === 'publish_now') { status = 'scheduled'; scheduledFor = new Date().toISOString(); }
  try {
    const post = await blogCreate({
      clientId: b.client_user_id, createdBy: req.user.id,
      oauthConnectionId: b.oauth_connection_id || null, siteResourceId: b.site_resource_id || null, siteUrl: b.site_url || null,
      title: String(b.title || 'Untitled'), contentMarkdown: String(b.content_markdown || ''),
      featuredFileUploadId: b.featured_file_upload_id || null, status, scheduledFor
    });
    res.json({ post });
  } catch (err) { console.error('[ops] POST /blog/posts failed:', err); res.status(500).json({ message: 'Failed to create post' }); }
});

router.patch('/blog/posts/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'id');
  try { const post = await blogUpdate(req.params.id, req.body || {}); if (!post) return res.status(404).json({ message: 'Not found' }); res.json({ post }); }
  catch (err) { console.error('[ops] PATCH /blog/posts/:id failed:', err); res.status(500).json({ message: 'Failed to update' }); }
});

router.post('/blog/posts/:id/cancel', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'id');
  try { const post = await blogCancel(req.params.id); if (!post) return res.status(409).json({ message: 'Cannot cancel in current state' }); res.json({ post }); }
  catch (err) { console.error('[ops] POST /blog/posts/:id/cancel failed:', err); res.status(500).json({ message: 'Failed to cancel' }); }
});

router.delete('/blog/posts/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'id');
  try { await blogDelete(req.params.id); res.json({ ok: true }); }
  catch (err) { console.error('[ops] DELETE /blog/posts/:id failed:', err); res.status(500).json({ message: 'Failed to delete' }); }
});

router.post('/blog/media', blogUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file' });
  try {
    const stored = await storeFile(req.file, { category: 'blog', ownerId: req.user.id, ownerType: 'ops_blog' });
    res.json(stored); // { id, url }
  } catch (err) { console.error('[ops] POST /blog/media failed:', err); res.status(500).json({ message: 'Upload failed' }); }
});

export default router;
