// server/services/ops/agents/claudeSupervisor.js
//
// Claude-backed supervisor: thread-persistent chat using the Anthropic API.
// Reuses the supervisor's tool registry + approval logic via the exported
// helpers from supervisor.js; stores conversation history in ops_chat_threads
// / ops_chat_messages so every turn can resume from the full prior context.

import { query } from '../../../db.js';
import { createCostTracker } from '../costTracker.js';
import { runClaudeToolLoop } from './anthropicRuntime.js';
import { toAnthropicTools } from './toolSchema.js';
import { resolveChatModel } from './models.js';
import { getSupervisorTools, makeSupervisorRunTool, buildSystemInstruction } from './supervisor.js';

// ---------------------------------------------------------------------------
// Thread management
// ---------------------------------------------------------------------------

export async function createThread({ clientUserId, userId, modelId, title }) {
  const { rows } = await query(
    `INSERT INTO ops_chat_threads (client_user_id, created_by, model_id, title)
     VALUES ($1,$2,$3,$4) RETURNING *`,
    [clientUserId || null, userId, resolveChatModel(modelId), title || null]
  );
  return rows[0];
}

export async function listThreads(clientUserId) {
  const { rows } = await query(
    `SELECT id, client_user_id, title, model_id, created_at, updated_at
       FROM ops_chat_threads
      WHERE archived_at IS NULL
        AND ($1::uuid IS NULL OR client_user_id = $1)
      ORDER BY updated_at DESC
      LIMIT 100`,
    [clientUserId || null]
  );
  return rows;
}

export async function loadThread(threadId) {
  const { rows: t } = await query(`SELECT * FROM ops_chat_threads WHERE id = $1`, [threadId]);
  if (!t[0]) return null;
  const { rows: msgs } = await query(
    `SELECT id, role, content_json, created_at
       FROM ops_chat_messages
      WHERE thread_id = $1
      ORDER BY created_at`,
    [threadId]
  );
  return { thread: t[0], messages: msgs };
}

// ---------------------------------------------------------------------------
// History helpers
// ---------------------------------------------------------------------------

// Rebuild Anthropic messages[] from persisted rows.
// content_json is stored as the raw Anthropic content value (string or block[]).
function historyToMessages(rows) {
  return rows.map((r) => ({ role: r.role, content: r.content_json }));
}

// ---------------------------------------------------------------------------
// Main turn runner
// ---------------------------------------------------------------------------

/**
 * Run one Claude chat turn.
 *
 * @param {Object} p
 * @param {string} [p.clientUserId]   Client context for supervisor grounding
 * @param {string}  p.userId          Admin user id (for audit)
 * @param {string} [p.threadId]       Existing thread; omit to start a new one
 * @param {string}  p.prompt          The user's message
 * @param {string} [p.modelId]        Optional model override
 * @param {Function} [p.onEvent]      Progress callback ({ type, ... })
 * @returns {Promise<{ threadId, status, text, pendingApprovalId, costSummary, assistantMessageId }>}
 */
export async function runClaudeChatTurn({
  clientUserId,
  userId,
  threadId,
  prompt,
  modelId,
  onEvent = () => {}
}) {
  // ── Resolve or create thread ──────────────────────────────────────────────
  let thread;
  let loaded = null;
  if (threadId) {
    loaded = await loadThread(threadId);
    if (!loaded) throw new Error('Thread not found');
    thread = loaded.thread;
  } else {
    thread = await createThread({
      clientUserId,
      userId,
      modelId,
      title: String(prompt || '').slice(0, 60) || null
    });
  }
  const chosenModel = resolveChatModel(modelId || thread.model_id);

  // ── Build prior history + append new user turn ────────────────────────────
  const priorRows = threadId ? loaded.messages : [];
  const messages = historyToMessages(priorRows);

  const userContent = [{ type: 'text', text: String(prompt || '') }];
  messages.push({ role: 'user', content: userContent });

  // Persist the user message immediately so it's not lost if the turn errors.
  await query(
    `INSERT INTO ops_chat_messages (thread_id, role, content_json)
     VALUES ($1,'user',$2)`,
    [thread.id, JSON.stringify(userContent)]
  );

  // ── Build tools + system ──────────────────────────────────────────────────
  const costTracker = createCostTracker();
  const tools = toAnthropicTools(getSupervisorTools());
  const runTool = makeSupervisorRunTool({
    clientUserId: thread.client_user_id,
    userId,
    costTracker
  });
  const system = await buildSystemInstruction({ clientUserId: thread.client_user_id });

  // ── Run the loop ──────────────────────────────────────────────────────────
  const before = messages.length;
  const out = await runClaudeToolLoop({
    modelId: chosenModel,
    system,
    messages,
    tools,
    runTool,
    costTracker,
    onEvent
  });

  // ── Persist every message produced this turn ──────────────────────────────
  // messages[] is mutated in-place by runClaudeToolLoop (assistant + tool_result turns).
  let lastAssistantId = null;
  for (let i = before; i < out.messages.length; i += 1) {
    const m = out.messages[i];
    const isLastMessage = i === out.messages.length - 1;
    const { rows } = await query(
      `INSERT INTO ops_chat_messages
         (thread_id, role, content_json, usage_json, cost_cents)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING id`,
      [
        thread.id,
        m.role,
        JSON.stringify(m.content),
        isLastMessage && out.status === 'final' ? JSON.stringify(costTracker.summary()) : null,
        isLastMessage ? costTracker.summary().total_cents : 0
      ]
    );
    if (m.role === 'assistant') lastAssistantId = rows[0].id;
  }

  await query(
    `UPDATE ops_chat_threads SET updated_at = NOW(), model_id = $2 WHERE id = $1`,
    [thread.id, chosenModel]
  );

  // ── Resolve pending approval id ───────────────────────────────────────────
  let pendingApprovalId = null;
  if (out.status === 'awaiting_approval') {
    pendingApprovalId = out.proposedTool?.approval_id || null;
  }

  return {
    threadId: thread.id,
    status: out.status,
    text: out.text || '',
    pendingApprovalId,
    costSummary: costTracker.summary(),
    assistantMessageId: lastAssistantId
  };
}
