# North-Star Realignment — Design Spec

**Date:** 2026-06-28
**Status:** Locked (foundation-first re-plan)
**Supersedes nothing** — this reconciles the *Anchor Operations Autonomous Agent
North-Star Build Plan* + *Expandable Integration Architecture Requirement* with the
system already shipped (`docs/OPERATIONS.md`).

---

## 1. Purpose

The north-star describes an **autonomous marketing-operations employee**: a
capability/provider/asset platform with a longitudinal learning loop, Google Chat
as the operator cockpit, and a structured recommendation→action engine.

What is **shipped** is a strong but narrower **multi-platform health-check + AI-chat
system** organized around four hard-coded umbrellas (`website`, `google_ads`,
`meta`, `ctm`).

The decision (2026-06-28): **foundation-first re-plan** — insert the missing
foundation *underneath* the existing spine with backward-compatible shims, build
every aspect methodically, throw away nothing that works.

---

## 2. What is already true (keep — do not rebuild)

These honor the north-star and are load-bearing. New work builds on them.

| Capability | Where | North-star section satisfied |
|---|---|---|
| Run lifecycle + registry fan-out | `runExecutor.js`, `runQueue.js`, `checks/registry.js` | §1.1, §20 |
| Cross-platform correlator | `correlator.js`, `correlatorRules.js` | §16.5 |
| Deterministic-first, AI-second | checks → findings → correlator → supervisor | §16.2 |
| No-direct-LLM-mutation + approval audit | `ops_tool_approvals`, 4-event chain | §17 |
| PHI sanitizer + HIPAA gate | `payloadSanitizer.js`, `meta/_hipaaGate.js` | §10 |
| Cost cap + budget guard | `costTracker.js`, `budgetGuard.js` | §6 |
| Orchestration (dev queue + Pub/Sub + Cloud Run Job + Scheduler) | `scheduleFanout.js`, `opsRunner.js` | §4, §20 |
| Email digest | `emailDigest.js` (Mailgun) | §16 (notification) |
| Client-first UI shell | `src/views/admin/Operations/` | §19 |

---

## 3. Reality reconciliation (north-star assumptions that are wrong for THIS repo)

The north-star was written aspirationally. These corrections are **binding** on every
downstream plan:

1. **Credentials are env-var / Postgres, not Secret Manager.**
   Agency creds resolve from `process.env` at read time (Cloud Run injects them);
   per-client creds live in `client_platform_credentials` (AES-256, `credentialStore.js`)
   with `credentials_source ∈ {agency_mcc, agency_sysuser, self_serve_oauth, env_var}`.
   `@google-cloud/secret-manager` is **not** a dependency.
   → The Access Audit checks **env-var presence + decryptability**, not Secret Manager API.
   Adding Secret Manager is a *future* option, not a Phase-0 requirement.

2. **`oauth_connections` and `tracking_configs` do not exist.** Ignore those names
   from north-star §0.2. The credential source of truth is `client_platform_credentials`.

3. **Pre-existing client tables are `users` + `client_profiles`** (not `ops_client_agent_profiles`
   yet). The roster pulls `FROM users` joined to `client_profiles`. `client_profiles`
   carries `client_type` (HIPAA flag) and `ops_monthly_cap_cents`.

4. **`@google-cloud/pubsub` is present; Secret Manager / GA4 / GSC / Tag Manager
   client libs are not.** Each new external connector names its own dependency in its plan.

5. **In-app `ops_chat_*` is the Vertex AI assistant, NOT Google Chat.** Google Chat
   (the operator cockpit) is greenfield — new tables, new route, no overlap.

---

## 4. The one architectural decision (locked)

**Reframe `umbrella` → `service_category` + `provider`, and make checks declare
required capabilities — with a back-compat shim so nothing breaks on day one.**

The shipped registry keys checks by `umbrella: website|google_ads|meta|ctm`. The
expandable-architecture doc is explicit that this is the anti-pattern (a "website"
that conflates host + CMS + public site cannot absorb Vercel, a React site, or GA4
without bespoke code).

Locked model:

```
service_category   hosting | cms | website | analytics | organic_search |
                   paid_ads | call_tracking | chat | repo | deployment | task
provider           kinsta | wordpress | public_http | ga4 | search_console |
                   google_ads | ctm | meta | google_chat | github | monday | vercel ...
capability         read, crawl, inspect_html, list_pages, create_draft, publish,
                   clear_cache, create_backup, run_wp_cli, mutate, ...
```

**Migration strategy (no break):**
- Existing `umbrella` values map deterministically onto `(service_category, provider)`:
  `website → {website/public_http, hosting/kinsta, cms/wordpress}`,
  `google_ads → paid_ads/google_ads`, `meta → paid_ads/meta`,
  `ctm → call_tracking/ctm`.
- `registry.js` keeps accepting `umbrella` (derives category/provider from it) **and**
  accepts an explicit `serviceCategory`/`provider`/`requiredCapabilities`. Old checks
  keep registering unchanged; new checks use the richer contract.
- The executor gains a capability gate: a check whose `requiredCapabilities` aren't
  satisfied by the client's connections is **skipped with a reason**, never errored.

**Hard rule for all future work:** do not add new vendor-named umbrella checks. New
integrations arrive as connector modules implementing the shared contract.

---

## 5. Connector contract (locked interface)

Every integration — current and future — implements one shape
(`server/services/ops/connections/registry.js`):

```js
export default {
  id: 'wordpress',
  serviceCategory: 'cms',
  provider: 'wordpress',
  connectionTypes: ['service_account', 'oauth', 'api_key', 'webhook', 'ssh'],

  async verifyConnection(ctx),     // → { status, detail, capabilities }
  async discoverInventory(ctx),    // → ops_platform_inventory rows
  async collectSnapshot(ctx),      // → ops_daily_snapshots rows (normalized)
  async listCapabilities(ctx),     // → capability map

  actions: {                       // optional
    async preflight(actionType, args, ctx),
    async execute(actionType, args, ctx)
  },
  checks: []                       // capability-gated check ids
}
```

The five-layer law (north-star §1.2) is enforced by the contract order:
**Connection → Inventory → Snapshot → Checks → Actions.** No connector may jump from
connection straight to AI recommendations.

---

## 6. New tables (generic-first; specialized only where volume demands)

Added via the existing ops migration runner. Names follow the generic model.

| Table | Replaces / extends | North-star |
|---|---|---|
| `ops_access_audit_runs` | (new) | §0.3 |
| `ops_service_connections` | formalizes `client_platform_credentials` linkage | §2.1 |
| `ops_client_assets` | (new) — a client's web presence as assets, not one WP install | expandability §6 |
| `ops_platform_inventory` | (new) | §2.3 |
| `ops_daily_snapshots` | (new) | §2.4 |
| `ops_metric_baselines` | extends `ops_phase0_drift_baseline` thinking | §2.5 |
| `ops_action_recommendations` | structures what `ops_tool_approvals` only audits | §2.6 |
| `ops_notification_events` | (new) — Chat/email/dashboard delivery log | §2.7 |
| `ops_chat_user_mappings` | (new) — Google Chat user → Anchor user | §2.8 |
| `ops_agent_memory` | (new) — curated per-client memory | §2.9 |
| `ops_client_agent_profiles` | extends `client_profiles` (goals/policies) | §2.2 |

`client_platform_credentials` stays as the encrypted secret store;
`ops_service_connections` references it via `credential_ref` and owns the
status lifecycle (`missing → configured → verified → degraded → failed → disabled`).

---

## 7. Re-sequenced roadmap (foundation underneath the spine)

Each phase is its **own plan** producing working, testable software. Build in order;
all aspects matter, none skipped.

| # | Plan | Delivers | Unblocks |
|---|---|---|---|
| **F0** | **Access Audit** | Prove access per service per client; green/yellow/red; `ops_access_audit_runs`; `/api/ops/access/audit`; dashboard page; infra plan/apply reconciliation | Trust; everything |
| **F1** | **Connection / capability / asset model** | `ops_service_connections` + `ops_platform_inventory` + `ops_client_assets`; connector registry + contract; umbrella→category/provider shim; capability gate in executor | All connectors |
| **F2** | **Inventory discovery** | `discoverInventory` for each existing provider (kinsta, wordpress, public_http, google_ads, meta, ctm) | Snapshots |
| **F3** | **Snapshots + baselines + memory** | `ops_daily_snapshots`, `ops_metric_baselines`, `ops_agent_memory`; baseline engine; anomaly scorer; memory updater | "Knows normal" |
| **F4** | **Recommendation → action engine** | `ops_action_recommendations`; deterministic group→summarize→risk→policy pipeline; preflight; capability-aware abstract→provider action resolver | Safe acting |
| **F5** | **Google Chat cockpit** | Webhook digests/alerts/approvals (Phase 1) then interactive app (Phase 2): events endpoint, user mapping, commands, cards, approval buttons; `ops_notification_events`, `ops_chat_user_mappings` | Operator UX |
| **F6** | **GA4 connector** | Full analytics/ga4 connector (verify/discover/snapshot/checks) — the missing "is it ads, website, or tracking?" leg | Cross-platform reasoning |
| **F7** | **GSC depth + Search Console connector** | Promote the single GSC check into a full organic_search/search_console connector | Organic visibility layer |
| **F8** | **Client agent profiles** | `ops_client_agent_profiles` (goals, target CPA, budgets, policies) + UI | Per-client policy |
| **F9+** | **New providers** | GTM, GBP, Monday, GitHub, Vercel/Netlify — each a connector module, zero core changes | Expandability proof |

**F0 is the mandated first step (north-star §0.4 hard rule, §23).** No deeper
integration work begins until the audit can say what is connected, missing, or
misconfigured.

---

## 8. Non-goals for the foundation phases

- No new vendor-named umbrella checks (locked §4).
- No LLM math / no LLM mutation (unchanged from shipped posture).
- No destructive provider actions (restore/delete) in any foundation phase.
- No Secret Manager migration (env-var model stays until a phase explicitly proposes it).
- No GBP/Monday/GitHub/Vercel until F9 (placeholders only).

---

## 9. Acceptance for the foundation as a whole

The system can answer, from inside Cloud Run, *per client*:
1. Which services are connected / missing / misconfigured (F0).
2. What external objects exist for each (F1–F2).
3. What is normal, and what changed vs normal (F3).
4. What it recommends, at what risk, requiring what approval (F4).
5. Reachable + actionable from Google Chat (F5).

…without rewriting the executor, the dashboard, or the agent to add the next
integration (expandability §12).
