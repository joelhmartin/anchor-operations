// server/services/ops/agents/geminiSupervisor.js
//
// Gemini-backed supervisor: thread-persistent streaming chat using Vertex AI.
// Mirrors runClaudeChatTurn (claudeSupervisor.js) exactly for thread creation,
// message persistence, approval-gate semantics, and return shape — but stores
// conversation history in Vertex Content format ({ role, parts }) and drives
// runToolLoopStream instead of runClaudeToolLoop.
//
// Approval gate difference vs Claude path:
//   Claude:  runTool returns { __awaiting_approval: true } → anthropicRuntime
//            pauses the loop mid-turn and returns status='awaiting_approval'.
//   Gemini:  runToolLoopStream has no __awaiting_approval check; instead the
//            runTool closure here captures the approval_id, emits
//            'approval_required' via onEvent, and returns the raw handler result
//            so the model can close its response naturally. After the loop the
//            status is set to 'awaiting_approval' if any proposal was made.
//            The user-visible behaviour (approval card, no execution) is
//            identical.
//
// Task-4 ordering note:
//   ops_chat_threads.provider column is added by Task 4's migration. The INSERT
//   below omits `provider` so the code is deployable before Task 4 lands. Once
//   Task 4 merges, add `provider = 'google'` to the INSERT column list.

import { query } from '../../../db.js';
import { createCostTracker } from '../costTracker.js';
import { runToolLoopStream, PER_TURN_BUDGET_CENTS } from './vertexRuntime.js';
import { resolveChatModel } from './models.js';
import {
  getSupervisorTools,
  buildSystemInstruction,
  listSupervisorDeclarations
} from './supervisor.js';

// ---------------------------------------------------------------------------
// History helpers — Vertex format
// ---------------------------------------------------------------------------

// content_json rows store the full Vertex Content object { role, parts }.
// JSONB returns parsed JS objects on SELECT, so loading is a direct map.
function historyToMessages(rows) {
  return rows.map((r) => r.content_json);
}

// ---------------------------------------------------------------------------
// Main turn runner
// ---------------------------------------------------------------------------

/**
 * Run one Gemini chat turn — streaming, persistent, approval-gated.
 *
 * @param {Object}   p
 * @param {string}  [p.clientUserId]   Client context for supervisor grounding
 * @param {string}   p.userId          Admin user id (for audit + ops_tool_approvals)
 * @param {string}  [p.threadId]       Existing thread; omit to start a new one
 * @param {string}   p.prompt          The user's message
 * @param {string}  [p.modelId]        Optional model override (must be a Google/Vertex model)
 * @param {Function} [p.onEvent]       Progress callback ({ type, ... })
 *                                     Emits: text | tool_use | tool_result | cost |
 *                                            approval_required | done
 * @returns {Promise<{ threadId, status, text, pendingApprovalId, costSummary, assistantMessageId }>}
 */
export async function runGeminiChatTurn({
  clientUserId,
  userId,
  threadId,
  prompt,
  modelId,
  onEvent = () => {}
}) {
  // ── Resolve or create thread ──────────────────────────────────────────────
  let thread;
  let priorMessages = [];

  if (threadId) {
    const { rows: tRows } = await query(`SELECT * FROM ops_chat_threads WHERE id = $1`, [threadId]);
    if (!tRows[0]) throw new Error('Thread not found');
    thread = tRows[0];
    const { rows: mRows } = await query(
      `SELECT id, role, content_json, created_at
         FROM ops_chat_messages
        WHERE thread_id = $1
        ORDER BY created_at`,
      [threadId]
    );
    priorMessages = mRows;
  } else {
    // NOTE: omits `provider` column — add once Task 4 migration (ALTER TABLE
    // ops_chat_threads ADD COLUMN provider TEXT) has been applied.
    const newModel = resolveChatModel(modelId);
    const { rows } = await query(
      `INSERT INTO ops_chat_threads (client_user_id, created_by, model_id, title)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [clientUserId || null, userId, newModel, String(prompt || '').slice(0, 60) || null]
    );
    thread = rows[0];
  }

  const chosenModel = resolveChatModel(modelId || thread.model_id);

  // ── Build prior history in Vertex format ──────────────────────────────────
  const messages = historyToMessages(priorMessages);

  // ── Append new user turn ──────────────────────────────────────────────────
  const userMsg = { role: 'user', parts: [{ text: String(prompt || '') }] };
  messages.push(userMsg);

  // Persist the user message immediately — survives loop errors.
  await query(
    `INSERT INTO ops_chat_messages (thread_id, role, content_json)
     VALUES ($1,'user',$2)`,
    [thread.id, JSON.stringify(userMsg)]
  );

  // ── Build system instruction + tools ──────────────────────────────────────
  const costTracker = createCostTracker();
  const systemText = await buildSystemInstruction({ clientUserId: thread.client_user_id });
  const systemInstruction = { role: 'system', parts: [{ text: systemText }] };

  // Build a name → handler map from the exported tool registry so we can call
  // handlers directly without re-implementing them here.
  const toolHandlerMap = Object.fromEntries(
    getSupervisorTools().map((t) => [t.declaration.name, t.handler])
  );

  const toolCtx = {
    clientUserId: thread.client_user_id,
    userId,
    budgetCents: PER_TURN_BUDGET_CENTS
  };

  let lastPendingApprovalId = null;

  // Custom runTool for the streaming path.  Does NOT return __awaiting_approval
  // (that's the Anthropic-runtime signal); instead it captures the approval id
  // in the closure and emits 'approval_required' so the UI can render the card.
  const runTool = async (name, args) => {
    const handler = toolHandlerMap[name];
    if (!handler) return { error: `Unknown tool: ${name}` };
    const result = await handler({ args, ctx: toolCtx, costTracker });
    if (name === 'propose_action' && result?.approval_id) {
      lastPendingApprovalId = result.approval_id;
      onEvent({ type: 'approval_required', approvalId: result.approval_id });
    }
    return result;
  };

  // ── Run the streaming loop ────────────────────────────────────────────────
  // `before` marks the first index of new model/tool turns in out.messages.
  // (runToolLoopStream works on a copy of messages; out.messages = convo copy.)
  const before = messages.length;
  const out = await runToolLoopStream({
    modelName: chosenModel,
    messages,
    systemInstruction,
    toolDeclarations: listSupervisorDeclarations(),
    runTool,
    costTracker,
    onEvent
  });

  // ── Persist every message produced this turn ──────────────────────────────
  // out.messages is the convo copy; slice from `before` to get new turns only.
  // The user message was already persisted above.
  const newMsgs = out.messages.slice(before);
  let lastAssistantId = null;

  for (let i = 0; i < newMsgs.length; i += 1) {
    const m = newMsgs[i];
    const isLast = i === newMsgs.length - 1;
    const { rows } = await query(
      `INSERT INTO ops_chat_messages
         (thread_id, role, content_json, usage_json, cost_cents)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [
        thread.id,
        m.role,
        JSON.stringify(m),          // full Vertex Content object { role, parts }
        isLast ? JSON.stringify(costTracker.summary()) : null,
        isLast ? costTracker.summary().total_cents : 0
      ]
    );
    // Vertex uses 'model' for assistant turns (Anthropic uses 'assistant').
    if (m.role === 'model') lastAssistantId = rows[0].id;
  }

  await query(
    `UPDATE ops_chat_threads SET updated_at = NOW(), model_id = $2 WHERE id = $1`,
    [thread.id, chosenModel]
  );

  // ── Resolve status ────────────────────────────────────────────────────────
  // If propose_action fired during this turn the conversation is paused for
  // admin approval; otherwise the turn is complete.
  const status = lastPendingApprovalId ? 'awaiting_approval' : 'final';

  onEvent({
    type: 'done',
    threadId: thread.id,
    status,
    assistantMessageId: lastAssistantId,
    costSummary: costTracker.summary()
  });

  // Return shape matches runClaudeChatTurn exactly.
  return {
    threadId: thread.id,
    status,
    text: out.text || '',
    pendingApprovalId: lastPendingApprovalId,
    costSummary: costTracker.summary(),
    assistantMessageId: lastAssistantId
  };
}
