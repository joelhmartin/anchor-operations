/**
 * Schedule fanout — Phase 2.
 *
 * Bound at `POST /api/ops/internal/fanout?tier=...`. Cloud Scheduler invokes
 * this once per tier (daily/weekly/monthly). For each enabled subscription
 * matching the tier, we insert a queued ops_runs row and call enqueueRun.
 *
 * Auth: OIDC bearer token signed by the scheduler service account. We verify
 * with google-auth-library's OAuth2Client.verifyIdToken. If the library is
 * unavailable, we fall back to a shared-secret bearer (`OPS_FANOUT_SHARED_SECRET`)
 * — note this is a coverage gap captured in the completion doc.
 */

import { query } from '../../db.js';
import { enqueueRun } from './runQueue.js';
import { checkBudget, recordBudgetThrottle } from './budgetGuard.js';
import { getSkill } from './skills/store.js';
import { listOpsClientRoster } from './clientRoster.js';

const VALID_TIERS = new Set(['daily_essential', 'weekly_deep', 'monthly_audit', 'on_demand']);

const ALLOWED_SCHEDULER_SAS = (process.env.OPS_FANOUT_ALLOWED_SAS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

let oauthClientPromise = null;
function getOAuthClient() {
  if (!oauthClientPromise) {
    oauthClientPromise = import('google-auth-library')
      .then(({ OAuth2Client }) => new OAuth2Client())
      .catch((err) => {
        console.warn(`[ops/scheduleFanout] google-auth-library unavailable: ${err.message}`);
        oauthClientPromise = null;
        throw err;
      });
  }
  return oauthClientPromise;
}

async function verifyOidcBearer(token) {
  const client = await getOAuthClient();
  // audience left undefined — the audience is the URL Cloud Scheduler called,
  // which we can't reconstruct trivially behind Cloud Run's load balancer.
  // verifyIdToken still validates the token signature + iss + exp.
  const ticket = await client.verifyIdToken({ idToken: token });
  const payload = ticket.getPayload();
  if (!payload) throw new Error('verifyIdToken returned empty payload');
  if (ALLOWED_SCHEDULER_SAS.length > 0 && !ALLOWED_SCHEDULER_SAS.includes(payload.email)) {
    throw new Error(`scheduler service account ${payload.email} not in allowlist`);
  }
  return payload;
}

function checkSharedSecret(token) {
  const expected = process.env.OPS_FANOUT_SHARED_SECRET;
  if (!expected) return false;
  return token === expected;
}

/**
 * Validate the inbound fanout request. Returns true on success; on failure,
 * writes a 401 to the response and returns false.
 */
export async function authorizeFanoutRequest(req, res) {
  const auth = req.headers.authorization || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) {
    res.status(401).json({ message: 'Missing bearer token' });
    return false;
  }
  const token = m[1];

  try {
    await verifyOidcBearer(token);
    return true;
  } catch (err) {
    if (checkSharedSecret(token)) return true;
    console.warn(`[ops/scheduleFanout] auth failed: ${err?.message || err}`);
    res.status(401).json({ message: 'Invalid bearer token' });
    return false;
  }
}

/**
 * Fan out scheduled runs for the requested tier.
 *
 * Joins enabled `client_run_subscriptions` against `ops_run_definitions`. For
 * each match, inserts a queued ops_runs row and enqueues it.
 */
export async function fanoutTier(tier) {
  if (!VALID_TIERS.has(tier)) {
    const err = new Error(`invalid tier: ${tier}`);
    err.status = 400;
    throw err;
  }

  // Per Phase 8 §10.2: clients with an explicit per-client schedule_cron are
  // skipped during default-tier fanout. Their cron is honored by an external
  // (per-client) scheduler entry that hits this endpoint with explicit overrides.
  // Simpler than a parsing layer; documented in phase-8-completion.md.
  const { rows: subs } = await query(
    `
    SELECT s.client_user_id, s.run_definition_id, d.tier
      FROM client_run_subscriptions s
      JOIN ops_run_definitions d ON d.id = s.run_definition_id
     WHERE s.enabled = TRUE AND d.tier = $1 AND s.schedule_cron IS NULL
    `,
    [tier]
  );

  let queued = 0;
  let failed = 0;
  let throttled = 0;
  const enqueueResults = [];

  for (const s of subs) {
    try {
      const budget = await checkBudget(s.client_user_id);
      if (!budget.allowed) {
        await recordBudgetThrottle(
          s.client_user_id,
          s.run_definition_id,
          budget.capCents,
          budget.spendCents
        );
        console.warn(
          `[ops/scheduleFanout] budget throttle: client=${s.client_user_id} spend=${budget.spendCents}¢ cap=${budget.capCents}¢`
        );
        throttled += 1;
        continue;
      }

      const { rows } = await query(
        `
        INSERT INTO ops_runs
          (client_user_id, run_definition_id, tier, status, trigger, metadata)
        VALUES ($1, $2, $3, 'queued', 'schedule', $4)
        RETURNING id
        `,
        [s.client_user_id, s.run_definition_id, s.tier, { source: 'schedule_fanout', tier }]
      );
      const runId = rows[0]?.id;
      if (runId) {
        const result = await enqueueRun(runId);
        enqueueResults.push({ runId, ...result });
        queued += 1;
      }
    } catch (err) {
      failed += 1;
      console.warn(`[ops/scheduleFanout] fanout failure for client=${s.client_user_id}: ${err?.message || err}`);
    }
  }

  return {
    tier,
    matched: subs.length,
    queued,
    throttled,
    failed,
    results: enqueueResults
  };
}

/**
 * Express handler for `POST /api/ops/internal/fanout?tier=...`.
 */
export async function handleFanoutRequest(req, res) {
  const ok = await authorizeFanoutRequest(req, res);
  if (!ok) return;

  const tier = String(req.query.tier || '');
  try {
    const result = await fanoutTier(tier);
    res.json(result);
  } catch (err) {
    const status = err.status || 500;
    console.warn(`[ops/scheduleFanout] handler error: ${err?.message || err}`);
    res.status(status).json({ message: err.message || 'fanout failed' });
  }
}

// ---------------------------------------------------------------------------
// Bulk schedule fanout
// ---------------------------------------------------------------------------

/**
 * For each umbrella, the per-client tracking_configs columns that must be
 * non-null for that umbrella's skill to run, plus any extra gates.
 *
 * Note: this replaces the earlier enumeration through client_platform_credentials,
 * which was an empty parallel store nobody had populated. Per-client platform
 * IDs already live in tracking_configs (and CTM data is keyed on owner_user_id
 * with no separate account ID needed).
 */
const UMBRELLA_REQUIREMENTS = {
  website: {
    requiredColumns: ['website_domain'],
    reasonIfMissing: 'no website_domain configured'
  },
  google_ads: {
    requiredColumns: ['google_ads_customer_id'],
    reasonIfMissing: 'no google_ads_customer_id configured'
  },
  meta: {
    requiredColumns: ['meta_ad_account_id', 'meta_pixel_id'], // either suffices
    requiredColumnsAny: true,
    extraGate: (tc) => tc.client_type !== 'medical',
    reasonIfMissing: 'no meta_ad_account_id / meta_pixel_id configured',
    reasonIfGateFailed: 'HIPAA gate: client_type=medical (Meta blocked)'
  },
  ctm: {
    // CTM checks query call_logs / twilio_tracking_numbers / ctm_forms by
    // owner_user_id directly — no per-client account ID needed.
    requiredColumns: [],
    reasonIfMissing: null
  }
};

function clientSatisfies(umbrella, tc) {
  const req = UMBRELLA_REQUIREMENTS[umbrella];
  if (!req) return { ok: false, reason: `unknown umbrella: ${umbrella}` };
  if (req.requiredColumns.length > 0) {
    if (!tc) return { ok: false, reason: 'no tracking_configs row for this client' };
    const filled = req.requiredColumns.filter((c) => tc[c] !== null && tc[c] !== undefined && tc[c] !== '');
    if (req.requiredColumnsAny) {
      if (filled.length === 0) return { ok: false, reason: req.reasonIfMissing };
    } else if (filled.length !== req.requiredColumns.length) {
      return { ok: false, reason: req.reasonIfMissing };
    }
  }
  if (req.extraGate) {
    // Refuse to evaluate a compliance gate against a synthetic empty object.
    // Without a real tracking_configs row we cannot prove the gate passes —
    // fail closed. (Today no umbrella has both requiredColumns:[] AND an
    // extraGate, but if one is added later this prevents a silent bypass.)
    if (!tc) return { ok: false, reason: 'no tracking_configs row for this client' };
    if (!req.extraGate(tc)) {
      return { ok: false, reason: req.reasonIfGateFailed || 'gate failed' };
    }
  }
  return { ok: true };
}

/**
 * Fan out a bulk schedule: create a parent ops_bulk_runs row, then enqueue one
 * child ops_runs row per (active client, skill) pair where the client has the
 * per-umbrella config a skill requires. Skipped pairs are recorded in
 * ops_bulk_runs.metadata.skipped[].
 *
 * Enumeration source: the Operations client roster. Each row represents one
 * client account owner; platform-specific columns are used only to decide
 * whether a particular skill can run or should be recorded as skipped.
 *
 * @param {string} scheduleId  UUID of the ops_bulk_schedules row.
 * @param {object} options
 * @param {string|null} options.triggeredByUserId
 * @param {'schedule'|'manual'} options.trigger
 * @returns {Promise<{bulkRunId: string, enqueued: number, skipped: number}|null>}
 *   null if the schedule is missing or disabled.
 */
export async function fanOutBulkSchedule(scheduleId, { triggeredByUserId = null, trigger = 'schedule' } = {}) {
  const { rows: schedRows } = await query('SELECT * FROM ops_bulk_schedules WHERE id = $1', [scheduleId]);
  const schedule = schedRows[0];
  if (!schedule || !schedule.enabled) return null;

  // Create the parent bulk-run row.
  const { rows: bulkRunRows } = await query(
    `INSERT INTO ops_bulk_runs (bulk_schedule_id, trigger, triggered_by_user_id, status)
     VALUES ($1, $2, $3, 'running') RETURNING *`,
    [scheduleId, trigger, triggeredByUserId]
  );
  const bulkRun = bulkRunRows[0];

  // Resolve non-archived skills referenced by this schedule.
  const skills = [];
  for (const sid of schedule.skill_ids) {
    const s = await getSkill(sid);
    if (s && !s.archived_at) skills.push(s);
  }

  const clients = skills.length
    ? (await listOpsClientRoster()).map((client) => ({
        ...client,
        client_user_id: client.user_id || client.id,
        client_name: client.client_label
      }))
    : [];

  const skipped = [];
  let enqueued = 0;

  for (const client of clients) {
    for (const skill of skills) {
      const result = clientSatisfies(skill.umbrella, client);
      if (!result.ok) {
        skipped.push({
          client_user_id: client.client_user_id,
          client_name: client.client_name,
          skill_slug: skill.slug,
          reason: result.reason
        });
        continue;
      }
      const { rows: insertedRows } = await query(
        `INSERT INTO ops_runs
           (client_user_id, skill_id, skill_version_number, bulk_run_id,
            tier, status, trigger, metadata)
         VALUES ($1, $2, $3, $4, 'on_demand', 'queued', 'bulk_schedule', $5::jsonb)
         RETURNING id`,
        [
          client.client_user_id,
          skill.id,
          skill.current_version,
          bulkRun.id,
          JSON.stringify({ source: 'bulk_schedule', schedule_id: scheduleId })
        ]
      );
      const newRunId = insertedRows[0]?.id;
      if (newRunId) {
        try {
          await enqueueRun(newRunId);
        } catch (e) {
          console.warn(`[ops/fanOutBulk] enqueueRun(${newRunId}) failed: ${e?.message || e}`);
        }
      }
      enqueued += 1;
    }
  }

  // Update the parent bulk-run row with final counts. client_count is the
  // number of client accounts considered; enqueued is the child run count.
  // If we enqueued ZERO
  // children there's nothing to roll up — finalize the parent here so it
  // doesn't sit at 'running' forever.
  if (enqueued === 0) {
    await query(
      `UPDATE ops_bulk_runs
          SET client_count = $2,
              skipped_count = $3,
              metadata = jsonb_set(metadata, '{skipped}', $4::jsonb, true),
              status = 'complete',
              completed_at = now()
        WHERE id = $1`,
      [bulkRun.id, clients.length, skipped.length, JSON.stringify(skipped)]
    );
  } else {
    await query(
      `UPDATE ops_bulk_runs
          SET client_count = $2,
              skipped_count = $3,
              metadata = jsonb_set(metadata, '{skipped}', $4::jsonb, true)
        WHERE id = $1`,
      [bulkRun.id, clients.length, skipped.length, JSON.stringify(skipped)]
    );
  }

  // Touch the schedule's last_run_at.
  await query(
    'UPDATE ops_bulk_schedules SET last_run_at = now(), updated_at = now() WHERE id = $1',
    [scheduleId]
  );

  console.warn(
    `[ops/scheduleFanout] bulk schedule ${scheduleId}: enqueued=${enqueued} skipped=${skipped.length}`
  );

  return { bulkRunId: bulkRun.id, clientCount: clients.length, enqueued, skipped: skipped.length };
}

/**
 * Compute the next time a bulk schedule should fire.
 *
 * NOTE: this is a UTC-only implementation for v1. The schedule's `timezone`
 * column is stored but not yet honored — `hour_local` is interpreted as UTC.
 * TODO: honor the timezone field once the UI surfaces it (post-MVP).
 *
 * Pure function — no DB I/O. Returns a JS Date.
 */
export function computeNextRunAt(schedule, fromDate = new Date()) {
  const cadence = schedule.cadence;
  const hour = Number(schedule.hour_local ?? 8);
  const now = new Date(fromDate.getTime());

  if (cadence === 'daily') {
    const candidate = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0
    ));
    if (candidate.getTime() <= now.getTime()) candidate.setUTCDate(candidate.getUTCDate() + 1);
    return candidate;
  }

  if (cadence === 'weekly') {
    const targetDow = Number(schedule.day_of_week ?? 1);
    for (let i = 0; i < 8; i++) {
      const probe = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + i, hour, 0, 0
      ));
      if (probe.getUTCDay() === targetDow && probe.getTime() > now.getTime()) return probe;
    }
    // Fallback: 7 days from now at the requested hour.
    return new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 7, hour, 0, 0
    ));
  }

  if (cadence === 'monthly') {
    const targetDom = Math.min(Number(schedule.day_of_month ?? 1), 28);
    let candidate = new Date(Date.UTC(
      now.getUTCFullYear(), now.getUTCMonth(), targetDom, hour, 0, 0
    ));
    if (candidate.getTime() <= now.getTime()) {
      candidate = new Date(Date.UTC(
        now.getUTCFullYear(), now.getUTCMonth() + 1, targetDom, hour, 0, 0
      ));
    }
    return candidate;
  }

  throw new Error(`computeNextRunAt: unsupported cadence "${cadence}"`);
}
