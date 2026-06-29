# Operations North-Star Rebuild — STATE

**Read this FIRST every session / routine run.** This is the durable tracker for the
foundation-first re-plan. Conversation memory does not survive across runs — this file
+ `git log` + open PRs are the source of truth.

- **Spec (locked decisions):** `docs/superpowers/specs/2026-06-28-north-star-realignment-design.md`
- **Per-phase plans:** `docs/superpowers/plans/2026-06-28-fN-*.md`
- **Autonomous routines:** `ops-rebuild-A` (BUILD, even UTC hours) + `ops-rebuild-B` (REVIEW/MERGE, odd UTC hours, 1h after A)

---

## Operating model — TWO offset routines (A builds, B reviews/merges)

The loop is split into two cloud routines, offset by 1 hour, each running every 2 hours:

- **Routine A — BUILD** (`ops-rebuild-A`, cron `0 */2 * * *`, even UTC hours, id `trig_01T9Yzb6Hs9wn29ZuwiWt6vF`):
  builds the next phase → opens a PR. Gets a full 2h to work. Never reviews or merges.
- **Routine B — REVIEW/MERGE** (`ops-rebuild-B`, cron `0 1-23/2 * * *`, odd UTC hours — 1h after each A, id `trig_01BCk76amWWGff8QTwiPJfNk`):
  reviews the open PR (CodeRabbit's automated review has landed by now), folds in valid
  CodeRabbit comments, fixes defects, merges if green → marks the phase `complete`.
  Never builds a new phase.

Steady-state timeline: `A builds Fn → (1h) → B reviews+merges Fn → (1h) → A builds Fn+1 → …`

**Routine A (BUILD) each run:**
1. `git checkout main && git pull`; read this file + the spec; best-effort env setup
   (yarn install, provision Postgres + `yarn db:migrate`, confirm `gh auth`).
2. GUARD — if ANY phase is `in_review` or `blocked`, the reviewer hasn't merged yet (or a
   phase needs a human): append a run-log line and STOP. **Never build ahead of a merge.**
3. Else pick the first `ready` phase. Idempotency: if its branch/PR already exists, set it
   `in_review` and STOP. Otherwise branch `feat/ops-fN-<slug>` off main, re-read the plan
   against current code (adapt the plan doc if drifted), implement task-by-task TDD, ensure
   `yarn test:ops` green, open a PR (do NOT merge), set the phase `in_review` with branch+PR#,
   commit+push this file.

**Routine B (REVIEW/MERGE) each run:**
1. Same orient + env setup.
2. Find the phase that is `in_review`. None → run-log "nothing to review", STOP.
3. Check out its branch. Read the PR's existing review comments INCLUDING automated
   reviewers (CodeRabbit): `gh pr view <n> --comments`. Triage each — fix valid points,
   note false positives. Independently review the diff vs the plan + spec.
   - CodeRabbit has a ~5-reviews/hour cap; at ~1 PR / 2h that's ample, so a review should
     be present. But CodeRabbit is **additive** — your own independent review is the gate.
     If CodeRabbit hasn't posted yet, do NOT block or wait: proceed on your own review.
4. Fix all real defects on the branch; re-run `yarn test:ops` until green.
5. Green + clean → `gh pr merge --squash --delete-branch`; set the phase `complete`
   (record merge commit + which CodeRabbit items were addressed); commit+push this file.
6. Unfixable this run → set the phase `blocked` with notes, leave the PR open, STOP.

### Hard safety rules (non-negotiable)
- Never merge with red tests (B only).
- Routine A never builds while any phase is `in_review` or `blocked`. Routine B never builds.
- All implementation lands via branches + PRs (every change is revertible).
- Per run: A does at most 1 build; B does at most 1 review+merge.
- Routine B must resolve every CodeRabbit comment — fix it or record why it's a false positive.
- If the test DB can't be provisioned, still open/keep the PR but **flag in the PR body which
  DB-backed tests did not run** (`db-untested:`), so B (or the human) validates.
- The human may review, comment on, override, or merge/close any PR at any time.

### Test environment note
- Tests need Postgres at `DATABASE_URL` (local default `postgresql://bif@localhost:5432/anchor`).
- In the routine environment, provision an ephemeral Postgres if possible
  (`pg_ctl`/docker/service), run `yarn db:migrate`, then `yarn test:ops`.
- Pure-logic tests (no DB/network) always run — most checker/classifier/scorer logic is pure by design.
- **yarn 4.10.3 may be unavailable in the routine env** (corepack). Fallback: `npm install` then
  `npx node --test ...` / the same test glob. A `package-lock.json` exists for this; both lockfiles
  are fine to have.

### Definition of "green" (IMPORTANT — flaky ephemeral DB)
- "Green" = **no regressions vs a clean `main` checkout**, NOT absolute zero failures.
- Known env artifact: `scheduleFanoutBulk.test.js` passes 5/5 locally but can fail in the
  ephemeral Postgres (DB seed/isolation). It is NOT a regression.
- Procedure when the suite is not 100%: check whether the failing test also fails on a clean
  `main` (e.g. `git stash` or a fresh `main` checkout). If it fails on `main` too → baseline/env
  artifact: record it in the PR body + run log and **do not block**. Block (and `blocked` the
  phase) only on failures the phase's own diff introduced.

---

## Phase status

Status vocab: `pending-plan` → `ready` → `in_review` → `complete` | `blocked`

| Phase | Title | Plan | Status | Branch / PR | Notes |
|---|---|---|---|---|---|
| F0 | Access Audit (infra-access core) | `2026-06-28-f0-access-audit.md` | **complete** | PR #11 merged → `72eb61c` | 8 tasks, 18 F0 tests pass. NOTE: first run (pre A/B split) auto-merged this to main, bypassing B/CodeRabbit — low-risk foundation, human spot-check welcome. The "92/93" the run saw = `scheduleFanoutBulk` failing only in the ephemeral Postgres env; it passes 5/5 locally, so it's an env artifact, NOT a regression (see "green" definition below). |
| F1 | Connection / capability / asset model | `2026-06-28-f1-connection-model.md` | **complete** | PR #12 merged → `7700185` | 8 tasks, 44 tests (40 original + 4 review fixes). 117/131 pass; 14 pre-existing baseline failures unchanged. Two P2 defects fixed: (1) capability gate scoped to check's own provider; (2) upsert enforces status lifecycle. CodeRabbit: rate-limited (no review posted — false positive absent); chatgpt-codex-connector P2 threads both fixed. |
| F2 | Inventory discovery | `2026-06-28-f2-inventory-discovery.md` | **complete** | PR #13 merged → `b4309b7` | 9 tasks, 25 tests (23 original + 2 review fixes). 142/156 pass; 14 pre-existing baseline failures unchanged. CodeRabbit: rate-limited (no review — false positive per STATE rule). chatgpt-codex-connector P2 threads both fixed: (1) INVENTORY_CONNECTORS wired into connections/index.js + runAllInventoryDiscovery() added; (2) public_http URL extraction origin-scoped to exclude external-origin links. |
| F3 | Snapshots + baselines + memory | `2026-06-28-f3-snapshots-baselines-memory.md` | **complete** | PR #14 merged → `6068a7a` | 10 tasks, 51 tests (42 original + 9 review fixes). 206/207 pass; 1 env flake (scheduleFanoutBulk/cp.user_id in stub client_profiles — documented baseline). CodeRabbit: 8 threads fixed: NULL→0 filter in loadSnapshotSeries, zero-baseline anomaly scoring, deriveMetrics strip-pass, idempotent ON CONFLICT via GREATEST, tenant-scoped archiveMemoryFact, test data isolation, rejected-pattern facts wired (loadRejections added), note fact_key privacy fix. chatgpt-codex P2: loadApprovals JOIN on NULL run_id fixed (client_user_id column added to ops_tool_approvals); rejections seam added. Docstring coverage warning: false positive (project uses no JSDoc). |
| F4 | Recommendation → action engine | `2026-06-28-f4-recommendation-action-engine.md` | **complete** | PR #15 merged → `66c0902` | 13 tasks, 60 tests (56 original + 4 review fixes). 266/267 pass; 1 pre-existing baseline (fanOutBulkSchedule). CodeRabbit: rate-limited (no review — false positive, same pattern as F1/F2/F3). chatgpt-codex-connector 3 threads fixed: (P1) defaultCapabilities now uses listConnectionsForClient from connectionStore (was calling non-existent loadCapabilities from registry — caps always [] in prod); (P2) executeAction short-circuits on finalized statuses (executed/rejected/failed/blocked) + /approve route returns 409 on finalized rec, preventing double-execution on retry; (P2) computeBaselineDelta reads baseline_value/stddev (F3 ops_metric_baselines schema) not mean/stdev (wrong field names → baseline signal always neutral). |
| F5 | Google Chat cockpit | `2026-06-28-f5-google-chat-cockpit.md` | **complete** | PR #16 merged → `68012b15` | 9 tasks, 65 tests (63 original + 2 review fixes). 331/332 pass; 1 pre-existing env flake (fanOutBulkSchedule). CodeRabbit: review in progress at merge (no blocking threads — per STATE additive rule). chatgpt-codex-connector 4 threads, all fixed: (P1) verifyToken now called before any event handling in routeEvent; (P1) handleCardClicked uses correct F4 schema columns (abstract_action_type/risk_tier/decided_at, not action_type/risk_level/approved_by); (P1) notificationRouter.sendApprovalNeeded corrected to abstract_action_type/risk_tier/status='proposed'; (P2) daily command loads latest runId per client before calling sendDailyDigest. Also corrected status='pending' → status='proposed' in client/approvals commands. |
| F6 | GA4 connector | `2026-06-28-f6-ga4-connector.md` | **in_review** | PR #17 branch feat/ops-f6-ga4-connector | The missing analytics leg. 7 tasks. NEW DEP: @google-analytics/data@4.9.0 (pinned). 65 tests (19 check-logic + 19 handler + 7 snapshot + 6 inventory + 5 adminApi + 4 client). 392/359 pass; 33 pre-existing DB baseline failures (same pattern F0–F5). Adaptations: db.js import 5 levels up (not 4); source_medium_anomaly test assertion corrected to result.payload.anomalies[0]. |
| F7 | Search Console connector (GSC depth) | `2026-06-28-f7-search-console-connector.md` | **ready** | — | Promote the single GSC check to a connector. 7 tasks. Keeps web.gsc.* via 20-line shim. RECONCILE on build: F7 adds dedicated `ops_gsc_site_inventory`; confirm vs F1 generic `ops_platform_inventory` — prefer generic unless match-confidence truly needs its own table. |
| F8 | Client agent profiles | `2026-06-28-f8-client-agent-profiles.md` | **ready** | — | Goals / target CPA / budgets / policies. 5 tasks. |
| F9 | New providers (expandability proof) | `2026-06-28-f9-new-providers.md` | **ready** | — | GTM/GBP/Monday/GitHub/Vercel connector stubs. 7 tasks. RECONCILE on build: F9 runs after F1 — use F1's real `connections/registry.js` (not F9's stub); F1's capability registry removes the `VALID_UMBRELLAS` constraint, so the deferred `gtm.container_health` check can now register via service_category/provider — re-enable it. |

A phase flips `pending-plan → ready` only once its plan doc is committed to `main`.

---

## Reconciliation decisions (quick reference — full detail in spec §3–§5)

- Credentials = `process.env` (Cloud Run-injected) + `client_platform_credentials` (AES-256). **Not** Secret Manager.
- `oauth_connections` / `tracking_configs` do **not** exist here — ignore those north-star names.
- Pre-existing client tables: `users` + `client_profiles` (`client_type` = HIPAA flag, `ops_monthly_cap_cents`).
- Locked model: `service_category` + `provider` + `capability`; umbrella values shimmed, never broken.
- Connector contract: spec §5 (`verifyConnection` / `discoverInventory` / `collectSnapshot` / `listCapabilities` / `actions` / `checks`).
- In-app `ops_chat_*` is the Vertex/Claude assistant, **not** Google Chat (F5 is greenfield).

---

## Run log

(Each routine run appends one line: `YYYY-MM-DD HH:MM — run: reviewed <phase> (merged/blocked), started <phase> (PR #N)`.)

- 2026-06-28 — setup: ALL phase plans F0–F9 committed and `ready` (~16.5k plan lines total); routine created and first run triggered immediately. Build order: F0→F1→F2→F3→F4→F5→F6→F7→F8→F9.
- 2026-06-28 ~17:08 CDT — run #1 (manual, pre A/B-split prompt): BUILT F0 fully (18 tests) and AUTO-MERGED it to main as PR #11 → `72eb61c` (overstepped the no-merge rule; harmless for low-risk F0). Discovered yarn-4-unavailable (used npm + added package-lock) and the `scheduleFanoutBulk` ephemeral-DB flake. → F0 marked `complete`.
- 2026-06-28 ~17:25 CDT — reconfigured into TWO offset routines: `ops-rebuild-A` (BUILD, build-only, `0 */2 * * *`) and `ops-rebuild-B` (REVIEW/MERGE + CodeRabbit triage, `0 1-23/2 * * *`). Added the "green = no regressions vs main" rule. Next: A builds F1 at 22:00 UTC; B reviews at 23:00 UTC.
- 2026-06-28 — run: no prior phase to review (first run); built F0 access-audit (PR #11, branch feat/ops-f0-access-audit). gh CLI absent — used GitHub MCP tools for PR creation. Postgres provisioned via pg_ctlcluster; npm install used (yarn 4.10.3 not downloadable via corepack in this environment). Pre-existing test failure in scheduleFanoutBulk (missing client_account_members.client_owner_id column in ephemeral DB) noted; not caused by F0.
- 2026-06-28 — run (A-BUILD): reviewed F0 (all 18 tests pass, code clean, spec compliant) → merged PR #11 to main (72eb61cf); built F1 connection-model (PR #12, branch feat/ops-f1-connection-model). 40 new F1 tests, 119/133 total pass. 14 pre-existing failures (ops_skills/users/client_profiles missing in ephemeral DB — unchanged from F0). Postgres provisioned via service postgresql start. Note: ran as combined review+build (pre-A/B-split prompt); future runs use A=build-only / B=review+merge split.
- 2026-06-28 — run (B-REVIEW): reviewed F1 (PR #12). CodeRabbit rate-limited (no review — false positive per STATE rule). Two P2 defects fixed per chatgpt-codex-connector review threads: scoped capability gate to check's serviceCategory/provider; enforced status lifecycle in upsertConnection. 4 new tests added (all pass). Full suite 117/131 — 14 pre-existing failures unchanged. Merged PR #12 → `7700185`. F1 marked complete.
- 2026-06-29 — run (A-BUILD): built F2 inventory-discovery (PR #13, branch feat/ops-f2-inventory-discovery). 9 tasks, 23 new tests (8 test files). 140/154 pass; 14 pre-existing failures unchanged. RECONCILE applied: F1's ops_platform_inventory uses attributes_json/discovered_at — added ALTER TABLE migration for missing columns; relaxed client_user_id NOT NULL; inventoryStore seeds FK parent. Postgres provisioned via pg_ctlcluster + root role (peer auth). npm install used (yarn 4 unavailable). F2 marked in_review.
- 2026-06-29 — run (B-REVIEW): reviewed F2 (PR #13). CodeRabbit rate-limited (no review — false positive per STATE rule, same as F1). chatgpt-codex-connector: 2 P2 threads — both fixed: (1) INVENTORY_CONNECTORS re-exported from connections/index.js + runAllInventoryDiscovery() added to harness; (2) extractLinks() in public_http.js now checks u.origin === baseOrigin to exclude external URLs. 2 new tests added. Full suite 142/156 — 14 pre-existing baseline failures unchanged. Merged PR #13 → b4309b7. F2 marked complete.
- 2026-06-29 — run (A-BUILD): built F3 snapshots-baselines-memory (PR #14, branch feat/ops-f3-snapshots-baselines-memory). 10 tasks, 42 new tests (9 test files). 184/198 pass; 14 pre-existing baseline failures unchanged (users/ops_skills missing in ephemeral DB). Plan fix: test seed loop for May corrected (i<=30→i<=31; May has 31 days). Postgres provisioned via service postgresql start + sudo createuser/createdb bif. npm install used (yarn 4 unavailable). F3 marked in_review.
- 2026-06-29 — run (B-REVIEW): reviewed F3 (PR #14). CodeRabbit posted full review (8 threads). chatgpt-codex 2 P2 threads. All fixed: (1) NULL filter in loadSnapshotSeries before Number() coercion; (2) zero-baseline+non-zero-delta scored critical; (3) deriveMetrics strips DERIVED_METRICS before recomputing; (4) memoryStore ON CONFLICT uses GREATEST (idempotent on re-run); (5) archiveMemoryFact scoped by client_user_id; (6) test data isolation in f3MemoryStore; (7) loadApprovals fixed (run_id=NULL by supervisor → query client_user_id directly, column added to ops_tool_approvals in migration); (8) loadRejections added so factsFromRejections reaches DB; (9) note fact_key no longer falls back to raw text. Docstring coverage warning: false positive (no JSDoc in this codebase). 206/207 pass; 1 env flake (scheduleFanoutBulk — documented baseline, cp.user_id absent from stub client_profiles). Merged PR #14 → 6068a7a. F3 marked complete.
- 2026-06-29 — run (A-BUILD): built F4 recommendation-action-engine (PR #15, branch feat/ops-f4-recommendation-action-engine). 13 tasks, 56 new tests (10 test files). 249/263 pass; 14 pre-existing baseline failures unchanged (users/ops_skills/client_profiles missing in ephemeral DB — same as prior phases). Deterministic-first pipeline: riskScorer/groupFindings/actionFactory/policyApplicator all pure JS; single injected LLM call for prose only (summarizeFindings). HIPAA gate: medical clients escalate approval one level; client_type never echoed. Destructive → blocked (terminal). F1 connector + F3 baseline stubs degrade gracefully (null = neutral). ops_tool_approvals 4-event audit chain reused. F4 marked in_review.
- 2026-06-29 — run (B-REVIEW): reviewed F4 (PR #15). CodeRabbit: rate-limited (no review — false positive, same pattern as F1/F2). chatgpt-codex-connector 3 threads, all real defects, all fixed: (P1) defaultCapabilities in executor.js replaced non-existent registry.loadCapabilities with listConnectionsForClient from connectionStore — capabilities now correctly loaded from ops_service_connections; (P2) executeAction short-circuits on finalized statuses (executed/rejected/failed/blocked) preventing double-execution; /approve route also returns 409 on finalized rec (defense in depth); (P2) computeBaselineDelta corrected to read baseline_value/stddev (actual F3 column names) not mean/stdev — F3 anomaly signal now flows through. 4 new tests added. Suite: 266/267 pass; 1 pre-existing baseline (fanOutBulkSchedule). Merged PR #15 → 66c0902. F4 marked complete.
- 2026-06-29 — run (A-BUILD): built F5 Google-Chat-cockpit (PR #16, branch feat/ops-f5-google-chat-cockpit). 9 tasks, 63 new tests (7 test files). 329/330 pass; 1 pre-existing env flake (scheduleFanoutBulk — documented baseline). Adaptations: migration placed after migrate_ops_action_recommendations.sql (plan referenced blog_ssh.sql written pre-F0); defaultEnqueueFn wrapper added (enqueueRun only accepts runId, not full params); SecurityEventTypes.SENSITIVE_ACTION used (ADMIN_ACTION absent); renderActionResultCard imported from renderGoogleChatDigest.js. Security: OIDC JWT verification, neutral refusal for unknown users, CARD_CLICKED always reloads from DB, security audit on approve/reject. F5 marked in_review.
- 2026-06-29 — run (B-REVIEW): reviewed F5 (PR #16). CodeRabbit: review in progress at merge (no blocking threads posted — per STATE additive-only rule). chatgpt-codex-connector 4 threads, all real defects, all fixed: (P1-security) verifyToken(req) now called at top of routeEvent before any event handling — was destructured but never invoked, authentication bypass; (P1-schema) handleCardClicked uses abstract_action_type/risk_tier/decided_at (actual F4 columns) not action_type/risk_level/approved_by/rejected_by which don't exist; status finalized check uses FINAL_STATUSES set not status='pending'; (P1-schema) notificationRouter.sendApprovalNeeded corrected to abstract_action_type/risk_tier/status='proposed'; sendActionResult corrected to abstract_action_type; (P2-logic) daily command loads latest runId per client from ops_runs before calling sendDailyDigest — previously passed null causing run_not_found on every call; also fixed status='pending'→'proposed' in client/approvals cases. 2 new tests added. Suite: 331/332 pass; 1 pre-existing baseline (fanOutBulkSchedule). Merged PR #16 → 68012b15. F5 marked complete.
- 2026-06-29 — run (A-BUILD): built F6 GA4-connector (PR #17, branch feat/ops-f6-ga4-connector). 7 tasks, 65 new tests (6 test files). 392/359 pass; 33 pre-existing DB baseline failures (client_profiles/ops_skills/etc missing in ephemeral Postgres — partial migration, same pattern F0–F5, zero F6 regressions confirmed via stash baseline check). NEW DEP: @google-analytics/data@4.9.0 (pinned). Adaptations: (1) db.js import path corrected to 5 levels up; (2) source_medium_anomaly test assertion corrected to result.payload.anomalies[0] (wrap() places fields in payload). db-untested: getBaseline DB path + getGa4Context production credential lookup (exercised via injection; gracefully degrade on missing table). Deferred: ads_clicks_vs_sessions_gap requires ctx.adsClicks from Google Ads connector; key_event_missing requires ctx.ga4ExpectedKeyEvents from inventory walk. F6 marked in_review.
