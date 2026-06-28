# Operations North-Star Rebuild — STATE

**Read this FIRST every session / routine run.** This is the durable tracker for the
foundation-first re-plan. Conversation memory does not survive across runs — this file
+ `git log` + open PRs are the source of truth.

- **Spec (locked decisions):** `docs/superpowers/specs/2026-06-28-north-star-realignment-design.md`
- **Per-phase plans:** `docs/superpowers/plans/2026-06-28-fN-*.md`
- **Autonomous routine:** `ops-rebuild` (cloud routine, every 2 hours, PR-only)

---

## Operating model — autonomous PR-only loop (every 2h)

Each routine run does **two things in order** (this is the user's "routine A and B",
merged into one run so there is no two-cron coordination problem):

**STEP 1 — Close out the previous run (review B):**
- If any phase is `in_review` with an open PR:
  1. Check out the PR branch, pull latest.
  2. Run a code review of the diff (correctness + spec compliance + tests).
  3. Fix any errors on the branch. Ensure the full `yarn test:ops` suite is green.
  4. If green + review clean → **merge the PR to main**, set that phase `complete`,
     record the merge commit in this file.
  5. If problems are **unfixable this run** → set the phase `blocked` with notes,
     leave the PR open, and **HALT** (do not start a new phase). This is the
     compounding-error safety: never build a new phase on an unreviewed/broken base.

**STEP 2 — Start the next phase (build A):**
- Pick the first phase whose status is `ready` (plan committed) and not yet built.
- Create branch `feat/ops-fN-<slug>` off latest `main`.
- **Re-read the phase plan against the actual current codebase.** Earlier phases are
  now built — if the plan's assumptions drifted, adapt the plan doc first, then build.
- Execute the plan with **subagent-driven-development** (TDD, fresh subagent per task,
  task review after each). Commit per task.
- Run `yarn test:ops`. Open a PR (do **not** merge it this run — the next run reviews it).
- Set the phase `in_review` and record the branch + PR number here.

**STEP 3 — Persist:** update this file (statuses, PR/commit refs), commit + push to `main`.

### Hard safety rules (non-negotiable)
- Never merge with red tests.
- Never start a new phase while any phase is `blocked`.
- All implementation lands via branches + PRs (every change is revertible).
- A run touches at most: 1 merge (prior phase) + 1 new build (next phase).
- If the test DB can't be provisioned in the run environment, still open the PR but
  **flag in the PR body exactly which DB-backed tests did not run**, and set status
  `in_review` with a `db-untested` note so the review step (or human) validates.
- The human may review, comment on, override, or merge/close any PR at any time.

### Test environment note
- Tests need Postgres at `DATABASE_URL` (local default `postgresql://bif@localhost:5432/anchor`).
- In the routine environment, provision an ephemeral Postgres if possible
  (`pg_ctl`/docker/service), run `yarn db:migrate`, then `yarn test:ops`.
- Pure-logic tests (no DB/network) always run — most checker/classifier/scorer logic is pure by design.

---

## Phase status

Status vocab: `pending-plan` → `ready` → `in_review` → `complete` | `blocked`

| Phase | Title | Plan | Status | Branch / PR | Notes |
|---|---|---|---|---|---|
| F0 | Access Audit (infra-access core) | `2026-06-28-f0-access-audit.md` | **ready** | — | First build. No prior PR to review. |
| F1 | Connection / capability / asset model | `2026-06-28-f1-connection-model.md` | **ready** | — | The pivotal umbrella→category/provider shim. 8 tasks. |
| F2 | Inventory discovery | `2026-06-28-f2-inventory-discovery.md` | **ready** | — | `discoverInventory` per existing provider. 9 tasks. RECONCILE on build: F1 already creates `ops_platform_inventory` — adapt/skip F2's own migration of that table to match F1's columns (don't duplicate). |
| F3 | Snapshots + baselines + memory | `2026-06-28-f3-snapshots-baselines-memory.md` | **ready** | — | The "knows normal" learning loop. 10 tasks. F4-recommendations memory seam documented. |
| F4 | Recommendation → action engine | `2026-06-28-f4-recommendation-action-engine.md` | **ready** | — | Structured action queue + policy + preflight. 13 tasks. Reuses ops_tool_approvals 4-event chain. |
| F5 | Google Chat cockpit | `2026-06-28-f5-google-chat-cockpit.md` | pending-plan | — | Webhook digests → interactive app. |
| F6 | GA4 connector | `2026-06-28-f6-ga4-connector.md` | pending-plan | — | The missing analytics leg. |
| F7 | Search Console connector (GSC depth) | `2026-06-28-f7-search-console-connector.md` | pending-plan | — | Promote the single GSC check to a connector. |
| F8 | Client agent profiles | `2026-06-28-f8-client-agent-profiles.md` | **ready** | — | Goals / target CPA / budgets / policies. 5 tasks. |
| F9 | New providers (expandability proof) | `2026-06-28-f9-new-providers.md` | pending-plan | — | GTM/GBP/Monday/GitHub/Vercel connector stubs. |

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

- 2026-06-28 — setup: F0 plan committed (ready); F1–F9 plans being authored; routine `ops-rebuild` created (every 2h).
