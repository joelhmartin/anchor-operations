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
