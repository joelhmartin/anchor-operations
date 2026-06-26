/**
 * Phase 7 — Operations supervisor agent.
 *
 * The supervisor sits above four sub-agents (website, googleAds, meta, ctm). It
 * loads recent run context for the picked client, lets the user ask a question,
 * and either answers directly or delegates to a sub-agent. Mutating tool
 * proposals from sub-agents are surfaced back to the user via
 * `ops_tool_approvals` and the ApprovalDialog UI.
 *
 * Tools the supervisor exposes:
 *   load_run({ runId })             – fetches a run + check_results summary
 *   drill_into({ checkResultId })   – full payload for one check result
 *   delegate_to({ subagent, prompt, context })
 *                                   – spawns a sub-agent; result merges into history
 *   propose_action({ tool, args, rationale })
 *                                   – writes ops_tool_approvals row, returns approval id;
 *                                     UI surfaces it as a pending approval card.
 *
 * Per-turn budget: $0.50 (PER_TURN_BUDGET_CENTS in vertexRuntime.js).
 * Stateless: the caller owns history. Resuming after an approval is done by
 * calling runSupervisorTurn with `approval_id` set; the supervisor looks up
 * the row, executes the tool, appends the result, and resumes the loop.
 */

import { query } from '../../../db.js';
import crypto from 'node:crypto';
import { runToolLoop, PER_TURN_BUDGET_CENTS } from './vertexRuntime.js';
import { createCostTracker } from '../costTracker.js';
import { logSecurityEvent, SecurityEventTypes, SecurityEventCategories } from '../../security/audit.js';
import { runSubAgent, listSubAgents, getSubAgentTool } from './subAgents/index.js';

const MAX_RUNS_PER_TIER = 3;

const SUPERVISOR_SYSTEM = `You are the Operations supervisor for the Anchor agency console. You orchestrate four read-only sub-agents (website, googleAds, meta, ctm) and surface findings to an admin.

## Hard rules
1. Compliance first. This system handles PHI for healthcare clients. Never echo user contact info, health data, or secrets.
2. Read before write. Use load_run + drill_into to ground yourself in the most recent ops runs before answering. Cite specific check_result ids when you reference findings.
3. Delegate when scope is clearly one platform. Use delegate_to with a tight prompt; do NOT pass the user's raw prompt verbatim if it is broad.
4. Mutations require approval. The only path to mutate anything is propose_action — the admin then approves in the UI. Never claim a mutation succeeded until the approval+execution returns.
5. Concise output. Lead with the answer. Cite the specific run / check_result that supports each claim.
6. Per-turn budget: you have a hard $0.50 cap across this whole turn (your calls + any sub-agent calls). If you need more, ask the admin to split the question.

## Sub-agent capabilities
- **website**: WP-CLI reads, plugin list, recent posts, SFTP read of small files, GTM/GA4/Pixel verification, PSI on demand, GSC queries, SEMrush keyword lookup. Mutations available with approval: plugin_update, wp_user_password_reset.
- **googleAds**: read-only — GAQL execution (SELECT only), keyword position history, disapproved-ad reasons. NO mutations in v1.
- **meta**: read-only — Graph queries, pixel test events. NOT available for medical clients (HIPAA gate).
- **ctm**: read-only — tracking-number health, AI classification quality, form-flow config, CTM webhook delivery recency. No caller PII exposed.

## Output style
- No throat-clearing. Lead with the conclusion.
- When citing a finding, format as \`[run <runId-short>/<check_id>]\`.
- If you delegate, summarize what the sub-agent returned in your final answer; do not paste the full transcript.`;

function shortId(id) {
  return String(id || '').slice(0, 8);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

function hashArgs(args) {
  return crypto.createHash('sha256').update(canonicalJson(args || {})).digest('hex');
}

async function loadRecentRunsContext(clientUserId) {
  if (!clientUserId) return { runs: [] };
  // Latest MAX_RUNS_PER_TIER runs per tier — cap at ~9 rows total.
  const { rows } = await query(
    `WITH ranked AS (
       SELECT r.id, r.tier, r.status, r.created_at, r.finished_at,
              r.cost_estimate_cents, d.name AS definition_name,
              ROW_NUMBER() OVER (PARTITION BY r.tier ORDER BY r.created_at DESC) AS rn
         FROM ops_runs r
         LEFT JOIN ops_run_definitions d ON d.id = r.run_definition_id
        WHERE r.client_user_id = $1
     )
     SELECT id, tier, status, definition_name, created_at, finished_at, cost_estimate_cents
       FROM ranked
      WHERE rn <= $2
      ORDER BY tier, created_at DESC`,
    [clientUserId, MAX_RUNS_PER_TIER]
  );
  return { runs: rows };
}

function buildContextPreamble({ clientUserId, runs }) {
  const lines = [];
  lines.push(`# Client: ${clientUserId}`);
  if (!runs.length) {
    lines.push('No recent ops runs on file. Suggest the admin trigger one before deep-diving.');
  } else {
    lines.push('## Recent runs (latest 3 per tier)');
    for (const r of runs) {
      lines.push(
        `- [${shortId(r.id)}] tier=${r.tier} status=${r.status} def="${r.definition_name || '?'}" created=${
          r.created_at?.toISOString?.() || r.created_at
        } cost=${r.cost_estimate_cents ?? '?'}c`
      );
    }
    lines.push('Use load_run({runId}) to pull check_results for any of these.');
  }
  return lines.join('\n');
}

// ---------------- supervisor tools ----------------

const SUPERVISOR_TOOLS = {
  load_run: {
    declaration: {
      name: 'load_run',
      description:
        'Fetch one ops_run with a summary of its check_results (counts by status + the failing/warning ones inline). Use this before answering any question that references a run.',
      parameters: {
        type: 'object',
        properties: { runId: { type: 'string', description: 'ops_runs.id (UUID, full or first 8 chars)' } },
        required: ['runId']
      }
    },
    async handler({ args, ctx }) {
      const id = String(args.runId || '').trim();
      if (!id) return { error: 'runId required' };
      // Allow short ids by prefix-matching against the client's runs.
      let resolved = id;
      if (id.length < 36 && ctx.clientUserId) {
        const { rows } = await query(
          `SELECT id FROM ops_runs WHERE client_user_id = $1 AND id::text LIKE $2 LIMIT 2`,
          [ctx.clientUserId, `${id}%`]
        );
        if (rows.length === 0) return { error: 'No matching run for this client' };
        if (rows.length > 1) return { error: 'Ambiguous runId prefix; provide more characters' };
        resolved = rows[0].id;
      }
      const run = await query(`SELECT * FROM ops_runs WHERE id = $1`, [resolved]);
      if (!run.rows[0]) return { error: 'Run not found' };
      if (ctx.clientUserId && run.rows[0].client_user_id !== ctx.clientUserId) {
        return { error: 'Run not visible for this client picker' };
      }
      const results = await query(
        `SELECT id, check_id, umbrella, status, severity, payload_json
           FROM ops_check_results WHERE run_id = $1 ORDER BY created_at ASC`,
        [resolved]
      );
      const counts = { pass: 0, warn: 0, fail: 0, skipped: 0, error: 0 };
      for (const r of results.rows) {
        if (counts[r.status] === undefined) counts[r.status] = 0;
        counts[r.status] += 1;
      }
      const interesting = results.rows
        .filter((r) => ['fail', 'warn', 'error'].includes(r.status))
        .slice(0, 30)
        .map((r) => ({
          check_result_id: r.id,
          check_id: r.check_id,
          umbrella: r.umbrella,
          status: r.status,
          severity: r.severity,
          summary:
            (typeof r.payload_json === 'object' &&
              (r.payload_json.summary || r.payload_json.reason || r.payload_json.message)) ||
            null
        }));
      return {
        run: {
          id: run.rows[0].id,
          tier: run.rows[0].tier,
          status: run.rows[0].status,
          cost_estimate_cents: run.rows[0].cost_estimate_cents,
          created_at: run.rows[0].created_at,
          finished_at: run.rows[0].finished_at
        },
        counts,
        interesting,
        total_results: results.rows.length
      };
    }
  },

  drill_into: {
    declaration: {
      name: 'drill_into',
      description: 'Fetch the full payload for one check_result by id. Use sparingly — payloads can be large.',
      parameters: {
        type: 'object',
        properties: { checkResultId: { type: 'string' } },
        required: ['checkResultId']
      }
    },
    async handler({ args, ctx }) {
      const id = String(args.checkResultId || '').trim();
      if (!id) return { error: 'checkResultId required' };
      const { rows } = await query(`SELECT * FROM ops_check_results WHERE id = $1`, [id]);
      if (!rows[0]) return { error: 'check_result not found' };
      if (ctx.clientUserId && rows[0].client_user_id && rows[0].client_user_id !== ctx.clientUserId) {
        return { error: 'check_result not visible for this client' };
      }
      // Truncate payload to keep context bounded.
      const payload = rows[0].payload_json || {};
      const json = JSON.stringify(payload);
      const truncated = json.length > 8000 ? `${json.slice(0, 8000)}…[truncated]` : json;
      return {
        id: rows[0].id,
        check_id: rows[0].check_id,
        status: rows[0].status,
        severity: rows[0].severity,
        payload_json_serialized: truncated,
        payload_truncated: json.length > 8000
      };
    }
  },

  delegate_to: {
    declaration: {
      name: 'delegate_to',
      description:
        'Delegate a focused question to a sub-agent. Pick exactly one of: website, googleAds, meta, ctm. The sub-agent has its own tools; pass a tight prompt.',
      parameters: {
        type: 'object',
        properties: {
          subagent: { type: 'string', description: `One of: ${listSubAgents().join(', ')}` },
          prompt: { type: 'string' },
          context: { type: 'string', description: 'Optional extra grounding (run ids, check_result ids, etc.)' }
        },
        required: ['subagent', 'prompt']
      }
    },
    async handler({ args, ctx, costTracker }) {
      const subagent = String(args.subagent || '').trim();
      if (!listSubAgents().includes(subagent)) {
        return { error: `Unknown subagent. Pick one of: ${listSubAgents().join(', ')}` };
      }
      const result = await runSubAgent(subagent, {
        prompt: String(args.prompt || ''),
        context: String(args.context || ''),
        clientUserId: ctx.clientUserId,
        userId: ctx.userId,
        costTracker, // shared budget across supervisor + sub-agents
        budgetCents: ctx.budgetCents
      });
      return result;
    }
  },

  propose_action: {
    declaration: {
      name: 'propose_action',
      description:
        'Propose a mutating action that the admin must approve in the UI. Returns an approval id. The action does NOT run until the admin clicks Approve.',
      parameters: {
        type: 'object',
        properties: {
          subagent: { type: 'string' },
          tool: { type: 'string', description: 'Sub-agent tool name (e.g. plugin_update)' },
          args: { type: 'object' },
          rationale: { type: 'string' }
        },
        required: ['subagent', 'tool', 'args', 'rationale']
      }
    },
    async handler({ args, ctx }) {
      const subagent = String(args.subagent || '').trim();
      const tool = String(args.tool || '').trim();
      const toolDef = getSubAgentTool(subagent, tool);
      if (!toolDef) return { error: `Unknown tool ${subagent}.${tool}` };
      if (!toolDef.mutating) return { error: `Tool ${subagent}.${tool} is not mutating; call it directly via delegate_to` };
      const argsHash = hashArgs(args.args || {});
      const insert = await query(
        `INSERT INTO ops_tool_approvals (run_id, user_id, tool_name, args_hash, args_json)
         VALUES (NULL, $1, $2, $3, $4)
         RETURNING id, created_at`,
        [ctx.userId, `${subagent}.${tool}`, argsHash, args.args || {}]
      );
      const approvalId = insert.rows[0].id;
      await logSecurityEvent({
        userId: ctx.userId,
        eventType: SecurityEventTypes.OPERATIONS_TOOL_PROPOSED,
        eventCategory: SecurityEventCategories.OPERATIONS,
        success: true,
        details: {
          subagent,
          tool,
          clientUserId: ctx.clientUserId || null,
          approvalId,
          argsHash,
          rationale: String(args.rationale || '').slice(0, 500)
        }
      });
      return {
        approval_id: approvalId,
        status: 'pending',
        message:
          'Proposal recorded. The admin will see an approval card; the tool will only run after they click Approve.'
      };
    }
  }
};

function getSupervisorTool(name) {
  return SUPERVISOR_TOOLS[name] || null;
}

export function listSupervisorDeclarations() {
  return Object.values(SUPERVISOR_TOOLS).map((t) => t.declaration);
}

/**
 * Run one supervisor turn.
 *
 * @param {Object} p
 * @param {string} p.clientUserId
 * @param {string} p.userId           Admin user id (for audit + ops_tool_approvals)
 * @param {Array}  [p.history]        Vertex Content[] from prior turns
 * @param {string} [p.prompt]         New user prompt
 * @param {string} [p.modelId]
 * @returns {Promise<{ messages, status, text?, pendingApprovalId?, costSummary }>}
 */
export async function runSupervisorTurn({
  clientUserId,
  userId,
  history = [],
  prompt = '',
  modelId
}) {
  if (!clientUserId) throw new Error('clientUserId required');
  if (!userId) throw new Error('userId required');

  const messages = Array.isArray(history) ? [...history] : [];
  if (prompt) messages.push({ role: 'user', parts: [{ text: prompt }] });

  const ctxData = await loadRecentRunsContext(clientUserId);
  const systemInstruction = {
    role: 'system',
    parts: [{ text: `${SUPERVISOR_SYSTEM}\n\n${buildContextPreamble({ clientUserId, runs: ctxData.runs })}` }]
  };

  const costTracker = createCostTracker();
  const toolCtx = {
    clientUserId,
    userId,
    budgetCents: PER_TURN_BUDGET_CENTS
  };

  let lastPendingApproval = null;

  const runTool = async (name, args) => {
    const tool = getSupervisorTool(name);
    if (!tool) return { result: { error: `Unknown supervisor tool: ${name}` } };
    const result = await tool.handler({ args, ctx: toolCtx, costTracker });
    if (name === 'propose_action' && result?.approval_id) {
      lastPendingApproval = result.approval_id;
    }
    return { result };
  };

  const loop = await runToolLoop({
    modelName: modelId,
    messages,
    systemInstruction,
    toolDeclarations: listSupervisorDeclarations(),
    runTool,
    costTracker,
    budgetCents: PER_TURN_BUDGET_CENTS
  });

  return {
    messages,
    status: loop.status,
    text: loop.text || '',
    pendingApprovalId: lastPendingApproval,
    hopsUsed: loop.hopsUsed,
    costSummary: costTracker.summary()
  };
}

// --- Exported helpers for the Claude (Anthropic) runtime ---

/**
 * Return the supervisor tools as an array of { declaration, handler } objects
 * for consumption by toAnthropicTools / makeSupervisorRunTool.
 */
export function getSupervisorTools() {
  return Object.values(SUPERVISOR_TOOLS);
}

/**
 * Build a `runTool(name, args)` function bound to one turn's context +
 * costTracker. Translates the propose_action return value into the
 * `{ __awaiting_approval: true }` shape that anthropicRuntime expects.
 */
export function makeSupervisorRunTool({
  clientUserId,
  userId,
  costTracker,
  budgetCents = PER_TURN_BUDGET_CENTS
}) {
  const ctx = { clientUserId, userId, budgetCents };
  return async function runTool(name, args) {
    const tool = SUPERVISOR_TOOLS[name];
    if (!tool) return { error: `Unknown tool: ${name}` };
    const result = await tool.handler({ args, ctx, costTracker });
    // Translate the approval signal: propose_action returns { approval_id, status:'pending' }
    // but anthropicRuntime pauses on { __awaiting_approval: true }.
    if (name === 'propose_action' && result?.approval_id) {
      return { __awaiting_approval: true, approval_id: result.approval_id, ...result };
    }
    return result;
  };
}

/**
 * Build the plain-string system instruction for one session.
 * The Vertex path wraps this in { role:'system', parts:[{text}] }; the
 * Anthropic path passes it directly as the `system` parameter.
 */
export async function buildSystemInstruction({ clientUserId }) {
  const ctxData = await loadRecentRunsContext(clientUserId);
  return `${SUPERVISOR_SYSTEM}\n\n${buildContextPreamble({ clientUserId, runs: ctxData.runs })}`;
}

/**
 * Execute a previously-approved tool. Called from the chat route's
 * /approve endpoint.
 */
export async function executeApproval({ approvalId, userId }) {
  const { rows } = await query(`SELECT * FROM ops_tool_approvals WHERE id = $1`, [approvalId]);
  const row = rows[0];
  if (!row) return { error: 'approval not found' };
  if (row.executed_at) return { error: 'approval already executed', execution_result: row.execution_result_json };
  const [subagent, tool] = String(row.tool_name || '').split('.', 2);
  const toolDef = getSubAgentTool(subagent, tool);
  if (!toolDef) return { error: `Unknown tool ${row.tool_name}` };

  await query(`UPDATE ops_tool_approvals SET approved_at = COALESCE(approved_at, NOW()) WHERE id = $1`, [approvalId]);
  await logSecurityEvent({
    userId,
    eventType: SecurityEventTypes.OPERATIONS_TOOL_APPROVED,
    eventCategory: SecurityEventCategories.OPERATIONS,
    success: true,
    details: { subagent, tool, approvalId, argsHash: row.args_hash }
  });

  let result;
  let ok = false;
  try {
    result = await toolDef.handler(row.args_json || {}, { userId, subagent });
    ok = !result?.error;
  } catch (err) {
    result = { error: err.message || 'Tool error' };
    ok = false;
  }

  await query(
    `UPDATE ops_tool_approvals
        SET executed_at = NOW(), execution_result_json = $2
      WHERE id = $1`,
    [approvalId, result || {}]
  );
  await logSecurityEvent({
    userId,
    eventType: SecurityEventTypes.OPERATIONS_TOOL_EXECUTED,
    eventCategory: SecurityEventCategories.OPERATIONS,
    success: ok,
    failureReason: ok ? null : String(result?.error || 'tool_error').slice(0, 200),
    details: { subagent, tool, approvalId }
  });

  return { ok, result };
}

/**
 * Reject a pending approval. Records an audit event but does NOT execute.
 */
export async function rejectApproval({ approvalId, userId, reason }) {
  const { rows } = await query(
    `UPDATE ops_tool_approvals
        SET execution_result_json = jsonb_build_object('rejected', true, 'reason', $2::text),
            executed_at = NOW()
      WHERE id = $1 AND executed_at IS NULL
      RETURNING id`,
    [approvalId, String(reason || '').slice(0, 500) || null]
  );
  if (!rows[0]) return { error: 'approval not found or already finalized' };
  await logSecurityEvent({
    userId,
    eventType: SecurityEventTypes.OPERATIONS_TOOL_REJECTED,
    eventCategory: SecurityEventCategories.OPERATIONS,
    success: true,
    details: { approvalId, reason: String(reason || '').slice(0, 500) || null }
  });
  return { ok: true };
}
