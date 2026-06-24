# Sub-project B — Blog / WordPress Publisher — Design

**Date:** 2026-06-24
**Status:** Design / spec. Next → implementation plan.
**Home:** `anchor-operations` — a new **Blog** sub-view in the existing **Content** tab.
**Parent vision:** `docs/superpowers/specs/2026-06-23-content-marketing-vision.md`. This is sub-project B (the publish rail): "drafting exists; publishing + scheduling don't."

---

## 1. Goal & non-goals

**Goal:** Let the agency author blog posts in ops and **publish them to clients' self-hosted WordPress sites** on an **ops-side schedule**, mirroring the social publisher (sub-project A). Provides the missing publish rail.

**Non-goals (this sub-project):**
- No AI authoring buttons in B. AI drafting rides on the **already-built Claude chat** (and later D's content brain); B is the rail + a markdown editor. (Decision 2026-06-24.)
- No WYSIWYG editor — authoring is **markdown** (editor + live preview), converted to HTML at publish.
- No categories/tags/author selection, no multi-post bulk, no editorial approval workflow (C). Optional **featured image** is in scope; everything else deferred.
- Does not touch the dashboard's existing client-facing `blog_posts` table or BlogEditor — B is **ops-owned** and agency-facing.

---

## 2. Verified building blocks (from exploration 2026-06-24)

- **WP credential** lives in `oauth_connections` (provider='wordpress'): `access_token` = AES-256-GCM-encrypted base64(`username:app_password`); `token_type='Basic'`; `metadata.site_url`. ops can decrypt it (same `ENCRYPTION_KEY`): `isEncrypted(t) ? decrypt(t) : t` → `Authorization: Basic ${auth}`.
- **SSRF guard** exists in ops at `server/services/security/ssrfGuard.js` — `assertPublicHttpUrl(url)` (throws `SsrfBlockedError`); fetch with `redirect: 'manual'` and reject 3xx/opaqueredirect.
- **Client→site map:** `oauth_resources` (resource_type='wordpress_site', resource_url, oauth_connection_id, client_id, is_primary). ⚠️ `ops_app` does NOT have SELECT on `oauth_resources` yet — must GRANT it.
- **Existing `createWordPressPost()`** (dashboard `oauthIntegration.js`) is **WordPress.com only** (Bearer + `/sites/:id/posts/new`) — **NOT reusable** for self-hosted. B writes a new REST publisher.
- **Featured image:** `file_uploads` BYTEA + `fileStorage.storeFile()` (reuse). WP media via `POST {site}/wp-json/wp/v2/media`.
- **Social publisher to mirror:** `socialPublisher.js` `runDuePosts()` — `*/2` cron, `FOR UPDATE SKIP LOCKED` batch claim, `social_posts` status enum (`draft/scheduled/publishing/published/failed`), retry (`retry_count < 3`, 15-min backoff), `publishPost(id, {skipClaim})`.

---

## 3. Architecture

```
Content tab → Blog sub-view              server/routes/ops.js (or routes/blog.js)
  Calendar / Queue / Compose              /api/ops/blog/posts (CRUD + schedule + cancel)
  markdown editor + live preview          /api/ops/blog/sites/:clientId  (client WP sites)
  optional featured image                 /api/ops/blog/media (upload → file_uploads)
        │                                         │
        ▼                                         ▼
  ops_blog_posts (status, scheduled_for)   blogPublisher.js
        │  */2 cron                          runDueBlogPosts() → claim due → publishBlogPost()
        ▼                                      ├─ resolve WP conn (decrypt → Basic auth)
   publish to client WordPress (REST)          ├─ assertPublicHttpUrl(site) + redirect:'manual'
                                               ├─ optional featured image → POST /media → featured_media
                                               ├─ markdown→HTML (marked)
                                               └─ POST /wp-json/wp/v2/posts {title,content,status:'publish',featured_media}
```

### 3.1 Data model — `ops_blog_posts` (NEW, ops-owned)
Mirrors `social_posts`. Columns: `id` (uuid pk), `client_id` (uuid), `oauth_connection_id` (uuid — the WP connection), `site_resource_id` (uuid — `oauth_resources.id`), `site_url` (text — denormalized target), `created_by` (uuid), `title` (text), `content_markdown` (text), `featured_file_upload_id` (uuid nullable), `status` (text: `draft|scheduled|publishing|published|failed|cancelled`), `scheduled_for` (timestamptz), `wp_post_id` (text), `wp_post_url` (text), `published_at`/`failed_at` (timestamptz), `error` (text), `retry_count` (int default 0), `idempotency_key` (text unique), `meta` (jsonb), timestamps. Indexes: `(client_id, status)`, `(scheduled_for) WHERE status='scheduled'`.

### 3.2 Publisher — `server/services/ops/blog/blogPublisher.js`
- `runDueBlogPosts()` — verbatim shape of `runDuePosts()`: `BEGIN` → select due (`status='scheduled' AND scheduled_for<=NOW()` OR retry-eligible failed) `FOR UPDATE SKIP LOCKED LIMIT 50` → set `publishing` → `COMMIT` → loop `publishBlogPost(id, {skipClaim:true})`.
- `publishBlogPost(id, {skipClaim})` — claim (if not skipped), load the post + its WP connection (`oauth_connections` by `oauth_connection_id`, decrypt `access_token`) + site_url; `assertPublicHttpUrl(site_url)`; if `featured_file_upload_id`, fetch bytes from `file_uploads` and `POST {site}/wp-json/wp/v2/media` (multipart) → `featured_media` id; convert `content_markdown`→HTML via `marked`; `POST {site}/wp-json/wp/v2/posts` with `{ title, content: html, status: 'publish', featured_media? }` and `Authorization: Basic <auth>`, `redirect:'manual'`; on 2xx store `wp_post_id`/`wp_post_url`/`published_at`, status `published`; on error set `failed` + `error` + `retry_count++`.
- All WP fetches go through a `safeWpFetch` helper (SSRF + manual redirect), mirroring the dashboard's.

### 3.3 Markdown→HTML
Add `marked`. Convert at publish time only (`marked.parse(content_markdown)`); the editor preview uses the existing `react-markdown` (render). WP `content` accepts HTML.

### 3.4 Cron
`*/2 * * * *` `runDueBlogPosts()` added to `server/index.js`, **inside the same `if (!isDemoMode())` guard** as the social crons.

### 3.5 Routes (`/api/ops/blog/*`, admin-gated)
- `GET /blog/posts?clientId=` · `POST /blog/posts` (create draft/scheduled/publish_now) · `PATCH /blog/posts/:id` · `POST /blog/posts/:id/cancel` · `DELETE /blog/posts/:id`.
- `GET /blog/sites/:clientId` — the `oauth_resources⨝oauth_connections` WP sites for the client.
- `POST /blog/media` — multipart upload → `fileStorage.storeFile` → `{ id, url }` (for the featured image).

### 3.6 UI — Blog sub-view in the Content tab
The Content tab gains an inner switch **Social | Blog**. Blog holds:
- **Calendar/Queue** of `ops_blog_posts` (reuse the shared `Calendar` + `DataTable` like social).
- **Compose**: client picker → WP **site** picker (from `/blog/sites/:clientId`) → title → **markdown editor** (textarea) with **live preview** (`Markdown` component) → optional **featured image** (MediaPicker-style upload) → schedule datetime → action (draft / schedule / publish-now).

---

## 4. Compliance / safety
- PHI-free (ops app) → no gate. **SSRF guard mandatory** on every WP URL (it's a user/connection-supplied host). `redirect:'manual'`; reject 3xx.
- Never log the decrypted credential or `Authorization` header. The credential is read from `oauth_connections` (encrypted at rest) and used in-memory only.
- Staff author + schedule directly (no approval gate — consistent with social; the approval gate is for AI-proposed mutations).
- `ops_app` grants: DML on `ops_blog_posts`; **SELECT on `oauth_resources`** (new); existing SELECT on `oauth_connections` + DML on `file_uploads` already present.

## 5. Deps / infra
- Add `marked` (markdown→HTML). Commit `yarn.lock`.
- Migration `migrate_ops_blog.sql` (table + indexes) registered in `migrations.js`; net-new table → run as admin at deploy (`RUN_MIGRATIONS_ON_START=false`) + apply grants. No new secrets (`ENCRYPTION_KEY` already present; WP creds come from the shared DB).

## 6. Verification
- `yarn build` + `yarn lint`; DB-free unit tests (`yarn test:ops`): markdown→HTML conversion; the due-claim SQL selection logic (against a mocked `query`); the decrypt→Basic-auth header builder.
- `yarn db:migrate` (inline DATABASE_URL) idempotent.
- Server boots; `/api/ops/blog/posts` → 401 (gated); `/api/ops/blog/media` mounted.
- **Human**: e2e publish to a test WordPress site (draft + scheduled + publish-now; featured image) — needs a real WP connection + browser.

## 7. Open items for the plan
- Exact `marked` options (GFM on; sanitize? — WP sanitizes server-side, but we should still avoid injecting raw script: `marked` doesn't execute, and we control the markdown source = staff, so acceptable; note it).
- Whether to reuse the social `MediaPicker` or a slim blog image uploader (plan picks: a slim uploader hitting `/blog/media`).
- The Content-tab inner Social|Blog switch wiring (add to the ported `ContentTab.jsx` from A).
- WP media multipart from Node (FormData/Blob from the BYTEA bytes) — confirm against the installed Node 20 `fetch`/`FormData`.
