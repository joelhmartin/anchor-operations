# Task 6 Report — Claude supervisor turn

## supervisor.js exports added (verbatim)

```javascript
export function getSupervisorTools() {
  return Object.values(SUPERVISOR_TOOLS);
}

export function makeSupervisorRunTool({
  clientUserId, userId, costTracker,
  budgetCents = PER_TURN_BUDGET_CENTS
}) {
  const ctx = { clientUserId, userId, budgetCents };
  return async function runTool(name, args) {
    const tool = SUPERVISOR_TOOLS[name];
    if (!tool) return { error: `Unknown tool: ${name}` };
    const result = await tool.handler({ args, ctx, costTracker });
    if (name === 'propose_action' && result?.approval_id) {
      return { __awaiting_approval: true, approval_id: result.approval_id, ...result };
    }
    return result;
  };
}

export async function buildSystemInstruction({ clientUserId }) {
  const ctxData = await loadRecentRunsContext(clientUserId);
  return `${SUPERVISOR_SYSTEM}\n\n${buildContextPreamble({ clientUserId, runs: ctxData.runs })}`;
}
```

## Reconciliation notes

### propose_action approval signal
The real handler returns `{ approval_id, status: 'pending', message }` — no flag. Vertex path detects via `if (name === 'propose_action' && result?.approval_id)`. anthropicRuntime pauses on `outcome?.__awaiting_approval`. makeSupervisorRunTool translates: spreads result + adds `__awaiting_approval: true` when condition met. claudeSupervisor reads `out.proposedTool?.approval_id`.

### System prompt extraction
buildSystemInstruction calls module-scope loadRecentRunsContext + buildContextPreamble, returns plain string. anthropicRuntime.withCaching wraps it as Anthropic system param (no Vertex role/parts wrapper needed).

### Brief's import path corrected
Brief wrote `../../db.js` but agents/ is 3 levels from server/. Fixed to `../../../db.js`.

### SUPERVISOR_TOOLS object key access
Object keyed by name. getSupervisorTools() returns Object.values(). makeSupervisorRunTool uses SUPERVISOR_TOOLS[name] direct lookup.

### cost_cents column
Brief had `/100` (dollars); corrected to store `total_cents` (integer cents).

## Build + lint + test:ops

- yarn build: PASS (23.14s, 0 errors)
- yarn lint: PASS (0 errors, 213 pre-existing prettier warnings)
- yarn test:ops: 12 pass / 15 fail — 15 failures are pre-existing DB-dependent tests (correlator, CTM, migrations, recipes, skills*). anthropicRuntime (3), models (3), toolSchema (2), socialMediaTokens (4) all green. No regressions.

## Concerns

None.

## Follow-up fixes (c21237a)

Single loadThread call: line 106 reuses `loaded.messages` from line 92. Cost tracking: only final message writes `cost_cents` + `usage_json`; earlier rows get `cost_cents = 0` and `usage_json = null`.

## Dangling tool_use fix (a9ba2d4)

**Bug:** `runClaudeToolLoop` returns `status:'awaiting_approval'` without appending a `tool_result` for the `propose_action` tool_use block. On the next send, `historyToMessages` replays `[..., assistant(tool_use), user(new text)]` — the Anthropic API returns 400 because every tool_use must be immediately followed by a matching tool_result, making the thread permanently unusable.

**Fix:** In `runClaudeChatTurn`, after the persist loop and after `pendingApprovalId` is resolved, a new block checks `out.status === 'awaiting_approval'`, scans `out.messages` from the end for the last assistant message with a `tool_use` block, captures its `id`, and persists a synthetic user message row (`role='user'`, `cost_cents=0`, `usage_json=NULL`) whose `content_json` is a `tool_result` referencing that id. The content text truthfully states the action is queued and not yet executed.

**Inserted at:** `claudeSupervisor.js` after line 172 (after `pendingApprovalId` assignment), before the `return` statement.

**Build:** PASS (33.48s) | **Lint:** PASS (0 errors, 287 pre-existing prettier warnings)
