# Professional AI Chat — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the basic single-turn Gemini "Agent" chat in `anchor-operations` with a streaming, persistent, Claude-powered conversational interface (rich markdown, visible tool steps, model switcher), preserving the existing approval-gate + cost governance.

**Architecture:** A new `anthropicRuntime.js` (official `@anthropic-ai/sdk`, first-party key) runs a manual streaming tool loop, reusing the existing supervisor/sub-agent tool *declarations* (translated from Vertex to Anthropic schema) and tool *handlers* unchanged. A new `claudeSupervisor.js` persists conversations to two new tables (`ops_chat_threads`/`ops_chat_messages`) and streams turns over SSE. The React chat is rebuilt to consume the SSE stream. Vertex/Gemini stays for non-chat automated work.

**Tech Stack:** Express 4 / Node 20 ESM, `@anthropic-ai/sdk`, React 19 + Vite + MUI 7, `react-markdown` + `dompurify`, PostgreSQL 15 (shared, `ops_app` role), Node `--test` (`yarn test:ops`).

## Global Constraints

- **Model IDs (exact, no date suffix):** `claude-haiku-4-5`, `claude-sonnet-4-6`, `claude-opus-4-8`. Defaults: sub-agents → Haiku; supervisor chat → Sonnet; hard-strategy opt-in → Opus.
- **4.x request surface:** adaptive thinking only — `thinking: { type: 'adaptive', display: 'summarized' }`. NEVER send `budget_tokens`, `temperature`, `top_p`, or `top_k` (all return 400). Use streaming for the chat turns.
- **Tool schema:** Anthropic tool = `{ name, description, input_schema }` (input_schema = the existing Vertex `parameters` object). Do NOT set `strict: true` (existing schemas have optional props without `additionalProperties:false`).
- **Prompt caching:** put `cache_control: { type: 'ephemeral' }` on the last `system` block (caches tools+system) and on the last content block of the most-recent turn. Keep system + tool list byte-stable (no timestamps/UUIDs in the prefix) or `cache_read_input_tokens` stays 0.
- **Cost:** read real `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`); feed the existing `costTracker.add({ promptTokens, completionTokens, dollars, source })` shape. Per-model price/1K (USD): Haiku 0.001/0.005, Sonnet 0.003/0.015, Opus 0.005/0.025; cache-read ≈ 0.1× input, cache-write ≈ 1.25× input.
- **Approval gate preserved:** mutations still go through `propose_action` → `ops_tool_approvals` → `executeApproval`/`rejectApproval` (unchanged handlers).
- **Compliance:** ops app is PHI-free by design → NO medical gate. Never put secrets/tokens in prompts or persisted messages. Consult `compliance-auditor` on the new message store before merge.
- **Verify:** `yarn build` + `yarn lint` green; DB-free unit tests via `yarn test:ops`; `yarn db:migrate` (inline `DATABASE_URL`) idempotent. Streaming/browser checks are human-verified.
- **ESM** project; **yarn 4** (`yarn add`, commit `yarn.lock` — CI `--immutable`).

---

## File Structure

**Backend (create unless noted):**
- `server/services/ops/agents/models.js` — Claude model registry + override validation.
- `server/services/ops/agents/toolSchema.js` — Vertex `declaration` → Anthropic tool translator.
- `server/services/ops/agents/anthropicRuntime.js` — `ensureAnthropic()` + streaming `runClaudeToolLoop()`.
- `server/services/ops/agents/claudeSupervisor.js` — `runClaudeChatTurn()` (thread load/persist + loop), reuses supervisor tools + `executeApproval`.
- `server/services/ops/agents/supervisor.js` — MODIFY: export the tool registry + `runTool` factory so `claudeSupervisor` reuses them.
- `server/sql/migrate_ops_chat.sql` — `ops_chat_threads` + `ops_chat_messages`.
- `server/migrations.js` — MODIFY: register the migration.
- `server/routes/ops.js` — MODIFY: SSE `POST /chat`, new thread GETs; keep approve/reject.
- `infra/sql/ops_app_role.sql` — MODIFY: GRANT on the 2 new tables.
- `scripts/gdeploy.sh` — MODIFY: add `ANTHROPIC_API_KEY` to secrets.
- `.env.example` — MODIFY: document `ANTHROPIC_API_KEY` + `OPS_CHAT_DEFAULT_MODEL`.
- `package.json` — MODIFY: add `@anthropic-ai/sdk`, `react-markdown`.
- `server/services/ops/__tests__/{models,toolSchema,anthropicRuntime}.test.js` — unit tests.

**Frontend (create unless noted):**
- `src/api/opsChatStream.js` — SSE fetch helper (reuses auth token).
- `src/api/ops.js` — MODIFY: add thread API fns.
- `src/ui-component/extended/Markdown.jsx` — safe markdown renderer.
- `src/views/admin/Operations/Chat/ClientChat.jsx` — REBUILD.
- `src/views/admin/Operations/Chat/ThreadSidebar.jsx` — thread list.
- `src/views/admin/Operations/Chat/ApprovalDialog.jsx` — keep as-is.
- `src/views/admin/Operations/index.jsx` — MODIFY: tab label "Chat".

---

## Task 1: Dependencies + env + deploy wiring

**Files:**
- Modify: `package.json` (+ `yarn.lock`), `scripts/gdeploy.sh`, `.env.example`

- [ ] **Step 1: Add deps**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
yarn add @anthropic-ai/sdk react-markdown
```

- [ ] **Step 2: Add `ANTHROPIC_API_KEY` to the deploy secret set** in `scripts/gdeploy.sh` — change:

```bash
SECRETS+=",FACEBOOK_SYSTEM_USER_TOKEN=FACEBOOK_SYSTEM_USER_TOKEN:latest"
```
to:
```bash
SECRETS+=",FACEBOOK_SYSTEM_USER_TOKEN=FACEBOOK_SYSTEM_USER_TOKEN:latest"
SECRETS+=",ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest"
```
> Confirm with `grep -n SOCIAL_MEDIA_SECRET scripts/gdeploy.sh` that the SECRETS block exists; the new line goes adjacent to the other content-suite secrets.

- [ ] **Step 3: Document env in `.env.example`** (append near other AI/Vertex vars)

```
# --- Pro AI chat (Claude) ---
ANTHROPIC_API_KEY=          # first-party Anthropic API key (chat runtime). Same secret as Secret Manager.
OPS_CHAT_DEFAULT_MODEL=     # optional override of the supervisor default (claude-sonnet-4-6)
```

- [ ] **Step 4: Build + lint + commit**

```bash
yarn build && yarn lint
git add package.json yarn.lock scripts/gdeploy.sh .env.example
git commit -m "chore(chat): add @anthropic-ai/sdk + react-markdown, wire ANTHROPIC_API_KEY"
```

---

## Task 2: Model registry

**Files:**
- Create: `server/services/ops/agents/models.js`
- Test: `server/services/ops/__tests__/models.test.js`

**Interfaces:**
- Produces: `CLAUDE_MODELS` (object), `DEFAULT_CHAT_MODEL`, `SUBAGENT_MODEL`, `resolveChatModel(modelId)`, `priceFor(modelId)`. Consumed by Tasks 4, 6, 7.

- [ ] **Step 1: Write the failing test**

```javascript
// server/services/ops/__tests__/models.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatModel, priceFor, DEFAULT_CHAT_MODEL } from '../agents/models.js';

test('resolveChatModel returns the default for null/unknown', () => {
  assert.equal(resolveChatModel(null), DEFAULT_CHAT_MODEL);
  assert.equal(resolveChatModel('gpt-4'), DEFAULT_CHAT_MODEL);
});

test('resolveChatModel accepts allowlisted Claude models', () => {
  assert.equal(resolveChatModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(resolveChatModel('claude-haiku-4-5'), 'claude-haiku-4-5');
});

test('priceFor returns per-1K input/output rates', () => {
  const p = priceFor('claude-sonnet-4-6');
  assert.equal(p.inPer1k, 0.003);
  assert.equal(p.outPer1k, 0.015);
});
```

- [ ] **Step 2: Run it (fails — module missing)**

Run: `cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations" && yarn test:ops`
Expected: FAIL (cannot find `../agents/models.js`).

- [ ] **Step 3: Implement `models.js`**

```javascript
// server/services/ops/agents/models.js
// Claude model registry for the ops chat. Exact IDs (no date suffix).

export const CLAUDE_MODELS = {
  'claude-haiku-4-5': { label: 'Haiku 4.5 (fast/cheap)', inPer1k: 0.001, outPer1k: 0.005 },
  'claude-sonnet-4-6': { label: 'Sonnet 4.6 (balanced)', inPer1k: 0.003, outPer1k: 0.015 },
  'claude-opus-4-8': { label: 'Opus 4.8 (deep strategy)', inPer1k: 0.005, outPer1k: 0.025 }
};

export const DEFAULT_CHAT_MODEL = process.env.OPS_CHAT_DEFAULT_MODEL || 'claude-sonnet-4-6';
export const SUBAGENT_MODEL = process.env.OPS_CHAT_SUBAGENT_MODEL || 'claude-haiku-4-5';

export function resolveChatModel(modelId) {
  if (modelId && CLAUDE_MODELS[modelId]) return modelId;
  return CLAUDE_MODELS[DEFAULT_CHAT_MODEL] ? DEFAULT_CHAT_MODEL : 'claude-sonnet-4-6';
}

export function priceFor(modelId) {
  return CLAUDE_MODELS[modelId] || CLAUDE_MODELS['claude-sonnet-4-6'];
}
```

- [ ] **Step 4: Run the test (passes)**

Run: `yarn test:ops`
Expected: PASS (new model tests; pre-existing DB tests may fail locally for lack of DATABASE_URL — that's environmental).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/agents/models.js server/services/ops/__tests__/models.test.js
git commit -m "feat(chat): Claude model registry + override validation"
```

---

## Task 3: Vertex→Anthropic tool-schema translator

**Files:**
- Create: `server/services/ops/agents/toolSchema.js`
- Test: `server/services/ops/__tests__/toolSchema.test.js`

**Interfaces:**
- Consumes: a tool object `{ declaration: { name, description, parameters } }` (existing supervisor/sub-agent shape).
- Produces: `toAnthropicTool(declaration)` → `{ name, description, input_schema }`; `toAnthropicTools(toolObjs)` → array. Consumed by Tasks 4, 6.

- [ ] **Step 1: Write the failing test**

```javascript
// server/services/ops/__tests__/toolSchema.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicTool } from '../agents/toolSchema.js';

test('translates a Vertex functionDeclaration to an Anthropic tool', () => {
  const decl = {
    name: 'load_run',
    description: 'Fetch one ops_run.',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] }
  };
  const tool = toAnthropicTool(decl);
  assert.equal(tool.name, 'load_run');
  assert.equal(tool.description, 'Fetch one ops_run.');
  assert.deepEqual(tool.input_schema, decl.parameters);
  assert.ok(!('parameters' in tool));
  assert.ok(!('strict' in tool)); // existing schemas have optional props; strict would 400
});

test('defaults input_schema to an empty object schema when parameters missing', () => {
  const tool = toAnthropicTool({ name: 'noargs', description: 'x' });
  assert.deepEqual(tool.input_schema, { type: 'object', properties: {} });
});
```

- [ ] **Step 2: Run it (fails)** — `yarn test:ops` → FAIL (module missing).

- [ ] **Step 3: Implement `toolSchema.js`**

```javascript
// server/services/ops/agents/toolSchema.js
// Translate the Vertex functionDeclaration shape used across the ops agents
// into Anthropic's tool schema. The two are nearly identical; `parameters`
// becomes `input_schema`. We intentionally do NOT set `strict: true` — the
// existing declarations carry optional properties without additionalProperties:false.

export function toAnthropicTool(declaration = {}) {
  return {
    name: declaration.name,
    description: declaration.description || '',
    input_schema: declaration.parameters || { type: 'object', properties: {} }
  };
}

export function toAnthropicTools(toolObjs = []) {
  return toolObjs.map((t) => toAnthropicTool(t.declaration || t));
}
```

- [ ] **Step 4: Run (passes)** — `yarn test:ops` → PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/agents/toolSchema.js server/services/ops/__tests__/toolSchema.test.js
git commit -m "feat(chat): Vertex->Anthropic tool-schema translator"
```

---

## Task 4: Anthropic runtime (streaming tool loop)

**Files:**
- Create: `server/services/ops/agents/anthropicRuntime.js`
- Test: `server/services/ops/__tests__/anthropicRuntime.test.js`

**Interfaces:**
- Consumes: `priceFor` (Task 2), the existing `costTracker` (`createCostTracker()` → `.add(...)`, `.totalCents()`).
- Produces: `ensureAnthropic()`; `runClaudeToolLoop({ modelId, system, messages, tools, runTool, costTracker, maxHops = 8, onEvent })` → `{ status, text, proposedTool, hopsUsed, messages }`. `runTool(name, args)` returns `{ result }` or `{ __awaiting_approval: true, ... }` (same contract as the Vertex loop). `onEvent(evt)` receives `{type:'text',delta}`, `{type:'thinking',delta}`, `{type:'tool_use',name,input}`, `{type:'tool_result',name,result}`, `{type:'cost',summary}`. Consumed by Tasks 6, 8.

- [ ] **Step 1: Write the failing test** (mocks the SDK client — NO network; injects a fake client via the `__clientForTest` option)

```javascript
// server/services/ops/__tests__/anthropicRuntime.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ANTHROPIC_API_KEY = 'test-key';
const { runClaudeToolLoop } = await import('../agents/anthropicRuntime.js');

// Minimal fake of client.messages.stream(): returns an object whose
// finalMessage() resolves to a scripted assistant message. Each call to
// stream() pops the next scripted turn.
function fakeClient(turns) {
  let i = 0;
  return {
    messages: {
      stream() {
        const msg = turns[i++];
        return {
          async *[Symbol.asyncIterator]() { /* no deltas needed for this test */ },
          on() { return this; },
          finalMessage: async () => msg
        };
      }
    }
  };
}

function tracker() { let c = 0; return { add({ dollars = 0 }) { c += dollars; }, totalCents: () => Math.ceil(c * 100), summary: () => ({ total_cents: Math.ceil(c * 100) }) }; }

test('returns final text when the model stops with end_turn', async () => {
  const client = fakeClient([
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All good.' }], usage: { input_tokens: 10, output_tokens: 5 } }
  ]);
  const out = await runClaudeToolLoop({
    modelId: 'claude-haiku-4-5', system: 'sys', messages: [{ role: 'user', content: 'hi' }],
    tools: [], runTool: async () => ({ result: {} }), costTracker: tracker(), __clientForTest: client
  });
  assert.equal(out.status, 'final');
  assert.equal(out.text, 'All good.');
});

test('executes a read-only tool then finishes', async () => {
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'load_run', input: { runId: 'r1' } }], usage: { input_tokens: 8, output_tokens: 4 } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Run r1 looks healthy.' }], usage: { input_tokens: 12, output_tokens: 6 } }
  ]);
  let called = null;
  const out = await runClaudeToolLoop({
    modelId: 'claude-haiku-4-5', system: 'sys', messages: [{ role: 'user', content: 'check r1' }],
    tools: [{ name: 'load_run', description: 'x', input_schema: { type: 'object', properties: {} } }],
    runTool: async (name, args) => { called = { name, args }; return { result: { ok: true } }; },
    costTracker: tracker(), __clientForTest: client
  });
  assert.deepEqual(called, { name: 'load_run', args: { runId: 'r1' } });
  assert.equal(out.status, 'final');
  assert.equal(out.text, 'Run r1 looks healthy.');
});

test('pauses on an approval-gated tool', async () => {
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_2', name: 'propose_action', input: { tool: 'plugin_update' } }], usage: { input_tokens: 8, output_tokens: 4 } }
  ]);
  const out = await runClaudeToolLoop({
    modelId: 'claude-haiku-4-5', system: 'sys', messages: [{ role: 'user', content: 'update plugin' }],
    tools: [{ name: 'propose_action', description: 'x', input_schema: { type: 'object', properties: {} } }],
    runTool: async () => ({ __awaiting_approval: true, approval_id: 'a1' }),
    costTracker: tracker(), __clientForTest: client
  });
  assert.equal(out.status, 'awaiting_approval');
  assert.equal(out.proposedTool.name, 'propose_action');
});
```

- [ ] **Step 2: Run it (fails)** — `yarn test:ops` → FAIL (module missing).

- [ ] **Step 3: Implement `anthropicRuntime.js`**

```javascript
// server/services/ops/agents/anthropicRuntime.js
import Anthropic from '@anthropic-ai/sdk';
import { priceFor } from './models.js';

let cached = null;
export function ensureAnthropic() {
  if (cached) return cached;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  cached = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return cached;
}

const MAX_OUTPUT_TOKENS = 4096;

function usageDollars(modelId, usage = {}) {
  const p = priceFor(modelId);
  const inTok = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 0.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  const outTok = usage.output_tokens || 0;
  return (inTok / 1000) * p.inPer1k + (outTok / 1000) * p.outPer1k;
}

// Mark cache breakpoints on the system block and the last message block.
function withCaching(system, messages) {
  const sys = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  const msgs = messages.map((m) => ({ ...m }));
  const last = msgs[msgs.length - 1];
  if (last && Array.isArray(last.content) && last.content.length) {
    const c = last.content.map((b) => ({ ...b }));
    c[c.length - 1] = { ...c[c.length - 1], cache_control: { type: 'ephemeral' } };
    msgs[msgs.length - 1] = { ...last, content: c };
  }
  return { sys, msgs };
}

export async function runClaudeToolLoop({
  modelId,
  system,
  messages,
  tools = [],
  runTool,
  costTracker,
  maxHops = 8,
  onEvent = () => {},
  __clientForTest = null
}) {
  const client = __clientForTest || ensureAnthropic();

  for (let hop = 0; hop < maxHops; hop += 1) {
    const { sys, msgs } = withCaching(system, messages);
    const stream = client.messages.stream({
      model: modelId,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: sys,
      messages: msgs,
      tools,
      thinking: { type: 'adaptive', display: 'summarized' }
    });

    // Relay deltas (real SDK emits these; the test fake skips them).
    if (typeof stream.on === 'function') {
      stream.on('text', (delta) => onEvent({ type: 'text', delta }));
      stream.on('thinking', (delta) => onEvent({ type: 'thinking', delta }));
    }

    const message = await stream.finalMessage();
    costTracker.add({
      promptTokens: message.usage?.input_tokens || 0,
      completionTokens: message.usage?.output_tokens || 0,
      dollars: usageDollars(modelId, message.usage),
      source: `anthropic:${modelId}`
    });
    onEvent({ type: 'cost', summary: costTracker.summary() });

    // Persist the assistant turn into the running history (full blocks).
    messages.push({ role: 'assistant', content: message.content });

    if (message.stop_reason !== 'tool_use') {
      const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return { status: 'final', text, hopsUsed: hop + 1, messages };
    }

    // Execute all tool_use blocks; collect tool_result blocks for one user turn.
    const toolUses = (message.content || []).filter((b) => b.type === 'tool_use');
    const results = [];
    for (const tu of toolUses) {
      onEvent({ type: 'tool_use', name: tu.name, input: tu.input });
      let outcome;
      try {
        outcome = await runTool(tu.name, tu.input || {});
      } catch (err) {
        outcome = { result: { error: err.message || 'Tool error' } };
      }
      if (outcome?.__awaiting_approval) {
        return { status: 'awaiting_approval', proposedTool: { name: tu.name, input: tu.input || {}, ...outcome }, hopsUsed: hop + 1, messages };
      }
      const payload = outcome.result ?? outcome;
      onEvent({ type: 'tool_result', name: tu.name, result: payload });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(payload) });
    }
    messages.push({ role: 'user', content: results });
  }

  return { status: 'tool_loop_exhausted', text: 'Tool loop exceeded maximum hops.', hopsUsed: maxHops, messages };
}
```

- [ ] **Step 4: Run the tests (pass)** — `yarn test:ops` → the 3 anthropicRuntime tests PASS.

- [ ] **Step 5: Build + lint + commit**

```bash
yarn build && yarn lint
git add server/services/ops/agents/anthropicRuntime.js server/services/ops/__tests__/anthropicRuntime.test.js
git commit -m "feat(chat): Anthropic streaming tool loop runtime (manual loop, approval-aware)"
```

---

## Task 5: Chat persistence (migration + grants)

**Files:**
- Create: `server/sql/migrate_ops_chat.sql`
- Modify: `server/migrations.js`, `infra/sql/ops_app_role.sql`

- [ ] **Step 1: Write the migration**

```sql
-- Pro AI chat — persistent conversation threads + messages.
-- Stores full Anthropic content blocks for faithful replay. Idempotent.

CREATE TABLE IF NOT EXISTS ops_chat_threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_user_id UUID,
  created_by UUID NOT NULL,
  title TEXT,
  model_id TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  archived_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ops_chat_threads_client
  ON ops_chat_threads (client_user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS ops_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES ops_chat_threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content_json JSONB NOT NULL,
  usage_json JSONB,
  cost_cents NUMERIC(10,4) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_chat_messages_thread
  ON ops_chat_messages (thread_id, created_at);
```

- [ ] **Step 2: Register it** in `server/migrations.js` — append to `MIGRATIONS_BEFORE_SEED` after `'migrate_social_publishing.sql'`:

```javascript
  'migrate_social_publishing.sql',
  'migrate_ops_chat.sql'
];
```
> The two `ops_chat_*` tables match `ops\_%`, so the existing `ops_app_role.sql` loop already grants DML on them — but add an explicit block for clarity + so a fresh role provision covers them regardless of loop timing.

- [ ] **Step 3: Add explicit GRANT** in `infra/sql/ops_app_role.sql` after the `file_uploads` grant:

```sql
-- Pro AI chat tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON ops_chat_threads, ops_chat_messages TO ops_app;
```

- [ ] **Step 4: Run migrations locally (idempotent)**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
DATABASE_URL="postgresql://bif@localhost:5432/anchor" yarn db:migrate
DATABASE_URL="postgresql://bif@localhost:5432/anchor" yarn db:migrate
```
Expected: both runs complete with `[migrations] all ops migrations completed`; second run clean (CREATE ... IF NOT EXISTS).

- [ ] **Step 5: Build + lint + commit**

```bash
yarn build && yarn lint
git add server/sql/migrate_ops_chat.sql server/migrations.js infra/sql/ops_app_role.sql
git commit -m "feat(chat): ops_chat_threads/messages migration + ops_app grants"
```

---

## Task 6: Claude supervisor turn (thread persistence + tool reuse)

**Files:**
- Modify: `server/services/ops/agents/supervisor.js` (export the tool registry + a `makeRunTool` factory)
- Create: `server/services/ops/agents/claudeSupervisor.js`

**Interfaces:**
- Consumes: `runClaudeToolLoop` (Task 4), `toAnthropicTools` (Task 3), `resolveChatModel`/`SUBAGENT_MODEL` (Task 2), the existing supervisor tools + `executeApproval`/`rejectApproval`, `query`/`getClient` (`../../db.js`), `createCostTracker`.
- Produces: `runClaudeChatTurn({ clientUserId, userId, threadId, prompt, modelId, onEvent })` → `{ threadId, status, text, pendingApprovalId, costSummary, assistantMessageId }`; `loadThread(threadId)`, `listThreads(clientUserId)`, `createThread({...})`. Consumed by Task 8.

- [ ] **Step 1: Export reusable tool plumbing from `supervisor.js`**

In `supervisor.js`, locate where `SUPERVISOR_TOOLS` (the array of `{ declaration, handler }`) and the per-turn `runTool(name, args)` are built inside `runSupervisorTurn`. Refactor so they're reusable: add near the existing exports:

```javascript
// Reusable by the Claude runtime: the raw supervisor tool objects + a runTool factory.
export function getSupervisorTools() {
  return SUPERVISOR_TOOLS; // the existing array of { declaration, handler }
}

// Build a runTool(name,args) bound to one turn's context + costTracker.
export function makeSupervisorRunTool({ clientUserId, userId, costTracker, budgetCents = PER_TURN_BUDGET_CENTS }) {
  const ctx = { clientUserId, userId, budgetCents };
  return async function runTool(name, args) {
    const tool = SUPERVISOR_TOOLS.find((t) => t.declaration.name === name);
    if (!tool) return { result: { error: `Unknown tool: ${name}` } };
    return tool.handler({ args, ctx, costTracker });
  };
}
```
> If `SUPERVISOR_TOOLS` / `PER_TURN_BUDGET_CENTS` are local consts inside `runSupervisorTurn`, hoist them to module scope first (they don't depend on per-call state — the handlers already take `ctx`/`costTracker` as args). Preserve the existing `runSupervisorTurn` behavior unchanged. The `propose_action` handler already returns the `{ __awaiting_approval }`-style pause via the runtime — confirm its return triggers the loop's approval branch (it inserts the `ops_tool_approvals` row and the loop treats a `propose_action` result as awaiting approval; if the existing code signals this differently, mirror that signal here).

- [ ] **Step 2: Implement `claudeSupervisor.js`**

```javascript
// server/services/ops/agents/claudeSupervisor.js
import { query } from '../../db.js';
import { createCostTracker } from '../costTracker.js';
import { runClaudeToolLoop } from './anthropicRuntime.js';
import { toAnthropicTools } from './toolSchema.js';
import { resolveChatModel } from './models.js';
import { getSupervisorTools, makeSupervisorRunTool, buildSystemInstruction } from './supervisor.js';

// buildSystemInstruction: reuse the supervisor's system-prompt builder. If supervisor.js
// builds the system text inline, export a `buildSystemInstruction({ clientUserId })` from it
// that returns the same string (sans the Vertex { role, parts } wrapper).

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
     FROM ops_chat_threads WHERE archived_at IS NULL AND ($1::uuid IS NULL OR client_user_id = $1)
     ORDER BY updated_at DESC LIMIT 100`,
    [clientUserId || null]
  );
  return rows;
}

export async function loadThread(threadId) {
  const { rows: t } = await query(`SELECT * FROM ops_chat_threads WHERE id = $1`, [threadId]);
  if (!t[0]) return null;
  const { rows: msgs } = await query(
    `SELECT id, role, content_json, created_at FROM ops_chat_messages WHERE thread_id = $1 ORDER BY created_at`,
    [threadId]
  );
  return { thread: t[0], messages: msgs };
}

// Rebuild the Anthropic messages[] from persisted rows.
function historyToMessages(rows) {
  return rows.map((r) => ({ role: r.role, content: r.content_json }));
}

export async function runClaudeChatTurn({ clientUserId, userId, threadId, prompt, modelId, onEvent = () => {} }) {
  // Resolve / create the thread.
  let thread;
  if (threadId) {
    const loaded = await loadThread(threadId);
    if (!loaded) throw new Error('Thread not found');
    thread = loaded.thread;
  } else {
    thread = await createThread({ clientUserId, userId, modelId, title: prompt.slice(0, 60) });
  }
  const chosenModel = resolveChatModel(modelId || thread.model_id);

  // Build history (persisted) + append the new user turn.
  const priorRows = threadId ? (await loadThread(thread.id)).messages : [];
  const messages = historyToMessages(priorRows);
  const userContent = [{ type: 'text', text: String(prompt || '') }];
  messages.push({ role: 'user', content: userContent });

  // Persist the user message immediately.
  await query(
    `INSERT INTO ops_chat_messages (thread_id, role, content_json) VALUES ($1,'user',$2)`,
    [thread.id, JSON.stringify(userContent)]
  );

  const costTracker = createCostTracker();
  const tools = toAnthropicTools(getSupervisorTools());
  const runTool = makeSupervisorRunTool({ clientUserId: thread.client_user_id, userId, costTracker });
  const system = await buildSystemInstruction({ clientUserId: thread.client_user_id });

  const before = messages.length;
  const out = await runClaudeToolLoop({ modelId: chosenModel, system, messages, tools, runTool, costTracker, onEvent });

  // Persist every assistant/user(tool_result) message produced this turn.
  let lastAssistantId = null;
  for (let i = before; i < out.messages.length; i += 1) {
    const m = out.messages[i];
    const { rows } = await query(
      `INSERT INTO ops_chat_messages (thread_id, role, content_json, usage_json, cost_cents)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [thread.id, m.role, JSON.stringify(m.content), JSON.stringify(out.status === 'final' ? costTracker.summary() : null), costTracker.summary().total_cents / 100]
    );
    if (m.role === 'assistant') lastAssistantId = rows[0].id;
  }
  await query(`UPDATE ops_chat_threads SET updated_at = NOW(), model_id = $2 WHERE id = $1`, [thread.id, chosenModel]);

  let pendingApprovalId = null;
  if (out.status === 'awaiting_approval') {
    pendingApprovalId = out.proposedTool?.approval_id || null;
  }

  return { threadId: thread.id, status: out.status, text: out.text || '', pendingApprovalId, costSummary: costTracker.summary(), assistantMessageId: lastAssistantId };
}
```
> Cross-check the real `propose_action` handler return: this plan assumes it returns `{ __awaiting_approval: true, approval_id }`. If it returns `{ approval_id, status:'pending' }` without the flag, either (a) wrap it in `makeSupervisorRunTool` to add `__awaiting_approval: true` when `tool === propose_action`, or (b) mirror however `runSupervisorTurn` currently detects the pause. Confirm against `supervisor.js` and adjust this one spot.

- [ ] **Step 3: Build + lint** — `yarn build && yarn lint` → PASS (no route wiring yet; this is library code).

- [ ] **Step 4: Commit**

```bash
git add server/services/ops/agents/supervisor.js server/services/ops/agents/claudeSupervisor.js
git commit -m "feat(chat): Claude supervisor turn — thread persistence, reuses supervisor tools + approval"
```

---

## Task 7: SSE chat route + thread routes

**Files:**
- Modify: `server/routes/ops.js`

**Interfaces:**
- Consumes: `runClaudeChatTurn`, `listThreads`, `loadThread`, `createThread` (Task 6); existing `executeApproval`/`rejectApproval`, `chatRateLimit`, `requireAuth`/`requireAdmin`.

- [ ] **Step 1: Add imports** near the existing supervisor import in `ops.js`

```javascript
import { runClaudeChatTurn, listThreads, loadThread } from '../services/ops/agents/claudeSupervisor.js';
```

- [ ] **Step 2: Replace the `POST /chat` handler with an SSE streamer** (keep `chatRateLimit`)

```javascript
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
```

- [ ] **Step 3: Add thread routes** (after the chat route, before `/chat/approve`)

```javascript
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
```
> Leave `/chat/approve`, `/chat/reject`, `/chat/approvals/:id` exactly as they are (the approval flow is unchanged). They remain JSON.

- [ ] **Step 4: Build + lint + boot smoke**

```bash
yarn build && yarn lint
DATABASE_URL="postgresql://bif@localhost:5432/anchor" yarn server &
sleep 5
curl -s -o /dev/null -w "threads=%{http_code}\n" http://localhost:4000/api/ops/chat/threads   # expect 401 (admin-gated)
lsof -ti:4000 | xargs kill -9
```
Expected: boots; `/chat/threads` returns 401 (route mounted, behind requireAuth+requireAdmin).

- [ ] **Step 5: Commit**

```bash
git add server/routes/ops.js
git commit -m "feat(chat): SSE /chat stream + thread list/detail routes"
```

---

## Task 8: Frontend — streaming fetch helper + thread API

**Files:**
- Create: `src/api/opsChatStream.js`
- Modify: `src/api/ops.js`

**Interfaces:**
- Produces: `streamOpsChat({ clientUserId, threadId, prompt, modelId, signal, onEvent })` → Promise resolving to the `done` payload; `listOpsChatThreads(clientUserId)`, `getOpsChatThread(id)`. Consumed by Task 10.

- [ ] **Step 1: Implement the SSE fetch helper** (axios can't stream; use native `fetch` + the same auth token)

```javascript
// src/api/opsChatStream.js
import { getAccessToken } from './tokenStore';

const API_BASE = import.meta.env.VITE_APP_API_BASE || '/api';

// POST /ops/chat and parse the SSE stream. Calls onEvent({type, ...}) per frame.
// Resolves with the `done` payload; rejects on `error` frame or network failure.
export async function streamOpsChat({ clientUserId, threadId, prompt, modelId, signal, onEvent }) {
  const token = getAccessToken();
  const resp = await fetch(`${API_BASE}/ops/chat`, {
    method: 'POST',
    credentials: 'include',
    signal,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ client_user_id: clientUserId || null, thread_id: threadId || null, prompt, model_id: modelId || null })
  });
  if (!resp.ok || !resp.body) {
    let msg = `Chat failed (${resp.status})`;
    try { msg = (await resp.json()).message || msg; } catch { /* not json */ }
    throw new Error(msg);
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = null;
  let errored = null;

  // SSE frames are separated by a blank line; each frame has `event:` + `data:` lines.
  const handleFrame = (frame) => {
    const lines = frame.split('\n');
    let event = 'message';
    let data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data) return;
    const payload = JSON.parse(data);
    if (event === 'done') done = payload;
    else if (event === 'error') errored = new Error(payload.message || 'Chat failed');
    else onEvent({ type: event, ...payload });
  };

  for (;;) {
    const { value, done: streamDone } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (frame.trim()) handleFrame(frame);
    }
  }
  if (errored) throw errored;
  return done;
}
```

- [ ] **Step 2: Add thread API fns to `src/api/ops.js`** (keep the existing approve/reject fns)

```javascript
export const listOpsChatThreads = (clientUserId) =>
  client.get('/ops/chat/threads', { params: clientUserId ? { clientUserId } : {} }).then((res) => res.data.threads || []);

export const getOpsChatThread = (threadId) =>
  client.get(`/ops/chat/threads/${threadId}`).then((res) => res.data);
```
> The old `sendOpsChat` is superseded by `streamOpsChat`; remove `sendOpsChat` only after Task 10 stops importing it (do it in Task 10's commit to avoid a broken intermediate build).

- [ ] **Step 3: Build + lint + commit**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
yarn build && yarn lint
git add src/api/opsChatStream.js src/api/ops.js
git commit -m "feat(chat): SSE streaming fetch helper + thread API"
```

---

## Task 9: Markdown renderer component

**Files:**
- Create: `src/ui-component/extended/Markdown.jsx`

**Interfaces:**
- Produces: default `Markdown` component, props `{ children: string }`. Consumed by Task 10.

- [ ] **Step 1: Implement** (react-markdown sanitizes by default — it does NOT render raw HTML; safe for streamed model text)

```jsx
// src/ui-component/extended/Markdown.jsx
import ReactMarkdown from 'react-markdown';
import { Box } from '@mui/material';

// Renders assistant markdown. react-markdown does not render raw HTML by default
// (no rehype-raw), so model output cannot inject markup.
export default function Markdown({ children }) {
  return (
    <Box
      sx={{
        '& p': { m: 0, mb: 1 },
        '& p:last-child': { mb: 0 },
        '& ul, & ol': { my: 1, pl: 3 },
        '& code': { px: 0.5, py: 0.1, bgcolor: 'grey.100', borderRadius: 0.5, fontSize: '0.85em' },
        '& pre': { p: 1.5, bgcolor: 'grey.900', color: 'grey.100', borderRadius: 1, overflow: 'auto' },
        '& pre code': { bgcolor: 'transparent', color: 'inherit', p: 0 },
        '& table': { borderCollapse: 'collapse', my: 1 },
        '& th, & td': { border: '1px solid', borderColor: 'divider', px: 1, py: 0.5 },
        '& a': { color: 'primary.main' }
      }}
    >
      <ReactMarkdown>{children || ''}</ReactMarkdown>
    </Box>
  );
}
```

- [ ] **Step 2: Build + lint + commit**

```bash
yarn build && yarn lint
git add src/ui-component/extended/Markdown.jsx
git commit -m "feat(chat): safe markdown renderer component"
```

---

## Task 10: Rebuild the chat UI

**Files:**
- Create: `src/views/admin/Operations/Chat/ThreadSidebar.jsx`
- Modify (rebuild): `src/views/admin/Operations/Chat/ClientChat.jsx`
- Keep: `src/views/admin/Operations/Chat/ApprovalDialog.jsx`

**Interfaces:**
- Consumes: `streamOpsChat` (Task 8), `listOpsChatThreads`/`getOpsChatThread`/`listOpsClients`/`approveOpsChatAction`/`rejectOpsChatAction` (api/ops), `Markdown` (Task 9), `useToast`, `clientLabel` (`../_clientLabel`), `CLAUDE_MODELS` list (inline the 3 ids — Haiku/Sonnet/Opus), `ApprovalDialog`.

- [ ] **Step 1: Build `ThreadSidebar.jsx`**

```jsx
// src/views/admin/Operations/Chat/ThreadSidebar.jsx
import { List, ListItemButton, ListItemText, Button, Stack, Typography } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';

export default function ThreadSidebar({ threads, activeId, onSelect, onNew }) {
  return (
    <Stack spacing={1} sx={{ width: 240, borderRight: '1px solid', borderColor: 'divider', pr: 1, height: '100%' }}>
      <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={onNew}>New chat</Button>
      <List dense sx={{ overflowY: 'auto' }}>
        {threads.map((t) => (
          <ListItemButton key={t.id} selected={t.id === activeId} onClick={() => onSelect(t.id)}>
            <ListItemText primary={t.title || 'Untitled'} primaryTypographyProps={{ noWrap: true, variant: 'body2' }} />
          </ListItemButton>
        ))}
        {!threads.length && <Typography variant="caption" sx={{ p: 1, color: 'text.secondary' }}>No conversations yet.</Typography>}
      </List>
    </Stack>
  );
}
```

- [ ] **Step 2: Rebuild `ClientChat.jsx`** (streaming consumer, markdown, model dropdown, thinking, inline tool cards, stop). Full component:

```jsx
// src/views/admin/Operations/Chat/ClientChat.jsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Stack, Box, Paper, Autocomplete, TextField, Select, MenuItem, IconButton, Typography, Chip, Collapse, Button } from '@mui/material';
import SendIcon from '@mui/icons-material/Send';
import StopIcon from '@mui/icons-material/Stop';
import { useToast } from 'contexts/ToastContext';
import { listOpsClients, listOpsChatThreads, getOpsChatThread, approveOpsChatAction, rejectOpsChatAction } from 'api/ops';
import { streamOpsChat } from 'api/opsChatStream';
import { clientLabel } from '../_clientLabel';
import Markdown from 'ui-component/extended/Markdown';
import ThreadSidebar from './ThreadSidebar';
import ApprovalDialog from './ApprovalDialog';

const MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (fast)' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (deep)' }
];

// Flatten persisted Anthropic content blocks into render rows.
function rowsFromMessages(messages) {
  const rows = [];
  for (const m of messages) {
    const blocks = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content || '') }];
    for (const b of blocks) {
      if (b.type === 'text') rows.push({ kind: 'text', role: m.role, text: b.text });
      else if (b.type === 'thinking') rows.push({ kind: 'thinking', text: b.thinking || '' });
      else if (b.type === 'tool_use') rows.push({ kind: 'tool_use', name: b.name, input: b.input });
      else if (b.type === 'tool_result') rows.push({ kind: 'tool_result', text: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
    }
  }
  return rows;
}

export default function ClientChat({ initialClientUserId }) {
  const toast = useToast();
  const [clients, setClients] = useState([]);
  const [client, setClient] = useState(null);
  const [threads, setThreads] = useState([]);
  const [threadId, setThreadId] = useState(null);
  const [model, setModel] = useState('claude-sonnet-4-6');
  const [rows, setRows] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamThinking, setStreamThinking] = useState('');
  const [streamTools, setStreamTools] = useState([]);
  const [pendingApproval, setPendingApproval] = useState(null);
  const [cost, setCost] = useState(null);
  const abortRef = useRef(null);
  const scrollRef = useRef(null);

  useEffect(() => { listOpsClients().then(setClients).catch(() => {}); }, []);
  useEffect(() => {
    if (initialClientUserId && clients.length) setClient(clients.find((c) => c.id === initialClientUserId) || null);
  }, [initialClientUserId, clients]);
  const refreshThreads = useCallback(() => {
    listOpsChatThreads(client?.id).then(setThreads).catch(() => {});
  }, [client]);
  useEffect(() => { refreshThreads(); }, [refreshThreads]);
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [rows, streamText, streamThinking, streamTools]);

  const openThread = useCallback(async (id) => {
    setThreadId(id);
    setStreamText(''); setStreamThinking(''); setStreamTools([]);
    if (!id) { setRows([]); return; }
    try {
      const data = await getOpsChatThread(id);
      setRows(rowsFromMessages((data.messages || []).map((r) => ({ role: r.role, content: r.content_json }))));
      if (data.thread?.model_id) setModel(data.thread.model_id);
    } catch (e) { toast.error('Could not load conversation'); }
  }, [toast]);

  const newChat = useCallback(() => { setThreadId(null); setRows([]); setStreamText(''); setStreamThinking(''); setStreamTools([]); }, []);

  const send = useCallback(async () => {
    const text = prompt.trim();
    if (!text) return;
    if (!client) { toast.warning('Pick a client first'); return; }
    setBusy(true);
    setRows((r) => [...r, { kind: 'text', role: 'user', text }]);
    setPrompt(''); setStreamText(''); setStreamThinking(''); setStreamTools([]);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const done = await streamOpsChat({
        clientUserId: client.id, threadId, prompt: text, modelId: model, signal: controller.signal,
        onEvent: (evt) => {
          if (evt.type === 'text') setStreamText((s) => s + (evt.delta || ''));
          else if (evt.type === 'thinking') setStreamThinking((s) => s + (evt.delta || ''));
          else if (evt.type === 'tool_use') setStreamTools((t) => [...t, { name: evt.name, input: evt.input, state: 'running' }]);
          else if (evt.type === 'tool_result') setStreamTools((t) => t.map((x, i) => (i === t.length - 1 ? { ...x, state: 'done', result: evt.result } : x)));
          else if (evt.type === 'cost') setCost(evt.summary);
        }
      });
      // Reconcile: reload the thread so persisted blocks render canonically.
      if (done?.threadId) { setThreadId(done.threadId); await openThread(done.threadId); refreshThreads(); }
      if (done?.pendingApproval) setPendingApproval(done.pendingApproval);
      if (done?.costSummary) setCost(done.costSummary);
      if (done?.status === 'budget_exhausted') toast.warning('Per-turn budget hit — split the question');
    } catch (e) {
      if (e.name === 'AbortError') toast.info('Stopped');
      else toast.error(e.message || 'Chat failed');
    } finally {
      setBusy(false); abortRef.current = null;
      setStreamText(''); setStreamThinking(''); setStreamTools([]);
    }
  }, [prompt, client, threadId, model, toast, openThread, refreshThreads]);

  const stop = useCallback(() => { abortRef.current?.abort(); }, []);

  const handleApprove = useCallback(async (id) => {
    try { await approveOpsChatAction(id); setPendingApproval(null); if (threadId) await openThread(threadId); }
    catch (e) { toast.error('Approval failed'); }
  }, [threadId, openThread, toast]);
  const handleReject = useCallback(async (id) => {
    try { await rejectOpsChatAction(id); setPendingApproval(null); if (threadId) await openThread(threadId); }
    catch (e) { toast.error('Reject failed'); }
  }, [threadId, openThread, toast]);

  const allRows = useMemo(() => {
    const live = [];
    if (streamThinking) live.push({ kind: 'thinking', text: streamThinking });
    streamTools.forEach((t) => live.push({ kind: 'tool_use', name: t.name, input: t.input, state: t.state, result: t.result }));
    if (streamText) live.push({ kind: 'text', role: 'assistant', text: streamText });
    return [...rows, ...live];
  }, [rows, streamText, streamThinking, streamTools]);

  return (
    <Stack direction="row" spacing={2} sx={{ height: '70vh' }}>
      <ThreadSidebar threads={threads} activeId={threadId} onSelect={openThread} onNew={newChat} />
      <Stack spacing={1} sx={{ flex: 1, minWidth: 0 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Autocomplete sx={{ flex: 1 }} size="small" options={clients} value={client}
            getOptionLabel={(c) => clientLabel(c)} onChange={(_, v) => { setClient(v); newChat(); }}
            renderInput={(p) => <TextField {...p} label="Client" />} />
          <Select size="small" value={model} onChange={(e) => setModel(e.target.value)} sx={{ minWidth: 200 }}>
            {MODELS.map((m) => <MenuItem key={m.id} value={m.id}>{m.label}</MenuItem>)}
          </Select>
        </Stack>

        <Box ref={scrollRef} sx={{ flex: 1, overflowY: 'auto', p: 1, bgcolor: 'grey.50', borderRadius: 1 }}>
          {allRows.map((row, i) => {
            if (row.kind === 'text') return (
              <Paper key={i} sx={{ p: 1.5, mb: 1, maxWidth: '85%', ml: row.role === 'user' ? 'auto' : 0, bgcolor: row.role === 'user' ? 'primary.lighter' : 'background.paper' }}>
                {row.role === 'user' ? <Typography sx={{ whiteSpace: 'pre-wrap' }}>{row.text}</Typography> : <Markdown>{row.text}</Markdown>}
              </Paper>
            );
            if (row.kind === 'thinking') return (
              <Box key={i} sx={{ mb: 1 }}>
                <Chip size="small" label="thinking" sx={{ mb: 0.5 }} />
                <Typography variant="caption" sx={{ display: 'block', whiteSpace: 'pre-wrap', color: 'text.secondary', pl: 1 }}>{row.text}</Typography>
              </Box>
            );
            if (row.kind === 'tool_use') return (
              <Paper key={i} variant="outlined" sx={{ p: 1, mb: 1, bgcolor: 'grey.100' }}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip size="small" color={row.state === 'done' ? 'success' : 'info'} label={row.name} />
                  <Typography variant="caption" sx={{ color: 'text.secondary' }}>{JSON.stringify(row.input)}</Typography>
                </Stack>
                {row.result != null && (
                  <Box component="pre" sx={{ mt: 0.5, m: 0, fontSize: '0.75rem', whiteSpace: 'pre-wrap', maxHeight: 180, overflow: 'auto' }}>
                    {typeof row.result === 'string' ? row.result : JSON.stringify(row.result, null, 2)}
                  </Box>
                )}
              </Paper>
            );
            return null; // tool_result is shown inline on the tool_use card
          })}
        </Box>

        {cost && <Typography variant="caption" sx={{ color: 'text.secondary' }}>This turn: {cost.total_cents}¢ · {cost.total_tokens} tokens</Typography>}

        <Stack direction="row" spacing={1} alignItems="flex-end">
          <TextField fullWidth multiline minRows={1} maxRows={6} size="small" placeholder="Ask about this client…"
            value={prompt} onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); send(); } }} />
          {busy
            ? <Button color="warning" variant="outlined" startIcon={<StopIcon />} onClick={stop}>Stop</Button>
            : <Button variant="contained" endIcon={<SendIcon />} disabled={!client || !prompt.trim()} onClick={send}>Send</Button>}
        </Stack>
      </Stack>

      <ApprovalDialog open={Boolean(pendingApproval)} approval={pendingApproval}
        onApprove={handleApprove} onReject={handleReject} onDismiss={() => setPendingApproval(null)} />
    </Stack>
  );
}
```
> Cross-check `ApprovalDialog`'s prop names against the kept file (`open`, `approval`, `onApprove`, `onReject`, `onDismiss`) — they match the current usage. `clientLabel` import path is `../_clientLabel` (same as the old ClientChat). Remove the now-unused `sendOpsChat` export from `src/api/ops.js` in this commit (nothing imports it anymore).

- [ ] **Step 3: Build + lint**

```bash
yarn build && yarn lint
```
Expected: PASS (the Chat tab compiles; `react-markdown` resolves).

- [ ] **Step 4: Commit**

```bash
git add src/views/admin/Operations/Chat/ClientChat.jsx src/views/admin/Operations/Chat/ThreadSidebar.jsx src/api/ops.js
git commit -m "feat(chat): rebuilt streaming chat UI (threads, markdown, thinking, tool cards, model switch, stop)"
```

---

## Task 11: Tab label + final verification

**Files:**
- Modify: `src/views/admin/Operations/index.jsx`

- [ ] **Step 1: Rename the tab label** — in `WORKSPACE_TABS`, change the `agent` entry's label from `Agent` to `Chat` (keep `value: 'agent'` so existing `?tab=agent` links work). The `<TabPanel value="agent"><ClientChat .../></TabPanel>` stays as-is.

```javascript
{ value: 'agent', label: 'Chat', Icon: ChatIcon },
```

- [ ] **Step 2: Build + lint** — `yarn build && yarn lint` → PASS.

- [ ] **Step 3: Local end-to-end (automatable parts)**

```bash
DATABASE_URL="postgresql://bif@localhost:5432/anchor" ANTHROPIC_API_KEY="<a real key or skip live>" yarn server &
sleep 5
curl -s -o /dev/null -w "threads=%{http_code}\n" http://localhost:4000/api/ops/chat/threads   # 401 (gated)
lsof -ti:4000 | xargs kill -9
```
- `yarn test:ops` → models/toolSchema/anthropicRuntime tests pass.
- `yarn db:migrate` (inline DATABASE_URL) → idempotent.

- [ ] **Step 4: HUMAN verification (cannot run here)** — note in the PR for the user to do:
  - Open `/operations?tab=agent`, pick a client, send a message → **streaming** text renders live; markdown formats; **thinking** shows; a **tool call** card shows its result inline.
  - Switch the **model dropdown** to Opus → next turn uses it (persisted on the thread).
  - **Stop** mid-stream aborts. **New chat** + reload → threads persist and reopen with full history.
  - A mutation proposal surfaces the **ApprovalDialog**; approve → executes + audits (`ops_tool_approvals`).
  - Cost readout matches `usage`.

- [ ] **Step 5: Compliance + commit**
  - Consult `compliance-auditor` on the `ops_chat_messages` store (persists conversation + tool results; no PHI by design, but confirm retention/audit expectations).

```bash
git add src/views/admin/Operations/index.jsx
git commit -m "feat(chat): rename Agent tab to Chat"
```

- [ ] **Step 6: Push + PR (deploy gate)**

```bash
git push -u origin feat/pro-ai-chat
gh pr create --title "feat(chat): professional Claude-powered AI chat" \
  --body "Streaming, persistent, Claude-powered chat replacing the Gemini Agent tab. Requires: ANTHROPIC_API_KEY mapped on anchor-ops (in gdeploy.sh secrets), ops_chat_* migration run as admin at deploy (RUN_MIGRATIONS_ON_START=false), ops_app GRANT applied. Human verify: streaming/thinking/tool-cards/model-switch/threads/approval (see plan Task 11). compliance-auditor consulted on the message store."
```
> **Deploy note:** unlike the shared social tables, `ops_chat_*` are net-new — the migration MUST be run against prod (admin) since `RUN_MIGRATIONS_ON_START=false`. Apply the `ops_app` GRANT too.

---

## Self-Review

**Spec coverage** (against `2026-06-24-pro-ai-chat-design.md`):
- §3.1 Anthropic runtime (streaming, adaptive thinking, manual loop, prompt caching, cost) → Tasks 4 (+caching in `withCaching`, cost in `usageDollars`). ✓
- §3.2 model policy (tiered + switchable) → Task 2 + UI dropdown Task 10. ✓
- §3.3 SSE protocol → Task 7 (route) + Task 8 (client parser). ✓
- §3.4 persistence (threads/messages, full blocks) → Task 5 + Task 6. ✓
- §3.5 rebuilt UI (sidebar, streaming markdown, thinking, inline tool results, stop, model dropdown, cost) → Tasks 9–11. ✓
- §4 compliance (no PHI gate; approval preserved; secrets) → preserved (approval handlers untouched; Task 11 compliance consult). ✓
- §5 secrets/deps → Task 1; migration deploy note Task 11. ✓
- §7 verification → unit tests (Tasks 2–4), migrate/boot (5,7,11), human checks (11). ✓
- §8 open items → addressed: SDK stream shape (Task 4 uses `stream.on`/`finalMessage`), sub-agents stay reachable via existing handlers (Haiku via SUBAGENT_MODEL — wire into `delegate_to` is a follow-up; supervisor delegate still works), markdown via react-markdown (Task 9), cost caps (constants surfaced; resizing is a config change), regenerate deferred (YAGNI — `newChat`/stop cover the core; note in PR).

**Placeholder scan:** No "TBD"/"handle errors"/"similar to". The `>` notes are concrete verification guards (confirm a return shape, a prop name) — Task 6 Step 1 flags the one real integration uncertainty (`propose_action` pause signal) with the exact spot to reconcile, not a deferral.

**Type/name consistency:** `runClaudeToolLoop` signature (Task 4) matches its callers (Task 6); `streamOpsChat`/`onEvent` event shapes (Task 8) match what the route emits (Task 7) and what the runtime's `onEvent` produces (Task 4: text/thinking/tool_use/tool_result/cost); `resolveChatModel`/`priceFor` (Task 2) used in 4/6; thread API names (`listOpsChatThreads`/`getOpsChatThread`) consistent across 7/8/10.

**Known residual risks (flagged, not hidden):**
- `propose_action` pause-signal shape (Task 6 Step 1 note) — the one spot to verify against `supervisor.js`.
- `buildSystemInstruction` export from `supervisor.js` (Task 6) — if the supervisor builds its system text inline, it must be extracted into that exported helper; Task 6 Step 1 calls this out.
- Sub-agent model: `delegate_to` still runs sub-agents on Vertex/Gemini (unchanged); moving them to Haiku is a clean follow-up, not required for the chat to work.
