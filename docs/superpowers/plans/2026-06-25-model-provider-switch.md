# Model Provider Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Default the Operations AI chat to Google/Vertex (Gemini) so it works without Anthropic credits, keep Claude switchable, give Gemini real token streaming, and add a per-run-definition model override.

**Architecture:** A provider-aware model registry drives a provider dispatch in the chat turn: Claude keeps its streaming Anthropic loop; Gemini gets a new streaming chat path built on a new Vertex streaming tool-loop, reusing the existing Vertex supervisor tools + approval gate + persistence pattern. Chat threads are provider-bound. Scheduled run-definitions gain an optional `model_id` threaded into the sub-agent runner.

**Tech Stack:** Node 20 ESM, `@anthropic-ai/sdk`, `@google-cloud/vertexai` (already installed), PostgreSQL, React 19 + MUI 7, `node:test`.

## Global Constraints

- **No new npm dependencies** — Vertex (`@google-cloud/vertexai`) and Anthropic SDK are already installed and authed; Vertex works in prod today.
- **Keep both providers** — Anthropic stays available (just not default); never remove the Claude path.
- **Preserve the approval gate + audit** — `propose_action` → `ops_tool_approvals` and the four `operations.tool_*` events must work identically on BOTH chat paths. Don't change `/chat/approve` / `/chat/reject` (`executeApproval`/`rejectApproval` are provider-neutral).
- **Provider-bound threads** — `ops_chat_messages.content_json` stays in the active runtime's native format; a thread keeps one provider for its lifetime. Cross-provider model switch = new chat.
- **Parameterized SQL only**; UUID-validate path/body params (`isUuid`/`badUuid` in `ops.js`). No PHI/secrets in logs or persisted messages. `console.warn`/`console.error` only (console.log stripped in prod).
- **Default model** = `process.env.OPS_CHAT_DEFAULT_MODEL || 'gemini-2.5-flash'`. `gemini-2.5-flash` is proven in prod; `gemini-2.5-pro` must be verified to resolve on this Vertex project before relying on it.
- **Vertex per-turn budget** `$0.50` and safety thresholds stay on the Gemini path.
- **Migrations** are net-new columns on ops-owned tables (`ops_app` already has DML) — idempotent `ADD COLUMN IF NOT EXISTS`, registered in `server/migrations.js`, run as admin at deploy (`RUN_MIGRATIONS_ON_START=false`).
- **Verification norm:** `node:test` for pure functions (true TDD); `yarn build` + `yarn lint` + boot + curl/manual for endpoints/UI (no endpoint/UI harness). Tests require `DATABASE_URL` set (e.g. `DATABASE_URL=postgresql://bif@localhost:5432/anchor`) because service modules import `db.js` at load.

---

## File Structure

**Modified:**
- `server/services/ops/agents/models.js` — add `provider` field + Gemini entries; flip default; add `providerOf`; broaden `resolveChatModel`; keep `CLAUDE_MODELS`/`SUBAGENT_MODEL`.
- `server/services/ops/agents/vertexRuntime.js` — add `runToolLoopStream(...)` (streaming via `generateContentStream`) alongside the existing blocking `runToolLoop`.
- `server/routes/ops.js` — `POST /chat` → call new `runChatTurn` (provider dispatch); add `GET /chat/models`; `POST`/`PUT /run-definitions` accept `model_id`.
- `server/services/ops/agents/claudeSupervisor.js` — set `provider='anthropic'` on thread creation (minor).
- `src/views/admin/Operations/Chat/ClientChat.jsx` — model options from API; default Gemini; cross-provider switch → newChat.
- `src/api/ops.js` — add `getChatModels()`.
- Run executor / fanout path (`server/services/ops/runExecutor.js` and/or `scheduleFanout.js`) — thread run-definition `model_id` into the sub-agent runner.
- The run-definition admin UI (in `src/views/admin/Operations/Bulk/` — confirm file) — model dropdown.
- `server/migrations.js` — register the two new migrations.

**Created:**
- `server/services/ops/agents/chatTurn.js` — `runChatTurn(...)` provider dispatch.
- `server/services/ops/agents/geminiSupervisor.js` — `runGeminiChatTurn(...)` (Gemini streaming chat: persistence + approval + SSE).
- `server/sql/migrate_ops_chat_provider.sql` — `ops_chat_threads.provider`.
- `server/sql/migrate_ops_run_definition_model.sql` — `ops_run_definitions.model_id`.
- Tests: `server/services/ops/agents/__tests__/models.test.js`, `vertexStream.test.js`, `runDefinitionModel.test.js`.

---

## Task 1: Provider-aware model registry

**Files:**
- Modify: `server/services/ops/agents/models.js`
- Test: `server/services/ops/agents/__tests__/models.test.js`

**Interfaces:**
- Produces:
  - `MODELS` (object keyed by model id; each `{ provider, label, inPer1k, outPer1k }`).
  - `DEFAULT_CHAT_MODEL` (string, default `'gemini-2.5-flash'`).
  - `SUBAGENT_MODEL` (unchanged export).
  - `CLAUDE_MODELS` (kept — filtered view of anthropic models, for back-compat).
  - `providerOf(modelId)` → `'anthropic' | 'google' | null`.
  - `resolveChatModel(modelId)` → a valid model id (the arg if known, else `DEFAULT_CHAT_MODEL`).

- [ ] **Step 1: Write the failing test**

`server/services/ops/agents/__tests__/models.test.js`:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, DEFAULT_CHAT_MODEL, providerOf, resolveChatModel, CLAUDE_MODELS } from '../models.js';

test('registry has both providers and a Google default', () => {
  assert.equal(providerOf('gemini-2.5-flash'), 'google');
  assert.equal(providerOf('claude-sonnet-4-6'), 'anthropic');
  assert.equal(providerOf('nope'), null);
  assert.equal(MODELS[DEFAULT_CHAT_MODEL].provider, 'google');
});

test('resolveChatModel accepts known ids across providers, falls back to default', () => {
  assert.equal(resolveChatModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(resolveChatModel('gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(resolveChatModel('bogus'), DEFAULT_CHAT_MODEL);
  assert.equal(resolveChatModel(null), DEFAULT_CHAT_MODEL);
});

test('CLAUDE_MODELS back-compat view contains only anthropic models', () => {
  for (const id of Object.keys(CLAUDE_MODELS)) assert.equal(providerOf(id), 'anthropic');
});
```

- [ ] **Step 2: Run it — fail**

Run: `DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/agents/__tests__/models.test.js`
Expected: FAIL (`providerOf` not exported / default still claude).

- [ ] **Step 3: Implement**

Replace `server/services/ops/agents/models.js` contents:
```javascript
// Unified model registry across providers. Anthropic stays available; Google
// (Vertex Gemini) is the default because the Anthropic credit balance is
// exhausted. Gemini already runs in prod for checks/sub-agents.
export const MODELS = {
  'claude-haiku-4-5': { provider: 'anthropic', label: 'Claude Haiku 4.5 (fast)', inPer1k: 0.001, outPer1k: 0.005 },
  'claude-sonnet-4-6': { provider: 'anthropic', label: 'Claude Sonnet 4.6 (balanced)', inPer1k: 0.003, outPer1k: 0.015 },
  'claude-opus-4-8': { provider: 'anthropic', label: 'Claude Opus 4.8 (deep)', inPer1k: 0.005, outPer1k: 0.025 },
  'gemini-2.5-flash': { provider: 'google', label: 'Gemini 2.5 Flash (fast/cheap)', inPer1k: 0.000075, outPer1k: 0.0003 },
  'gemini-2.5-pro': { provider: 'google', label: 'Gemini 2.5 Pro (deep)', inPer1k: 0.00125, outPer1k: 0.005 }
};

// Back-compat: some code imports CLAUDE_MODELS.
export const CLAUDE_MODELS = Object.fromEntries(
  Object.entries(MODELS).filter(([, m]) => m.provider === 'anthropic')
);

export const DEFAULT_CHAT_MODEL = process.env.OPS_CHAT_DEFAULT_MODEL || 'gemini-2.5-flash';
export const SUBAGENT_MODEL = process.env.OPS_CHAT_SUBAGENT_MODEL || 'gemini-2.5-flash';

export function providerOf(modelId) {
  return MODELS[modelId]?.provider || null;
}

export function resolveChatModel(modelId) {
  if (modelId && MODELS[modelId]) return modelId;
  return MODELS[DEFAULT_CHAT_MODEL] ? DEFAULT_CHAT_MODEL : 'gemini-2.5-flash';
}
```
Note: confirm `SUBAGENT_MODEL`'s prior default wasn't depended on as a Claude id elsewhere — grep `SUBAGENT_MODEL` usages; sub-agents run on Vertex, so a Gemini default is correct. If any caller passes `SUBAGENT_MODEL` into the Anthropic loop, leave that caller's behavior unchanged (it shouldn't — sub-agents are Vertex).

- [ ] **Step 4: Run — pass.**

- [ ] **Step 5: Commit**
```bash
git add server/services/ops/agents/models.js server/services/ops/agents/__tests__/models.test.js
git commit -m "feat(ops): provider-aware model registry, default Gemini"
```

---

## Task 2: Vertex streaming tool loop

Add a streaming variant of the Vertex tool loop so the Gemini chat can emit token deltas. Keep the existing blocking `runToolLoop` for non-chat callers.

**Files:**
- Modify: `server/services/ops/agents/vertexRuntime.js`
- Test: `server/services/ops/agents/__tests__/vertexStream.test.js`

**Interfaces:**
- Consumes: existing `vertexRuntime.js` internals (`ensureVertex`, `DEFAULT_MODEL`, the message/tool format helpers, `costTracker` usage, safety thresholds, `PER_TURN_BUDGET_CENTS`).
- Produces: `runToolLoopStream({ modelName, messages, systemInstruction, toolDeclarations, runTool, costTracker, maxHops, budgetCents, onEvent })` → resolves to `{ text, messages, usage }` (same return shape as `runToolLoop`), emitting `onEvent({type:'text', text})` per delta, `onEvent({type:'tool_use', id, name, args})` and `onEvent({type:'tool_result', id, result})` per tool call, and `onEvent({type:'cost', ...})` per hop. `onEvent` defaults to a no-op.

- [ ] **Step 1: Read the existing runtime**

Read `server/services/ops/agents/vertexRuntime.js` in full — the blocking `runToolLoop` (≈ lines 117–200), how it builds the `model` (`ensureVertex().getGenerativeModel(...)`), the per-hop `generateContent` call, how it extracts text + `functionCall` parts, how it appends `functionResponse` parts, the cost accounting, and the budget/maxHops guards. The streaming variant mirrors this exactly except for the model call + delta emission.

- [ ] **Step 2: Write the failing test (chunk→event mapping)**

`server/services/ops/agents/__tests__/vertexStream.test.js` — tests the streaming loop against an injected fake model (no network). The implementation must accept a `__modelForTest` option that supplies an object with `generateContentStream(req)` returning `{ stream: asyncIterable, response: Promise }`, so the test drives it:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoopStream } from '../vertexRuntime.js';

// Fake Vertex model: hop 1 streams two text deltas + a functionCall; hop 2 streams final text.
function fakeModel() {
  let hop = 0;
  return {
    generateContentStream() {
      hop += 1;
      if (hop === 1) {
        return {
          stream: (async function* () {
            yield { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] };
            yield { candidates: [{ content: { parts: [{ text: 'lo ' }] } }] };
            yield { candidates: [{ content: { parts: [{ functionCall: { name: 'ping', args: { x: 1 } } }] } }] };
          })(),
          response: Promise.resolve({
            candidates: [{ content: { parts: [{ text: 'Hello ' }, { functionCall: { name: 'ping', args: { x: 1 } } }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 }
          })
        };
      }
      return {
        stream: (async function* () {
          yield { candidates: [{ content: { parts: [{ text: 'done.' }] } }] };
        })(),
        response: Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'done.' }] } }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2 }
        })
      };
    }
  };
}

test('runToolLoopStream emits text deltas, runs the tool, and finishes', async () => {
  const events = [];
  const toolCalls = [];
  const out = await runToolLoopStream({
    modelName: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ text: 'hi' }] }],
    systemInstruction: { role: 'system', parts: [{ text: 'sys' }] },
    toolDeclarations: [{ name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } }],
    runTool: async (name, args) => { toolCalls.push({ name, args }); return { ok: true }; },
    costTracker: { add() {} },
    onEvent: (e) => events.push(e),
    __modelForTest: fakeModel()
  });
  const textDeltas = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.ok(textDeltas.includes('Hello'));
  assert.ok(textDeltas.includes('done.'));
  assert.deepEqual(toolCalls, [{ name: 'ping', args: { x: 1 } }]);
  assert.ok(events.some((e) => e.type === 'tool_use' && e.name === 'ping'));
  assert.ok(events.some((e) => e.type === 'tool_result'));
  assert.equal(out.text, 'done.');
});
```

- [ ] **Step 3: Run — fail** (`runToolLoopStream` not exported).

- [ ] **Step 4: Implement `runToolLoopStream`**

Add to `vertexRuntime.js`, mirroring `runToolLoop` but using `generateContentStream`. Use `__modelForTest` when provided, else build the model the same way `runToolLoop` does (same `getGenerativeModel({ model: modelName||DEFAULT_MODEL, systemInstruction, tools: [{functionDeclarations: toolDeclarations}], safetySettings })`). Per hop:
```javascript
export async function runToolLoopStream({
  modelName = DEFAULT_MODEL,
  messages,
  systemInstruction,
  toolDeclarations,
  runTool,
  costTracker,
  maxHops = MAX_TOOL_HOPS,
  budgetCents = PER_TURN_BUDGET_CENTS,
  onEvent = () => {},
  __modelForTest = null
}) {
  const model =
    __modelForTest ||
    ensureVertex().getGenerativeModel({
      model: modelName,
      systemInstruction,
      tools: toolDeclarations?.length ? [{ functionDeclarations: toolDeclarations }] : undefined,
      safetySettings: SAFETY_SETTINGS // the same constant runToolLoop uses
    });

  const convo = [...messages];
  let finalText = '';
  for (let hop = 0; hop < maxHops; hop += 1) {
    const { stream, response } = await model.generateContentStream({ contents: convo });
    let hopText = '';
    for await (const chunk of stream) {
      const parts = chunk?.candidates?.[0]?.content?.parts || [];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text) {
          hopText += p.text;
          onEvent({ type: 'text', text: p.text });
        }
      }
    }
    const full = await response;
    const parts = full?.candidates?.[0]?.content?.parts || [];
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    // cost accounting from full.usageMetadata, mirror runToolLoop's costTracker.add(...)
    const usage = full?.usageMetadata || {};
    if (costTracker?.add) costTracker.add({ promptTokens: usage.promptTokenCount || 0, outputTokens: usage.candidatesTokenCount || 0, modelName });
    onEvent({ type: 'cost', /* same shape runToolLoop/anthropic emit */ });

    // Record the model turn (text + any functionCalls) into the convo as a 'model' message.
    convo.push({ role: 'model', parts });

    if (!calls.length) { finalText = hopText || finalText; break; }

    // Run each tool, append a single 'function' message with functionResponse parts.
    const responseParts = [];
    for (const call of calls) {
      onEvent({ type: 'tool_use', id: `${call.name}-${hop}`, name: call.name, args: call.args || {} });
      let result;
      try { result = await runTool(call.name, call.args || {}); }
      catch (err) { result = { error: String(err?.message || err) }; }
      onEvent({ type: 'tool_result', id: `${call.name}-${hop}`, result });
      responseParts.push({ functionResponse: { name: call.name, response: result } });
    }
    convo.push({ role: 'function', parts: responseParts });
    // budget guard: if costTracker exposes spentCents and budgetCents exceeded, break (mirror runToolLoop)
  }
  return { text: finalText, messages: convo, usage: {} };
}
```
Match the EXACT cost-tracker call shape, safety settings constant name, and budget-guard logic used by the existing `runToolLoop` (read them in Step 1 and copy them). Do not change `runToolLoop`.

- [ ] **Step 5: Run — pass** (`DATABASE_URL=... node --test server/services/ops/agents/__tests__/vertexStream.test.js`).

- [ ] **Step 6: Commit**
```bash
git add server/services/ops/agents/vertexRuntime.js server/services/ops/agents/__tests__/vertexStream.test.js
git commit -m "feat(ops): streaming Vertex tool loop (generateContentStream)"
```

---

## Task 3: Gemini chat supervisor (streaming + persistence + approval)

A Gemini counterpart to `claudeSupervisor.js`'s `runClaudeChatTurn`, built on `runToolLoopStream` and the existing Vertex supervisor tools + approval gate.

**Files:**
- Read: `server/services/ops/agents/claudeSupervisor.js` (mirror its persistence + thread + approval handling), `server/services/ops/agents/supervisor.js` (reuse `listSupervisorDeclarations`, the `runTool` builder, and the `propose_action`/approval handling).
- Create: `server/services/ops/agents/geminiSupervisor.js`

**Interfaces:**
- Consumes: `runToolLoopStream` (Task 2); `resolveChatModel`/`providerOf` (Task 1); supervisor tool declarations + `runTool` + approval helpers from `supervisor.js`; `ops_chat_threads`/`ops_chat_messages` via `query`.
- Produces: `runGeminiChatTurn({ clientUserId, userId, threadId, prompt, modelId, onEvent })` → `{ threadId, status, messageId, costCents }` (match `runClaudeChatTurn`'s return shape). Persists user + assistant messages as **Vertex-format** `content_json`; sets/uses `ops_chat_threads.provider='google'`; emits the same SSE event types the UI consumes (`text`, `tool_use`/`tool_result` (or `tool_step`), `cost`, `approval_required`, `done`).

- [ ] **Step 1: Read both supervisors fully**

Read `claudeSupervisor.js` (thread create/load, message rebuild, `ops_chat_messages` insert shape, `ops_chat_threads` update, `costCents` computation, the `done` event payload incl. persisted message id, and how `propose_action` surfaces `approval_required`). Read `supervisor.js` `runSupervisorTurn` (how it builds `systemInstruction`, `messages`, `listSupervisorDeclarations()`, the `runTool` closure incl. `propose_action` writing `ops_tool_approvals` and pausing). `runGeminiChatTurn` = the claude persistence/thread shell + the supervisor's Vertex tools/approval + `runToolLoopStream`.

- [ ] **Step 2: Implement `geminiSupervisor.js`**

Mirror `runClaudeChatTurn` exactly for: creating a thread when `threadId` is null (set `provider='google'`, `model_id=resolveChatModel(modelId)`), loading + rebuilding prior messages (in Vertex `role/parts` format from `content_json`), inserting the user message, running `runToolLoopStream` with `systemInstruction`/`messages`/`listSupervisorDeclarations()`/the supervisor `runTool` (including the approval-gate behavior — a `propose_action` writes the pending `ops_tool_approvals` row, emits `approval_required`, and pauses the turn exactly as the Claude path does), persisting the assistant message (Vertex-format content_json + usage_json + cost_cents), updating `ops_chat_threads.model_id`, and emitting `done` with the persisted message id + status. Build `runTool`/system prompt by calling into the existing `supervisor.js` exports (do not duplicate the tool logic) — if `supervisor.js` doesn't export the `runTool` builder + system prompt separately, refactor it minimally to export them, leaving `runSupervisorTurn` working.

Forced structure (fill from the real files):
```javascript
import { query } from '../../db.js';
import { runToolLoopStream } from './vertexRuntime.js';
import { resolveChatModel } from './models.js';
import { buildSupervisorContext, runSupervisorTool, listSupervisorDeclarations } from './supervisor.js'; // names per the real exports
// ... mirror claudeSupervisor's thread/message/persistence/cost/approval, but Vertex-format + runToolLoopStream.
export async function runGeminiChatTurn({ clientUserId, userId, threadId, prompt, modelId, onEvent = () => {} }) {
  /* ... */
}
```

- [ ] **Step 3: Verify (no isolated unit test — it's integration glue; covered by Task 4's boot/curl)**

`yarn build` (server isn't bundled by Vite, but build catches frontend; run `node --check server/services/ops/agents/geminiSupervisor.js` to confirm it parses) and `DATABASE_URL=... node --test server/services/ops/agents/__tests__/vertexStream.test.js` still passes. Full streaming/persistence/approval verification happens in Task 4 (boot + curl SSE).

- [ ] **Step 4: Commit**
```bash
git add server/services/ops/agents/geminiSupervisor.js server/services/ops/agents/supervisor.js
git commit -m "feat(ops): Gemini chat supervisor (streaming, persistent, approval-gated)"
```

---

## Task 4: Provider dispatch + provider-bound threads + wire POST /chat

**Files:**
- Create: `server/services/ops/agents/chatTurn.js`
- Create: `server/sql/migrate_ops_chat_provider.sql`
- Modify: `server/migrations.js`, `server/routes/ops.js`, `server/services/ops/agents/claudeSupervisor.js`

**Interfaces:**
- Consumes: `runClaudeChatTurn` (claudeSupervisor), `runGeminiChatTurn` (Task 3), `resolveChatModel`/`providerOf` (Task 1).
- Produces: `runChatTurn(args)` — resolves the model, looks up provider, and delegates to the right supervisor; enforces provider-bound threads.

- [ ] **Step 1: Migration — `ops_chat_threads.provider`**

`server/sql/migrate_ops_chat_provider.sql`:
```sql
ALTER TABLE ops_chat_threads ADD COLUMN IF NOT EXISTS provider TEXT NOT NULL DEFAULT 'google';
-- Existing threads were all Claude; backfill them so their history replays on the Anthropic runtime.
UPDATE ops_chat_threads SET provider = 'anthropic'
 WHERE provider = 'google' AND model_id LIKE 'claude-%';
```
Register it in `server/migrations.js` `MIGRATIONS_BEFORE_SEED` after `migrate_ops_chat.sql`.

- [ ] **Step 2: `claudeSupervisor.js` — set provider on thread create**

In the thread-INSERT in `claudeSupervisor.js`, add `provider='anthropic'` to the inserted columns (so new Claude threads are tagged). (Gemini threads are tagged in Task 3.)

- [ ] **Step 3: Implement `chatTurn.js`**
```javascript
import { providerOf, resolveChatModel } from './models.js';
import { runClaudeChatTurn } from './claudeSupervisor.js';
import { runGeminiChatTurn } from './geminiSupervisor.js';
import { query } from '../../db.js';

export async function runChatTurn(args) {
  let { threadId, modelId } = args;
  // Provider-bound threads: an existing thread keeps its provider; ignore a cross-provider modelId.
  if (threadId) {
    const { rows } = await query('SELECT provider, model_id FROM ops_chat_threads WHERE id = $1', [threadId]);
    const threadProvider = rows[0]?.provider || null;
    if (threadProvider && providerOf(resolveChatModel(modelId)) !== threadProvider) {
      modelId = rows[0].model_id; // stick to the thread's own model/provider
    }
  }
  const provider = providerOf(resolveChatModel(modelId));
  const next = { ...args, modelId };
  return provider === 'anthropic' ? runClaudeChatTurn(next) : runGeminiChatTurn(next);
}
```

- [ ] **Step 4: Wire `POST /chat`**

In `server/routes/ops.js`: change the import on line 26 to also import `runChatTurn` from `'../services/ops/agents/chatTurn.js'` (keep `listThreads`/`loadThread` from claudeSupervisor). Replace the `runClaudeChatTurn(...)` call (~line 1382) with `runChatTurn({...})` — same args. Leave `/chat/approve` / `/chat/reject` / `/chat/threads` unchanged.

- [ ] **Step 5: Verify (boot + curl SSE)**

`yarn build && yarn lint`. Run migrations against dev DB: `DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn db:migrate` (idempotent; adds `provider`). Boot the server; with an admin token, `curl -N` the SSE `POST /api/ops/chat` with `{"prompt":"hi","model_id":"gemini-2.5-flash","client_user_id":"<a roster client>"}` → confirm `event: text` deltas then `event: done`; the thread persists (`GET /chat/threads`); a `propose_action` (ask it to change something) surfaces `event: approval_required`; `POST /chat/approve` executes + audits. With a `claude-*` model_id, confirm it routes to the Claude path (errors cleanly with the credit message rather than crashing if credits are still empty).

- [ ] **Step 6: Commit**
```bash
git add server/services/ops/agents/chatTurn.js server/sql/migrate_ops_chat_provider.sql server/migrations.js \
  server/routes/ops.js server/services/ops/agents/claudeSupervisor.js
git commit -m "feat(ops): provider dispatch for chat + provider-bound threads"
```

---

## Task 5: `GET /chat/models` + frontend picker

**Files:**
- Modify: `server/routes/ops.js`, `src/api/ops.js`, `src/views/admin/Operations/Chat/ClientChat.jsx`

**Interfaces:**
- Consumes: `MODELS`/`DEFAULT_CHAT_MODEL`/`providerOf` (Task 1); `runChatTurn` already wired.
- Produces: `GET /api/ops/chat/models` → `{ models: [{id,label,provider}], default: '<id>' }`; `getChatModels()` (api).

- [ ] **Step 1: Endpoint**

In `ops.js` (admin-gated section): 
```javascript
router.get('/chat/models', (_req, res) => {
  const models = Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, provider: m.provider }));
  res.json({ models, default: DEFAULT_CHAT_MODEL });
});
```
Import `MODELS, DEFAULT_CHAT_MODEL` from `../services/ops/agents/models.js`.

- [ ] **Step 2: api client**

`src/api/ops.js`:
```javascript
export const getChatModels = () => client.get('/ops/chat/models').then((r) => r.data);
```

- [ ] **Step 3: Frontend picker (`ClientChat.jsx`)**

- Replace the hardcoded `MODELS` array + `useState('claude-sonnet-4-6')` with: load `getChatModels()` on mount into `modelOptions` state; default `model` to the server `default`. Render the dropdown from `modelOptions` (label includes provider). When opening an existing thread, keep using `thread.model_id`.
- On model change: if `providerOf(newModel) !== providerOf(currentModel)`, call the existing `newChat()` before adopting it (provider-bound threads). Derive provider client-side from the option's `provider` field (the options carry it) — no need to call the server.

- [ ] **Step 4: Verify**

`yarn build && yarn lint`. Boot; the chat dropdown lists Gemini + Claude, defaults to Gemini Flash; sending works on Gemini (streams); switching Gemini↔Claude starts a new chat; switching Flash↔Pro stays in the same thread.

- [ ] **Step 5: Commit**
```bash
git add server/routes/ops.js src/api/ops.js src/views/admin/Operations/Chat/ClientChat.jsx
git commit -m "feat(ops): chat model picker from API (Gemini + Claude, default Gemini)"
```

---

## Task 6: Per-run-definition model override

**Files:**
- Create: `server/sql/migrate_ops_run_definition_model.sql`
- Modify: `server/migrations.js`, `server/routes/ops.js`, the run executor/fanout path (`server/services/ops/runExecutor.js` / `scheduleFanout.js`), the run-definition admin UI
- Test: `server/services/ops/agents/__tests__/runDefinitionModel.test.js`

**Interfaces:**
- Consumes: `MODELS`/`providerOf` (validation); `subAgents/_runner.js` `modelName` param (already plumbed); vertex `DEFAULT_MODEL` fallback.
- Produces: `resolveRunModel(defModelId)` → a valid model id or `null` (→ caller falls back to the global default).

- [ ] **Step 1: Migration**

`server/sql/migrate_ops_run_definition_model.sql`:
```sql
ALTER TABLE ops_run_definitions ADD COLUMN IF NOT EXISTS model_id TEXT;
```
Register in `server/migrations.js`.

- [ ] **Step 2: Failing test for `resolveRunModel`**

`server/services/ops/agents/__tests__/runDefinitionModel.test.js`:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunModel } from '../models.js';

test('resolveRunModel passes through a valid id, nulls unknown/empty', () => {
  assert.equal(resolveRunModel('gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(resolveRunModel('claude-haiku-4-5'), 'claude-haiku-4-5');
  assert.equal(resolveRunModel('bogus'), null);
  assert.equal(resolveRunModel(null), null);
  assert.equal(resolveRunModel(''), null);
});
```

- [ ] **Step 3: Run — fail; then add `resolveRunModel` to `models.js`**
```javascript
export function resolveRunModel(modelId) {
  return modelId && MODELS[modelId] ? modelId : null;
}
```

- [ ] **Step 4: Run — pass.**

- [ ] **Step 5: Persist `model_id` on run-definitions**

In `ops.js` `POST /run-definitions` and `PUT /run-definitions/:id`, accept `model_id` in the body, validate with `resolveRunModel` (store the resolved value or null), and include it in the INSERT/UPDATE + the `GET /run-definitions` SELECT. (Read the current handlers; add the one column.)

- [ ] **Step 6: Thread the model through execution**

Read the run execution chain (`runExecutor.js` → how it invokes the supervisor/sub-agents; `scheduleFanout.js` for scheduled runs). Where a run loads its `run_definition`, read `model_id`; pass `modelName: resolveRunModel(def.model_id) || undefined` into the sub-agent runner (`subAgents/_runner.js` already forwards `modelName`; null/undefined → vertex `DEFAULT_MODEL`). Do not force a model when the definition has none.

- [ ] **Step 7: Run-definition admin UI — model dropdown**

In the run-definition create/edit UI (under `src/views/admin/Operations/Bulk/` — confirm the exact file that edits run definitions), add a model `Select` populated from `getChatModels()` (reuse the Task 5 api), with a "Default (Gemini Flash)" empty option mapping to null. Submit `model_id`.

- [ ] **Step 8: Verify**

`DATABASE_URL=... node --test server/services/ops/agents/__tests__/runDefinitionModel.test.js` (pass). `yarn build && yarn lint`. `DATABASE_URL=... yarn db:migrate` (adds `model_id`). Boot; create/edit a run-definition with a model; confirm it persists (`GET /run-definitions`) and that a run for that definition uses the chosen model (check the run's recorded model/cost or logs). A definition with no model still runs on the Gemini default.

- [ ] **Step 9: Commit**
```bash
git add server/sql/migrate_ops_run_definition_model.sql server/migrations.js server/routes/ops.js \
  server/services/ops/agents/models.js server/services/ops/agents/__tests__/runDefinitionModel.test.js \
  server/services/ops/runExecutor.js src/views/admin/Operations/Bulk
git commit -m "feat(ops): per-run-definition model override"
```

---

## Deployment (after all tasks + final review)

`scripts/gdeploy.sh` (Cloud Build → amd64). Two net-new columns → run migrations once as admin via the Cloud SQL Auth Proxy (`DATABASE_URL=$ADMIN_DATABASE_URL RUN_MIGRATIONS_ON_START=true yarn db:migrate`, or apply the two `migrate_ops_*` files directly), then deploy. No new secrets. `OPS_CHAT_DEFAULT_MODEL` may be set on the service to override the default model without a code change. Smoke: `https://ops.anchorcorps.com` chat defaults to Gemini and streams.

## Self-Review Notes (spec coverage)

- §3.1 registry → Task 1. §3.3 Vertex streaming → Task 2. §3.3 Gemini chat path (persistence+approval) → Task 3. §3.2 dispatch + §3.4 provider-bound threads → Task 4. §3.5 frontend picker + `/chat/models` → Task 5. §3.6 per-run-definition model → Task 6. §4 migrations → Tasks 4 & 6. §5 approval/cost/budget preserved → Tasks 2–4 (carried in the runtime/supervisor). §6 verification → per-task. Open items (§7): `gemini-2.5-pro` availability (Task 1 note + Step 8 of Task 6), `generateContentStream` functionCall surfacing (Task 2 Step 1/4), thinking deferred (not built), run-definition wiring point (Task 6 Step 6) — all flagged for the implementer to confirm against real code.
