# Anchor — Three-App Integration Plan (Production)

**Date:** 2026-06-10
**Status:** Plan for later — connecting the three apps in production once the new repos are built.
**Scope:** What each repo must do to talk to the others in prod. The *removal* is already done (branches `chore/extract-tasks-ops` for main, `chore/extract-tasks-ops-staging` for staging — both pushed, not merged). Their `task_*` / `ops_*` / `kinsta_*` tables remain dormant in the shared DB for migration.

---

## 0. The shape of it

Three Cloud Run services, **one GCP project** (`anchor-hub-480305`, region `us-central1`), one shared Postgres (Cloud SQL), one shared Secret Manager:

```
                ┌─────────────────────────────────────────────┐
                │   GCP project: anchor-hub-480305 (us-central1) │
                │                                               │
   users ──▶  ┌─┴────────────┐   reads client data    ┌────────┴──────┐
   (SSO via   │  MAIN APP     │◀───────(DB SELECT)─────│ OPERATIONS APP │
   shared JWT)│  anchor-hub   │                         │ anchor-ops    │
              │  (source of   │   API glance (optional) │ (shared DB,   │
              │   truth for   │────────────────────────▶│  ops schema)  │
              │   clients +   │                         └───────┬───────┘
              │   creds)      │                                 │ Pub/Sub
              │               │   API (token) for board link    │ ops-runner
              │               │◀───────────────────────┐        ▼
              └─────┬─────────┘                  ┌──────┴────────────┐
                    │                            │  TASK MANAGER APP  │
                    │  shared Postgres (Cloud SQL)│  anchor-tasks      │
                    └────────────────────────────│  (own schema or    │
                                                  │   own DB; SSO JWT) │
                                                  └────────────────────┘
                         Shared Secret Manager (AES key, JWT secret,
                         agency tokens) mounted into all three services
```

**Two different connection styles, on purpose** (matches the extraction plan):
- **Operations ↔ Main = shared database.** Ops is a read-heavy consumer of client data + writer of its own findings. Direct DB is the cleanest fit.
- **Task Manager ↔ Main = API.** Tasks needs almost nothing from main except "which client owns this board." A thin token-authed API beats coupling its schema to the shared DB. (You *can* put tasks on the shared DB too if you'd rather — noted in §4.)

---

## 1. Shared foundation — set ONCE at the project level

Because all three run in the same project, put the truly-shared values in **Secret Manager** and grant each service account access. This is the "share it globally and they all pick it up" pattern you described — it's the right move for the *bounded set of global secrets*:

| Secret (Secret Manager name) | Used by | Why it must be shared |
|---|---|---|
| `anchor-aes-encryption-key` | main + ops (+ tasks if it stores encrypted data) | **Must be byte-identical** or a service can't decrypt `oauth_connections` / `client_platform_credentials` written by another. |
| `anchor-jwt-signing-secret` | all three | Same secret → a login token minted by main is accepted by ops + tasks = **single sign-on** across the three apps. |
| `anchor-db-url-mainapp` | main | `public` schema owner role (existing). |
| `anchor-db-url-ops` | ops | `ops_app` role (see §3). |
| `anchor-db-url-tasks` | tasks (only if shared-DB option) | `tasks_app` role. |
| Agency tokens: `google-ads-mcc-token`, `google-ads-developer-token`, `meta-system-user-token`, `kinsta-api-key`, `mailgun-api-key`, GA4/GTM service-account creds | main + ops (whichever calls that API) | One source of truth; rotate in one place. Ops is the heavy consumer of Google Ads/Meta/Kinsta. |
| `recaptcha-*` | main | Main only. |

**How to wire it (per service):** `gcloud run services update <svc> --update-secrets=AES_KEY=anchor-aes-encryption-key:latest,JWT_SECRET=anchor-jwt-signing-secret:latest,...` and `gcloud secrets add-iam-policy-binding <secret> --member=serviceAccount:<svc-sa> --role=roles/secretmanager.secretAccessor`.

> **Rule of thumb:** *Global/agency* secrets → Secret Manager (small, bounded, rotate-once). *Per-client* data (account IDs, OAuth tokens, the 47 clients' credentials) → **shared Postgres**, NOT Secret Manager. See §5 for why, and how your "push per-client credential to Secret Manager" idea fits.

---

## 2. MAIN APP (this repo — `anchor-hub`) — what to do

The main app stays the **source of truth for client data and per-client credentials**. It barely changes; it mostly *grants access* and *keeps owning* the right tables.

- [ ] **Keep owning, do NOT duplicate:** `tracking_configs` (GA4/Ads/Meta account IDs, website domain, `client_type`), `oauth_connections` (per-client OAuth tokens), `users`, `client_profiles`, `client_account_members`, `brand_assets`. These remain edited only via the client drawer / tracking wizard.
- [ ] **Create DB roles for the other apps** (run once against Cloud SQL):
  - `ops_app` — `GRANT SELECT` on `users, client_profiles, client_account_members, brand_assets, tracking_configs, oauth_connections`; full DML on the `ops` schema + `client_platform_credentials`.
  - `tasks_app` (only if tasks uses shared DB) — `GRANT SELECT` on `users, client_profiles, client_account_members`; full DML on the `tasks` schema.
- [ ] **Move dormant tables into named schemas** (clarifies ownership): `ALTER TABLE ops_* / kinsta_* / client_platform_credentials SET SCHEMA ops;` and `ALTER TABLE task_* SET SCHEMA tasks;` — OR leave in `public` and just gate by role grants. (Schema move is cleaner long-term.)
- [ ] **Stop running the dormant migrations** — already done on the removal branches (the 12 task + 17 ops/kinsta `maybeRun…` calls were removed from `server/index.js`). Schema ownership now belongs to the new apps.
- [ ] **(Optional) Expose a tiny read-only API** for cross-app glances, e.g. `GET /api/clients/:id/ops-summary` proxied from the ops service, or a client roster endpoint Tasks can call. Auth: the shared JWT (admin/service token). Build only when you actually want the embed.
- [ ] **(Optional) Add a thin "credentials" editor** in the client drawer later — but make it a thin editor over the existing `tracking_configs` / `oauth_connections` rows, **not** a new store.
- [ ] **Do NOT drop** any `task_*` / `ops_*` / `kinsta_*` table or column until data is confirmed migrated to the new apps.

**Merge note:** merging the removal branch to `main` auto-deploys to prod. Get the new apps reading the shared DB *before* (or in lockstep with) cutting Operations access off in main.

---

## 3. OPERATIONS APP (new repo — `anchor-ops`) — what to do

This is the heavier integration: it owns the ops schema in the shared DB and reuses the lifted code.

- [ ] **DB connection:** connect as `ops_app` via `anchor-db-url-ops`. Schema-qualify all ops queries (`ops.ops_runs`, etc.) if you moved them to an `ops` schema.
- [ ] **Run the ~17 ops/kinsta migrations from THIS app** (they were copied out of main): `migrate_ops_foundation`, `…_vuln_feed`, `…_seed_run_definitions` (website/meta/gads), `…_keyword_history`, `…_check_results_trend_index`, `…_subscription_email`, `…_monthly_cap`, `…_audit_runs_deprecation_marker`, `…_discoveries_upgrade`, `…_skills_and_bulk`, `…_recipes`, `…_skill_model`, `migrate_kinsta_operations`, `migrate_kinsta_findings`, `migrate_ops_phase0_drift_baseline`, plus the seed-skills sync. They are idempotent — safe to run against the already-existing dormant tables.
- [ ] **Carry the shared modules** the ops code imports (copy from main first; promote to a private npm package only if drift hurts): `server/db.js`, `server/services/security/{encryption,audit,rateLimit,ssrfGuard}.js`, `server/services/mailgun.js`, `server/services/clientLabel.js`, `server/services/queryHelpers.js`, `server/utils/roles.js`.
- [ ] **Match secrets:** mount `anchor-aes-encryption-key` (to decrypt `oauth_connections` / `client_platform_credentials`) and `anchor-jwt-signing-secret` (to accept main's logins). **Both must equal main's.**
- [ ] **Agency API creds:** mount `google-ads-mcc-token` + `…-developer-token`, `meta-system-user-token`, `kinsta-api-key`, GA4/GTM service-account, `mailgun-api-key`.
- [ ] **Pub/Sub (run executor):** recreate the topology that was in `infra/pubsub/ops.tf` — topics `ops.run.requested` / `ops.run.completed` / `ops.run.cancel` / `ops.run.dead`, subscription `ops-runner` (ack_deadline 600s, max_delivery 5 → DLQ). Redeploy the Cloud Run **Job** (`Dockerfile.opsRunner` + `gdeploy-ops-runner.sh` were removed from main — recreate them in this repo) as `anchor-ops-runner`, entry `node server/jobs/opsRunner.js`, env `OPS_RUN_SUBSCRIPTION=ops-runner`, `OPS_RUNNER_CONCURRENCY=4`.
- [ ] **Reads client data live** from the shared DB: `tracking_configs` (account IDs — critical), `oauth_connections` (tokens), `client_profiles` (incl. `ops_monthly_cap_cents`), roster tables. No copy, no sync — just SELECT.
- [ ] **HIPAA gate stays:** Meta CAPI / Meta checks must still enforce `client_type !== 'medical'`. Carry that guard.
- [ ] **Health check:** the `ops.supervisor` probe was removed from main's health framework — re-home it in this app's own health endpoint.
- [ ] **Routing/SSO:** validate the shared JWT + admin role on every route, so existing admin logins work here. Decide prod URL (subdomain `ops.<domain>` or path `/ops` behind a load balancer).

---

## 4. TASK MANAGER APP (new repo — `anchor-tasks`) — what to do

Lightest coupling. Default: **its own database/schema + an API to main.**

- [ ] **Data:** migrate the dormant `task_*` tables (workspaces, boards, groups, items, subitems, assignees, updates, files, time_entries, automations, status_labels, ai summaries, …) into this app's DB. Either a one-time dump→restore into a new `anchor-tasks` DB, or `ALTER … SET SCHEMA tasks` + connect as `tasks_app` on the shared instance (cheaper; one less DB).
- [ ] **Migrations:** carry the 12 task `.sql` files (`task-events`, `task-automation-v2/v3`, `task-labels`, `task-deps-recurrence`, `task-dashboards`, `task-item-links`, `task-mirror-columns`, `task-baselines`, `task-time-tracking-v2`, `task-webhooks`, `task-subitem-workflow`). Run them from this app.
- [ ] **SSO:** mount `anchor-jwt-signing-secret` and validate the same JWT → users move between apps without re-login.
- [ ] **Client ↔ board linking (the one real connection):** main removed `client_profiles.task_workspace_id / task_board_id / board_prefix` wiring. Re-establish via an API you define:
  - Option A (recommended): Tasks owns the mapping (`board → client_id`) and calls main's read-only client roster API (shared JWT) to resolve client labels for display.
  - Option B: main keeps the `task_board_id` column (still dormant in `client_profiles`) and calls a Tasks API (`POST /boards`, `GET /boards/:id`) to provision/fetch — re-add the provisioning block that was deleted from `hub/clients.js`, pointed at the new service.
- [ ] **Self-contained services** to bring: the 9 deleted services (`taskAutomations`, `taskEventBus`, `taskEventSubscribers`, `ruleEngine`, `conditionEvaluator`, `taskLabels`, `taskRecurrence`, `taskCleanup`, `templateVariables`) + the 3 crons (purge-archived, due-date automations, recurring tasks).
- [ ] **Carry shared modules** it used: `db.js`, `queryHelpers.js`, security/audit, `utils/roles.js`.
- [ ] No agency API creds, no AES key needed unless tasks stores encrypted data.

---

## 5. The credential-sharing pattern (your "push to Secret Manager" idea)

Your instinct — *same project, so share secrets globally and everyone reads them instantly* — is exactly right for the **global/agency** layer. Two tiers:

**Tier 1 — Global secrets → Secret Manager (do this).**
AES key, JWT secret, agency tokens (Ads MCC, Meta system user, Kinsta, Mailgun), service-account JSON. A handful of values, rarely change, every app needs the same one. Grant each service's SA `secretAccessor`; rotate once, all pick up `:latest`. Clean.

**Tier 2 — Per-client credentials → shared Postgres (don't put these in Secret Manager).**
The 47 clients' account IDs and OAuth tokens live in `tracking_configs` / `oauth_connections` today and are *already* the source of truth. Reasons to keep them in the DB rather than pushing each to Secret Manager:
- **Volume & churn:** dozens of clients × multiple platforms × token refreshes = lots of secret versions; Secret Manager has per-project quotas and version costs, and isn't built to be queried/joined.
- **They're relational data**, not app config — you filter/join them by client, account, type. SQL is the right tool.
- **Already encrypted at rest** (AES) and access-controlled by DB role. Ops just needs `SELECT` + the shared AES key to decrypt.

> If you still want a literal "set a client credential → instantly available to ops" flow without a DB read, the lighter version is: main writes the row to the shared DB (as today), ops reads it on demand. No push step needed — they're already looking at the same table. **Reserve the Secret-Manager-push approach for the small set of global secrets**, where it shines.

---

## 6. Connection matrix (who talks to whom, and how it's authed)

| From → To | Channel | Auth |
|---|---|---|
| User → any app | HTTPS / browser | Login on main, **shared JWT** accepted by all three |
| Ops → shared DB | Postgres (`ops_app` role) | `anchor-db-url-ops`; SELECT on client tables, DML on ops schema |
| Ops → Google Ads / Meta / Kinsta / GA4 | external APIs | agency tokens from Secret Manager |
| Ops → client OAuth-scoped APIs | external | per-client token from `oauth_connections` (shared DB) + shared AES key to decrypt |
| Ops runner Job ← Pub/Sub | `ops-runner` subscription | project-internal IAM |
| Tasks → main (client roster/labels) | HTTPS API | shared JWT / service token |
| Main → ops or tasks (optional embed) | HTTPS API | shared JWT |
| Tasks → its DB | Postgres (`tasks_app` or own DB) | `anchor-db-url-tasks` |

---

## 7. Suggested sequence

1. **Project prep:** create the Secret Manager entries (§1); create `ops_app` (and maybe `tasks_app`) DB roles (§2); optionally move dormant tables into `ops` / `tasks` schemas.
2. **Stand up Operations app:** point it at the shared DB, run its migrations (idempotent against existing tables), mount matching AES + JWT + agency secrets, recreate Pub/Sub + the runner Job. Verify it reads live client data and runs a check end-to-end.
3. **Stand up Task Manager app:** migrate `task_*` data, run its migrations, mount JWT for SSO, build the client↔board API.
4. **Cut over:** point production traffic (subdomains or LB paths) at the new services. Only now consider merging main's removal branch fully / dropping the dormant tables — **after** data is confirmed migrated.
5. **Decommission leftovers:** delete the live `anchor-ops-runner` Job + `ops-runner` Pub/Sub sub if you recreated them under the new app; remove any stale env vars from `anchor-hub`.

---

## Gotchas to remember

- **AES key + JWT secret must be byte-identical across services** — the #1 thing that silently breaks decryption and SSO.
- **Don't drop dormant tables** until migration is verified. The removal branches preserved all 29 `.sql` files + all tables + the `client_profiles.{task_workspace_id, task_board_id, board_prefix, ops_monthly_cap_cents}` columns for exactly this.
- **gRPC for Google Ads** — the `google-ads-api` npm package uses gRPC; REST 404s. Ops carries this dependency.
- **Schema-ownership discipline:** once ops migrations run from the ops app, they must NOT also run from main (already removed). One owner per table.
- **Single project = blast radius:** shared SA permissions mean a compromise in one service can read the others' secrets. Consider per-service service accounts with least-privilege secret grants rather than one shared SA.
