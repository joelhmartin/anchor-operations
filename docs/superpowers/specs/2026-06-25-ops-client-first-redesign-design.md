# Operations Client-First Redesign — Design

**Date:** 2026-06-25
**Status:** Design / spec. Next → implementation plan.
**Home:** `anchor-operations` — restructure of the `/operations` command center UI.
**Parent context:** content-marketing suite (`docs/superpowers/specs/2026-06-23-content-marketing-vision.md`). This redesign reorganizes the surfaces that suite built (social, blog, chat) plus the existing checks/findings engine into a coherent client-first IA.

---

## 1. Problem & goal

**Problem.** Today's ops UI is **feature-first**: five tabs (Command Center, Discoveries, Chat, Bulk, Content), each mixing all clients together, and each with a *different* way of choosing a client — Chat has a dropdown, Discoveries uses a hidden query-param filter, Content is per-post, Command Center is aggregated, Bulk is global. There is **no single "which client am I looking at" concept**. The result reads as "everything splattered into one big view." Separately, the per-client **Kinsta "Sites"** feature was orphaned in the Phase-10 rebuild (9 tabs → 5): its components, `kinsta_*` tables, and `/api/operations/sites` endpoints are all still live, but the UI was never re-wired, so there is no way to assign a Kinsta site to a client anymore.

**Goal.** Flip ops to a **client-first** information architecture with one URL-driven active-client context, mirroring how the main dashboard organizes per client. Each account gets its own page with all of its sections (overview, findings, socials, blog, sites, chat, and config). A curated **Home** digest greets the user with what needs attention today. Genuinely cross-client tools move to a **Portfolio** area. Revive the Kinsta Sites feature as a per-client section. Wipe the accumulated test activity data (surgically — shared DB).

**Non-goals.**
- Not rebuilding the checks/runs/findings engine, the automations, or the chat agent loop — those stay; only the *surfacing* IA changes.
- Not refactoring the `client_id` vs `client_user_id` column-naming inconsistency (mapped at the query layer; a rename is risk with no user benefit).
- Not building new content/SEO features (that's sub-projects C/D) — this organizes what exists.
- Not touching the main dashboard. (Context: the dashboard is being narrowed to leads + analytics + eventual CRM and will stop owning posting/SEO — ops becomes the canonical home for all posting + SEO. This design assumes no parity obligation with going-away dashboard content features.)

---

## 2. Verified current state (exploration 2026-06-25)

- **UI entry:** `src/views/admin/Operations/index.jsx` — `WORKSPACE_TABS` = Command Center, Discoveries, Chat, Bulk, Content (5 tabs); back-compat alias map redirects old URLs (`sites`/`cost` → `command-center`, with no content behind them).
- **Client identity:** roster from `listOpsClientRoster()` (`server/services/ops/clientRoster.js`); display name resolved by `src/views/admin/Operations/_clientLabel.js` (order: `client_identifier_value` → `client_label` → `business_name` → `first_name` → `email` → `id`).
- **Per-feature client scoping (already present):**
  | Feature | Table | Client column |
  |---|---|---|
  | Runs (health checks) | `ops_runs` | `client_user_id` |
  | Findings / Discoveries | `ops_findings` | `client_user_id` |
  | Chat threads/messages | `ops_chat_threads` / `ops_chat_messages` | `client_user_id` |
  | Social posts | `social_posts` | `client_id` |
  | Blog posts | `ops_blog_posts` | `client_id` |
  | Kinsta site mapping | `kinsta_site_clients` (junction → `kinsta_sites`) | `client_user_id` + `relationship` |
  | Credentials | `client_platform_credentials` | `client_user_id` |
  | Monthly cap | `client_profiles.ops_monthly_cap_cents` | (per user row) |
- **Orphaned but live:** `Sites/` components (`SitesTab.jsx`, `SiteDrawer.jsx`, `SiteTerminal.jsx`, `SiteWorkspaceEditor.jsx`, `SiteAssistant.jsx`, `SiteFindings.jsx`, `SiteCommandHistory.jsx`, `SiteClientLinks.jsx`); legacy router `/api/operations/sites*` (list/detail/sync/scan/terminal/exec); Kinsta tables `kinsta_sites`, `kinsta_environments`, `kinsta_site_clients`, `kinsta_site_workspaces`, `kinsta_ssh_command_log`.
- **`/api/ops/*` already provides** client-scoped: `/runs`, `/findings` (+ acknowledge/resolve/assign/ignore), `/clients`, `/clients/:id/subscriptions`, `/clients/:id/credentials*`, `/clients/:clientUserId/cap`, `/chat*`, `/blog*`; portfolio: `/command-center`, `/bulk/*`, `/skills/*`, `/recipes/*`, `/run-definitions`, `/checks`. Social lives under `/social/*`.
- **Known gaps to close opportunistically (flagged by exploration):** `/clients/:id/subscriptions` (PUT), `/clients/:id/credentials*` mutations lack an `isOperationsClient` guard; credential DELETE has no audit event. There is **no `/api/ops/sites*`** equivalent yet (only legacy `/api/operations/sites`).

---

## 3. Architecture — the new IA

URL-driven, three top-level destinations in a **slim left navigation rail**:

```
┌──────────────────────────────────────────────────────────────┐
│ ░ rail ░ │                                                     │
│  ⌂ Home  │   (destination content)                            │
│  ☷ Clients                                                     │
│  ▦ Portfolio                                                   │
└──────────────────────────────────────────────────────────────┘
```

- **Left rail** (always visible): Home · Clients · Portfolio. Slim icon+label rail, not top tabs.
- **Routing:**
  - `/operations` → redirects to `/operations/home`
  - `/operations/home`
  - `/operations/clients` (roster, no client selected) and `/operations/clients/:clientUserId/:section`
  - `/operations/portfolio/:section`
  - All legacy `?tab=` aliases continue to resolve (sites → a client's Sites section is not auto-resolvable without a client, so `?tab=sites` → `/operations/clients`).

### 3.1 Active-client context (the load-bearing fix)

A single React context `OpsActiveClientProvider` holds `{ clientUserId, client }`, hydrated from the `:clientUserId` route param and the roster. Every client-section component reads the active client from this context — **no component fetches its own client selector anymore**. This is what eliminates the inconsistent-selection splatter. Changing client = navigating the route; deep links are shareable.

### 3.2 Clients destination (roster → client page)

Two columns when a client is selected:

```
┌──────────────┬───────────────────────────────────────────────┐
│ CLIENT ROSTER│  Pearson Roofing                               │
│ search ▢     │  Overview │ Findings │ Socials │ Blog │ Sites │ │
│ ●Pearson Roof│  Chat │ ⚙ Config ▾                             │
│ ●Acme Dental │  ───────────────────────────────────────────  │
│  Gunnerson D │  (active section content for this client)      │
│  Smith Law … │                                                │
└──────────────┴───────────────────────────────────────────────┘
```

- **Roster sidebar:** searchable list from `/api/ops/clients`, each row a status dot (red = open critical findings; amber = approvals waiting / scheduled-today; grey = clear). Sorted attention-first. Label via `_clientLabel.js`.
- **Section tabs** (primary row): Overview · Findings · Socials · Blog · Sites · Chat.
- **Config group** (gear dropdown / secondary row): Health-check setup · Connections · Run history · Cost.

**Section sourcing (reuse vs build):**
| Section | Source | Build effort |
|---|---|---|
| Overview | NEW (`ClientOverview.jsx`) + `GET /api/ops/clients/:id/overview` | New, small — curated digest |
| Findings | reuse `Discoveries/DiscoveriesTab.jsx`, locked to active client | Re-scope |
| Socials | reuse Content social mode (calendar/queue + page links), locked to active client | Re-scope |
| Blog | reuse Content blog mode (`blog/BlogPane.jsx`), locked to active client | Re-scope |
| Sites | REVIVE `Sites/*` components, scoped via `kinsta_site_clients`; + assign-site picker | Re-wire + 1 endpoint |
| Chat | reuse `Chat/ClientChat.jsx` (already client-scoped) — drop its internal dropdown, read context | Re-scope |
| Health-check setup | reuse subscriptions UI (`/clients/:id/subscriptions`) | Re-scope |
| Connections | reuse credentials UI (`/clients/:id/credentials*`) | Re-scope + close auth gaps |
| Run history | reuse runs list (`/runs?client_user_id=`) + report links | Re-scope |
| Cost | reuse cost summary + cap (`/clients/:id/cap`) | Re-scope |

### 3.3 Per-client Overview (curated, not a firehose)

`ClientOverview.jsx` shows, for the active client only: top open/critical **findings** (capped, "notable" not all), content **scheduled today/soon** (blogs + social, with a review link into the relevant section), **site status** (live env up/SSL/last scan, from the Kinsta mapping), and a few headline counts (open findings, posts queued, MTD spend vs cap). Backed by `GET /api/ops/clients/:id/overview` returning a small curated payload (counts + top-N items), never a raw event stream.

### 3.4 Home (curated cross-client digest)

`/operations/home` — the actionable landing, backed by `GET /api/ops/home` (an extension/rename of the existing `/command-center` aggregate):
- **Needs attention** — clients with open critical findings (count + per-client rows → deep-link to that client's Overview).
- **Scheduled today** — blogs publishing today + social posts queued today, each with a **Review** action linking into the client's Socials/Blog section.
- **Approvals waiting** — pending chat tool-approvals across clients → deep-link to the client's Chat.
- Curated counts + top items only. No firehose.

### 3.5 Portfolio destination

`/operations/portfolio/:section` — the genuinely cross-client tooling, relocated from today's Bulk tab with minimal change: **Bulk** (schedules + runs), **Skills**, **Recipes**, **Run definitions**, and a portfolio **Cost roll-up** (`/cost-summary`). These intentionally are not client-scoped.

---

## 4. Backend changes

Small, additive — most data is already client-scoped, so this is mostly re-composition.

1. **`GET /api/ops/clients/:id/overview`** — curated per-client digest (top findings, scheduled-today content, site status, headline counts). Roster-guarded.
2. **`GET /api/ops/home`** — cross-client digest (needs-attention clients, scheduled-today content, approvals-waiting). May be implemented by extending `/command-center`; keep `/command-center` as an alias to avoid breaking callers.
3. **Sites under `/api/ops`** — add `GET /api/ops/clients/:id/sites` (the client's mapped Kinsta sites + env/status) and `POST /api/ops/clients/:id/sites` (assign a Kinsta site to the client → insert/relabel `kinsta_site_clients`). These wrap the existing Kinsta services; the legacy `/api/operations/sites*` (sync/scan/terminal/exec) remain the heavy-lift endpoints the Sites components already call.
4. **Close the flagged auth/audit gaps** while in `clients/*`: add `isOperationsClient` guard to `/clients/:id/subscriptions` (PUT) and `/clients/:id/credentials*` mutations; emit an audit event on credential DELETE.

No new external integrations, no new secrets.

---

## 5. Database wipe (one-time, guarded, admin-run)

Surgical — this is the **shared `anchor` database**; never touch dashboard tables.

- **Truncate (ops-owned test activity):** `ops_runs`, `ops_findings` (+ any derived ops finding tables), `ops_chat_threads`, `ops_chat_messages`, `ops_tool_approvals`, `ops_bulk_runs`, and `ops_blog_posts`.
- **`social_posts`:** now **in scope** to truncate — the dashboard publisher is being retired and **no real posts exist**. **Seatbelt:** the script first `SELECT count(*)` and prints existing `social_posts` rows for confirmation; truncation of `social_posts` is gated behind an explicit `--include-social` flag so a careless run can't nuke it. (If any real rows appear, stop and reassess.)
- **Keep (config):** client roster, `ops_run_definitions`, skills, recipes, `client_platform_credentials`, `kinsta_*` mappings, `meta_page_links`, `client_profiles` caps.
- **Delivery:** an idempotent SQL script (`infra/sql/wipe_ops_activity.sql`) + a thin runner documented for one-time admin execution via the Cloud SQL Auth Proxy. **Never** wired into the migration chain or any cron. Respects `TRUNCATE … RESTART IDENTITY CASCADE` only within ops-owned tables; FKs into shared tables are verified absent before truncation.

---

## 6. Compliance / safety

- PHI-free app → no medical gate (ops connects to Google Ads (BAA), Meta, client sites only).
- The wipe must be provably scoped to ops-owned tables; the script enumerates an explicit allowlist of tables and refuses anything not on it. `social_posts` requires the extra flag.
- Closing the credential-endpoint `isOperationsClient` gaps is a net compliance improvement (least-privilege, server-side authorization) and is in scope here.
- Preserve the chat approval gate and all existing audit events; the IA move must not drop any `operations.*` audit emission.
- No secrets in any new endpoint payloads (credentials section returns metadata + validation state only, never decrypted secrets — unchanged from today).

---

## 7. Decomposition (for the plan)

One coherent spec; the plan sequences it so each task is independently shippable and mostly reuses existing components:

1. **Shell + active-client context + routing** — left rail (Home/Clients/Portfolio), `OpsActiveClientProvider`, route table, roster sidebar with status dots. (Old tabs still reachable during transition.)
2. **Client sections — reuse pass** — mount Findings, Socials, Blog, Chat under the client page reading the active-client context; strip their internal client selectors.
3. **Sites revival** — re-wire `Sites/*` into the client Sites section; add `GET/POST /api/ops/clients/:id/sites` incl. the assign-a-site picker.
4. **Per-client Overview** — `ClientOverview.jsx` + `/api/ops/clients/:id/overview`.
5. **Home digest** — `/operations/home` + `/api/ops/home` (extend `/command-center`).
6. **Config-group sections** — Health-check setup, Connections (+ auth/audit gap fixes), Run history, Cost.
7. **Portfolio destination** — relocate Bulk/Skills/Recipes/Run-definitions/Cost-roll-up under `/operations/portfolio`.
8. **DB wipe script** — `infra/sql/wipe_ops_activity.sql` + runner + docs.
9. **Decommission** — remove dead alias routing and any now-unused pre-pivot tab shells; update `docs/OPERATIONS.md` (tab list, route table).

---

## 8. Verification (no UI test suite)

- `yarn build` + `yarn lint` green after every task.
- DB-free unit tests (`yarn test:ops` where applicable): the overview/home aggregate shaping (against mocked `query`), the Sites assign endpoint's `kinsta_site_clients` upsert logic, the wipe script's table-allowlist guard.
- Server boots; new endpoints gated (401 unauth); `/api/ops/clients/:id/overview` and `/api/ops/home` return curated shapes; `POST /api/ops/clients/:id/sites` assigns and is roster-guarded.
- `yarn db:migrate` unaffected (no schema change beyond possibly none); the wipe script is **not** a migration.
- **Human browser pass:** left-rail navigation; pick a client → every section shows only that client's data; Sites assign works; Home digest deep-links land on the right client/section; run the wipe against the dev DB and confirm only ops-owned tables emptied (dashboard data intact).

---

## 9. Open items for the plan

- Exact left-rail component (reuse the app's existing layout rail vs a local one) and how it coexists with the broader admin shell.
- Whether Config sections render as a gear-dropdown menu or a secondary tab row (plan picks one; default: gear dropdown to keep the primary row clean).
- Status-dot computation source for the roster (reuse `/command-center` per-client rollup vs a dedicated lightweight `/api/ops/clients?withStatus=1`).
- Whether `/api/ops/home` fully replaces `/command-center` or wraps it (plan picks: wrap + alias to avoid breakage).
- Precise list of ops-owned finding/derived tables to include in the wipe allowlist (enumerate from `migrate_ops_*` at plan time).
