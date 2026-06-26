# Blog Publishing via Kinsta SSH / WP-CLI — Design

**Date:** 2026-06-26
**Status:** Design / spec (resumed from the 2026-06-25 brainstorm that was parked for the model-provider switch). Next → implementation plan.
**Home:** `anchor-operations` — the Content tab's **Blog** sub-view + the blog publisher.

---

## 1. Problem & goal

**Problem.** The Blog tab's site dropdown shows **"No WordPress sites for this client"** even for clients that clearly have a site assigned in the **Sites** tab. Root cause (verified): the two tabs read different things — Sites reads **Kinsta hosting** records (`kinsta_site_clients`), while Blog reads a **WordPress REST connection** (`oauth_connections` provider=`wordpress`, an app-password login). There are **zero** WordPress REST connections anywhere in the system, and the ops app can't create them. So the blog publisher has no credential to post with, and an assigned Kinsta site is invisible to it.

**Goal.** Let the agency **publish blog posts to a client's assigned Kinsta site over SSH / WP-CLI**, using the Kinsta environment's existing SSH credentials — no separate WordPress app-password. The Blog site picker lists the client's **Kinsta sites**; publishing runs `wp post create` over SSH on the live environment, with a featured image. This reuses the existing cron / status machine / retry and the existing SSH + WP-CLI + SFTP infrastructure.

**Non-goals.**
- No WordPress REST/app-password connect flow (rejected — SSH is the path).
- No categories/tags/author/multi-post; **featured (hero) image IS in scope for v1** (decision 2026-06-25).
- No change to the deterministic checks engine or the social publisher.
- The old REST publish path (`oauth_connection_id`) stays as dormant code; we branch on the new target, don't rip it out.

---

## 2. Verified building blocks (exploration 2026-06-25)

- **SSH client** `server/services/ops/operations-website/sshClient.js`:
  - `execCommand(environmentId, command, { userId, timeoutMs=30000, triggeredBy='manual' })` → `{ stdout, stderr, exitCode, durationMs }`. Read-only guard: refuses non-read verbs when `metadata.read_only` (`isReadOnlyEnv` + `isReadVerb`) — so `wp post create`/`wp media import`/`wp post update` are correctly **blocked on read-only envs**. Logs to `kinsta_ssh_command_log`.
  - `wpcli(environmentId, args, opts)` → runs `cd /www/${username}_*/public && wp ${args}` via `execCommand`; returns the same shape.
  - `withSftp(environmentId, fn, { userId, triggeredBy })` → connects SFTP (`ssh2-sftp-client`), calls `fn(sftp)` with `sftp.put(buffer, remotePath)` / `sftp.get` / `sftp.delete`. (No read-only guard on the SFTP channel — but the WP commands are guarded, so a read-only env still can't publish.)
  - `ensurePassword(envRow)` auto-decrypts `ssh_password_encrypted`, refreshing from the Kinsta API + re-encrypting if stale. Used internally by all three.
- **Kinsta env columns** (`migrate_kinsta_operations.sql`): `kinsta_environments(id, site_id, kinsta_environment_id, environment_name, is_live, primary_domain, ssh_host, ssh_ip, ssh_port, ssh_username, ssh_password_encrypted, metadata, ...)`. The **live** environment per site: `WHERE site_id=$1 AND is_live=TRUE ORDER BY created_at ASC LIMIT 1`.
- **Client→Kinsta sites:** `kinsta_site_clients(site_id, client_user_id, relationship, link_id)` ⨝ `kinsta_sites`. The Sites tab uses `fetchClientSites(clientId)` → `GET /api/operations/clients/:clientId/sites`.
- **Blog publisher** `server/services/ops/blog/blogPublisher.js`: `publishBlogPost(id, { skipClaim })` (today: REST via `resolveWpConnection(post.oauth_connection_id)` → `wpCreatePost`/`wpUploadMedia`), `runDueBlogPosts()` (`*/2` cron, `FOR UPDATE SKIP LOCKED`, claim → `publishing`, retry `retry_count<3` w/ 15-min backoff). Cron registered in `server/index.js` inside the `if (!isDemoMode())` guard.
- **Blog store** `blogStore.js`: `createPost({clientId,createdBy,oauthConnectionId,siteResourceId,siteUrl,title,contentMarkdown,featuredFileUploadId,status,scheduledFor})`; `updatePost(id, fields)` (allowlist of columns); `listClientWpSites(clientId)` (oauth_resources path).
- **`ops_blog_posts`** columns: `id, client_id, oauth_connection_id, site_resource_id, site_url, created_by, title, content_markdown, featured_file_upload_id, status, scheduled_for, wp_post_id, wp_post_url, published_at, failed_at, error, retry_count, idempotency_key, meta, created_at, updated_at`. `meta JSONB`. Indexes on `(client_id,status)` and `(scheduled_for) WHERE status='scheduled'`.
- **Markdown** `markdown.js` `mdToHtml(md)` (via `marked`).
- **Featured image storage:** `file_uploads` (BYTEA `bytes`, `content_type`, `original_name`); upload endpoint `POST /api/ops/blog/media` → `storeFile` → `{id,url}`. Compose UI: `BlogCompose.jsx` (`onPickImage` → `uploadBlogMedia`).
- **Compose payload** (`BlogCompose.jsx`): `createBlogPost({ client_user_id, action, oauth_connection_id, site_resource_id, site_url, title, content_markdown, featured_file_upload_id, scheduled_for })`; handled by `POST /api/ops/blog/posts` (`ops.js`).

---

## 3. Architecture

```
Content → Blog → Compose            POST /api/ops/blog/posts  (now accepts kinsta_environment_id)
  Kinsta-site picker  ◄──────────── GET /api/ops/blog/sites/:clientId  (now returns Kinsta sites + live env)
  markdown editor + preview                       │
  optional featured image                         ▼
        │                            ops_blog_posts (+ kinsta_environment_id)
        ▼   */2 cron (unchanged)                   │
  blogPublisher.runDueBlogPosts() → publishBlogPost(id) branches:
        ├─ kinsta_environment_id set → publishViaSsh(post)   ◄── NEW
        └─ else oauth_connection_id  → existing REST path     (dormant)
```

### 3.1 Site picker = Kinsta sites
`GET /api/ops/blog/sites/:clientId` returns the client's **Kinsta sites with a live, SSH-capable environment**:
```
SELECT s.id AS site_id, s.display_name, s.site_name,
       e.id AS kinsta_environment_id, e.primary_domain
  FROM kinsta_site_clients ksc
  JOIN kinsta_sites s ON s.id = ksc.site_id
  JOIN kinsta_environments e ON e.site_id = s.id AND e.is_live = TRUE
 WHERE ksc.client_user_id = $1
 ORDER BY s.display_name NULLS LAST, s.site_name
```
Returns `[{ site_id, kinsta_environment_id, label, primary_domain }]` (label = `display_name || site_name`). The dropdown value = `kinsta_environment_id`. (A `listClientKinstaBlogTargets(clientId)` helper in `blogStore.js`.) If a site has no live environment, it's omitted (can't publish to it) — note that case in the empty state.

### 3.2 Data model — one new column
`ops_blog_posts` gains `kinsta_environment_id UUID` (nullable). When set, the post is an **SSH target**. The publisher branches on its presence. Migration `migrate_ops_blog_ssh.sql` (idempotent `ADD COLUMN IF NOT EXISTS`). `createPost`/`updatePost` accept `kinstaEnvironmentId` / add `kinsta_environment_id` to the allowlist.

### 3.3 SSH publisher — `server/services/ops/blog/sshPublisher.js`
`publishViaSsh(post)` — given a claimed `ops_blog_posts` row whose `kinsta_environment_id` is set:
1. **Render:** `html = mdToHtml(post.content_markdown)`.
2. **Idempotent create (draft first):** if `post.wp_post_id` is already set (a prior attempt created the draft), **skip create** and resume at step 4 — this prevents duplicate posts on retry.
   Else: SFTP the HTML to a temp file (`withSftp` → `sftp.put(Buffer.from(html), '/tmp/ops-blog-<id>.html')`), then
   `wpcli(envId, ['post','create','/tmp/ops-blog-<id>.html', \`--post_title=${shellQuote(post.title)}\`, '--post_status=draft', '--porcelain'])` → stdout = new post id. Persist `wp_post_id` immediately (`updatePost`), so a later failure resumes instead of re-creating.
3. **Featured image (if `featured_file_upload_id`):** load bytes from `file_uploads`; `withSftp` → `sftp.put(bytes, '/tmp/ops-blog-<id>-img')`; `wpcli(envId, ['media','import','/tmp/ops-blog-<id>-img', \`--post_id=${wpPostId}\`, '--featured_image', '--porcelain'])`.
4. **Publish:** `wpcli(envId, ['post','update', wpPostId, '--post_status=publish', '--porcelain'])`.
5. **URL:** `wpcli(envId, ['post','get', wpPostId, '--field=url'])` → `wp_post_url` (fallback: build from `primary_domain`).
6. **Persist published:** `status='published'`, `wp_post_id`, `wp_post_url`, `published_at`, `error=NULL`.
7. **Cleanup:** in a `finally`, `withSftp` → `sftp.delete` the temp files (best-effort; ignore errors).
On any error: `status='failed'`, `error` (truncated stderr/message), `retry_count+1`, `failed_at` — the existing cron retries (≤3, 15-min backoff). Because `wp_post_id` is persisted after the draft create, retries resume mid-flow (no duplicate post).

### 3.4 Publisher branch — `blogPublisher.publishBlogPost`
After claiming the post, branch: `if (post.kinsta_environment_id) return publishViaSsh(post);` else the existing REST path. `runDueBlogPosts()` unchanged (it already calls `publishBlogPost`).

### 3.5 Compose UI — `BlogCompose.jsx`
- The site dropdown loads from `GET /blog/sites/:clientId` (now Kinsta sites); value = `kinsta_environment_id`; empty-state text updated ("No Kinsta site with a live environment is assigned to this client — assign one in the Sites tab").
- The create payload sends `kinsta_environment_id` (instead of the REST `oauth_connection_id`/`site_resource_id`/`site_url`). `POST /blog/posts` accepts + stores it. Featured-image upload unchanged (`POST /blog/media` → `featured_file_upload_id`). Draft / Schedule / Publish-now actions unchanged (they drive `status`/`scheduled_for`).

---

## 4. Safety / compliance
- **Command injection:** post **content goes via a temp file** (never inline in the command). The **title** and any other argument are passed through a `shellQuote()` single-quote escaper (`'` → `'\''`), unit-tested with injection cases. WP-CLI args are built as an array and joined with the quoter. No unescaped user string reaches the shell.
- **Write guard:** publishing WP commands run through `wpcli`→`execCommand`, which **refuses non-read verbs on `read_only` environments** — a read-only env can't be published to (the publish fails cleanly and is surfaced as an error).
- **Audit:** every SSH/SFTP command already logs to `kinsta_ssh_command_log` (built into the SSH client). Temp files removed in `finally`.
- **No secrets logged:** SSH credentials are decrypted in-memory by `ensurePassword`; never logged. `console.warn`/`console.error` only.
- **PHI-free** app → no gate. `ops_app` already has SELECT on `kinsta_*` (the Sites tab works) + DML on `ops_blog_posts` + SELECT on `file_uploads`; the migration adds a column to an ops-owned table — **no grant change**.

## 5. Deps / infra
- No new npm dependency (`ssh2`/`ssh2-sftp-client`/`marked` already present).
- Migration `migrate_ops_blog_ssh.sql` (1 column), registered in `server/migrations.js`; net-new column → applied by `gdeploy.sh`'s admin migration step at deploy.
- Demo-gated cron unchanged.

## 6. Verification (no UI/endpoint suite)
- `node:test` (DB-free): the `shellQuote()` escaper (injection cases); the publisher's **branch selection** (`kinsta_environment_id` present → SSH path) and the **idempotent-resume** logic (given `wp_post_id` already set, skip create) against a mocked `sshClient` (`wpcli`/`withSftp`/`query`); the WP-CLI arg array → command mapping.
- `yarn build` + `yarn lint`; `yarn db:migrate` idempotent.
- **Module-load check** (the boot-crash class): `node -e import('./server/routes/ops.js')` resolves; `node --check sshPublisher.js`.
- Server boots; `GET /blog/sites/:clientId` returns Kinsta sites for a client with an assigned site; `POST /blog/posts` accepts `kinsta_environment_id`.
- **Human (needs a live Kinsta site):** publish a post (draft / schedule / publish-now) to a real assigned Kinsta site — text + featured image — and confirm it appears in WordPress; confirm a retry after a mid-flow failure doesn't duplicate the post.

## 7. Open items for the plan
- Confirm `wpcli`'s exact arg signature (array vs string) and the `/www/${username}_*/public` path glob against the real `sshClient.js`; build the arg list to match.
- Confirm `wp post create <file>` reads post content from the file positional arg on the installed WP-CLI (vs `--post_content`); if not, switch to `--post_content="$(< file)"` or stdin — but keep content out of the inline command for injection safety (temp file remains the transport).
- Confirm `wp media import --featured_image --post_id=` attaches + sets the thumbnail in one call on the target WP-CLI version; else `wp media import --porcelain` then `wp post meta update <id> _thumbnail_id <mediaId>`.
- Whether to keep the REST columns on new posts (chosen: leave them null; SSH posts carry only `kinsta_environment_id`).
- Temp-file path + permissions on Kinsta (`/tmp` writable over SFTP) — confirm in the plan; fall back to the site's `public` dir + cleanup if `/tmp` isn't accessible.
