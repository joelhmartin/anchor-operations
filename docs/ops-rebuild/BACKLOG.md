# Operations — Production-Quality Completion Loop (BACKLOG)

**Read this FIRST every loop iteration.** This drives an autonomous, self-resuming
local loop that finishes the north-star to **production quality**, slice by slice,
where every slice ends in **observed, useful behavior** — not "tests pass, done."

Runs **locally** (full gcloud / Cloud SQL proxy / deploy / real DB access).
Spec: `docs/superpowers/specs/2026-06-28-north-star-realignment-design.md`.
North-star: the autonomous marketing-ops agent (daily checks → findings →
recommendations → Google Chat → approvals → safe actions).

---

## Definition of Useful-Done (ALL must hold — no exceptions)

A backlog item may be marked `done` ONLY when:

1. **It does the useful thing end-to-end** — not a stub, not "basic functionality."
   A human (or a command) can actually accomplish the item's stated behavior.
2. **I ran it and observed the behavior** — real evidence captured in this file
   (command output, a Chat message id, a DB row, an HTTP code, a rendered screen
   described). "It builds / the suite is green" is necessary but **NOT** sufficient.
3. **A fresh-context reviewer agent approved it** — a subagent with NO prior context
   was given the slice + the item's acceptance and asked: *"Is this genuinely useful
   and production-quality, or basic scaffolding? What's missing for a real user?"*
   Its Critical/Important findings were fixed and it re-approved.
4. **Shipped through the gate** — CI `build` green, merged via PR, deployed to prod,
   verified live.
5. **Evidence recorded** here as: `done — <one line a human can now actually do> · <evidence>`.

If any of 1–4 fails, the item stays `todo`/`needs-rework`. **Never declare done to move on.**

---

## Iteration protocol (each loop pass)

1. `git checkout main && git pull`. Read this file + STATE.md. Pick the highest-value
   item that is `todo` or `needs-rework` (rework beats new work).
2. Build the slice locally, end-to-end (real behavior, real data paths).
3. **Verify by running it** — locally and/or against prod via the Cloud SQL proxy
   (read-only for prod data; the deploy step writes). Capture the evidence. If it
   doesn't actually work or isn't useful, keep building — do not advance.
4. **Fresh-context review** — dispatch a subagent (clean context) with the diff +
   acceptance: "useful & production-quality, or scaffolding? find gaps." Fix findings.
5. Build + `test:ops` green → branch → PR → wait for CI `build` green → merge →
   deploy (`scripts/gdeploy.sh`) → verify live.
6. Mark the item `done` with evidence. Append a STATE.md run-log line.
7. If context is getting large, schedule a wakeup to resume; else continue to next item.

**Yarn:** always `node .yarn/releases/yarn-4.10.3.cjs <cmd>` (vendored; never npm).
**Branch protection:** `main` requires the CI `build` check — every merge goes through it.

---

## Backlog (value-ordered; the loop works top-down)

Status: `todo` → `in-progress` → `needs-rework` → `done`

| # | Slice | Useful behavior (acceptance = observed) | Status |
|---|---|---|---|
| V1 | **Live access verification** | Access Audit credential cards actually call each API and show "verified, N accounts/sites" or "failed: reason" — Kinsta, CTM, Google Ads, GA4, GSC, Meta. ACCEPTANCE: run audit in prod, ≥1 service shows a real verified count. | **done** ✅ (PR #24, rev 00018) |
| V2 | **Daily digest auto-posts to Chat** | Cloud Scheduler → internal endpoint → real digest in the Chat space every morning. ACCEPTANCE: trigger the internal endpoint, observe a real digest message land; scheduler job exists. | todo |
| V3 | **Per-client Service Connections UI** | Open a real client → see per-platform connection status from real data → "Verify" button updates it live. ACCEPTANCE: open a client, see states, click verify, watch it change. | todo |
| V4 | **Run pipeline actually runs new checks** | A `daily_essential` run for one client collects website/uptime + connector checks → writes real `ops_findings`. ACCEPTANCE: trigger a run, see new findings in the Findings inbox. | todo |
| V5 | **Snapshots scheduled → baselines compute** | Daily snapshot collection runs; after enough days, baselines populate; an anomaly check fires. ACCEPTANCE: snapshot rows for a client; a baseline row; one anomaly finding. | todo |
| V6 | **Recommendations → Action Queue UI** | Findings produce recommendations shown with evidence; approve/reject writes the audit chain. ACCEPTANCE: see a recommendation in the UI, approve it, see the audit row. | todo |
| V7 | **Google Chat commands** | `/anchorops daily`, `/anchorops clients`, `/anchorops client <name>` return real data in the Chat app. ACCEPTANCE: type a command, get a real reply. | todo |
| V8 | **Critical findings → Chat alerts** | A new critical finding posts a real alert to Chat (threaded). ACCEPTANCE: create/observe a critical finding, see the alert. | todo |
| V9 | **Quality hardening pass** | Loading/empty/error states, auth + rate-limit on new endpoints, no-data graceful, PII/secret audit on every new path. ACCEPTANCE: reviewer pass finds no Critical/Important. | todo |

The loop may **groom** this backlog (split/add items) as it learns — record changes here.

---

## Evidence log (done items, with proof)

(Each completed slice appends: `Vn done — <what a human can now do> · <evidence: output/msg-id/row/url>`.)

- (none done yet.)

## Loop progress (resume here)

- **V1 in-progress** on branch `feat/ops-v1-live-verify`. Done so far: `liveVerify.js`
  runs real per-service API calls and overrides the audit's presence-based status;
  wired into `accessAudit.js`; **Kinsta verifier PROVEN against the live API
  (`verified — reached Kinsta, 114 sites`)**; offline unit tests added.
  **Proven live so far (real API calls, creds from Secret Manager):** Kinsta 114 sites ·
  CTM 77 accounts · Meta 31 ad accounts · Mailgun 64 domains. Suite 524/524.
  **Remaining for V1:** Google Ads (`checks/google_ads/_client.js` GoogleAdsApi →
  `listAccessibleCustomers`), GSC (reuse `connections/gsc/auth.js` → `sites.list`),
  GA4 (GA4_SERVICE_ACCOUNT_KEY → accountSummaries; may need `@google-analytics/admin`).
  Then: fresh-context review → PR → green CI build → merge → deploy → run the audit in
  prod and confirm verified counts render on the Access Audit page → mark V1 done.
  - To fetch a cred locally for a live test: `gcloud secrets versions access latest --secret=<NAME> --project=anchor-hub-480305`. Agency secret names: KINSTA_API_KEY, KINSTA_AGENCY_ID, CTM_API_KEY, CTM_API_SECRET, GOOGLE_ADS_DEVELOPER_TOKEN/REFRESH_TOKEN/CLIENT_ID/CLIENT_SECRET/MANAGER_ID, GA4_SERVICE_ACCOUNT_KEY, FACEBOOK_SYSTEM_USER_TOKEN, MAILGUN_API_KEY/DOMAIN.

- **SOCIAL (system-user Facebook posting) — DONE** (user-verified "it's reading the pages") · PR #23 → revision anchor-ops-00017-87v. Create-post is scoped to the client's tab (no picker, no OAuth gate); links a client's Page from the 22 system-user-accessible Pages; posts via the system-user Page token (proven: 204-char token resolved, no posting). Dormant grant-access API for Pages outside the 22.

- **V1 (live access verification) — DONE** ✅ · PR #24 → revision anchor-ops-00018-tsw. Fresh review caught a real "verified-0 renders green" bug + missing fetch timeouts + token-in-URL; all fixed before ship. Proven live against real APIs (creds from Secret Manager): Kinsta 114 sites, CTM 77 accounts, Meta 31 ad accounts, Mailgun 64 domains, Google Ads 3 accessible customers, GA4 62 properties (44 accounts) — all 🟢 verified; Search Console 🟡 degraded "reached but 0 sites visible — service account not added to any property" (honest finding, not a false green). A human now opens Operations → Portfolio → Access Audit → Run audit now and sees real per-service verified counts. ACTION FOR USER: add the GA4 service account to Search Console properties to light up organic-search.

- **V2 (daily Chat digest) — IN PROGRESS, deploy pending.** Built + reviewed + fixed + MERGED (PR #25, commit f2bb308 on main). Scheduler job `ops-chat-daily-digest` created (8am America/Chicago, OIDC via compute SA). Cloud Scheduler API enabled. BLOCKER: Cloud Build queue was congested (first build stuck QUEUED ~27min, cancelled); re-deploying. ON RESUME: confirm new revision live (POST /api/ops/internal/chat-digest returns authorizeFanoutRequest's 'Missing bearer token', not requireAuth's 'TOKEN_EXPIRED_OR_INVALID'), then `gcloud scheduler jobs run ops-chat-daily-digest`, verify a digest event (ops_notification_events event_type='agency_daily_digest' status sent) + the Chat message, then mark V2 done. Do NOT rebuild V2 — it's merged. NOTE: old F0-F9 cloud routines (trig_01T9…, trig_01BCk…) DISABLED.
