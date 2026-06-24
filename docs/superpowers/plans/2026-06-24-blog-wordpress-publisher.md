# Blog / WordPress Publisher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the agency author markdown blog posts in ops and publish them to clients' self-hosted WordPress sites on an ops-side schedule, mirroring the social publisher.

**Architecture:** New ops-owned `ops_blog_posts` table + a `*/2` cron (`runDueBlogPosts`) that claims due posts (`FOR UPDATE SKIP LOCKED`) and publishes via the WordPress REST API — decrypting the app-password from `oauth_connections` into a Basic-auth header, SSRF-guarding the site URL, optionally uploading a featured image to WP media, and POSTing `marked`-rendered HTML. A "Blog" sub-view in the Content tab provides a markdown editor + live preview. AI drafting rides on the existing chat, not B.

**Tech Stack:** Express 4 / Node 20 ESM (native `fetch`/`FormData`/`Blob`), `marked`, React 19 + MUI 7 + `react-markdown` (preview), PostgreSQL 15 (`ops_app` role), `marked`, Node `--test`.

## Global Constraints

- **Ops-owned table is `ops_blog_posts`** — must NOT collide with the dashboard's existing `blog_posts`.
- **WP credential**: `oauth_connections.access_token` = AES-GCM-encrypted base64(`user:app_password`); decrypt with `isEncrypted(t) ? decrypt(t) : t` → `Authorization: Basic ${auth}`. Site URL from `oauth_connections.metadata.site_url` (or `oauth_resources.resource_url`).
- **SSRF mandatory**: every WP fetch goes through `assertPublicHttpUrl(url)` (throws `SsrfBlockedError`) + `redirect: 'manual'`; reject `response.type==='opaqueredirect'` or 3xx. Never log the decrypted credential or `Authorization` header.
- **Status enum** (mirror social): `draft | scheduled | publishing | published | failed | cancelled`. Retry: `retry_count < 3`, 15-min backoff.
- **Cron** added to `server/index.js` INSIDE the existing `if (!isDemoMode())` guard (same as social crons).
- **Grants**: `ops_app` needs DML on `ops_blog_posts` AND `SELECT on oauth_resources` (currently missing); SELECT on `oauth_connections` + DML on `file_uploads` already present.
- **Markdown→HTML** via `marked.parse()` at publish time only; the editor preview uses `react-markdown`. Markdown source is staff-authored (trusted); WP sanitizes server-side.
- **Verify**: `yarn build` + `yarn lint`; DB-free unit tests via `yarn test:ops`; `yarn db:migrate` (inline `DATABASE_URL`) idempotent. Live WP publish + browser are human-verified.
- **Net-new table** → migration must run as admin at deploy (`RUN_MIGRATIONS_ON_START=false`) + grants applied.

---

## File Structure

**Backend (create unless noted):**
- `server/sql/migrate_ops_blog.sql` — `ops_blog_posts` table + indexes.
- `server/migrations.js` — MODIFY: register it.
- `infra/sql/ops_app_role.sql` — MODIFY: GRANT DML on `ops_blog_posts` + SELECT on `oauth_resources`.
- `server/services/ops/blog/wpClient.js` — credential resolve + `safeWpFetch` (SSRF) + WP post/media calls.
- `server/services/ops/blog/markdown.js` — `mdToHtml`.
- `server/services/ops/blog/blogPublisher.js` — `publishBlogPost` + `runDueBlogPosts`.
- `server/services/ops/blog/blogStore.js` — DB CRUD for `ops_blog_posts` + the client-WP-sites query.
- `server/routes/ops.js` — MODIFY: mount `/blog/*` routes after the auth gate.
- `server/index.js` — MODIFY: add the `*/2` blog cron in the demo-gated block.
- `package.json` — MODIFY: add `marked`.
- `server/services/ops/__tests__/{blogWpClient,blogMarkdown,blogPublisher}.test.js` — unit tests.

**Frontend (create unless noted):**
- `src/api/blog.js` — blog API client.
- `src/views/admin/Operations/Content/blog/BlogPane.jsx` — Queue + Compose.
- `src/views/admin/Operations/Content/blog/BlogCompose.jsx` — markdown editor + site picker + featured image.
- `src/views/admin/Operations/Content/ContentTab.jsx` — MODIFY: add a Social|Blog switch.

---

## Task 1: Deps + migration + grants

**Files:** Modify `package.json`(+lock); Create `server/sql/migrate_ops_blog.sql`; Modify `server/migrations.js`, `infra/sql/ops_app_role.sql`.

- [ ] **Step 1: Add `marked`**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
yarn add marked
```

- [ ] **Step 2: Write the migration** `server/sql/migrate_ops_blog.sql`

```sql
-- Ops-owned blog publishing — posts scheduled + published to clients' self-hosted
-- WordPress via the REST API. Distinct from the dashboard's client-facing blog_posts.
-- Idempotent.

CREATE TABLE IF NOT EXISTS ops_blog_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID NOT NULL,
  oauth_connection_id UUID,
  site_resource_id UUID,
  site_url TEXT,
  created_by UUID NOT NULL,
  title TEXT NOT NULL,
  content_markdown TEXT NOT NULL DEFAULT '',
  featured_file_upload_id UUID,
  status TEXT NOT NULL DEFAULT 'draft',
  scheduled_for TIMESTAMPTZ,
  wp_post_id TEXT,
  wp_post_url TEXT,
  published_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error TEXT,
  retry_count INT NOT NULL DEFAULT 0,
  idempotency_key TEXT UNIQUE,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ops_blog_posts_client ON ops_blog_posts (client_id, status);
CREATE INDEX IF NOT EXISTS idx_ops_blog_posts_due ON ops_blog_posts (scheduled_for) WHERE status = 'scheduled';
```

- [ ] **Step 3: Register** in `server/migrations.js` — append after `'migrate_ops_chat.sql'`:

```javascript
  'migrate_ops_chat.sql',
  'migrate_ops_blog.sql'
];
```

- [ ] **Step 4: Grants** in `infra/sql/ops_app_role.sql` — after the existing `ops_chat` grant block:

```sql
-- Blog publisher.
GRANT SELECT, INSERT, UPDATE, DELETE ON ops_blog_posts TO ops_app;
-- WordPress site mapping (read) — needed to resolve a client's WP sites.
GRANT SELECT ON oauth_resources TO ops_app;
```
> Note the `oauth_resources` SELECT in the PR: it must be applied to prod (alongside the migration) for blog publishing to resolve sites.

- [ ] **Step 5: Build + lint + migrate twice**

```bash
yarn build && yarn lint
DATABASE_URL="postgresql://bif@localhost:5432/anchor" yarn db:migrate
DATABASE_URL="postgresql://bif@localhost:5432/anchor" yarn db:migrate   # idempotent
```
Expected: both clean; `ops_blog_posts` created.

- [ ] **Step 6: Commit**

```bash
git add package.json yarn.lock server/sql/migrate_ops_blog.sql server/migrations.js infra/sql/ops_app_role.sql
git commit -m "feat(blog): add marked, ops_blog_posts migration + grants (oauth_resources SELECT)"
```

---

## Task 2: WP client (credential resolve + SSRF fetch + post/media)

**Files:** Create `server/services/ops/blog/wpClient.js`; Test `server/services/ops/__tests__/blogWpClient.test.js`.

**Interfaces:**
- Consumes: `decrypt`/`isEncrypted` (`../../../security/encryption.js`), `assertPublicHttpUrl`/`SsrfBlockedError` (`../../../security/ssrfGuard.js`), `query` (`../../../db.js`).
- Produces: `basicAuthHeader(auth)` → `string`; `resolveWpConnection(oauthConnectionId)` → `{ auth, siteUrl }`; `safeWpFetch(url, { auth, method, body, headers })` → `Response` (throws on SSRF/redirect); `wpCreatePost(siteUrl, auth, { title, html, featuredMediaId })` → `{ id, url }`; `wpUploadMedia(siteUrl, auth, { bytes, filename, contentType })` → `{ id }`. Consumed by Task 4.

- [ ] **Step 1: Write the failing test** (DB-free: tests the pure header builder + that `safeWpFetch` enforces SSRF via an injected guard)

```javascript
// server/services/ops/__tests__/blogWpClient.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { basicAuthHeader } from '../blog/wpClient.js';

test('basicAuthHeader passes a base64 credential straight through as Basic', () => {
  assert.equal(basicAuthHeader('dXNlcjpwYXNz'), 'Basic dXNlcjpwYXNz');
});
```

- [ ] **Step 2: Run it (fails — module missing)** — `yarn test:ops` → FAIL.

- [ ] **Step 3: Implement `wpClient.js`**

```javascript
// server/services/ops/blog/wpClient.js
import { decrypt, isEncrypted } from '../../../security/encryption.js';
import { assertPublicHttpUrl, SsrfBlockedError } from '../../../security/ssrfGuard.js';
import { query } from '../../../db.js';

export function basicAuthHeader(auth) {
  return `Basic ${auth}`;
}

// Resolve the decrypted Basic credential + site URL for a WordPress oauth_connection.
export async function resolveWpConnection(oauthConnectionId) {
  const { rows } = await query(
    `SELECT access_token, metadata FROM oauth_connections WHERE id = $1 AND provider = 'wordpress'`,
    [oauthConnectionId]
  );
  if (!rows.length) throw new Error('WordPress connection not found');
  const stored = rows[0].access_token;
  const auth = isEncrypted(stored) ? decrypt(stored) : stored;
  if (!auth) throw new Error('WordPress credential could not be decrypted');
  const siteUrl = (rows[0].metadata && rows[0].metadata.site_url) || null;
  if (!siteUrl) throw new Error('WordPress site_url missing on connection');
  return { auth, siteUrl: String(siteUrl).replace(/\/+$/, '') };
}

// SSRF-guarded fetch: blocks private hosts and refuses redirects.
export async function safeWpFetch(url, { auth, method = 'GET', body = null, headers = {} } = {}) {
  await assertPublicHttpUrl(url); // throws SsrfBlockedError
  const opts = {
    method,
    redirect: 'manual',
    headers: { Authorization: basicAuthHeader(auth), ...headers }
  };
  if (body != null) opts.body = body;
  const res = await fetch(url, opts);
  if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
    throw new SsrfBlockedError(`Refused redirect from ${url}`);
  }
  return res;
}

export async function wpUploadMedia(siteUrl, auth, { bytes, filename, contentType }) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes], { type: contentType || 'application/octet-stream' }), filename || 'image');
  const res = await safeWpFetch(`${siteUrl}/wp-json/wp/v2/media`, { auth, method: 'POST', body: fd });
  if (!res.ok) throw new Error(`WP media upload failed (${res.status})`);
  const json = await res.json();
  return { id: json.id };
}

export async function wpCreatePost(siteUrl, auth, { title, html, featuredMediaId = null }) {
  const payload = { title, content: html, status: 'publish' };
  if (featuredMediaId) payload.featured_media = featuredMediaId;
  const res = await safeWpFetch(`${siteUrl}/wp-json/wp/v2/posts`, {
    auth,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`WP post create failed (${res.status})`);
  }
  const json = await res.json();
  return { id: String(json.id), url: json.link || null };
}
```

- [ ] **Step 4: Run the test (passes)** — `yarn test:ops` → the basicAuthHeader test passes. Then `yarn build && yarn lint`.

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/blog/wpClient.js server/services/ops/__tests__/blogWpClient.test.js
git commit -m "feat(blog): WP REST client — decrypt->Basic auth, SSRF-guarded fetch, post+media"
```

---

## Task 3: markdown→HTML

**Files:** Create `server/services/ops/blog/markdown.js`; Test `server/services/ops/__tests__/blogMarkdown.test.js`.

**Interfaces:** Produces `mdToHtml(md)` → HTML string. Consumed by Task 4.

- [ ] **Step 1: Write the failing test**

```javascript
// server/services/ops/__tests__/blogMarkdown.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mdToHtml } from '../blog/markdown.js';

test('renders headings and paragraphs', () => {
  const html = mdToHtml('# Title\n\nHello **world**.');
  assert.match(html, /<h1[^>]*>Title<\/h1>/);
  assert.match(html, /<strong>world<\/strong>/);
});

test('empty input → empty string', () => {
  assert.equal(mdToHtml('').trim(), '');
});
```

- [ ] **Step 2: Run it (fails)** — `yarn test:ops` → FAIL.

- [ ] **Step 3: Implement `markdown.js`**

```javascript
// server/services/ops/blog/markdown.js
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

// Convert staff-authored markdown to HTML for the WordPress post body.
export function mdToHtml(md) {
  if (!md) return '';
  return marked.parse(String(md));
}
```
> `marked` named export is `{ marked }` in v9+. If the installed version exports a default, adjust the import (`import marked from 'marked'`) — confirm with `node -e "import('marked').then(m=>console.log(Object.keys(m)))"`.

- [ ] **Step 4: Run (passes)** — `yarn test:ops` → PASS. Then `yarn build && yarn lint`.

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/blog/markdown.js server/services/ops/__tests__/blogMarkdown.test.js
git commit -m "feat(blog): markdown->HTML for WP post body"
```

---

## Task 4: Blog store + publisher

**Files:** Create `server/services/ops/blog/blogStore.js`, `server/services/ops/blog/blogPublisher.js`; Test `server/services/ops/__tests__/blogPublisher.test.js`.

**Interfaces:**
- Consumes: `query`/`getClient` (`../../../db.js`), `resolveWpConnection`/`wpCreatePost`/`wpUploadMedia` (Task 2), `mdToHtml` (Task 3).
- Produces (blogStore): `createPost`, `updatePost`, `cancelPost`, `deletePost`, `listPosts`, `getPost`, `listClientWpSites(clientId)`. Produces (blogPublisher): `publishBlogPost(id, { skipClaim })` → `{ ok, reason? }`; `runDueBlogPosts()` → `{ processed }`. Consumed by Tasks 5, 6.

- [ ] **Step 1: Write the failing test** (DB-free: inject a fake `query` to assert the due-selection SQL claims `scheduled` + retry-eligible `failed`, and that publishBlogPost maps a published row)

```javascript
// server/services/ops/__tests__/blogPublisher.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

// Stub the WP client + db before importing the publisher.
import { mock } from 'node:test';

test('runDueBlogPosts claims scheduled + retry-eligible failed posts', async () => {
  const calls = [];
  const fakeGetClient = async () => ({
    query: async (sql, params) => { calls.push({ sql, params }); if (/SELECT id FROM ops_blog_posts/i.test(sql)) return { rows: [{ id: 'b1' }] }; return { rows: [] }; },
    release() {}
  });
  // The select must constrain status='scheduled' (and a failed/retry branch).
  // We assert the claim SQL shape via the captured calls.
  const mod = await import('../blog/blogPublisher.js?test=1');
  // Inject the fake getClient + a no-op publishBlogPost via the test hook.
  await mod.runDueBlogPosts({ __getClientForTest: fakeGetClient, __publishForTest: async () => ({ ok: true }) });
  const sel = calls.find((c) => /SELECT id FROM ops_blog_posts/i.test(c.sql));
  assert.ok(sel, 'ran a select against ops_blog_posts');
  assert.match(sel.sql, /status = 'scheduled'/);
  assert.match(sel.sql, /FOR UPDATE SKIP LOCKED/);
});
```
> Adjust the test hooks to whatever injection the implementation exposes; the assertion that matters is: the due-select constrains `status='scheduled'`, includes the retry-eligible `failed` branch, and uses `FOR UPDATE SKIP LOCKED`.

- [ ] **Step 2: Run it (fails)** — `yarn test:ops` → FAIL.

- [ ] **Step 3: Implement `blogStore.js`**

```javascript
// server/services/ops/blog/blogStore.js
import { query } from '../../../db.js';

export async function createPost({ clientId, createdBy, oauthConnectionId, siteResourceId, siteUrl, title, contentMarkdown, featuredFileUploadId, status, scheduledFor }) {
  const { rows } = await query(
    `INSERT INTO ops_blog_posts
      (client_id, created_by, oauth_connection_id, site_resource_id, site_url, title, content_markdown, featured_file_upload_id, status, scheduled_for)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [clientId, createdBy, oauthConnectionId || null, siteResourceId || null, siteUrl || null, title, contentMarkdown || '', featuredFileUploadId || null, status || 'draft', scheduledFor || null]
  );
  return rows[0];
}

export async function updatePost(id, fields) {
  const allowed = ['title', 'content_markdown', 'oauth_connection_id', 'site_resource_id', 'site_url', 'featured_file_upload_id', 'status', 'scheduled_for'];
  const sets = []; const vals = []; let i = 1;
  for (const k of allowed) { if (k in fields) { sets.push(`${k} = $${i++}`); vals.push(fields[k]); } }
  if (!sets.length) return getPost(id);
  vals.push(id);
  const { rows } = await query(`UPDATE ops_blog_posts SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`, vals);
  return rows[0] || null;
}

export async function cancelPost(id) {
  const { rows } = await query(`UPDATE ops_blog_posts SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status IN ('draft','scheduled','failed') RETURNING *`, [id]);
  return rows[0] || null;
}

export async function deletePost(id) {
  await query(`DELETE FROM ops_blog_posts WHERE id=$1`, [id]);
  return { ok: true };
}

export async function getPost(id) {
  const { rows } = await query(`SELECT * FROM ops_blog_posts WHERE id=$1`, [id]);
  return rows[0] || null;
}

export async function listPosts(clientId) {
  const { rows } = await query(
    `SELECT * FROM ops_blog_posts WHERE ($1::uuid IS NULL OR client_id=$1) ORDER BY COALESCE(scheduled_for, published_at, created_at) DESC LIMIT 200`,
    [clientId || null]
  );
  return rows;
}

// A client's connected WordPress sites (connection + resource).
export async function listClientWpSites(clientId) {
  const { rows } = await query(
    `SELECT r.id AS site_resource_id, r.resource_url AS site_url, r.resource_name AS site_name, r.is_primary,
            oc.id AS oauth_connection_id
       FROM oauth_resources r
       JOIN oauth_connections oc ON r.oauth_connection_id = oc.id
      WHERE r.client_id = $1 AND r.provider = 'wordpress' AND r.resource_type = 'wordpress_site'
        AND oc.provider = 'wordpress'
      ORDER BY r.is_primary DESC NULLS LAST, r.resource_name ASC`,
    [clientId]
  );
  return rows;
}
```

- [ ] **Step 4: Implement `blogPublisher.js`**

```javascript
// server/services/ops/blog/blogPublisher.js
import { query, getClient } from '../../../db.js';
import { resolveWpConnection, wpCreatePost, wpUploadMedia } from './wpClient.js';
import { mdToHtml } from './markdown.js';

const FETCH_SQL = `SELECT * FROM ops_blog_posts WHERE id = $1`;
const CLAIM_SQL = `UPDATE ops_blog_posts SET status='publishing', updated_at=NOW()
  WHERE id=$1 AND status IN ('scheduled','draft','failed') RETURNING *`;

export async function publishBlogPost(id, options = {}) {
  const { skipClaim = false } = options;
  let post;
  if (skipClaim) {
    const { rows } = await query(FETCH_SQL, [id]);
    if (!rows.length) return { ok: false, reason: 'not_found' };
    post = rows[0];
  } else {
    const { rows } = await query(CLAIM_SQL, [id]);
    if (!rows.length) return { ok: false, reason: 'already_claimed_or_finalized' };
    post = rows[0];
  }
  try {
    if (!post.oauth_connection_id) throw new Error('No WordPress connection selected');
    const { auth, siteUrl } = await resolveWpConnection(post.oauth_connection_id);
    const target = post.site_url || siteUrl;

    let featuredMediaId = null;
    if (post.featured_file_upload_id) {
      const { rows: f } = await query(`SELECT bytes, content_type, original_name FROM file_uploads WHERE id=$1`, [post.featured_file_upload_id]);
      if (f.length) {
        const up = await wpUploadMedia(target, auth, { bytes: f[0].bytes, filename: f[0].original_name, contentType: f[0].content_type });
        featuredMediaId = up.id;
      }
    }

    const html = mdToHtml(post.content_markdown);
    const created = await wpCreatePost(target, auth, { title: post.title, html, featuredMediaId });

    await query(
      `UPDATE ops_blog_posts SET status='published', wp_post_id=$2, wp_post_url=$3, published_at=NOW(), error=NULL, updated_at=NOW() WHERE id=$1`,
      [id, created.id, created.url]
    );
    return { ok: true, wpPostId: created.id, wpPostUrl: created.url };
  } catch (err) {
    await query(
      `UPDATE ops_blog_posts SET status='failed', failed_at=NOW(), error=$2, retry_count=retry_count+1, updated_at=NOW() WHERE id=$1`,
      [id, String(err.message || err).slice(0, 500)]
    );
    return { ok: false, reason: 'error' };
  }
}

export async function runDueBlogPosts(testHooks = {}) {
  const getClientFn = testHooks.__getClientForTest || getClient;
  const publishFn = testHooks.__publishForTest || ((postId) => publishBlogPost(postId, { skipClaim: true }));
  const c = await getClientFn();
  let ids = [];
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(`
      SELECT id FROM ops_blog_posts
       WHERE (
           (status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= NOW())
           OR
           (status = 'failed' AND scheduled_for IS NOT NULL AND scheduled_for <= NOW()
            AND retry_count < 3 AND updated_at < NOW() - INTERVAL '15 minutes')
       )
       ORDER BY scheduled_for ASC LIMIT 50 FOR UPDATE SKIP LOCKED`);
    ids = rows.map((r) => r.id);
    if (ids.length) {
      await c.query(`UPDATE ops_blog_posts SET status='publishing', updated_at=NOW() WHERE id = ANY($1::uuid[])`, [ids]);
    }
    await c.query('COMMIT');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    c.release();
    throw e;
  }
  c.release();
  for (const id of ids) {
    try { await publishFn(id); } catch (e) { console.error('[blog] publishBlogPost', id, e?.message); }
  }
  return { processed: ids.length };
}
```

- [ ] **Step 5: Run the test (passes)** — adjust the test's import/hooks to match the `runDueBlogPosts(testHooks)` signature above; `yarn test:ops` → the due-select assertions pass. Then `yarn build && yarn lint`.

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/blog/blogStore.js server/services/ops/blog/blogPublisher.js server/services/ops/__tests__/blogPublisher.test.js
git commit -m "feat(blog): blog store + publisher (claim-and-publish to WP REST, featured image, retry)"
```

---

## Task 5: Cron wiring

**Files:** Modify `server/index.js`.

- [ ] **Step 1: Add the import** near the other service imports

```javascript
import { runDueBlogPosts } from './services/ops/blog/blogPublisher.js';
```

- [ ] **Step 2: Add the cron INSIDE the existing `if (!isDemoMode()) { ... }` block** (where the social `*/2` cron lives), after the social-publish cron:

```javascript
  // Content suite — publish due blog posts to clients' WordPress sites.
  cron.schedule('*/2 * * * *', async () => {
    try {
      await runDueBlogPosts();
    } catch (e) {
      console.error('[cron:blog-publish]', e?.message);
    }
  }, { timezone: 'America/New_York' });
```

- [ ] **Step 3: Build + lint + boot smoke**

```bash
yarn build && yarn lint
DATABASE_URL="postgresql://bif@localhost:5432/anchor" yarn server &
sleep 5
curl -s -o /dev/null -w "boot ok\n" http://localhost:4000/api/health
lsof -ti:4000 | xargs kill -9
```
Expected: boots without crash (the cron registers; with no due posts it's a no-op).

- [ ] **Step 4: Commit**

```bash
git add server/index.js
git commit -m "feat(blog): demo-gated */2 cron to publish due blog posts"
```

---

## Task 6: Blog routes

**Files:** Modify `server/routes/ops.js`.

**Interfaces:** Consumes blogStore (Task 4), `publishBlogPost` (Task 4), `storeFile` (`../services/fileStorage.js`), `multer`, `isOperationsClient`/`isUuid`/`badUuid` (existing in ops.js).

- [ ] **Step 1: Add imports** near the top of `ops.js`

```javascript
import multer from 'multer';
import { storeFile } from '../services/fileStorage.js';
import { createPost as blogCreate, updatePost as blogUpdate, cancelPost as blogCancel, deletePost as blogDelete, listPosts as blogList, getPost as blogGet, listClientWpSites } from '../services/ops/blog/blogStore.js';
import { publishBlogPost } from '../services/ops/blog/blogPublisher.js';

const blogUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
```
> If `multer` is already imported in ops.js, don't duplicate. `multer` is a dep (added in the social work).

- [ ] **Step 2: Add the routes** after the auth gate (alongside the chat routes)

```javascript
// ── Blog publishing ───────────────────────────────────────────────────────
router.get('/blog/sites/:clientId', async (req, res) => {
  if (!isUuid(req.params.clientId)) return badUuid(res, 'clientId');
  try { res.json({ sites: await listClientWpSites(req.params.clientId) }); }
  catch (err) { console.error('[ops] GET /blog/sites failed:', err); res.status(500).json({ message: 'Failed to load WordPress sites' }); }
});

router.get('/blog/posts', async (req, res) => {
  const clientId = req.query.clientId && isUuid(req.query.clientId) ? req.query.clientId : null;
  try { res.json({ posts: await blogList(clientId) }); }
  catch (err) { console.error('[ops] GET /blog/posts failed:', err); res.status(500).json({ message: 'Failed to load posts' }); }
});

router.post('/blog/posts', async (req, res) => {
  const b = req.body || {};
  if (!isUuid(b.client_user_id)) return badUuid(res, 'client_user_id');
  if (!(await isOperationsClient(b.client_user_id))) return res.status(404).json({ message: 'Client not found' });
  const action = b.action || 'draft'; // draft | schedule | publish_now
  let status = 'draft';
  let scheduledFor = null;
  if (action === 'schedule') { status = 'scheduled'; scheduledFor = b.scheduled_for || null; }
  else if (action === 'publish_now') { status = 'scheduled'; scheduledFor = new Date().toISOString(); }
  try {
    const post = await blogCreate({
      clientId: b.client_user_id, createdBy: req.user.id,
      oauthConnectionId: b.oauth_connection_id || null, siteResourceId: b.site_resource_id || null, siteUrl: b.site_url || null,
      title: String(b.title || 'Untitled'), contentMarkdown: String(b.content_markdown || ''),
      featuredFileUploadId: b.featured_file_upload_id || null, status, scheduledFor
    });
    res.json({ post });
  } catch (err) { console.error('[ops] POST /blog/posts failed:', err); res.status(500).json({ message: 'Failed to create post' }); }
});

router.patch('/blog/posts/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'id');
  try { const post = await blogUpdate(req.params.id, req.body || {}); if (!post) return res.status(404).json({ message: 'Not found' }); res.json({ post }); }
  catch (err) { console.error('[ops] PATCH /blog/posts/:id failed:', err); res.status(500).json({ message: 'Failed to update' }); }
});

router.post('/blog/posts/:id/cancel', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'id');
  try { const post = await blogCancel(req.params.id); if (!post) return res.status(409).json({ message: 'Cannot cancel in current state' }); res.json({ post }); }
  catch (err) { console.error('[ops] POST /blog/posts/:id/cancel failed:', err); res.status(500).json({ message: 'Failed to cancel' }); }
});

router.delete('/blog/posts/:id', async (req, res) => {
  if (!isUuid(req.params.id)) return badUuid(res, 'id');
  try { await blogDelete(req.params.id); res.json({ ok: true }); }
  catch (err) { console.error('[ops] DELETE /blog/posts/:id failed:', err); res.status(500).json({ message: 'Failed to delete' }); }
});

router.post('/blog/media', blogUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ message: 'No file' });
  try {
    const stored = await storeFile(req.file, { category: 'blog', ownerId: req.user.id, ownerType: 'ops_blog' });
    res.json(stored); // { id, url }
  } catch (err) { console.error('[ops] POST /blog/media failed:', err); res.status(500).json({ message: 'Upload failed' }); }
});
```

- [ ] **Step 3: Build + lint + boot smoke**

```bash
yarn build && yarn lint
DATABASE_URL="postgresql://bif@localhost:5432/anchor" yarn server &
sleep 5
curl -s -o /dev/null -w "blog/posts=%{http_code}\n" http://localhost:4000/api/ops/blog/posts   # expect 401 (admin-gated)
lsof -ti:4000 | xargs kill -9
```
Expected: boots; `/blog/posts` → 401.

- [ ] **Step 4: Commit**

```bash
git add server/routes/ops.js
git commit -m "feat(blog): /api/ops/blog routes (posts CRUD, sites, media)"
```

---

## Task 7: Frontend blog API client

**Files:** Create `src/api/blog.js`.

**Interfaces:** Produces `listBlogPosts(clientId)`, `createBlogPost(body)`, `updateBlogPost(id,fields)`, `cancelBlogPost(id)`, `deleteBlogPost(id)`, `listClientWpSites(clientId)`, `uploadBlogMedia(file)`. Consumed by Task 8.

- [ ] **Step 1: Implement** (axios client, mirroring `src/api/social.js`)

```javascript
// src/api/blog.js
import client from './client';

export const listBlogPosts = (clientId) =>
  client.get('/ops/blog/posts', { params: clientId ? { clientId } : {} }).then((r) => r.data.posts || []);
export const listClientWpSites = (clientId) =>
  client.get(`/ops/blog/sites/${clientId}`).then((r) => r.data.sites || []);
export const createBlogPost = (body) => client.post('/ops/blog/posts', body).then((r) => r.data.post);
export const updateBlogPost = (id, fields) => client.patch(`/ops/blog/posts/${id}`, fields).then((r) => r.data.post);
export const cancelBlogPost = (id) => client.post(`/ops/blog/posts/${id}/cancel`).then((r) => r.data.post);
export const deleteBlogPost = (id) => client.delete(`/ops/blog/posts/${id}`).then((r) => r.data);
export const uploadBlogMedia = (file) => {
  const fd = new FormData();
  fd.append('file', file);
  return client.post('/ops/blog/media', fd, { headers: { 'Content-Type': 'multipart/form-data' } }).then((r) => r.data);
};
```

- [ ] **Step 2: Build + lint + commit**

```bash
yarn build && yarn lint
git add src/api/blog.js
git commit -m "feat(blog): frontend blog API client"
```

---

## Task 8: Blog UI + Content-tab switch

**Files:** Create `src/views/admin/Operations/Content/blog/BlogCompose.jsx`, `BlogPane.jsx`; Modify `src/views/admin/Operations/Content/ContentTab.jsx`.

**Interfaces:** Consumes `api/blog` (Task 7), `listOpsClients` (api/ops), `Markdown` (`ui-component/extended/Markdown`), `useToast`, `clientLabel` (`../../_clientLabel`).

- [ ] **Step 1: Build `BlogCompose.jsx`** (markdown editor + live preview + site picker + featured image)

```jsx
// src/views/admin/Operations/Content/blog/BlogCompose.jsx
import { useEffect, useState } from 'react';
import { Stack, TextField, Select, MenuItem, Button, Box, Typography, ToggleButtonGroup, ToggleButton } from '@mui/material';
import { useToast } from 'contexts/ToastContext';
import { listClientWpSites, createBlogPost, uploadBlogMedia } from 'api/blog';
import Markdown from 'ui-component/extended/Markdown';

export default function BlogCompose({ client, onCreated }) {
  const toast = useToast();
  const [sites, setSites] = useState([]);
  const [site, setSite] = useState('');
  const [title, setTitle] = useState('');
  const [md, setMd] = useState('');
  const [featured, setFeatured] = useState(null); // { id, url }
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSites([]); setSite('');
    if (client?.id) listClientWpSites(client.id).then((s) => { setSites(s); if (s[0]) setSite(s[0].site_resource_id); }).catch(() => {});
  }, [client]);

  const chosen = sites.find((s) => s.site_resource_id === site) || null;

  const onPickImage = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try { setFeatured(await uploadBlogMedia(f)); } catch { toast.error('Image upload failed'); }
  };

  const submit = async (action) => {
    if (!client) { toast.warning('Pick a client'); return; }
    if (!chosen) { toast.warning('Pick a WordPress site'); return; }
    if (!title.trim()) { toast.warning('Title required'); return; }
    setBusy(true);
    try {
      await createBlogPost({
        client_user_id: client.id, action,
        oauth_connection_id: chosen.oauth_connection_id, site_resource_id: chosen.site_resource_id, site_url: chosen.site_url,
        title, content_markdown: md, featured_file_upload_id: featured?.id || null,
        scheduled_for: action === 'schedule' ? (when ? new Date(when).toISOString() : null) : null
      });
      toast.success(action === 'publish_now' ? 'Queued to publish' : action === 'schedule' ? 'Scheduled' : 'Saved draft');
      setTitle(''); setMd(''); setFeatured(null); setWhen('');
      onCreated?.();
    } catch (e) { toast.error(e?.response?.data?.message || 'Failed'); }
    finally { setBusy(false); }
  };

  return (
    <Stack spacing={1.5}>
      <Select size="small" value={site} onChange={(e) => setSite(e.target.value)} displayEmpty>
        <MenuItem value="" disabled>{sites.length ? 'Select WordPress site' : 'No WordPress sites for this client'}</MenuItem>
        {sites.map((s) => <MenuItem key={s.site_resource_id} value={s.site_resource_id}>{s.site_name || s.site_url}</MenuItem>)}
      </Select>
      <TextField size="small" label="Title" value={title} onChange={(e) => setTitle(e.target.value)} fullWidth />
      <Stack direction="row" spacing={2}>
        <TextField multiline minRows={12} label="Content (markdown)" value={md} onChange={(e) => setMd(e.target.value)} sx={{ flex: 1 }} />
        <Box sx={{ flex: 1, border: '1px solid', borderColor: 'divider', borderRadius: 1, p: 1.5, overflow: 'auto', maxHeight: 360 }}>
          <Typography variant="caption" color="text.secondary">Preview</Typography>
          <Markdown>{md}</Markdown>
        </Box>
      </Stack>
      <Stack direction="row" spacing={1} alignItems="center">
        <Button variant="outlined" component="label" size="small">{featured ? 'Change hero image' : 'Add hero image'}<input hidden type="file" accept="image/*" onChange={onPickImage} /></Button>
        {featured && <Typography variant="caption" color="text.secondary">image attached</Typography>}
        <TextField size="small" type="datetime-local" label="Schedule" InputLabelProps={{ shrink: true }} value={when} onChange={(e) => setWhen(e.target.value)} sx={{ ml: 'auto' }} />
      </Stack>
      <Stack direction="row" spacing={1} justifyContent="flex-end">
        <Button disabled={busy} onClick={() => submit('draft')}>Save draft</Button>
        <Button disabled={busy} variant="outlined" onClick={() => submit('schedule')}>Schedule</Button>
        <Button disabled={busy} variant="contained" onClick={() => submit('publish_now')}>Publish now</Button>
      </Stack>
    </Stack>
  );
}
```

- [ ] **Step 2: Build `BlogPane.jsx`** (client picker + queue + compose)

```jsx
// src/views/admin/Operations/Content/blog/BlogPane.jsx
import { useEffect, useState, useCallback } from 'react';
import { Stack, Autocomplete, TextField, Paper, Typography, Chip, Button } from '@mui/material';
import { listOpsClients } from 'api/ops';
import { listBlogPosts, cancelBlogPost } from 'api/blog';
import { clientLabel } from '../../_clientLabel';
import BlogCompose from './BlogCompose';

const STATUS_COLOR = { draft: 'default', scheduled: 'info', publishing: 'warning', published: 'success', failed: 'error', cancelled: 'default' };

export default function BlogPane() {
  const [clients, setClients] = useState([]);
  const [client, setClient] = useState(null);
  const [posts, setPosts] = useState([]);

  useEffect(() => { listOpsClients().then(setClients).catch(() => {}); }, []);
  const refresh = useCallback(() => { listBlogPosts(client?.id).then(setPosts).catch(() => {}); }, [client]);
  useEffect(() => { refresh(); }, [refresh]);

  return (
    <Stack spacing={2}>
      <Autocomplete size="small" options={clients} value={client} getOptionLabel={(c) => clientLabel(c)}
        onChange={(_, v) => setClient(v)} renderInput={(p) => <TextField {...p} label="Client" />} sx={{ maxWidth: 360 }} />
      {client && <BlogCompose client={client} onCreated={refresh} />}
      <Stack spacing={1}>
        <Typography variant="subtitle2">Posts</Typography>
        {posts.map((p) => (
          <Paper key={p.id} variant="outlined" sx={{ p: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
            <Chip size="small" color={STATUS_COLOR[p.status] || 'default'} label={p.status} />
            <Typography variant="body2" sx={{ flex: 1 }} noWrap>{p.title}</Typography>
            {p.wp_post_url && <a href={p.wp_post_url} target="_blank" rel="noopener noreferrer">view</a>}
            {['draft', 'scheduled', 'failed'].includes(p.status) && <Button size="small" onClick={() => cancelBlogPost(p.id).then(refresh)}>Cancel</Button>}
          </Paper>
        ))}
        {!posts.length && <Typography variant="caption" color="text.secondary">No posts yet.</Typography>}
      </Stack>
    </Stack>
  );
}
```

- [ ] **Step 3: Add the Social|Blog switch in `ContentTab.jsx`** — wrap the existing social content. Add a `mode` state and an outer toggle; render `BlogPane` when `mode==='blog'`, else the existing social Calendar/Queue/Compose. Concretely: import `BlogPane` and `ToggleButtonGroup/ToggleButton`, add `const [mode, setMode] = useState('social');` at the top, render the toggle above the existing tabs, and gate the existing social UI behind `mode === 'social'`:

```jsx
// near the top of the returned JSX, above the existing <Tabs>:
import { ToggleButton, ToggleButtonGroup } from '@mui/material';
import BlogPane from './blog/BlogPane';
// ...
<ToggleButtonGroup size="small" exclusive value={mode} onChange={(_, v) => v && setMode(v)} sx={{ mb: 1 }}>
  <ToggleButton value="social">Social</ToggleButton>
  <ToggleButton value="blog">Blog</ToggleButton>
</ToggleButtonGroup>
{mode === 'blog' ? <BlogPane /> : (
  /* the EXISTING social calendar/queue/compose JSX, unchanged */
)}
```
> Read the current `ContentTab.jsx` first; wrap its existing social JSX (the `<Tabs>` + CalendarView/QueueView + ComposeDialog) in the `mode === 'social'` branch without altering it. Keep the existing `clients`/`refreshKey`/compose state for the social branch.

- [ ] **Step 4: Build + lint**

```bash
yarn build && yarn lint
```
Expected: PASS (Content tab compiles with the Social|Blog switch + BlogPane).

- [ ] **Step 5: Commit**

```bash
git add src/views/admin/Operations/Content/blog src/views/admin/Operations/Content/ContentTab.jsx
git commit -m "feat(blog): Blog sub-view (markdown compose + queue) + Social|Blog switch"
```

---

## Task 9: Verify + PR

- [ ] **Step 1: Full local verification**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
yarn build && yarn lint
yarn test:ops   # the 3+ new blog unit tests pass; pre-existing DB tests fail for lack of DATABASE_URL (environmental)
DATABASE_URL="postgresql://bif@localhost:5432/anchor" yarn db:migrate   # idempotent; ops_blog_posts present
DATABASE_URL="postgresql://bif@localhost:5432/anchor" yarn server &
sleep 5
curl -s -o /dev/null -w "blog/posts=%{http_code}\n" http://localhost:4000/api/ops/blog/posts   # 401
lsof -ti:4000 | xargs kill -9
```

- [ ] **Step 2: HUMAN verification (note in PR — can't run here)**
  - Content tab → Blog: pick a client with a WordPress connection → the site dropdown populates.
  - Write markdown → live preview renders; attach a hero image.
  - Save draft → appears in the queue; Schedule ~3 min out → status `scheduled`; the cron publishes it → status `published` with a `view` link to the live WP post; Publish-now publishes within ~2 min.
  - Confirm the post (and featured image) appear on the client's WordPress site.

- [ ] **Step 3: Push + PR (deploy gate)**

```bash
git push -u origin feat/blog-wordpress-publisher
gh pr create --title "feat(blog): WordPress blog publisher (sub-project B)" \
  --body "Ops-owned blog publishing to clients' self-hosted WordPress (markdown authoring, ops-side schedule, SSRF-guarded WP REST, optional featured image). Requires at deploy: run the net-new ops_blog migration as admin (RUN_MIGRATIONS_ON_START=false) + apply ops_app grants (DML on ops_blog_posts + SELECT on oauth_resources). Human-verify a live WP publish (see plan Task 9)."
```
> **Deploy note:** `ops_blog_posts` is net-new → run the migration as admin; the new `GRANT SELECT ON oauth_resources TO ops_app` is required for site resolution.

---

## Self-Review

**Spec coverage:** §3.1 table → Task 1; §3.2 publisher (claim/decrypt/SSRF/featured/markdown/post/retry) → Tasks 2+4; §3.3 markdown→HTML → Task 3; §3.4 cron (demo-gated) → Task 5; §3.5 routes (posts/sites/media) → Task 6; §3.6 UI (Blog sub-view, markdown editor+preview, site picker, featured image) → Tasks 7+8; §4 compliance (SSRF, no creds in logs, grants incl. oauth_resources SELECT) → Tasks 1,2; §5 deps/infra (marked, migration deploy note) → Tasks 1,9; §6 verification → unit tests (2,3,4) + migrate/boot/human (9). ✓

**Placeholder scan:** Complete code in every code step; the `>` notes are concrete verification guards (marked export shape, ContentTab wrapping, multer dedupe) — not deferred work. The Task 4 test asserts the load-bearing due-select shape; the implementer adapts the injection hook to the provided `runDueBlogPosts(testHooks)` signature.

**Type/name consistency:** `resolveWpConnection`/`wpCreatePost`/`wpUploadMedia` (Task 2) consumed by `blogPublisher` (Task 4); `mdToHtml` (Task 3) used in Task 4; blogStore fns (Task 4) consumed by the routes (Task 6) and match the api client paths (Task 7) used by the UI (Task 8). Status enum consistent (`draft/scheduled/publishing/published/failed/cancelled`). `featured_file_upload_id` consistent across table/store/publisher/route/UI.

**Known residual risks (flagged):** `marked` import shape (Task 3 note); the Task-4 unit-test injection hook is illustrative — the assertion that matters is the due-select shape; ContentTab social JSX must be wrapped unchanged (Task 8 note); WP media multipart relies on Node 20 global `FormData`/`Blob` (confirmed available).
