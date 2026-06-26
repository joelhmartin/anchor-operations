# Model Provider Switch — Default Google, Switchable Everywhere — Design

**Date:** 2026-06-25
**Status:** Design / spec. Next → implementation plan.
**Home:** `anchor-operations` — the AI chat (`Chat`/Agent) + the scheduled-run / sub-agent model selection.

---

## 1. Problem & goal

**Problem.** The Operations AI chat is hardcoded to the Anthropic/Claude runtime and just failed in production with `400 invalid_request_error — "Your credit balance is too low to access the Anthropic API."` The Anthropic credit balance is exhausted, so the chat is dead. Meanwhile **Vertex/Gemini already runs in production** for every non-chat path (checks, scheduled runs, sub-agents via `vertexRuntime.js` + `supervisor.js`) and needs no Anthropic credits.

**Goal.** Make **Google/Vertex (Gemini) the default** model for the chat so it works without Anthropic credits, while keeping **Claude switchable** (for when credits are topped up). Make model selection broad: a per-conversation model picker in the chat (both providers, **real token streaming for Gemini**), and a **per-run-definition model override** so scheduled actions / sub-agents can each pick their model.

**Non-goals.**
- Not removing the Anthropic runtime — it stays, just not the default.
- Not changing the supervisor tool set, the approval gate, the checks engine, or the cost-tracking shape.
- Not building a general multi-provider abstraction beyond Anthropic + Google (YAGNI).
- Not converting message history across providers — threads are provider-bound (see §3.4).

---

## 2. Verified building blocks (audit 2026-06-25)

- **`server/services/ops/agents/models.js`** — `CLAUDE_MODELS` (haiku/sonnet/opus) only; `DEFAULT_CHAT_MODEL = process.env.OPS_CHAT_DEFAULT_MODEL || 'claude-sonnet-4-6'` (env exists, unused); `SUBAGENT_MODEL`; `resolveChatModel(modelId)` validates only against Claude. No Gemini entries, no `provider` field.
- **Anthropic runtime** `anthropicRuntime.js` → `runClaudeToolLoop({modelId, system, messages, tools, runTool, costTracker, maxHops=8, onEvent})` — **streams** via `client.messages.stream()` (`.on('text')`, `.on('thinking')`), full tool_use→tool_result loop, per-token cost.
- **Vertex runtime** `vertexRuntime.js` → `runToolLoop({modelName=DEFAULT_MODEL, messages, systemInstruction, toolDeclarations, runTool, costTracker, maxHops, budgetCents})` — **blocking** (`model.generateContent()`), full functionCall→functionResponse loop, $0.50/turn budget, safety thresholds, cost snapshot. `DEFAULT_MODEL = process.env.OPERATIONS_AGENT_MODEL || process.env.VERTEX_MODEL || 'gemini-2.5-flash'`. `ensureVertex()` authed via Compute SA on Cloud Run (working in prod).
- **Chat HTTP** `POST /api/ops/chat` (`ops.js`) — SSE; accepts `model_id`; **hardcodes** `runClaudeChatTurn` (from `claudeSupervisor.js`). No provider dispatch. `send(event,data)` writes SSE frames from `onEvent`.
- **`claudeSupervisor.js`** `runClaudeChatTurn({clientUserId,userId,threadId,prompt,modelId,onEvent})` — resolves `resolveChatModel(modelId||thread.model_id)` (always Claude), persists user+assistant messages (Anthropic content blocks) to `ops_chat_messages`, updates `ops_chat_threads.model_id`, calls `runClaudeToolLoop`.
- **`supervisor.js`** `runSupervisorTurn({clientUserId,userId,history,prompt,modelId})` — the **Vertex** supervisor: builds messages, `listSupervisorDeclarations()` (the same supervisor tools — `load_run`/`drill_into`/`delegate_to`/`propose_action`), `runTool`, calls vertex `runToolLoop`. Implements the **approval gate** (`propose_action` → `ops_tool_approvals`; `executeApproval`/`rejectApproval`). **Not wired to HTTP, does not stream or persist.**
- **Threads** `ops_chat_threads.model_id TEXT NOT NULL DEFAULT 'claude-sonnet-4-6'`; `ops_chat_messages.content_json` stores per-turn content blocks.
- **Frontend** `Chat/ClientChat.jsx` — hardcoded `MODELS` array (3 Claude); `useState('claude-sonnet-4-6')`; loads `thread.model_id` when opening a thread; sends `model_id` per turn via `streamOpsChat`.
- **Sub-agents** `subAgents/_runner.js` accepts `modelName` (plumbed) but the four agents never pass one → fall back to vertex `DEFAULT_MODEL` (`gemini-2.5-flash`). `ops_run_definitions` has **no model column**.

**The blocker:** `POST /chat` → `runClaudeChatTurn` is Anthropic-only; the registry has no Gemini entries; the Vertex runtime doesn't stream. Vertex auth + the Vertex supervisor tool loop + approval already work.

---

## 3. Architecture

### 3.1 Provider-aware model registry (`models.js`)
Add a `provider` field to every model and register Gemini entries:
```
MODELS = {
  'claude-haiku-4-5':  { provider:'anthropic', label:'Claude Haiku 4.5 (fast)',     inPer1k, outPer1k },
  'claude-sonnet-4-6': { provider:'anthropic', label:'Claude Sonnet 4.6 (balanced)', ... },
  'claude-opus-4-8':   { provider:'anthropic', label:'Claude Opus 4.8 (deep)',       ... },
  'gemini-2.5-flash':  { provider:'google',    label:'Gemini 2.5 Flash (fast/cheap)', ... },
  'gemini-2.5-pro':    { provider:'google',    label:'Gemini 2.5 Pro (deep)',         ... }
}
DEFAULT_CHAT_MODEL = process.env.OPS_CHAT_DEFAULT_MODEL || 'gemini-2.5-flash'   // flipped to Google
```
- `gemini-2.5-flash` is the proven-in-prod default. `gemini-2.5-pro` is offered as the deeper tier — **the plan must verify it resolves on this Vertex project**; if not, drop it and keep flash only.
- `resolveChatModel(modelId)` validates against the full `MODELS` map; falls back to `DEFAULT_CHAT_MODEL`.
- New helper `providerOf(modelId)` → `'anthropic' | 'google'` (also derivable by `claude-`/`gemini-` prefix; use the registry).
- Backward-compat: keep `CLAUDE_MODELS` as a filtered view if anything imports it; preserve `SUBAGENT_MODEL`.

### 3.2 Provider dispatch in the chat turn
Generalize the chat entry so `POST /chat` calls one `runChatTurn(...)` that dispatches by provider:
- `provider === 'anthropic'` → existing `runClaudeToolLoop` path (unchanged: streaming, persistence as Anthropic content blocks).
- `provider === 'google'` → **new** `runGeminiChatTurn` (a streaming + persistent wrapper around the Vertex supervisor tool loop).

Cleanest structure: keep `claudeSupervisor.js` as the Anthropic path; add `geminiSupervisor.js` for the Google path; add a thin `chatTurn.js` (`runChatTurn`) that resolves the model, looks up the provider, and delegates. `POST /chat` imports `runChatTurn` instead of `runClaudeChatTurn`. `listThreads`/`loadThread` stay provider-neutral (they read rows).

### 3.3 Gemini streaming chat path (`geminiSupervisor.js` + vertex streaming)
- Add a **streaming tool loop** to `vertexRuntime.js`: `runToolLoopStream({modelName, messages, systemInstruction, toolDeclarations, runTool, costTracker, maxHops, budgetCents, onEvent})` using `model.generateContentStream()`. Per hop: iterate stream chunks, emit `onEvent({type:'text', text:delta})` for text parts; accumulate `functionCall` parts (Vertex surfaces them across/at end of the stream); when the hop completes, if there are functionCalls → run tools, append `functionResponse` parts, next hop; else finish. Emit `tool_step` events (name, args, result) like the Anthropic path, and a final `done`. Preserve the `$0.50/turn` budget + safety thresholds + cost snapshot. (Keep the existing blocking `runToolLoop` for non-chat callers.)
- `geminiSupervisor.js` `runGeminiChatTurn({clientUserId,userId,threadId,prompt,modelId,onEvent})`: mirrors `claudeSupervisor` — create/load thread, rebuild the Vertex message array from persisted Gemini-format history, run `runToolLoopStream` with the supervisor tools (`listSupervisorDeclarations` + the shared `runTool` + the **approval gate**: `propose_action` writes `ops_tool_approvals` and pauses, exactly as the Anthropic path does), persist the user + assistant turn (Gemini-format `content_json`), update `ops_chat_threads.model_id`. Emits the same SSE event types the UI already handles (`text`, `thinking?`, `tool_step`/`tool_use`+`tool_result`, `cost`, `approval_required`, `done`).
- The approval execute/reject endpoints (`/chat/approve`, `/chat/reject`) already call `executeApproval`/`rejectApproval` (provider-neutral) — unchanged.

### 3.4 Provider-bound threads
`ops_chat_messages.content_json` is stored in the active runtime's native format (Anthropic content blocks vs Vertex `role/parts`). To avoid cross-format conversion, **a thread is bound to its provider**:
- `ops_chat_threads` gains `provider TEXT NOT NULL DEFAULT 'google'` (set on thread creation from the chosen model's provider). Migration: `ALTER TABLE ... ADD COLUMN IF NOT EXISTS provider`. Existing rows (all Claude) backfill to `'anthropic'` in the same migration.
- A turn's model must match the thread's provider. The UI prevents cross-provider switches within a thread: changing to a model of a different provider **starts a new chat** (calls the existing `newChat()`); switching tiers within the same provider is allowed. The backend also guards: if `providerOf(modelId) !== thread.provider`, it ignores the cross-provider model and uses the thread's provider default (defensive; the UI shouldn't send it).

### 3.5 Frontend model picker (`ClientChat.jsx`)
- Replace the hardcoded `MODELS` array with options from a new `GET /api/ops/chat/models` → `[{id,label,provider}]` (from the registry). Default selection = the server's `DEFAULT_CHAT_MODEL`.
- Group/label by provider (e.g., "Gemini 2.5 Flash", "Claude Sonnet 4.6"). On change: if the new model's provider differs from the current thread's provider, call `newChat()` before sending (so history stays single-provider). Persisted `thread.model_id` still drives the selection when opening an existing thread.

### 3.6 Per-run-definition model override (scheduled actions / sub-agents)
- `ops_run_definitions` gains `model_id TEXT` (nullable). Migration idempotent.
- The run/sub-agent execution path passes the definition's `model_id` (when set) as `modelName` into the sub-agent runner / supervisor; falls back to the global default (`OPERATIONS_AGENT_MODEL` / `gemini-2.5-flash`) when null. `subAgents/_runner.js` already threads `modelName` — wire the definition's value through `runExecutor`/`scheduleFanout` to it.
- Run-definition create/edit endpoints (`POST`/`PUT /run-definitions`) accept + persist `model_id`; the run-definition admin UI gets a model dropdown (same `/chat/models` source, Google entries; Claude allowed too). Validate against the registry.

---

## 4. Data model changes
- `ops_chat_threads`: `ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'google'` (+ backfill existing rows to `'anthropic'` since all current threads are Claude). Migration `migrate_ops_chat_provider.sql`.
- `ops_run_definitions`: `ADD COLUMN IF NOT EXISTS model_id TEXT`. Migration `migrate_ops_run_definition_model.sql`.
- Net-new columns → run as admin at deploy (`RUN_MIGRATIONS_ON_START=false`); both are on ops-owned tables (`ops_app` already has DML). No grant change.

## 5. Compliance / cost / infra
- PHI-free app → no gate. No new external dependency or secret — Vertex is already authed/working; Anthropic key stays for the Claude option.
- The **approval gate + `ops_tool_approvals` audit** is preserved on BOTH chat paths (the Vertex supervisor already implements it).
- Cost tracking: each runtime keeps its own `costTracker` pricing; the chat's `cost` SSE event + monthly cap continue to work (Gemini uses the vertex cost snapshot; flip the per-1k constants in the registry if desired).
- Vertex per-turn `$0.50` budget guard stays on the Gemini path.
- No secrets in prompts/persisted messages (unchanged).

## 6. Verification (no UI/endpoint suite)
- `node:test` (DB-free): `providerOf`/`resolveChatModel` across both providers + default; the Vertex streaming tool-loop's chunk→event mapping (text deltas + a functionCall round-trip) against a mocked `generateContentStream`; the per-run-definition model resolution (definition `model_id` → sub-agent `modelName`, null → default).
- `yarn build` + `yarn lint`.
- Server boots; `GET /api/ops/chat/models` returns both providers with Gemini default; `POST /chat` with a Gemini model streams `text` deltas + `done` (curl SSE), a read-only tool round-trips, `propose_action` surfaces an approval, approve executes + audits; a Claude model still works (if credits) or fails gracefully with the provider error surfaced (not a hard crash).
- `yarn db:migrate` idempotent for both new columns.
- **Human:** chat defaults to Gemini and streams; switch to Gemini Pro and to Claude; cross-provider switch starts a new chat; a scheduled run-definition with a `model_id` runs on that model.

## 7. Open items for the plan
- Confirm `gemini-2.5-pro` resolves on this Vertex project/location; if not, ship flash-only and note it.
- Vertex streaming + tool-calls: confirm how `generateContentStream` surfaces `functionCall` parts (mid-stream vs final chunk) against the installed `@google-cloud/vertexai` version; the loop must collect them correctly per hop.
- Whether to surface Gemini "thinking" parts as `thinking` events in v1 or defer (default: stream text only; thinking deferred).
- Exact place to thread the run-definition `model_id` through (`runExecutor.js` / `scheduleFanout.js` → `_runner.js`) — confirm the call chain in the plan.
- Whether `ops_chat_threads.provider` is stored (chosen: yes) vs derived from `model_id` — stored is more robust to registry changes; keep stored + backfill.
