# PROD REALITY — the Operations engine has never run in production

> Read this BEFORE picking up the BACKLOG loop. Written 2026-06-30 from a
> read-only prod inspection (Cloud SQL `anchor-hub-480305:us-central1:anchor`
> via the proxy, admin creds from Secret Manager `DATABASE_URL`).

## The one fact that matters

In **production**, all-time:

| table | rows | meaning |
|---|---|---|
| `ops_runs` | **0** | no run has ever executed |
| `ops_check_results` | **0** | no check has ever produced a result |
| `ops_findings` | **0** | the engine has never produced a single finding |
| `ops_daily_snapshots` | 0 | V5 never collected a snapshot |
| `ops_metric_baselines` | 0 | V5 never learned a baseline |
| `client_run_subscriptions` | **0** | no client is subscribed to any run-def |

This is the real answer to "why is nothing different / useful." The code
(F0–F9, V1–V5) was BUILT, but the production **runtime was never switched on**
and **no client data sources are connected**. Verifications recorded as "DONE"
in BACKLOG (e.g. V4's "a real web_daily_essential run wrote ops_check_results")
were run **locally against a dev DB**, NOT against prod — so they did not
reflect production reality. That is precisely the "looks done, isn't useful"
trap this loop exists to stop. Treat local-only evidence as insufficient:
**Useful-Done requires the behavior observed in PROD.**

## Switch-on gaps, in dependency order (each blocks the next)

1. **Execution runtime not deployed.** There is no Pub/Sub topic
   `ops.run.requested`, no `ops-runner` subscription, and no `opsRunner`
   Cloud Run Job. In prod, `enqueueRun` (runQueue.js) publishes to a topic that
   does not exist and nothing consumes the queue → runs can never execute.
   (Locally, an in-memory worker runs them — which is why local "proofs" passed.)
   → Deploy: create topic + subscription + the `server/jobs/opsRunner.js` Cloud
   Run Job (push or pull). Until then, the ONLY way to execute is to call
   `executeRun(runId)` directly.

2. **No client subscriptions.** 8 run-defs exist (6 `default_for_new_clients`),
   but `client_run_subscriptions` is empty, so the daily fanout
   (`ops-daily-fanout`, 07:00) joins to nothing. → Seed subscriptions (which
   clients / which tiers / what cadence is a cost+scope decision for the user).

3. **No connector credentials.** `client_platform_credentials` = 0,
   `ops_service_connections` = 0, `ops_gsc_site_inventory` = 0,
   `social_media_tokens` = 0, `meta_page_links` = 0. The only `oauth_connections`
   are 2 google rows for the user's own account ("Joel Martin"). So Google
   Ads / Meta / GA4 / GSC checks would all `skip`/`degrade`. → These require the
   USER (connect each client's accounts; grant the GA4/GSC service account on
   Search Console + GA4 properties). Cannot be done by an agent.

   **BUT:** the **website** checks (`web.uptime.reachable`, `web.ssl.*`,
   `web.tracking_install`) need only a website URL, and **43 of 50** clients have
   one (`brand_assets.website_url`). So the engine CAN produce real, useful
   findings (down sites, expiring SSL, missing tracking) with zero account
   connections — once the runtime (gap 1) and subscriptions (gap 2) are on.

4. **V5 snapshot collection has no scheduler + only one connector.** No Cloud
   Scheduler job hits `POST /api/ops/internal/snapshot-collect`, and
   `DEFAULT_SNAPSHOT_CONNECTORS = [gscConnector]` (GSC only). GSC returns 0
   because the service account isn't on any property. To make V5 collect real
   data, add a snapshot-collect scheduler job AND wire GA4 (it has a real
   `collectSnapshot`, but its default export needs a client-resolving wrapper
   like GSC's — resolve `getCredential(clientUserId,'ga4').account_id`). Both
   still depend on gap 3 for data.

## ⚠️ Notification hazard (user instruction 2026-06-30)

`executeRun` → `emailDigest.sendRunSummary(runId)` on completion. It sends ONLY
when the run's subscription has `email_on_completion = true`, and the recipient
is **the client's own primary email** (`users.email`). User instruction: **never
run a test that could notify real clients.** Before any prod run wave, ensure
`email_on_completion = false` (and any Chat/finding alerts are internal-only)
until the user explicitly approves client-facing delivery. The north-star
approval gate (review findings internally first) is the right design here.

## V5 status (PR #28, merged, rev anchor-ops-00022-mzk)

Anomaly scoring + schema + grants + run-def `baselines_daily_essential` SHIPPED
and verified at unit (560/560), migration (applied in prod), and endpoint
(`/internal/snapshot-collect` → HTTP 200 over 85 clients) levels. Review fixes
C1/I1/I2/I3/I4 (no crying-wolf on thin/favorable/near-zero data) landed.
**NOT useful-done:** the chain is dormant — it collects 0 because of gaps 1–4.

## Recommended next directive (for a fresh agent)

Do NOT keep building V6–V9 analysis features on an engine that has never run.
Highest-value, honest path:
1. With the USER's go-ahead: deploy the execution runtime (gap 1), seed a small
   website-only subscription set with `email_on_completion=false` (gaps 2+3-safe),
   trigger one real PROD run wave, and confirm real `ops_findings` appear in prod.
   THAT is the first true end-to-end proof. Keep client notifications OFF.
2. Then decide connector onboarding (gap 3) — a user/account task — before
   wiring Ads/Meta/GA4 deeper.
