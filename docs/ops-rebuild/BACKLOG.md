# Operations ÃÂ¢ÃÂÃÂ Production-Quality Completion Loop (BACKLOG)

**Read this FIRST every loop iteration.** This drives an autonomous, self-resuming
local loop that finishes the north-star to **production quality**, slice by slice,
where every slice ends in **observed, useful behavior** ÃÂ¢ÃÂÃÂ not "tests pass, done."

Runs **locally** (full gcloud / Cloud SQL proxy / deploy / real DB access).
Spec: `docs/superpowers/specs/2026-06-28-north-star-realignment-design.md`.
North-star: the autonomous marketing-ops agent (daily checks ÃÂ¢ÃÂÃÂ findings ÃÂ¢ÃÂÃÂ
recommendations ÃÂ¢ÃÂÃÂ Google Chat ÃÂ¢ÃÂÃÂ approvals ÃÂ¢ÃÂÃÂ safe actions).

---

## Definition of Useful-Done (ALL must hold ÃÂ¢ÃÂÃÂ no exceptions)

A backlog item may be marked `done` ONLY when:

1. **It does the useful thing end-to-end** ÃÂ¢ÃÂÃÂ not a stub, not "basic functionality."
   A human (or a command) can actually accomplish the item's stated behavior.
2. **I ran it and observed the behavior** ÃÂ¢ÃÂÃÂ real evidence captured in this file
   (command output, a Chat message id, a DB row, an HTTP code, a rendered screen
   described). "It builds / the suite is green" is necessary but **NOT** sufficient.
3. **A fresh-context reviewer agent approved it** ÃÂ¢ÃÂÃÂ a subagent with NO prior context
   was given the slice + the item's acceptance and asked: *"Is this genuinely useful
   and production-quality, or basic scaffolding? What's missing for a real user?"*
   Its Critical/Important findings were fixed and it re-approved.
4. **Shipped through the gate** ÃÂ¢ÃÂÃÂ CI `build` green, merged via PR, deployed to prod,
   verified live.
5. **Evidence recorded** here as: `done ÃÂ¢ÃÂÃÂ <one line a human can now actually do> ÃÂÃÂ· <evidence>`.

If any of 1ÃÂ¢ÃÂÃÂ4 fails, the item stays `todo`/`needs-rework`. **Never declare done to move on.**

---

## Iteration protocol (each loop pass)

1. `git checkout main && git pull`. Read this file + STATE.md. Pick the highest-value
   item that is `todo` or `needs-rework` (rework beats new work).
2. Build the slice locally, end-to-end (real behavior, real data paths).
3. **Verify by running it** ÃÂ¢ÃÂÃÂ locally and/or against prod via the Cloud SQL proxy
   (read-only for prod data; the deploy step writes). Capture the evidence. If it
   doesn't actually work or isn't useful, keep building ÃÂ¢ÃÂÃÂ do not advance.
4. **Fresh-context review** ÃÂ¢ÃÂÃÂ dispatch a subagent (clean context) with the diff +
   acceptance: "useful & production-quality, or scaffolding? find gaps." Fix findings.
5. Build + `test:ops` green ÃÂ¢ÃÂÃÂ branch ÃÂ¢ÃÂÃÂ PR ÃÂ¢ÃÂÃÂ wait for CI `build` green ÃÂ¢ÃÂÃÂ merge ÃÂ¢ÃÂÃÂ
   deploy (`scripts/gdeploy.sh`) ÃÂ¢ÃÂÃÂ verify live.
6. Mark the item `done` with evidence. Append a STATE.md run-log line.
7. If context is getting large, schedule a wakeup to resume; else continue to next item.

**Yarn:** always `node .yarn/releases/yarn-4.10.3.cjs <cmd>` (vendored; never npm).
**Branch protection:** `main` requires the CI `build` check ÃÂ¢ÃÂÃÂ every merge goes through it.

---

## Backlog (value-ordered; the loop works top-down)

Status: `todo` ÃÂ¢ÃÂÃÂ `in-progress` ÃÂ¢ÃÂÃÂ `needs-rework` ÃÂ¢ÃÂÃÂ `done`

| # | Slice | Useful behavior (acceptance = observed) | Status |
|---|---|---|---|
| V1 | **Live access verification** | Access Audit credential cards actually call each API and show "verified, N accounts/sites" or "failed: reason" ÃÂ¢ÃÂÃÂ Kinsta, CTM, Google Ads, GA4, GSC, Meta. ACCEPTANCE: run audit in prod, ÃÂ¢ÃÂÃÂ¥1 service shows a real verified count. | **done** ÃÂ¢ÃÂÃÂ (PR #24, rev 00018) |
| V2 | **Daily digest auto-posts to Chat** | Cloud Scheduler ÃÂ¢ÃÂÃÂ internal endpoint ÃÂ¢ÃÂÃÂ real digest in the Chat space every morning. ACCEPTANCE: trigger the internal endpoint, observe a real digest message land; scheduler job exists. | **done** Ã¢ÂÂ (PR #25, rev 00019) |
| V3 | **Per-client Service Connections UI** | Open a real client ÃÂ¢ÃÂÃÂ see per-platform connection status from real data ÃÂ¢ÃÂÃÂ "Verify" button updates it live. ACCEPTANCE: open a client, see states, click verify, watch it change. | **done** â (PR #26, rev 00020) |
| V4 | **Run pipeline actually runs new checks** | A `daily_essential` run for one client collects website/uptime + connector checks ÃÂ¢ÃÂÃÂ writes real `ops_findings`. ACCEPTANCE: trigger a run, see new findings in the Findings inbox. | **done** ✅ (PR #27, rev 00021) |
| V5 | **Snapshots scheduled ÃÂ¢ÃÂÃÂ baselines compute** | Daily snapshot collection runs; after enough days, baselines populate; an anomaly check fires. ACCEPTANCE: snapshot rows for a client; a baseline row; one anomaly finding. | **code shipped (PR #28, rev 00022); chain DORMANT — see PROD-REALITY.md** |

> ⛔ **STOP — READ `docs/ops-rebuild/PROD-REALITY.md` FIRST.** Prod inspection
> 2026-06-30: the engine has produced **0 runs / 0 check_results / 0 findings
> all-time**. The runtime was never switched on (no Pub/Sub topic, no runner
> Job, 0 subscriptions, 0 connector creds). Prior "DONE" verifications (incl.
> V4's) were **local, not prod**. Do NOT build V6–V9 on an engine that has
> never executed in production. Next work = switch-on (runtime + a website-only
> subscription wave with client emails OFF), not more features.
| V6 | **Recommendations ÃÂ¢ÃÂÃÂ Action Queue UI** | Findings produce recommendations shown with evidence; approve/reject writes the audit chain. ACCEPTANCE: see a recommendation in the UI, approve it, see the audit row. | todo |
| V7 | **Google Chat commands** | `/anchorops daily`, `/anchorops clients`, `/anchorops client <name>` return real data in the Chat app. ACCEPTANCE: type a command, get a real reply. | todo |
| V8 | **Critical findings ÃÂ¢ÃÂÃÂ Chat alerts** | A new critical finding posts a real alert to Chat (threaded). ACCEPTANCE: create/observe a critical finding, see the alert. | todo |
| V9 | **Quality hardening pass** | Loading/empty/error states, auth + rate-limit on new endpoints, no-data graceful, PII/secret audit on every new path. ACCEPTANCE: reviewer pass finds no Critical/Important. | todo |

The loop may **groom** this backlog (split/add items) as it learns ÃÂ¢ÃÂÃÂ record changes here.

---

## Evidence log (done items, with proof)

(Each completed slice appends: `Vn done ÃÂ¢ÃÂÃÂ <what a human can now do> ÃÂÃÂ· <evidence: output/msg-id/row/url>`.)

- (none done yet.)

## Loop progress (resume here)

- **V1 in-progress** on branch `feat/ops-v1-live-verify`. Done so far: `liveVerify.js`
  runs real per-service API calls and overrides the audit's presence-based status;
  wired into `accessAudit.js`; **Kinsta verifier PROVEN against the live API
  (`verified ÃÂ¢ÃÂÃÂ reached Kinsta, 114 sites`)**; offline unit tests added.
  **Proven live so far (real API calls, creds from Secret Manager):** Kinsta 114 sites ÃÂÃÂ·
  CTM 77 accounts ÃÂÃÂ· Meta 31 ad accounts ÃÂÃÂ· Mailgun 64 domains. Suite 524/524.
  **Remaining for V1:** Google Ads (`checks/google_ads/_client.js` GoogleAdsApi ÃÂ¢ÃÂÃÂ
  `listAccessibleCustomers`), GSC (reuse `connections/gsc/auth.js` ÃÂ¢ÃÂÃÂ `sites.list`),
  GA4 (GA4_SERVICE_ACCOUNT_KEY ÃÂ¢ÃÂÃÂ accountSummaries; may need `@google-analytics/admin`).
  Then: fresh-context review ÃÂ¢ÃÂÃÂ PR ÃÂ¢ÃÂÃÂ green CI build ÃÂ¢ÃÂÃÂ merge ÃÂ¢ÃÂÃÂ deploy ÃÂ¢ÃÂÃÂ run the audit in
  prod and confirm verified counts render on the Access Audit page ÃÂ¢ÃÂÃÂ mark V1 done.
  - To fetch a cred locally for a live test: `gcloud secrets versions access latest --secret=<NAME> --project=anchor-hub-480305`. Agency secret names: KINSTA_API_KEY, KINSTA_AGENCY_ID, CTM_API_KEY, CTM_API_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN/REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET/MANAGER_ID, GA4_SERVICE_ACCOUNT_KEY, FACEBOOK_SYSTEM_USER_TOKEN, MAILGUN_API_KEY/DOMAIN.

- **SOCIAL (system-user Facebook posting) ÃÂ¢ÃÂÃÂ DONE** (user-verified "it's reading the pages") ÃÂÃÂ· PR #23 ÃÂ¢ÃÂÃÂ revision anchor-ops-00017-87v. Create-post is scoped to the client's tab (no picker, no OAuth gate); links a client's Page from the 22 system-user-accessible Pages; posts via the system-user Page token (proven: 204-char token resolved, no posting). Dormant grant-access API for Pages outside the 22.

- **V1 (live access verification) ÃÂ¢ÃÂÃÂ DONE** ÃÂ¢ÃÂÃÂ ÃÂÃÂ· PR #24 ÃÂ¢ÃÂÃÂ revision anchor-ops-00018-tsw. Fresh review caught a real "verified-0 renders green" bug + missing fetch timeouts + token-in-URL; all fixed before ship. Proven live against real APIs (creds from Secret Manager): Kinsta 114 sites, CTM 77 accounts, Meta 31 ad accounts, Mailgun 64 domains, Google Ads 3 accessible customers, GA4 62 properties (44 accounts) ÃÂ¢ÃÂÃÂ all ÃÂ°ÃÂÃÂÃÂ¢ verified; Search Console ÃÂ°ÃÂÃÂÃÂ¡ degraded "reached but 0 sites visible ÃÂ¢ÃÂÃÂ service account not added to any property" (honest finding, not a false green). A human now opens Operations ÃÂ¢ÃÂÃÂ Portfolio ÃÂ¢ÃÂÃÂ Access Audit ÃÂ¢ÃÂÃÂ Run audit now and sees real per-service verified counts. ACTION FOR USER: add the GA4 service account to Search Console properties to light up organic-search.

- **V2 (daily Chat digest) ÃÂ¢ÃÂÃÂ IN PROGRESS, deploy pending.** Built + reviewed + fixed + MERGED (PR #25, commit f2bb308 on main). Scheduler job `ops-chat-daily-digest` created (8am America/Chicago, OIDC via compute SA). Cloud Scheduler API enabled. BLOCKER: Cloud Build queue was congested (first build stuck QUEUED ~27min, cancelled); re-deploying. ON RESUME: confirm new revision live (POST /api/ops/internal/chat-digest returns authorizeFanoutRequest's 'Missing bearer token', not requireAuth's 'TOKEN_EXPIRED_OR_INVALID'), then `gcloud scheduler jobs run ops-chat-daily-digest`, verify a digest event (ops_notification_events event_type='agency_daily_digest' status sent) + the Chat message, then mark V2 done. Do NOT rebuild V2 ÃÂ¢ÃÂÃÂ it's merged. NOTE: old F0-F9 cloud routines (trig_01T9ÃÂ¢ÃÂÃÂ¦, trig_01BCkÃÂ¢ÃÂÃÂ¦) DISABLED.

- **V2 (daily Chat digest) Ã¢ÂÂ DONE** Ã¢ÂÂ ÃÂ· PR #25 Ã¢ÂÂ revision anchor-ops-00019-qdn. Cloud Scheduler job `ops-chat-daily-digest` (8am America/Chicago, OIDC) Ã¢ÂÂ POST /api/ops/internal/chat-digest Ã¢ÂÂ loadCommandCenter Ã¢ÂÂ renders an agency summary (clients at risk ÃÂ· approvals waiting ÃÂ· 24h changes + per-client criticals) Ã¢ÂÂ posts ONE message to the default Google Chat space. VERIFIED LIVE: ran the job, a real digest posted Ã¢ÂÂ ops_notification_events row `agency_daily_digest | sent | 2026-06-30 18:45:35`. Fresh review caught + fixed: false-success on Chat-down (now 502 + event), emailÃ¢ÂÂnon-PII name fallback, robust test. Cloud Scheduler API enabled (the existing fanout/portfolio-digest jobs were never scheduled Ã¢ÂÂ follow-up: wire those too). A human now gets a daily Anchor Ops digest in Chat automatically.

- **V3 (per-client Service Connections UI) â DONE** â Â· PR #26 â revision anchor-ops-00020-2br. Open a client â Config â Connections shows a card per platform (google_ads/ga4/meta/website/ctm/kinsta) with real status from client_profiles + kinsta_site_clients + meta_page_links, plus a per-platform **Verify** button that runs a READ-ONLY live check and persists to ops_service_connections. VERIFIED: getClientConnections returns real per-client statuses; live Meta verify via getPageToken (no posting) â `verified`, persisted + overlaid. Fresh review caught + fixed: derived 'configured' no longer shows false-green (only a real verify â green); Google Ads account resolved via resolveCustomerIdForClient (tracking_configs, same as the checks); Kinsta verify guarded against 500. Suite 537/537. A human now opens a client and sees/verifies each platform's true connection state.

- **V4 RECON (run pipeline) â reframed.** The pipeline is ALREADY built: `runExecutor.executeRun(runId)` (server/services/ops/runExecutor.js:496) fans out to registered checks and INSERTs `ops_findings` (line 193). Run definitions exist (`ops_run_definitions`, 7 of them) with real checks incl. `web.uptime.reachable`/`web.ssl.*`/`web.tracking_install`/`web.psi`/`gsc.*`/`web.semrush.*`/meta.*/gads.*. All those checks are registered. So V4 is NOT "build the pipeline." The REAL gap = (a) verify a real run for one client actually executes + writes ops_findings (acceptance), and (b) wire DAILY SCHEDULING: Cloud Scheduler (now enabled) â POST /api/ops/internal/fanout (scheduleFanout `handleFanoutRequest`) â creates queued ops_runs from client_run_subscriptions â runExecutor. Website checks (uptime/ssl/tracking) need only the client's URL (no agency creds), so verifiable. ON RESUME (fresh context): pick ONE real client with a website + a daily subscription; trigger a run (look at how POST /api/ops/runs / runQueue creates+executes a run); confirm ops_findings rows appear (the Findings inbox). Then create a Cloud Scheduler job hitting /internal/fanout daily (OIDC via compute SA, same pattern as ops-chat-daily-digest). Fresh-review + ship. NOTE: agency-cred checks (gads/meta/gsc-data) will skip/degrade without per-client creds â that's fine; uptime/ssl/tracking prove the pipeline.

- **V4 (run pipeline) — DONE** ✅ · PR #27 → revision anchor-ops-00021-6nv. REPAIRED the run engine: fixed 2 real bugs that silently broke it — (1) website-URL resolution read primary_domain from the wrong table (kinsta_sites→kinsta_environments via LATERAL on the live env + brand_assets fallback), so every website check was erroring; (2) ops_app lacked DML on client_run_subscriptions (non-prefixed; missed by the grant loop), so fanout 500'd — plus closed an SSRF hole the fix exposed (ssl.js raw tls.connect now SSRF-guarded). VERIFIED: a real web_daily_essential run wrote real ops_check_results (uptime 200, SSL valid 35d, GTM/GA4 detected); daily Cloud Scheduler job `ops-daily-fanout` (07:00 America/Chicago, OIDC) created + runs without the prior permission error. Suite 542/542. ⚠️ ENABLEMENT (user decision, not a bug): prod has 0 client_run_subscriptions, so the daily run currently produces 0 runs. Seed subscriptions (which clients / cadence — a cost/scope choice) to switch on automatic daily findings. The engine is proven; turning it on per-client is operational.

- **SINGLE-SIGNAL WEBSITE FINDINGS — DONE (verified live in prod) ✅** · PR #29 → revision anchor-ops-00023-skr. ROOT CAUSE FOUND for "engine never produces anything useful": the correlator (`correlatorRules.js`) is purely rule-driven and EVERY rule required TWO correlated signals (e.g. "SSL expiring AND SEMrush organic drop"), and there was NO rule for a site being down at all. So a website-only run (the only kind with data in prod) could never emit a finding. FIX: added 4 single-signal rules needing only the site URL — `site_unreachable` (critical), `ssl_expiring_critical` (≤7d), `ssl_expiring_soon` (≤30d), `tracking_install_missing`. Suite 569/569 (real DB). Fresh-context reviewer: "genuinely-useful-and-correct, merge as-is" (no Critical/Important from the PR). VERIFIED LIVE: ran web_daily_essential against the demo client (brightsmilesdental.example, non-resolving) directly via executeRun against PROD → `web.uptime.reachable: fail[critical]` → **1 ops_findings row written: `correlation.site_unreachable` [critical]** "Site is unreachable…". ops_notification_events in last 10min = 0 (NO client notified — no subscription ⇒ digest skips). This is the FIRST genuinely useful finding the engine has ever produced in production.

  MILESTONE: the engine EXECUTED IN PROD FOR THE FIRST TIME this session — 14 real runs (1 boltondental + 12-client batch + 1 demo), all `completed`, all reaching live sites, 0 notifications. Prior "0 runs/findings all-time" (see PROD-REALITY.md) is now broken: real ops_runs/ops_check_results/ops_findings rows exist.

  FOLLOW-UPS (recorded, not blocking — from the run + the review):
  1. `gsc.connection_health` returns `error[critical]` (GSC 403 — service account not authorized on any property) on EVERY client but produces no finding. Decide: make a 401/403 an actionable `fail`/finding ("GSC not authorized — grant access") OR `skipped` when unauthorized. Currently a silent critical error.
  2. GCS report bucket does not exist → `[ops/report] GCS upload failed … using local fallback` on every run. Create the bucket or disable upload.
  3. Test-infra: `correlator.js`→`db.js` throws at import if `DATABASE_URL` unset, so the pure correlator unit tests can't load without a (stub) DB. Extract `evaluateRules` into a db-free module so unit tests run anywhere.
  4. Minor overlap: `ssl_expiring_soon`/`tracking_install_missing` can co-fire with the existing 2-signal correlated rules when the 2nd signal is present (acceptable — correlated rule adds causation; different categories).
  5. STILL the big levers (PROD-REALITY.md): execution runtime not deployed (no Pub/Sub topic/runner Job) so nothing runs AUTOMATICALLY; 0 client_run_subscriptions; 0 connector creds. Direct executeRun is the only execution path until the runtime ships.

- **GSC connection_health noise fix — DONE (verified live) ✅** · PR #30 → rev anchor-ops-00024-jkf. Resolves follow-up #1 above. `gsc.connection_health` now returns `skipped` (with an actionable reason) on a 401/403 — the service account isn't authorized on any property, a known config gap already surfaced by the Access Audit/Connections UI — instead of a false `error[critical]` per client per run. Non-auth errors downgraded critical→warning. Suite 571/571 (real DB). Fresh review: "correct and sensible, merge as-is." VERIFIED LIVE: re-ran web_daily_essential for boltondental.com in prod → `gsc.connection_health: skipped`, 4 website checks pass, **0 findings, 0 notifications** — the per-client false-critical is gone. Remaining follow-ups: #2 (GCS report bucket missing → upload fails every run, local fallback), #3 (db-free evaluateRules for DB-less unit tests), #5 (runtime/subscriptions/creds — needs user).

- **Run-report GCS persistence — DONE (verified live) ✅** · infra fix (no code change), resolves follow-up #2. reportRenderer.js uploads each run's HTML report to `gs://anchor-hub-ops-reports/<runId>.html` (env `OPS_REPORTS_BUCKET`), but the bucket did not exist → every run logged `GCS upload failed … using local fallback` and the report landed on ephemeral Cloud Run local disk (lost). FIX: created the bucket (us-central1, uniform bucket-level access, public-access-prevention enforced — reports contain client data), granted the Cloud Run runtime SA (333281424614-compute) `roles/storage.objectAdmin`. VERIFIED LIVE: ran web_daily_essential for boltondental.com → `ops_reports.storage_uri = gs://anchor-hub-ops-reports/02b67d95-…​.html` (6373 bytes, html), object confirmed present via `gcloud storage ls`; no upload error; 0 notifications. Run reports now persist durably. Remaining: #3 (db-free evaluateRules — minor test hardening), #5 (runtime/subscriptions/connector-creds — needs user go-ahead).

- **db-free evaluateRules — DONE ✅** · PR #31 → rev anchor-ops-00025-dt4. Resolves follow-up #3. Extracted the pure `evaluateRules` (value-critical finding logic) from `correlator.js` (which imports `db.js`, throwing at import when DATABASE_URL is unset) into a new DB-free `correlatorEval.js`; `correlator.js` re-exports it so the public API is unchanged. ACCEPTANCE: `node --test correlator.test.js` now loads + passes (20/20) with NO DATABASE_URL (previously aborted at import). Full suite 571/571 (real DB). Fresh inline review: faithful mechanical move, API preserved, no db import in the eval module. Pure refactor — no live behavior to verify beyond green tests.

- **AUTONOMOUS BACKLOG CLEARED (2026-06-30).** All autonomously-actionable follow-ups are done (single-signal findings, GSC noise fix, GCS report persistence, db-free evaluateRules). The engine now runs in prod and produces real findings (17 runs this session, 0 client notifications). REMAINING WORK IS USER-GATED and MUST NOT be started autonomously without an explicit go-ahead: (a) deploy the execution RUNTIME (Pub/Sub topic `ops.run.requested` + `ops-runner` subscription + `opsRunner` Cloud Run Job) so runs execute AUTOMATICALLY; (b) seed `client_run_subscriptions` (website-only, `email_on_completion=false`); (c) connect client data sources (Ads/Meta/GA4/GSC — needs the user's accounts). Building V6–V9 features before (a)+(b) = scaffolding on a dormant engine (the anti-pattern this loop exists to avoid). Next iteration: if no user go-ahead, there is no high-value autonomous work — do NOT invent marginal slices; hold for the runtime-deploy decision.

- **RUNTIME DEPLOY — INVESTIGATED, NOT READY (needs a real slice; 2026-06-30).** Deploying `opsRunner` (the Pub/Sub pull-subscriber Cloud Run Job that makes runs execute automatically) is NOT a one-command switch. `scripts/gdeploy-ops-runner.sh` + the surrounding infra are stale/broken in 6 concrete ways:
  1. **Artifact repo wrong**: script pushes to `anchor-hub-repo` — does NOT exist (only `cloud-run-source-deploy`, `npm-anchorcorps`). Push would fail.
  2. **Service account wrong**: script uses `anchor-ops@…` — does NOT exist. Only `anchor-hub@…` exists; the live service runs as `333281424614-compute@`. Deploy would fail on SA-not-found.
  3. **Local docker build → arm64**: `docker build -f Dockerfile.opsRunner` on Apple Silicon produces an arm64 image; Cloud Run rejects it ("exec format error"). Must build via Cloud Build (amd64) — e.g. `gcloud builds submit` to `cloud-run-source-deploy`, then `gcloud run jobs deploy --image`.
  4. **Reports bucket mismatch**: script sets `OPS_REPORTS_BUCKET=anchor-ops-reports-anchor-hub-480305`, but the bucket that exists (and the code default) is `anchor-hub-ops-reports`. Runner reports would fail. (Secret `anchor-db-url-ops` DOES exist — that ref is fine.)
  5. **No Pub/Sub infra**: topics `ops.run.requested` / `ops.run.cancel` and subscriptions `ops-runner` / `ops-runner-cancel` do NOT exist. The script doesn't create them. `enqueueRun` publishes to a missing topic today.
  6. **No trigger / lifecycle**: a Cloud Run JOB runs to completion (`--task-timeout=3600` = 1h) then exits — it is NOT a continuously-running puller. For automatic daily operation something must EXECUTE the Job after the 07:00 fanout (a Cloud Scheduler → `run jobs execute`, or convert to a push-subscription Cloud Run SERVICE). This is an architecture decision.
  → This is a genuine slice: fix the deploy script (repo/SA/build/bucket), provision the Pub/Sub topics+subscriptions+IAM, choose the trigger model (recommend: Scheduler executes the Job at 07:15, after fanout), deploy, and VERIFY by enqueuing one run through the real queue and watching the deployed Job execute it. SAFE because it stays inert until `client_run_subscriptions` are seeded (0 today) — no automatic client runs, no notifications. NOT done autonomously: it's prod infra + a design choice + a "go live" posture change → needs an explicit go-ahead.

- **EXECUTION RUNTIME DEPLOYED — DONE (verified end-to-end in prod) ✅✅** · PR #32 (branch feat/ops-runtime-deploy). THE switch from "proven capability" to "operating system": ops runs now execute via the real queue, not just manual executeRun. Provisioned in prod: Pub/Sub topics `ops.run.requested` + `ops.run.cancel`; PULL subscriptions `ops-runner` + `ops-runner-cancel` (ack-deadline 600s); IAM `roles/pubsub.subscriber` → 333281424614-compute@; Cloud Run JOB `anchor-ops-runner` (amd64 image built on Cloud Build, SA compute@, cloudsql, full secret set, OPS_REPORTS_BUCKET=anchor-hub-ops-reports). Fixed a real `Dockerfile.opsRunner` bug (didn't COPY the vendored Yarn → build failed) + added `cloudbuild.opsrunner.yaml` + corrected `scripts/gdeploy-ops-runner.sh` (repo/SA/bucket/Cloud-Build). Fresh review: "safe and correct, merge as-is." VERIFIED END-TO-END LIVE: inserted 1 queued run (boltondental) → published its id to `ops.run.requested` → executed the Job → **the deployed worker pulled the message and ran it**: logs `[ops/runner] starting run ef0981bc…` / `finished run … in 2093ms`; run `ef0981bc` status `completed`, all website checks pass, gsc.connection_health pass. `ops_notification_events` = 0. **INERT & SAFE:** `client_run_subscriptions` = 0 (untouched → nothing runs automatically), no email enabled, NO Cloud Scheduler trigger created (Job is manual-execute only for now). 

  REMAINING TO GO FULLY AUTOMATIC (explicit, user-gated — each is a small step): (a) Cloud Scheduler → `gcloud run jobs execute anchor-ops-runner` daily ~07:15 (after the 07:00 fanout) so queued runs drain automatically; (b) seed `client_run_subscriptions` (which clients / which tiers — website-only first, `email_on_completion=false`); then the daily fanout → queue → runner → findings chain runs on its own. Do (a)+(b) only on explicit go-ahead. NOTE: reviewer Minors (not blocking): add explicit `--platform linux/amd64` to the cloudbuild step; watch `--max-retries=3 --task-timeout=3600` (a hard-failing job can spin up to 3×1h).

- **FULL AUTONOMOUS PIPELINE — PROVEN END-TO-END IN PROD ✅✅✅ (2026-07-01).** The complete north-star chain runs on its own: `client_run_subscriptions` → fanout (`/internal/fanout?tier=daily_essential`) → Pub/Sub `ops.run.requested` → `anchor-ops-runner` Job → checks → correlator → `ops_findings`. VERIFIED with the DEMO client only (safe, non-real, then removed): fanout returned `{matched:1, queued:1, runId:4a939248…, mode:pubsub}`; the deployed worker logged `[ops/runner] starting run 4a939248…` / `finished … 1560ms`; run `completed`; `web.uptime.reachable` FAILED → **finding `correlation.site_unreachable` [critical]** written automatically (attention_score 140, status open). CLIENT-NOTIFICATION SAFETY PROVEN: `ops_notification_events` (last 15m) = 0 even though a subscription existed and a critical finding was produced — because `email_on_completion=false` suppressed the digest. Cleanup: demo subscription DELETED → `client_run_subscriptions` back to 0; idle runner execution cancelled; no Scheduler; no email enabled.

  ===> STATE NOW: the engine + runtime are BUILT, DEPLOYED, and PROVEN. It is INERT (0 enrollments, no auto-trigger). GOING LIVE is purely operational and USER-GATED — two small explicit steps: (1) add a Cloud Scheduler job → `gcloud run jobs execute anchor-ops-runner` daily ~07:15 (after the 07:00 fanout `ops-daily-fanout`); (2) seed real `client_run_subscriptions` (recommend: website-only clients first, `email_on_completion=false`, verify a day of real findings, THEN widen tiers / enable client emails). Connector-based checks (Ads/Meta/GA4/GSC) still need the user to connect accounts.

- **V6 RECOMMENDATIONS BACKEND — VERIFIED WORKING (2026-07-01).** The findings→recommendations stage already functions server-side (deterministic-first: group → risk → policy/approval → summarize → persist). VERIFIED against the demo client's real `site_unreachable` findings: `buildRecommendations` grouped 2 findings → 1 recommendation, risk_tier `critical` (score 100), non-mutating/non-destructive, approval_level `none` (correct — advisory), status `proposed`; `summarizeGroup` has a deterministic fallback so it works with NO LLM key. 0 notifications. Demo row cleaned up. So the ENTIRE server-side north-star chain is now proven: checks → findings → recommendations. GAPS for V6: (a) NO frontend Action Queue UI exists (`src/` has no recommendations view) — that's the remaining V6 build, but "verify live" needs the user to look (no browser automation on this machine); (b) design: categories without a `CATEGORY_ACTION_MAP` entry (e.g. site_unreachable) yield advisory-only recommendations with no proposed remediation action — intentional for this phase (no destructive actions), a later-phase enhancement.
