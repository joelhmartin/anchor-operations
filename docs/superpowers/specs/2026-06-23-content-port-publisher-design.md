# Sub-project A — Port Social Publisher into anchor-operations

**Date:** 2026-06-23
**Status:** Design / spec. Next step → implementation plan.
**Parent vision:** `docs/superpowers/specs/2026-06-23-content-marketing-vision.md`
**Type:** Faithful lift-and-shift (no feature changes) + hard-removal cutover from the main app.

---

## 1. Goal & non-goals

**Goal:** Move the mature Facebook/Instagram social publishing system out of the main
dashboard (`Anchor-Client-Dashboard`) and into `anchor-operations` under a new
**Content** tab, then remove it from the main app. Deliver a known-good publishing rail
that sub-projects B–D build on. **No behavior changes** — same composer, same FB/IG
scope, same scheduling.

**Non-goals (this sub-project):**
- No blog publishing / scheduling (sub-project B).
- No editorial calendar / approval workflow (sub-project C).
- No SEO content planning or AI drafting (sub-project D).
- No TikTok (stays a stubbed OAuth provider).
- No redesign of the composer or calendar — port as-is.

---

## 2. Source inventory (what moves, from the main app)

All paths below are in `Anchor-Client-Dashboard/`.

**Backend services** (`server/services/`):
- `socialPublisher.js` — orchestrator: atomic row claim (`FOR UPDATE SKIP LOCKED`), media URL resolution (Vimeo + signed tokens), FB/IG dispatch, retry (max 3, 15-min backoff).
- `metaPagePosting.js` — Graph API v21 wrapper: token resolution + encryption, FB text/link/image/carousel/video, IG 2-step container publish; exports `healthCheckPage`.
- `socialClientLinkSync.js` — reconciles `meta_page_links` vs `oauth_resources`; auto-links single pages; archives on disconnect; exports `syncClientFacebookLinks`.
- `socialMediaTokens.js` — stateless HMAC-SHA256 media tokens (1-hour TTL).

**Routes** (`server/routes/social.js`) — mounted at `/api/social`. Endpoints:
`GET /social/pages`, `GET|POST|PATCH|DELETE /social/links`,
`GET /social/client-pages/:clientId` (+ `/:fbPageId/publishing`, `/sync`),
`POST /social/media`, `GET /social/media/:token` (**public, no auth**),
`GET|POST /social/posts`, `POST /social/posts/:id/cancel`.

**Frontend** (`src/views/admin/AdminHub/social/`):
`SocialSection.jsx` (container, Calendar/Queue tabs + Compose launch),
`CalendarView.jsx`, `QueueView.jsx`, `ComposeDialog.jsx`, `MediaPicker.jsx`.
API client: `src/api/social.js`. Mounted from `src/views/admin/AdminHub.jsx`.

**Crons** (in `server/index.js`):
- `*/2 * * * *` → `runDuePosts()` (publish due posts; self-claiming).
- `0 4 * * *` (America/New_York) → `healthCheckPage(id)` for each non-archived `meta_page_links` row.
- Startup backfill → `syncClientFacebookLinks` ("auto-linked N clients").

**Public-CORS registration** (`server/index.js`): `/api/social/media/` is in
`publicCorsEndpoints` so Meta can fetch media without auth.

**Schema** (`server/sql/migrate_social_publishing.sql`): `meta_page_links`,
`social_posts`, `social_media_tokens` (+ indexes).

---

## 3. Shared-DB reality (no data migration)

`anchor-operations` connects to the **same** Cloud SQL Postgres as the main app (as the
`ops_app` role). The tables `meta_page_links`, `social_posts`, `social_media_tokens`,
and `file_uploads` already exist there and already hold live data. Therefore:

- **No data migration.** Ops reads/writes the same rows the main app was using.
- **Schema ownership:** the `migrate_social_publishing.sql` migration moves into ops's
  ordered migration runner so ops can stand the tables up in any fresh/lower
  environment, but in shared prod it is a no-op (idempotent `CREATE ... IF NOT EXISTS`).
- **`ops_app` role grants:** verify the role has `SELECT/INSERT/UPDATE/DELETE` on the
  three social tables + `file_uploads` (`infra/sql/ops_app_role.sql`). Add grants if
  missing — this is a likely gap since these tables were owned by the main-app role.

---

## 4. Target placement in ops

**Backend:**
- Services → `server/services/social/` (new folder): the four service files, import
  paths fixed for ops's tree. They depend on `db.js`, the encryption helper, Vimeo
  service, and `FACEBOOK_SYSTEM_USER_TOKEN` — confirm/port each dependency.
- Route → `server/routes/social.js`, mounted `app.use('/api/social', socialRouter)` in
  `server/index.js` alongside `/api/ops` and `/api/operations`.
- Public path → add `/api/social/media/` to ops's public-endpoint handling and ensure
  the `GET /social/media/:token` route is reachable **before** the `requireAuth` gate
  (mirror the main app's pattern; confirm how ops currently gates auth).
- Crons → add the `*/2` publish cron and the `0 4` health cron to ops's startup, plus
  the `syncClientFacebookLinks` backfill. Use ops's cron registration convention.
- Migration → register `migrate_social_publishing.sql` in `server/migrations.js`.

**Frontend:**
- Components → `src/views/admin/Operations/Content/`: `ContentTab.jsx` (replaces
  `SocialSection`'s role as the tab body), `CalendarView.jsx`, `QueueView.jsx`,
  `ComposeDialog.jsx`, `MediaPicker.jsx`. Fix imports to ops's `ui-component` / theme.
- API client → `src/api/social.js` (port; keep the `/social/...` paths so no rewrites).
- Register the tab in `src/views/admin/Operations/index.jsx`:
  add `{ value: 'content', label: 'Content', Icon: <calendar/edit icon> }` to
  `WORKSPACE_TABS` and a `<TabPanel value="content">`. **Note:** the live ops UI has 4
  tabs today (Command Center, Discoveries, Agent, Bulk) — `OPERATIONS.md`'s 9-tab list
  is aspirational/stale. Content becomes the 5th tab.
- The Content tab keeps the existing internal Calendar / Queue sub-tabs + Compose dialog
  (faithful port). Forward-compat: this tab is where Blog / Plans land in B–D.

---

## 5. Secrets / env ops needs

| Var | Why | Source |
|---|---|---|
| `FACEBOOK_SYSTEM_USER_TOKEN` | List pages, derive page tokens, FB/IG posting | Shared Secret Manager (`meta-system-user-token`) |
| `ENCRYPTION_KEY` | Decrypt/encrypt `page_access_token_encrypted` — must be byte-identical to main | Already shared (SSO/decrypt) |
| Vimeo creds (e.g. `VIMEO_ACCESS_TOKEN`) | Resolve Vimeo direct file URLs for video posts | Shared Secret Manager |
| `SOCIAL_MEDIA_TOKEN_SECRET` (or whatever `socialMediaTokens.js` reads) | HMAC media tokens | Match main app's value so in-flight tokens stay valid; else accept short token churn |

Wire via `gcloud run services update anchor-ops --update-secrets=...` + IAM binding per
the three-app plan. Confirm exact env var names by reading each service file during
implementation.

---

## 6. Cutover — hard move + removal (no flag)

Decided 2026-06-23: no `SOCIAL_PUBLISH_ENABLED` flag. Move it, remove it from main.

**Sequencing (the one safety rule: the publish cron must run in exactly one app):**
1. Build + deploy ops with the publisher and **cron live**. Ops now publishes due posts.
2. In the **same change window**, remove from the main app:
   - Delete services: `socialPublisher.js`, `metaPagePosting.js`,
     `socialClientLinkSync.js`, `socialMediaTokens.js`.
   - Delete `server/routes/social.js` + its mount + the `/api/social/media/` public
     entry in `server/index.js`.
   - Delete the `*/2` publish cron, the `0 4` health cron, and the social-links
     backfill from `server/index.js`.
   - Delete `src/views/admin/AdminHub/social/` and its usage in `AdminHub.jsx`.
   - Keep `src/api/social.js`? No — remove; replace the AdminHub nav entry with a small
     **"Social publishing has moved to Operations →"** card linking to the ops URL
     (`/operations?tab=content`) so bookmarks/muscle-memory land correctly.
   - Leave `migrate_social_publishing.sql` in the main app's tree (harmless, idempotent)
     OR remove its registration — decide in plan; the tables are shared so the main app
     no longer needs to own the migration.
3. Deploy main app. Done — single home.

**Brief-overlap note:** between step 1 deploy and step 2 deploy, both apps could
theoretically run the `*/2` cron. `runDuePosts()` uses `FOR UPDATE SKIP LOCKED`, so a
given `social_posts` row is claimed by exactly one worker — **no double-publish** even
during overlap. The window is minutes and safe.

**Rollback:** `git revert` the main-app removal commit (and redeploy) restores the old
path; ops's copy is additive. No flag needed.

---

## 7. Compliance posture

- **Encrypted page tokens:** `page_access_token_encrypted` stays AES-256-GCM via the
  shared `ENCRYPTION_KEY`. Ops must use the identical key or it cannot decrypt existing
  rows — verify before cutover.
- **No PHI in social payloads:** post content is marketing copy; no PHI flows through
  `social_posts`. Confirm no PHI is logged in publish errors.
- **Staff-only:** the Content tab lives in the staff-only ops command center behind
  `requireAuth` + staff role, matching the main app's AdminHub gating.
- **Public media endpoint:** `GET /social/media/:token` is intentionally unauthenticated
  but HMAC-gated with a 1-hour TTL and bound to a specific `file_upload_id` — preserve
  this exactly; do not widen.
- **Consult `compliance-auditor`** on the token/secret move (moving a decryption key's
  consumer to a new service) before cutover.

---

## 8. Verification (no test suite — see `verify-without-tests` discipline)

1. `yarn build` + `yarn lint` green in ops.
2. **Pre-cutover (ops cron live, main still present briefly):**
   - Content tab loads; `GET /social/pages` lists FB pages + IG accounts.
   - `GET /social/posts` renders existing posts in Calendar + Queue from the shared DB.
   - Create a **draft** in ops → row appears; cancel works.
   - Schedule a test post a few minutes out against a **test/internal page** → ops's
     `*/2` cron publishes it; `fb_post_id` / `ig_media_id` populated; status `published`.
   - Media: upload an image → `POST /social/media` stores in `file_uploads`; the public
     `/social/media/:token` URL resolves; image posts successfully.
   - Health cron: trigger `healthCheckPage` for one link → `last_health_status` updates.
3. **Post-removal:** main app builds/lints clean; AdminHub shows the "moved" card; no
   `/api/social` route or social cron remains in main; no orphaned imports.
4. Confirm `ops_app` role can read/write all three social tables + `file_uploads`.

---

## 9. Open items to resolve in the plan

- Exact env var names read by `socialMediaTokens.js` and the Vimeo dependency.
- How ops currently structures auth gating / public endpoints (confirm the pre-auth
  mount pattern for `/social/media/:token`).
- Whether `ops_app` already has grants on the social tables or needs an ALTER.
- Ops's cron registration convention (does it have a `registerCron` / demo-skip wrapper
  like main, or raw `cron.schedule`?).
- Icon choice for the Content tab (MUI — e.g. `CalendarMonthIcon` or `EditCalendarIcon`).
