# Operations Polish — Aspect Spec

The iterative polish routine (Routine A) works through these 42 aspects, one per run, one PR each. Routine A reads this file to look up the spec for whichever aspect is next in `.routines/ops-state.md`. A companion Routine B addresses the CodeRabbit/Codex findings on that PR and merges it.

Each aspect is a single, focused, PR-sized improvement. They are ordered by priority: **real bugs and security/compliance first, then API hygiene, then frontend bugs, then UX, then polish/cleanup.** Slugs here MUST match the queue slugs in `.routines/ops-state.md` exactly.

Architecture context lives in `docs/OPERATIONS.md` (authoritative). This is a HIPAA-regulated healthcare ops app: React 19 + Vite + MUI 7 frontend in `src/`, Express/Node ESM backend in `server/`, PostgreSQL. The app is an SSO consumer on a shared `anchor` DB (role `ops_app`); it does NOT own login. Verify path: `yarn build` + `yarn lint` (lint covers `src/` only — use `node --check` for `server/` files). No automated test suite.

Compliance is non-negotiable: no PHI or credentials in logs/errors/responses, parameterized queries only, server-side role checks, immutable audit trail for state changes, encryption at rest for secrets. Meta has no BAA — never send medical-client PII to Meta.

---

## Phase 1 — Run pipeline correctness

### runexec-status-compare-and-set
- **category:** bug
- **files:** `server/services/ops/runExecutor.js:380-395`, `:305-308`; `server/jobs/opsRunner.js:56-63`; `server/services/ops/runQueue.js:143-154`
- **problem:** `executeRun` loads the run, checks `run.status !== 'queued'` in JS, then `UPDATE ops_runs SET status='running'` with no `AND status='queued'` guard. Pub/Sub is at-least-once (opsRunner nacks → redelivery) and the prod fallback can also push to the in-memory worker, so two deliveries can both read `queued` and both run every check — duplicate `ops_check_results`/`ops_findings` and double cost.
- **fix:** Make the running transition an atomic conditional update (`UPDATE ... WHERE id=$1 AND status='queued' RETURNING id`) and bail when `rowCount===0`, in BOTH the legacy-tier and skill paths. 1 file.

### runexec-cancel-honors-cancellation
- **category:** bug
- **files:** `server/services/ops/runExecutor.js:540-551`, `:326-335`; `server/routes/ops.js:226-248`; `server/jobs/opsRunner.js:36-65`
- **problem:** The terminal `UPDATE ops_runs SET status=$2` is unconditional, so a run cancelled mid-flight (`POST /runs/:id/cancel`) gets clobbered back to `completed`/`partial`. In prod `executeRun(runId)` gets no `options.signal` and the Cloud Run Job never subscribes to the `ops.run.cancel` topic, so production cancel is a no-op.
- **fix:** Gate the terminal UPDATE with `AND status NOT IN ('cancelled')` (or re-read before writing); either subscribe opsRunner to the cancel topic + thread an AbortSignal, or explicitly document cancel as queued-only and reflect that in the API/UI. 1–2 files.

### runexec-cost-rounding
- **category:** bug
- **files:** `server/services/ops/costTracker.js:41-43`; `server/services/ops/runExecutor.js:455-456`, `:481-504`
- **problem:** `totalCents()` does `Math.ceil(dollars*100)` per check, then the executor sums already-ceiled per-check cents. N sub-cent checks each round up to 1¢, inflating `cost_estimate_cents` (which feeds budget math + billing) and tripping `totalCostCents > budget` prematurely with a spurious `ops.budget_exceeded` finding.
- **fix:** Accumulate fractional dollars at the run level and `Math.ceil` once when computing `cost_estimate_cents`; keep per-check cents for display only. 1–2 files.

### runexec-check-timeout-abortsignal
- **category:** bug
- **files:** `server/services/ops/runExecutor.js:47-63`, `:411-466`; check handlers under `server/services/ops/checks/`
- **problem:** `withTimeout` rejects after the deadline but the underlying `def.handler` promise keeps running (no AbortSignal passed in), so a hung Vertex/HTTP/SSH/GAQL check keeps consuming tokens + connections after the run recorded it as `error` and moved on; its cost is lost from the tracker. The only cancel point is the between-check `signal?.aborted` check, so a single long check ignores both timeout and user cancel.
- **fix:** Thread a per-check `AbortController` (tied to the timeout) and `ctx.signal` into handlers; pass `signal` to `safeHttpFetch`/wpcli/customer calls and abort on timeout; reconcile cost from the partial tracker. 2–3 files. (Consolidates the duplicate run-pipeline + checks findings.)

### budget-precheck-includes-run-cost
- **category:** bug
- **files:** `server/services/ops/budgetGuard.js:46-56`; `server/services/ops/scheduleFanout.js:117-148`
- **problem:** `checkBudget` returns `allowed: spendCents < capCents` — it only blocks once spend already met the cap. A client at 499¢ under a 500¢ cap can still enqueue a run that adds up to 500¢, landing near 2× the cap with no throttle finding. No reservation/estimate of the pending run's cost enters the decision.
- **fix:** Factor an estimated run cost (tier budget or definition estimate) into the gate: `spendCents + estCents <= capCents`; record the estimate. 1–2 files.

### skill-runs-correlate-report-digest
- **category:** ux
- **files:** `server/services/ops/runExecutor.js:304-361`, `:507-528`; `server/services/ops/scheduleFanout.js:305-318`
- **problem:** The Phase-6 hooks (`correlateRun`, `reportRenderer.render`, `sendRunSummary`) live only in the legacy-tier path. `executeSkillRun` returns before reaching them — yet every bulk schedule enqueues skill-backed runs. So bulk runs silently produce no report (so `GET /runs/:id/report` 404s), no cross-platform correlation, and no completion email, with no signal that this is by design.
- **fix:** Invoke the correlator/report/digest hooks (or an explicit, documented subset) at the end of `executeSkillRun`, or surface the difference in the UI. 1 file.

### fanout-bulk-batch-and-count
- **category:** bug
- **files:** `server/services/ops/scheduleFanout.js:276-329`
- **problem:** For each schedule, skills are resolved one-by-one and a separate single-row `INSERT ... RETURNING` runs per (client × skill) — O(clients×skills) round trips. `enqueued += 1` (line 327) sits outside the `if (newRunId)` guard, so a null id or thrown `enqueueRun` still increments, making `ops_bulk_runs.client_count` disagree with rows actually created.
- **fix:** Batch skill resolution and child-run inserts (single multi-row INSERT); only count `enqueued` when a row id exists and enqueue succeeds. 1 file.

### fanout-schedule-timezone-cadence
- **category:** bug
- **files:** `server/services/ops/scheduleFanout.js:380-421`; `server/services/ops/budgetGuard.js:27-39`
- **problem:** `computeNextRunAt` treats `hour_local` as UTC and ignores the stored `schedule.timezone`, so a client's 8am-local run fires at the wrong wall-clock time (and shifts at DST). Monthly schedules `Math.min(day_of_month, 28)` so the 30th/last day never fires. `getMonthToDateSpendCents` uses `date_trunc('month', NOW())` in the DB session TZ, which may not match the client's billing month.
- **fix:** Honor the `timezone` column (Luxon/Intl) when projecting next run; stop clamping DoM (cap to that month's real last day). 1 file.

---

## Phase 2 — Security & multi-tenant isolation

### fanout-oidc-audience-allowlist
- **category:** bug
- **files:** `server/services/ops/scheduleFanout.js:41-53`, `:22-25`, `:65-83`
- **problem:** `verifyOidcBearer` calls `verifyIdToken({ idToken })` with NO `audience`, and the SA allowlist is only enforced when `OPS_FANOUT_ALLOWED_SAS` is set (default empty). So by default ANY valid Google-issued OIDC token passes and can trigger portfolio-wide run fanout — an unauthenticated-trigger / billing-abuse vector.
- **fix:** Fail closed when the allowlist is empty; pass the expected audience (Cloud Run URL via env) to `verifyIdToken`; constant-time compare any shared-secret fallback. 1 file.

### agents-meta-query-scope-to-client
- **category:** bug
- **files:** `server/services/ops/agents/subAgents/metaAgent.js:40-46`, `:60-68`; `server/services/ops/checks/meta/_client.js:45-47`
- **problem:** The `meta_query` tool declaration tells the model it may pass absolute graph paths, and the handler forwards `endpoint` straight to `adapter.graph(path)`, authenticated with the agency-wide `FACEBOOK_SYSTEM_USER_TOKEN` (all 20 ad accounts + pages). The resolved `adAccountId` never constrains the request, so a prompt-injected/mistaken model for client A can read client B's ad data — cross-tenant exposure with an over-privileged token.
- **fix:** Require `endpoint` to begin with the resolved `act_<id>/` (or a client-owned pixel id); reject absolute paths; drop the "absolute graph paths" hint. 1 file.

### sec-approval-execute-atomic-scoped
- **category:** bug
- **files:** `server/services/ops/agents/supervisor.js:271-276`, `:383-416`; `server/services/ops/agents/subAgents/websiteTools.js:444-445`; route `server/routes/ops.js:1343-1353`
- **problem:** `executeApproval` reads the approval row, checks `executed_at` in JS, runs the tool handler, THEN does an unconditional UPDATE — two concurrent approves both pass and both fire a live mutation (e.g. `plugin_update`/Google Ads/Meta write runs twice). `rejectApproval` already uses the correct atomic `WHERE executed_at IS NULL RETURNING` guard. The approval also carries no `client_user_id`, so there's no re-authorization that the approver is allowed for the target client/env at execution. (Two agents flagged this — same issue.)
- **fix:** Claim the row atomically (`UPDATE ... SET executed_at=NOW() WHERE id=$1 AND executed_at IS NULL RETURNING *`), only run the handler if claimed, then a second UPDATE for `execution_result_json`; store `client_user_id` at proposal time and re-authorize it at execution. ~2 files.

### agents-wp-password-reset-no-cleartext
- **category:** bug
- **files:** `server/services/ops/agents/subAgents/websiteTools.js:487`, `:494-499`; `server/services/ops/operations-website/sshClient.js:100`; `server/services/ops/agents/supervisor.js:411-416`
- **problem:** `wp_user_password_reset` runs `wp user update <target> --user_pass=<newPassword>`. The plaintext password lands in (1) the SSH process argv on the Kinsta host (visible via `/proc`/`ps`), (2) `kinsta_ssh_command_log.command_summary` (logs `command.slice(0,200)` verbatim), and (3) `ops_tool_approvals.execution_result_json` (persisted `{ new_password }` plaintext). A live WP admin credential sits in two DB tables in cleartext.
- **fix:** Pass the password via STDIN/`--prompt`/temp file instead of an argv flag; redact `--user_pass=` in `logCommand`; strip `new_password` from the persisted approval result (return a one-time retrieval token instead). ~3 files.

### agents-tool-output-sanitize
- **category:** bug
- **files:** `server/services/ops/agents/subAgents/_runner.js:54-61`; `server/services/ops/agents/subAgents/websiteTools.js:184-188`; `server/services/ops/agents/subAgents/metaAgent.js:73-77`; `server/services/ops/runExecutor.js:71`
- **problem:** `payloadSanitizer.sanitize()` is applied only in `runExecutor.persistCheckResult`. The agent path never calls it: `wpcli_read` returns raw `stdout` (allowlist permits `user list/get/meta get` — names/emails on a healthcare WP), and `meta_query` returns raw Graph JSON. These results are appended to `messages` as `functionResponse` and sent to Vertex AI — putting potential PHI into an external LLM prompt.
- **fix:** Run every tool result through `sanitize()` inside the sub-agent `runTool` (and supervisor `runTool`) before appending to `messages`. ~2 files.

### agents-verify-tracking-ssrf
- **category:** bug
- **files:** `server/services/ops/agents/subAgents/websiteTools.js:47-67`, `:240-246`
- **problem:** Every other outbound fetch here uses `safeHttpFetch` (PSI, SEMrush), but `verify_tracking_install` calls `assertPublicHttpUrl(homeUrl)` once and then hands the URL to a local `fetchUrl()` that re-resolves DNS at connect time with no redirect handling — a TOCTOU/DNS-rebinding window. The home URL comes from `wp option get home` on a client-controlled site, so it's attacker-influenceable.
- **fix:** Replace `fetchUrl` with `safeHttpFetch` (re-validates on redirect/connect); delete the local helper. 1 file.

### api-write-endpoints-roster-scope
- **category:** bug
- **files:** `server/routes/ops.js:1003` (PUT subscriptions), `:1061` (PUT credentials), `:1263` (PUT cap), `:983`/`:1050` (GET reads); compare gated `:147` and `:1310`
- **problem:** `POST /runs` and `POST /chat` call `isOperationsClient(client_user_id)` and 404 on non-ops users; the subscription/credential/cap mutations do not, so they INSERT/UPDATE config for ANY user id in the shared `users` table (including non-ops clients). Contract-inconsistent with the read endpoints that all filter by `opsClientExistsExpression`.
- **fix:** Add the `isOperationsClient` guard (404) to the three write handlers. 1 file.

### api-credential-ownership-scope
- **category:** bug
- **files:** `server/routes/ops.js:1086` (DELETE `/clients/:id/credentials/:credentialId`), `:1119` (POST `.../validate`); `server/services/ops/credentialStore.js` delete/validate helpers
- **problem:** Both handlers validate `:id` is a UUID but then call `deleteCredential(req.params.credentialId)` / `validateCredential(...)` without checking the credential's `client_user_id` matches `:id`. A credential belonging to client A can be deleted/validated through client B's URL, and a non-existent client returns success/204 instead of 404.
- **fix:** Add `WHERE client_user_id = $1` ownership scoping in the delete/validate helpers and return 404 when no row matches. ~2 files.

---

## Phase 3 — Compliance & audit trail

### sec-credential-lifecycle-audit
- **category:** bug
- **files:** `server/routes/ops.js:1061-1096`, `:1119-1133`; `server/services/ops/credentialStore.js:99-203`
- **problem:** `client_platform_credentials.credentials_encrypted` holds AES-encrypted client OAuth secrets. Add/rotate/delete/validate write NO audit-trail event (skills/recipes/bulk/discovery transitions all do). Delete is a hard `DELETE` with no audit and no soft-delete — unattributable and unrecoverable.
- **fix:** Add `OPERATIONS_CREDENTIAL_UPSERT` / `_DELETE` security-event types in `audit.js` and call `logSecurityEvent` in the handlers (log platform + account_id + source only — NEVER the secret). 1 route file + audit.js.

### consistency-ops-state-change-audit
- **category:** consistency
- **search scope:** `server/routes/ops.js` — every handler that issues `INSERT/UPDATE/DELETE`. Known gaps: run-definitions `POST :679`/`PUT :706`; subscriptions `PUT :1003`; monthly-cap `PUT :1263`; findings `acknowledge :340`/`resolve :367`; run `cancel :226`. (Already-logging siblings: assign/ignore/bulk-status at `:398/:475/:498/:534`.)
- **problem:** The intended invariant is "every operator-initiated state change emits an `operations.*` audit event." The handlers above break it; the monthly-cap change governs spend authorization and ack/resolve change finding lifecycle, so it's an auditability hole.
- **fix:** Enumerate every mutating handler (FIX/OK/EXCEPTION), add `logSecurityEvent` + new event types where missing, and codify the rule in `docs/OPERATIONS.md`. Grep-proof completeness in the PR body.

### sec-encryption-prod-failfast
- **category:** bug
- **files:** `server/index.js` startup (no `initEncryption` call); `server/services/security/encryption.js:35-44`
- **problem:** In prod with no `ENCRYPTION_KEY`, `getEncryptionKey()` returns `null` and the app boots fine; the failure only surfaces when an admin stores an OAuth secret (`putCredential` throws). For a HIPAA app, "credential encryption disabled" should be a loud boot-time failure, not a lazy per-request surprise.
- **fix:** Call `initEncryption()` at startup; when `NODE_ENV==='production'` and it returns false, log a hard error (optionally refuse to mount credential routes). 1 file.

### sanitizer-names-and-phones
- **category:** bug
- **files:** `server/services/ops/payloadSanitizer.js:16-36`, `:54-62`
- **problem:** The sanitizer has no name pattern and only redacts phones on keys matching `USER_FIELD_HINTS`. A payload embedding a caller name/phone in a free-text field with a neutral key (`summary`, `reason`, `value`, `transcript_snippet`) passes straight into `ops_check_results.payload_json` and on to the supervisor/Vertex. The module's own docstring says false-negatives "are not acceptable."
- **fix:** Scan string VALUES (not just user-ish keys) for the phone pattern; add a conservative name-redaction pass for known CTM caller fields. 1 file.

### sec-chat-rate-limit-fail-closed
- **category:** bug
- **files:** `server/routes/ops.js:1285-1304` (`chatRateLimit`)
- **problem:** If `checkRateLimit`/`recordAttempt` throws (transient DB error on `rate_limit_events`), the middleware `console.warn`s and calls `next()` unthrottled. `/chat` drives Vertex sub-agents with real per-call cost + tool side effects, so fail-open removes the only abuse/cost guard on the most expensive endpoint.
- **fix:** Fail closed for the cost-bearing `/chat` route on limiter error (429/503) while leaving read endpoints fail-open; at minimum `console.error` so it's visible in Cloud Run logs. 1 file.

### compliance-audit-log-immutability
- **category:** polish
- **files:** `server/services/security/audit.js:125-173` (INSERT only); compare `server/services/activityLog.js:623-642` (purges at 30 days)
- **problem:** `security_audit_log` is immutable by convention only — nothing at the DB level blocks UPDATE/DELETE, and there's no documented retention/partition policy. SOC2/HIPAA want a 6-year append-only trail; an auditor will flag the missing enforcement.
- **fix:** One idempotent migration adding a `BEFORE UPDATE OR DELETE` trigger/rule on `security_audit_log` that raises, and granting only INSERT/SELECT to the app role; add a retention note in `docs/OPERATIONS.md`. No app-code change.

---

## Phase 4 — API contract & error hygiene

### api-no-leak-internal-errors
- **category:** bug
- **files:** `server/routes/ops.js` (~`:754,765,774,803,832,849,858,876,894,905,916,938,960,977,1339,1351,1363,1386,1447,1484,1500,1521,1541,1571,1588`); `server/routes/operations.js:293,364,475,530,650,662,715`
- **problem:** ~20 handlers (Skills/Recipes/Bulk/chat + several operations.js) do `res.status(500).json({ error:'x', message: e.message })`, echoing raw DB/Vertex/SSH/constraint errors (table/column names, possibly client identifiers) to the browser — a HIPAA info-leak and recon aid. The runs/findings handlers already do the right thing (`console.error` + generic message).
- **fix:** Replace `message: e.message` with a generic message + `console.error(e)`. ~2 files. (This is a consistency aspect — grep `message: e.message` / `message: err.message` across both route files.)

### api-list-pagination
- **category:** bug
- **files:** `server/routes/ops.js:332` (`/findings` LIMIT 500, no offset/meta), `:134` (`/runs` cap 200), `:671` (`/run-definitions` no LIMIT), `:751`/`:900`/`:1383` (`/skills`,`/recipes`,`/bulk/schedules` no LIMIT); good model at `:1527` (`/bulk/runs` → `{runs,total}` w/ limit+offset)
- **problem:** `/findings` silently truncates at 500 with no `total`/`offset`, so the Command Center can neither page nor detect truncation; `/run-definitions`/`/skills`/`/recipes`/`/bulk/schedules` are unbounded (memory/latency as data grows).
- **fix:** Add `limit`/`offset` + `{items,total}` (follow the `/bulk/runs` shape) to the five endpoints; update frontend callers expecting bare arrays. 1 backend file + callers.

### api-consistent-response-shapes
- **category:** ux
- **files:** `server/routes/ops.js` bare arrays `:135,333,671,996` vs wrapped `:660,752,901,1386,1539,1586`; error shapes `{message}` `:138` vs `{error,message}` `:754` vs `{error}` `:1406`
- **problem:** Lists are sometimes bare arrays, sometimes nested under a key; errors are sometimes `{message}`, sometimes `{error,message}`, sometimes `{error}`. Frontend must special-case each endpoint — a frequent source of `undefined.map` UI bugs.
- **fix:** Pick one envelope (e.g. `{data,total?}` for lists, `{message,code}` for errors) and normalize; coordinate with the `src/api/` modules. 1 backend file + frontend api callers. (Do AFTER api-list-pagination so they land together; may be merged.)

### api-json-body-limit
- **category:** bug
- **files:** `server/index.js` (`app.use(express.json())` default 100kb); `server/routes/operations.js:333` (allows `claude_md` up to 200,000 chars); also `ops.js:778` (`prompt_md`), `:1306` (chat `history`)
- **problem:** Express's default JSON limit is 100kb, but the workspace handler permits a 200KB `claude_md` (and skill `prompt_md`/chat `history` are unbounded). Any payload >100KB is rejected by the parser with a generic 413 the route never sees — the validated 200K limit is unreachable.
- **fix:** Set an explicit `express.json({ limit })` that matches the field caps, and reconcile the field caps; consider a tighter cap on internal routes. 1–2 files.

### api-runs-detail-roster-scope
- **category:** polish
- **files:** `server/routes/ops.js:217` (`GET /runs/:id`), `:255,:274,:285` (report/check-results/findings), `:226` (cancel), `:340,:367,:398,:475,:498` (finding mutations); contrast scoped lists `:101,:303,:602`
- **problem:** `GET /runs` and `GET /findings` only return rows where `opsClientExistsExpression(client_user_id)` holds, but the by-id detail + mutation routes return/modify rows regardless of roster membership. Admin-global today so not a breach, but a real contract inconsistency (a row hidden from the list is reachable by direct id) that becomes a leak the moment per-client scoping is added.
- **fix:** Add the roster `EXISTS` filter (or ownership join) to by-id selects/updates; return 404 when out of scope. 1 file.

---

## Phase 5 — Frontend bugs

### ui-discoveries-open-run-nav
- **category:** bug
- **files:** `src/views/admin/Operations/index.jsx:160`; `src/views/admin/Operations/Discoveries/DiscoveriesTab.jsx:241-254`; `Discoveries/DiscoveryDetail.jsx:311-320`
- **problem:** `index.jsx` renders `<DiscoveriesTab onOpenDiscovery={...} />` with NO `onOpenRun` prop, so the "Open run" buttons call an undefined handler — clicking does nothing, no feedback. In the post-pivot IA there's also no run-detail surface to navigate to (RunDetail/RunsTab orphaned).
- **fix:** Either wire `onOpenRun` from `index.jsx` to a run drawer/route, or remove the dead affordances; decide whether RunDetail should be reachable in the new IA. ~2–3 files.

### ui-discovery-detail-edit-stale-list
- **category:** bug
- **files:** `src/views/admin/Operations/Discoveries/DiscoveriesTab.jsx:360`; `Discoveries/DiscoveryDetail.jsx:89-133`; `CommandCenter/CommandCenterTab.jsx:254`
- **problem:** DiscoveryDetail's `setStatus`/`saveOwner`/`saveBusinessImpact`/`ack` update only the detail's own state. DiscoveriesTab renders `<DiscoveryDetail>` with no `onUpdated` callback, so resolving/ignoring in the panel doesn't patch the row behind it — table + Command Center inbox stay stale until manual Refresh. Violates the immediate-UI-update rule.
- **fix:** Add an `onUpdated(updatedDiscovery)` callback, call it after every successful mutation, and have DiscoveriesTab/CommandCenter patch/remove the row in local state. ~2 files.

### ui-discovery-detail-find-any-status
- **category:** bug
- **files:** `src/views/admin/Operations/Discoveries/DiscoveryDetail.jsx:57-83`
- **problem:** With no `GET /findings/:id`, `load()` calls `listOpsFindings({})` and `.find(f => f.id === id)`. If the list defaults to open-only, deep-linking to (or opening from an "including resolved" filter) a resolved/ignored discovery returns no match and renders "Not found" though the row exists.
- **fix:** Add a real `GET /ops/findings/:id`, or pass an explicit status/`open:false` param so the detail fetch resolves any status. ~1–2 files (possibly 1 backend route).

---

## Phase 6 — Frontend UX gaps

### ui-bulk-runs-refresh
- **category:** ux
- **files:** `src/views/admin/Operations/Bulk/RunsSection.jsx:34-46`, `:94-100`
- **problem:** `RunsSection` fetches the latest 100 runs on mount only — no Refresh, no polling. After a schedule "Run now," the new run + evolving status/cost never appear until the user leaves and returns. (The detail drawer polls; the list behind it goes stale.)
- **fix:** Add a Refresh `LoadingButton` and/or a lightweight interval poll while any row is non-terminal; reuse the silent-refresh pattern from `BulkRunDetailDrawer`. 1 file.

### ui-owner-assign-user-picker
- **category:** ux
- **files:** `src/views/admin/Operations/CommandCenter/CommandCenterTab.jsx:352-368`; `Discoveries/DiscoveryDetail.jsx:257-268`
- **problem:** Both owner-assign surfaces are bare `TextField`s labeled "Owner user id (UUID)". Operators can't know UUIDs, there's no validation, and a typo silently assigns a non-existent owner.
- **fix:** Replace the UUID field with an Autocomplete backed by a staff/admin user list; validate before submit. ~2–3 files (+ maybe 1 API to list staff users).

### ui-chat-autoscroll-and-reset
- **category:** ux
- **files:** `src/views/admin/Operations/Chat/ClientChat.jsx:349-374`, `:186-198`
- **problem:** The thread `Box` never scrolls to the bottom when a reply/tool card is appended, so the user must manually scroll after each turn. No "new conversation"/clear control, and `history` is in-memory (refresh wipes it). Long threads re-send unbounded `history` every turn.
- **fix:** Add a `ref` + `useEffect` to scroll-to-bottom on new content, and a "Clear / New conversation" button that resets history + pending approval. 1 file.

### ui-schedule-hour-timezone-label
- **category:** ux
- **files:** `src/views/admin/Operations/Bulk/ScheduleDialog.jsx:32-35`; `Bulk/SchedulesSection.jsx:15-23`
- **problem:** `ScheduleDialog` hour options read `"08:00 UTC"` and write to a field named `hour_local`; `formatCadence` then shows `@ 08:00` with no tz. The "UTC" label vs `hour_local` name vs unlabeled display is contradictory — operators can't tell when a run actually fires (pairs with the backend `fanout-schedule-timezone-cadence` bug).
- **fix:** Pick one timezone semantic; make field name, dialog label, and list rendering agree, and show the tz in `formatCadence`. ~2 files.

---

## Phase 7 — Frontend polish & cleanup

### ui-chat-platform-focus-structured
- **category:** polish
- **files:** `src/views/admin/Operations/Chat/ClientChat.jsx:33-38`, `:210-212`
- **problem:** Selecting a platform prepends a literal `[Focus: Website] ` to the sent prompt; the thread echoes user parts verbatim, so that control string shows up inside the user's chat bubble. Looks like a bug and is brittle (string-matched server-side).
- **fix:** Pass `platform` as a structured field on `sendOpsChat`; strip/hide the prefix from the rendered bubble. 1 file (+ maybe 1 API param).

### ui-discoveries-bulk-ack-parallel-confirm
- **category:** polish
- **files:** `src/views/admin/Operations/Discoveries/DiscoveriesTab.jsx:147-163`, `:343-345`
- **problem:** `handleBulkAck` does serial `for…of await` per id, so acking 25 findings is slow with no progress; no confirm for a large multi-row change; partial failures don't say which rows failed.
- **fix:** Parallelize with `Promise.allSettled`, show a busy state on the button, add a `ConfirmDialog` for large selections. 1 file.

### ui-skills-suggestions-count-endpoint
- **category:** polish
- **files:** `src/views/admin/Operations/Bulk/SkillsSection.jsx:37-60`
- **problem:** `reload()` calls `listSkills()` then `Promise.all` of `listPendingSuggestions(s.id)` for EVERY directive just to render a badge count — an N+1 fan-out growing with the catalog; failures swallowed to `0`; badges block on the slowest request.
- **fix:** Add a single endpoint returning pending-suggestion counts keyed by directive id (or include the count in `listSkills`); render from that. 1 file + 1 API.

### ui-ops-pre-pivot-dead-code-cleanup
- **category:** polish
- **files:** `src/views/admin/Operations/index.jsx:24-33,37-48`; orphaned: `Connections/`, `Clients/`, `Overview/`, `Bulk/BulkActionsTab.jsx`, `Runs/RunsTab.jsx`, `Runs/RunDetail.jsx`, `Schedule/`, `Cost/`, `Sites/*`
- **problem:** `index.jsx` only mounts CommandCenter, Discoveries, ClientChat, BulkTab. Import-graph shows ~15 pre-pivot components (+ their API surface) are unreachable but still shipped — confusing for maintainers, dead weight, and the route-alias map implies they exist.
- **fix:** Delete the orphaned tree (or explicitly re-wire any that must stay, e.g. RunDetail / Sites terminal, into the live IA). Verify with `yarn build`/`yarn lint`. Delete-only, ~15 files. NOTE: this is a large cleanup — if it would exceed the one-PR scope or collides with ui-discoveries-open-run-nav's RunDetail decision, do that decision first.

---

## Phase 8 — Backend polish, deprecation & schema

### api-legacy-operations-deprecation
- **category:** polish
- **files:** `server/index.js` (legacy mount); `server/routes/operations.js:114-743` (sites/sync/scan/exec/bulk live); existing deprecation only at `:591-602` (findings) and 410 at `:754` (assistant)
- **problem:** The new model lives under `/api/ops`, but the entire legacy `/api/operations` router — including high-risk SSH `exec` (`:511`) and credential-refresh (`:479`) — stays active with no deprecation signaling on the superseded endpoints, so there's no telemetry on remaining callers and no migration pressure.
- **fix:** Add `Deprecation`/`Link` headers (or access logging) to the endpoints superseded by `/api/ops`, leaving genuinely-unique Kinsta SSH endpoints alone. 1 file.

### agents-meta-pixel-test-event-endpoint
- **category:** bug
- **files:** `server/services/ops/agents/subAgents/metaAgent.js:81-116`
- **problem:** `meta_pixel_test_event` is described as returning recent pixel test events / `event_diagnostics`, but the handler calls `${pixelId}/stats?aggregation=event...`, which returns aggregated server-event counts, not test events. The model will confidently report on "test events" off the wrong data; the `event_name` filter likely never matches the `/stats` row shape.
- **fix:** Point at the correct Graph edge (pixel `event_diagnostics`/test-event endpoint) or rename the tool + description to "pixel event stats" and fix the filter field. 1 file.

### sec-dead-auth-suite-cleanup
- **category:** polish
- **files:** `server/services/security/sessions.js`, `mfa.js`, `deviceFingerprint.js`, `passwordPolicy.js` (no importers); `tokens.js:196-286` (`refreshSession` returns `invalid_token` but never revokes the family); `tokens.js:328-336` + `audit.js:30` (`revokeTokenFamily` / `TOKEN_REUSE_DETECTED` defined, never invoked)
- **problem:** This app is an SSO consumer (signature-only JWT verify); the copied sessions/MFA/token-reuse suite never executes here and references tables this app's DB role can't write. An auditor will assume reuse-detection is active when it's dead; if wired as-is, replaying a rotated refresh token logs the victim out but doesn't revoke the attacker's family.
- **fix:** Decide + clean up: delete the unused security modules from this app, or (if intentionally shared) document them as main-app-owned and wire `refreshSession`'s not-found path to revoke the family. ~5 files. (Decision aspect — if it'd rearchitect auth, document + defer per Routine A's "broken-state" rule.)

### schema-ops-fk-or-document
- **category:** polish
- **files:** `server/sql/migrate_ops_foundation.sql:34,51,99,140,163` (`client_user_id`/`triggered_by`/`owner_user_id`/`user_id` — no FK to `users`)
- **problem:** Integrity is enforced only at write time via `isOperationsClient`/`opsClientExistsExpression`; a direct insert/bug/deleted-user leaves orphaned ops rows, and the roster filter is the ONLY thing keeping archived clients out of list endpoints. Load-bearing on every list query rather than guaranteed by schema.
- **fix:** Either add `REFERENCES users(id)` FKs in one idempotent migration (if the shared DB permits cross-app FKs), OR document the deliberate omission + the invariant that every ops list query MUST include `opsClientExistsExpression`. Likely a documentation/decision aspect.

---

*Generated 2026-06-17 from a 5-agent parallel audit of `anchor-operations`. Slugs are stable identifiers — Routine A matches them against `.routines/ops-state.md`.*
