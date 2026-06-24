# Professional AI Chat — Design (anchor-operations)

**Date:** 2026-06-24
**Status:** Design / spec. Next step → implementation plan.
**Home:** `anchor-operations` (the ops command center "Agent" tab → rebuilt "Chat").
**Relation to content suite:** This is a standalone sub-project, sequenced BEFORE content sub-project B. The content brain (D) and B's AI authoring both ride on this chat. Parent context: `docs/superpowers/specs/2026-06-23-content-marketing-vision.md`.

---

## 1. Goal & non-goals

**Goal:** Turn the basic, single-turn Vertex/Gemini "Agent" chat into a **professional-grade, Claude-powered conversational interface** — streaming, persistent, richly rendered, with visible tool steps — while preserving the existing approval-gate and cost-cap governance.

**Non-goals:**
- Not rebuilding the automated check/run engine (the deterministic `website`/`google_ads`/`meta` checks stay as-is; only the *interactive AI* surface changes).
- Not removing Vertex/Gemini — it stays for the non-chat automated work; the new Anthropic runtime sits alongside it.
- Not the content suite itself (B/C/D) — those are separate specs that consume this chat.
- No managed-agents / hosted-container surface — we host the loop ourselves (we need the approval gate + custom tools).

---

## 2. Current state (verified)

- **Frontend** (`src/views/admin/Operations/Chat/ClientChat.jsx`, `ApprovalDialog.jsx`): plain-text rendering (no markdown), **no streaming**, **ephemeral** history (lost on reload / client switch), tool calls shown only as a status chip (no inline results), no stop/regenerate, locked to per-client. **PARTIAL.**
- **Endpoint** (`server/routes/ops.js` `POST /api/ops/chat` + `/chat/approve` + `/chat/reject`): single request/response (no streaming); accepts `{ client_user_id, prompt, history, model_id }`; returns `{ messages, status, text, pendingApproval, costSummary }`. Already supports a `model_id` override. **MATURE (non-streaming).**
- **Agent loop** (`server/services/ops/agents/supervisor.js`, `vertexRuntime.js`): Vertex Gemini 2.5 Flash, 8-hop tool loop, supervisor tools (`load_run`, `drill_into`, `delegate_to`, `propose_action`) + sub-agents (website / googleAds / meta / ctm), shared **50¢/turn** budget, stateless multi-turn (history passed in/out). **MATURE.**
- **Approval** (`ops_tool_approvals` table): `propose_action` → pending row → `/chat/approve` → `executeApproval` → tool runs → audit events. **MATURE — preserve.**
- **Persistence of conversations:** **ABSENT** — no chat thread/message tables.
- **No Anthropic/Claude usage anywhere** in ops today. `ANTHROPIC_API_KEY` exists in Secret Manager; ops's SA (`333281424614-compute@`) has project-level `secretmanager.secretAccessor`.

---

## 3. Architecture

```
Operations/Chat (rebuilt)               server/routes/ops.js
  thread sidebar                          POST /api/ops/chat        (SSE stream)
  streaming markdown                      POST /api/ops/chat/approve
  thinking (collapsible)                  POST /api/ops/chat/reject
  inline tool-step results                GET  /api/ops/chat/threads (+ /:id messages)
  model dropdown (Haiku/Sonnet/Opus)              │
  stop / regenerate                               ▼
        │  SSE events                    supervisor.js (model-agnostic orchestration)
        ▼                                   ├── anthropicRuntime.js  (NEW — Claude)
  ops_chat_threads / ops_chat_messages     └── vertexRuntime.js     (kept — Gemini, non-chat)
  (persisted Claude content blocks)        tools: load_run, drill_into, delegate_to,
                                                  propose_action  → ops_tool_approvals
```

### 3.1 Anthropic runtime (new) — `server/services/ops/agents/anthropicRuntime.js`
- Official **`@anthropic-ai/sdk`** first-party client (`new Anthropic()` reads `ANTHROPIC_API_KEY` from env). New dependency; commit `yarn.lock`.
- **Streaming** via `client.messages.stream(...)`; surface deltas to the route as they arrive.
- **Adaptive thinking**: `thinking: { type: 'adaptive', display: 'summarized' }` (display summarized so reasoning is visible; default is omitted/empty). No `budget_tokens`, no `temperature/top_p/top_k` (all 400 on the 4.x family).
- **Manual agentic tool loop** (NOT the SDK tool-runner) — we need the human-in-the-loop approval gate and custom rendering. Loop: stream a turn → collect `tool_use` blocks → for read-only tools, execute and append `tool_result` blocks (all in ONE user message) → continue; for `propose_action`, write the pending approval and pause the turn. Cap hops (mirror the existing 8).
- **Prompt caching**: `cache_control: { type: 'ephemeral' }` on the last system block (caches `tools` + `system` prefix) and on the last block of the most-recent turn for multi-turn reuse. Keep the system prompt + tool list byte-stable (no timestamps/UUIDs in the prefix) so `cache_read_input_tokens > 0`.
- **Cost**: read real `usage` (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) per turn; price per the model's rate (table below); accumulate into the existing `costTracker` shape so the Cost tab + monthly caps keep working.

`vertexRuntime.js` is untouched and remains the runtime for non-chat automated work.

### 3.2 Model policy (tiered + user-switchable)
A small registry maps a *role* to a default Claude model; the chat UI exposes a dropdown to override per conversation (the endpoint already takes `model_id`). Exact model IDs (no date suffixes):

| Role | Default model | Why | $/Mtok (in/out) |
|---|---|---|---|
| Sub-agents / directed "look for exactly X" tasks | `claude-haiku-4-5` | Cheap; ample for hardcoded directives | $1 / $5 |
| Interactive supervisor chat (default) | `claude-sonnet-4-6` | Strong tool-use + streaming, ~½ Opus cost | $3 / $15 |
| Hard strategy / planning (opt-in via dropdown) | `claude-opus-4-8` | Best reasoning for the hard problems | $5 / $25 |

The dropdown offers Haiku / Sonnet / Opus for the supervisor; the chosen model is persisted on the thread. Cache reads bill ~0.1×, writes ~1.25× (5-min TTL) — material at these prices, hence the prefix-caching requirement above.

### 3.3 Streaming protocol (route ↔ browser)
`POST /api/ops/chat` switches from JSON to **SSE** (or chunked). Event types relayed to the client (derived from the SDK stream): `text` deltas, `thinking` deltas, `tool_step` (start/result of each tool call, with the result payload), `cost` (running usage), `approval_required` (pending `ops_tool_approvals` id), and `done` (final status + persisted message id). The browser renders incrementally and can **abort** the fetch to stop generation.

### 3.4 Persistence (new tables)
- `ops_chat_threads`: `id` (uuid pk), `client_user_id` (uuid, nullable for general mode — see §6), `created_by` (uuid), `title` (text), `model_id` (text), `created_at`, `updated_at`, `archived_at`.
- `ops_chat_messages`: `id` (uuid pk), `thread_id` (fk), `role` (`user|assistant`), `content_json` (jsonb — the full Claude content blocks, incl. thinking/tool_use/tool_result, for faithful replay), `usage_json` (jsonb), `cost_cents` (numeric), `created_at`.
- Migration `migrate_ops_chat.sql` registered in `server/migrations.js`; `ops_app` GRANT on both tables (additive block in `infra/sql/ops_app_role.sql`).
- On each turn the route persists the user message and the assembled assistant message (content blocks) so reload/resume replays exactly. Thread list + per-thread message fetch via new `GET /api/ops/chat/threads` and `GET /api/ops/chat/threads/:id`.

### 3.5 Rebuilt chat UI — `src/views/admin/Operations/Chat/`
- **Thread sidebar**: list (most-recent first), new chat, switch, rename, archive. Loads from the threads API.
- **Streaming markdown**: render assistant text as markdown (add a lightweight renderer, e.g. `react-markdown`) updated live from the stream.
- **Thinking blocks**: collapsible, rendered from `thinking` deltas (summarized).
- **Tool steps**: each tool call shown as a card with its name, args, and **inline result** (not just a status chip); approvals still surface the `ApprovalDialog`.
- **Controls**: **model dropdown** (Haiku/Sonnet/Opus), **Stop** (abort the stream), **Regenerate** (re-run the last user turn), per-turn **cost/token** readout, Cmd/Ctrl+Enter to send.
- Keep per-client selection; persisted threads survive reload.

---

## 4. Compliance posture

**This ops application handles no PHI by design** (confirmed 2026-06-24). It connects only to Google Ads (BAA in place), Facebook/Meta (no direct person capture), and client websites (lead forms post to the *separate* HIPAA-compliant dashboard, not here). Therefore:
- **No medical/PHI gate** on the Claude chat — all clients use it. (Contrast: the content suite's Meta-for-medical gate exists because Meta CAPI relays conversions; that does not apply to this conversational tool.)
- **Approval gate preserved**: every mutation still routes through `ops_tool_approvals` + the four security events (`tool_proposed/approved/executed/rejected`). The chat can *propose* live actions; a human still approves.
- **Secrets**: `ANTHROPIC_API_KEY` mapped onto the service (it's in Secret Manager; SA has access) — add to `gdeploy.sh`'s secret set. No new IAM grant needed.
- **No secrets in prompts**: never place credentials/tokens in the system prompt or messages (persisted in `ops_chat_messages`).
- Consult `compliance-auditor` on the new `ops_chat_messages` store (it persists conversation content + tool results) before merge, to confirm retention/audit expectations — even though no PHI is involved.

---

## 5. Secrets / infra / deps

| Item | Action |
|---|---|
| `@anthropic-ai/sdk` | `yarn add`; commit `yarn.lock` (CI is `--immutable`) |
| `ANTHROPIC_API_KEY` | Add to `scripts/gdeploy.sh` `--update-secrets` set (exists in Secret Manager; SA can read) |
| Migration | Register `migrate_ops_chat.sql`; `ops_app` GRANT on the 2 new tables |
| `.env.example` | Document `ANTHROPIC_API_KEY` (+ optional `OPS_CHAT_DEFAULT_MODEL`) |

`RUN_MIGRATIONS_ON_START=false` in prod — the new tables get created by running ops migrations as admin at deploy (the chat tables are net-new, so this DOES need to run, unlike the shared social tables). Note this in the plan.

---

## 6. Scope decision

Default **per-client** (pick a client; chat scoped to them) — preserved from today. A **general ops mode** (no client) is allowed by the nullable `client_user_id` on `ops_chat_threads` but the UI for it is deferred to a follow-up (YAGNI now). The data model supports it without rework.

---

## 7. Verification (no UI test suite)

- `yarn build` + `yarn lint` green.
- Unit test (fits `yarn test:ops`, DB-free): the Claude tool-loop's parsing of a streamed tool_use → tool_result round-trip against a mocked SDK stream (no network).
- `yarn db:migrate` (inline `DATABASE_URL`) creates `ops_chat_threads`/`ops_chat_messages`; idempotent on re-run.
- Server boots; `POST /api/ops/chat` streams (curl with an auth token against a test client returns SSE frames); a read-only tool round-trips; `propose_action` surfaces an approval; approve executes + audits.
- Browser pass (human): streaming renders live, markdown + thinking + inline tool results show, model dropdown switches, stop aborts, reload resumes a thread, cost readout matches `usage`.
- `compliance-auditor` consulted on the message store before merge.

---

## 8. Open items to resolve in the plan

- Exact SDK stream event shape to map to our SSE events (from the `@anthropic-ai/sdk` streaming helpers) — confirm against the installed version.
- Whether to keep sub-agents on Gemini or move them to Haiku for one coherent stack (plan picks Haiku for the chat-invoked sub-agents; Gemini stays for non-chat checks).
- Markdown renderer choice (`react-markdown` vs the existing CKEditor read-mode) + safe rendering (no raw HTML injection).
- Resized cost-cap defaults per model (the monthly cap UI already exists; just new numbers/comments).
- How `regenerate` interacts with persisted messages (drop the last assistant message + re-stream).
