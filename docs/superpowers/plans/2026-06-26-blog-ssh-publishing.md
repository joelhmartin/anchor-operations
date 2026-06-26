# Blog SSH Publishing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish blog posts to a client's assigned Kinsta site over SSH/WP-CLI (using the Kinsta environment's SSH credentials), so the Blog tab lists Kinsta sites and can post — no WordPress app-password connection needed.

**Architecture:** Add a nullable `kinsta_environment_id` to `ops_blog_posts`. The Blog site picker lists the client's Kinsta sites (live environment). The publisher branches: a post with `kinsta_environment_id` publishes via a new `sshPublisher.js` (SFTP the HTML to a temp file → `wp post create` draft → optional `wp media import --featured_image` → `wp post update --post_status=publish`), reusing the existing cron/claim/retry. Idempotent (persist `wp_post_id` after the draft create so a retry resumes instead of duplicating).

**Tech Stack:** Node 20 ESM, `ssh2` + `ssh2-sftp-client` (via the existing `sshClient.js`), `marked`, PostgreSQL, React 19 + MUI 7, `node:test`.

## Global Constraints

- **No new npm dependencies** — `ssh2`/`ssh2-sftp-client`/`marked` already present.
- **Command-injection safety:** post **content** transports as a temp file (never inline in the command); the **title** and any other user value go through `shellQuote()` (single-quote escape). No unescaped user string reaches the shell. `wpcli(envId, args, opts)` takes `args` as a **string** — build it with `shellQuote` for any user value.
- **Write guard:** WP commands run via `wpcli`→`execCommand`, which refuses non-read verbs on `metadata.read_only` environments — a read-only env can't be published to (publish fails cleanly).
- **Idempotency:** persist `wp_post_id` immediately after the draft `wp post create`; on retry, if `wp_post_id` is set, **skip create** and resume — never create a duplicate post.
- **Parameterized SQL only**; UUID-validate ids (`isUuid`/`badUuid` in `ops.js`). No secrets/PHI in logs (`ensurePassword` decrypts in-memory). `console.warn`/`console.error` only.
- **Branch, don't rip out:** the old REST path (`oauth_connection_id`) stays as dormant code; new posts carry only `kinsta_environment_id`.
- **Migration** is a net-new nullable column on the ops-owned `ops_blog_posts` (`ops_app` already has DML) — idempotent `ADD COLUMN IF NOT EXISTS`, registered in `server/migrations.js`, applied by `gdeploy.sh`'s admin step at deploy.
- **Verification norm:** `node:test` for pure functions (TDD); `yarn build` + `yarn lint` + **a real module-load check** (`node -e import('./server/routes/ops.js')`) + boot/curl for endpoints/UI. Tests need `DATABASE_URL` set (e.g. `postgresql://bif@localhost:5432/anchor`). `yarn test:ops` globs `server/services/ops/__tests__/*.test.js` AND `server/services/ops/agents/__tests__/*.test.js`.

---

## File Structure

**Created:**
- `server/sql/migrate_ops_blog_ssh.sql` — `ops_blog_posts.kinsta_environment_id`.
- `server/services/ops/blog/sshPublisher.js` — `shellQuote`, `wpCreateArgs`/`wpMediaArgs`/`wpPublishArgs`, `publishViaSsh`.
- `server/services/ops/__tests__/blogSshPublisher.test.js` — TDD for `shellQuote` + the arg builders + the resume decision.

**Modified:**
- `server/migrations.js` — register the migration.
- `server/services/ops/blog/blogStore.js` — `createPost` (+ `kinstaEnvironmentId`), `updatePost` allowlist (+ `kinsta_environment_id`), new `listClientKinstaBlogTargets(clientId)`.
- `server/services/ops/blog/blogPublisher.js` — branch `publishBlogPost` on `post.kinsta_environment_id` → `publishViaSsh`.
- `server/routes/ops.js` — `GET /blog/sites/:clientId` → Kinsta targets; `POST /blog/posts` → accept `kinsta_environment_id`.
- `src/views/admin/Operations/Content/blog/BlogCompose.jsx` — picker from Kinsta targets (value = `kinsta_environment_id`); payload sends `kinsta_environment_id`; empty-state text.

---

## Task 1: Schema + store (Kinsta target column, site list)

**Files:**
- Create: `server/sql/migrate_ops_blog_ssh.sql`
- Modify: `server/migrations.js`, `server/services/ops/blog/blogStore.js`

**Interfaces:**
- Produces: `ops_blog_posts.kinsta_environment_id` column; `createPost({..., kinstaEnvironmentId})`; `updatePost` accepts `kinsta_environment_id`; `listClientKinstaBlogTargets(clientId)` → `[{ site_id, kinsta_environment_id, label, primary_domain }]`.

- [ ] **Step 1: Migration**

`server/sql/migrate_ops_blog_ssh.sql`:
```sql
ALTER TABLE ops_blog_posts ADD COLUMN IF NOT EXISTS kinsta_environment_id UUID;
```
Register in `server/migrations.js` `MIGRATIONS_BEFORE_SEED` immediately after `migrate_ops_blog.sql` (read the array; insert the filename there).

- [ ] **Step 2: `createPost` — accept `kinstaEnvironmentId`**

In `blogStore.js`, update `createPost` to add the column. New version:
```javascript
export async function createPost({ clientId, createdBy, oauthConnectionId, siteResourceId, siteUrl, kinstaEnvironmentId, title, contentMarkdown, featuredFileUploadId, status, scheduledFor }) {
  const { rows } = await query(
    `INSERT INTO ops_blog_posts
      (client_id, created_by, oauth_connection_id, site_resource_id, site_url, kinsta_environment_id, title, content_markdown, featured_file_upload_id, status, scheduled_for)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [clientId, createdBy, oauthConnectionId || null, siteResourceId || null, siteUrl || null, kinstaEnvironmentId || null, title, contentMarkdown || '', featuredFileUploadId || null, status || 'draft', scheduledFor || null]
  );
  return rows[0];
}
```

- [ ] **Step 3: `updatePost` allowlist — add the column**

In `blogStore.js`, add `'kinsta_environment_id'` to the `allowed` array:
```javascript
const allowed = ['title', 'content_markdown', 'oauth_connection_id', 'site_resource_id', 'site_url', 'kinsta_environment_id', 'featured_file_upload_id', 'status', 'scheduled_for'];
```

- [ ] **Step 4: `listClientKinstaBlogTargets`**

Add to `blogStore.js` (mirrors the Sites-tab join, but selects the live environment's id):
```javascript
export async function listClientKinstaBlogTargets(clientId) {
  const { rows } = await query(
    `SELECT s.id AS site_id,
            e.id AS kinsta_environment_id,
            COALESCE(NULLIF(s.display_name, ''), s.site_name) AS label,
            e.primary_domain
       FROM kinsta_site_clients ksc
       JOIN kinsta_sites s ON s.id = ksc.site_id
       JOIN kinsta_environments e ON e.site_id = s.id AND e.is_live = TRUE
      WHERE ksc.client_user_id = $1 AND s.archived_at IS NULL
      ORDER BY label ASC`,
    [clientId]
  );
  return rows;
}
```

- [ ] **Step 5: Verify**

`DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn db:migrate` (idempotent — run twice; confirms the column adds). `node --check server/services/ops/blog/blogStore.js`. `DATABASE_URL=... yarn test:ops` (unchanged count, nothing broken). `yarn lint`.

- [ ] **Step 6: Commit**
```bash
git add server/sql/migrate_ops_blog_ssh.sql server/migrations.js server/services/ops/blog/blogStore.js
git commit -m "feat(ops): ops_blog_posts.kinsta_environment_id + Kinsta blog targets list"
```

---

## Task 2: SSH publisher + publisher branch

**Files:**
- Create: `server/services/ops/blog/sshPublisher.js`
- Create: `server/services/ops/__tests__/blogSshPublisher.test.js`
- Modify: `server/services/ops/blog/blogPublisher.js`

**Interfaces:**
- Consumes: `wpcli(environmentId, argsString, opts)` → `{ stdout, stderr, exitCode, durationMs }` and `withSftp(environmentId, fn, opts)` (fn gets an `ssh2-sftp-client` with `put(Buffer, remotePath)` / `delete(remotePath)`) from `../operations-website/sshClient.js`; `mdToHtml` from `./markdown.js`; `query` from `../../../db.js`.
- Produces: `shellQuote(s)`; `wpCreateArgs(htmlPath, title)`; `wpMediaArgs(imgPath, wpPostId)`; `wpPublishArgs(wpPostId)`; `publishViaSsh(id, post)` → `{ ok, wpPostId, wpPostUrl }` or `{ ok:false, reason:'error' }`.

- [ ] **Step 1: Write the failing test (pure pieces)**

`server/services/ops/__tests__/blogSshPublisher.test.js`:
```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { shellQuote, wpCreateArgs, wpMediaArgs, wpPublishArgs } from '../blog/sshPublisher.js';

test('shellQuote single-quotes and escapes embedded quotes — injection-safe', () => {
  assert.equal(shellQuote('hello'), "'hello'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
  // A shell-metacharacter payload stays fully inside the single quotes (no break-out):
  const q = shellQuote("x'; rm -rf / #");
  assert.ok(q.startsWith("'") && q.endsWith("'"));
  assert.ok(q.includes("'\\''")); // the embedded quote is escaped
});

test('wpCreateArgs builds a draft create with quoted title + file content', () => {
  const a = wpCreateArgs('/tmp/ops-blog-7.html', "Bob's Post");
  assert.ok(a.startsWith('post create /tmp/ops-blog-7.html '));
  assert.ok(a.includes("--post_title='Bob'\\''s Post'"));
  assert.ok(a.includes('--post_status=draft'));
  assert.ok(a.includes('--porcelain'));
});

test('wpMediaArgs / wpPublishArgs', () => {
  assert.equal(wpMediaArgs('/tmp/ops-blog-7-img', '42'), 'media import /tmp/ops-blog-7-img --post_id=42 --featured_image --porcelain');
  assert.equal(wpPublishArgs('42'), 'post update 42 --post_status=publish --porcelain');
});
```

- [ ] **Step 2: Run — fail** (`DATABASE_URL=... node --test server/services/ops/__tests__/blogSshPublisher.test.js` → module not found).

- [ ] **Step 3: Implement `sshPublisher.js`**
```javascript
import { query } from '../../../db.js';
import { mdToHtml } from './markdown.js';
import { wpcli, withSftp } from '../operations-website/sshClient.js';

// Single-quote a value for safe shell use: ' -> '\'' . Everything else stays literal.
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

export function wpCreateArgs(htmlPath, title) {
  return `post create ${htmlPath} --post_title=${shellQuote(title)} --post_status=draft --porcelain`;
}
export function wpMediaArgs(imgPath, wpPostId) {
  return `media import ${imgPath} --post_id=${wpPostId} --featured_image --porcelain`;
}
export function wpPublishArgs(wpPostId) {
  return `post update ${wpPostId} --post_status=publish --porcelain`;
}

// Publish a claimed ops_blog_posts row (status='publishing') to its Kinsta site via WP-CLI.
// Idempotent: wp_post_id persisted after the draft create, so a retry resumes (no duplicate).
export async function publishViaSsh(id, post) {
  const envId = post.kinsta_environment_id;
  const htmlPath = `/tmp/ops-blog-${id}.html`;
  const imgPath = `/tmp/ops-blog-${id}-img`;
  try {
    let wpPostId = post.wp_post_id ? String(post.wp_post_id) : '';

    if (!wpPostId) {
      const html = mdToHtml(post.content_markdown);
      await withSftp(envId, async (sftp) => { await sftp.put(Buffer.from(html, 'utf8'), htmlPath); });
      const out = await wpcli(envId, wpCreateArgs(htmlPath, post.title));
      wpPostId = String(out.stdout || '').trim();
      if (!wpPostId) throw new Error(`wp post create returned no id: ${String(out.stderr || '').slice(0, 200)}`);
      await query(`UPDATE ops_blog_posts SET wp_post_id=$2, updated_at=NOW() WHERE id=$1`, [id, wpPostId]);
    }

    if (post.featured_file_upload_id) {
      const { rows } = await query(`SELECT bytes FROM file_uploads WHERE id=$1`, [post.featured_file_upload_id]);
      if (rows.length && rows[0].bytes) {
        await withSftp(envId, async (sftp) => { await sftp.put(rows[0].bytes, imgPath); });
        await wpcli(envId, wpMediaArgs(imgPath, wpPostId));
      }
    }

    await wpcli(envId, wpPublishArgs(wpPostId));

    let url = null;
    try {
      const u = await wpcli(envId, `post get ${wpPostId} --field=url`);
      url = String(u.stdout || '').trim() || null;
    } catch { /* url is non-fatal */ }

    await query(
      `UPDATE ops_blog_posts SET status='published', wp_post_id=$2, wp_post_url=$3, published_at=NOW(), error=NULL, updated_at=NOW() WHERE id=$1`,
      [id, wpPostId, url]
    );
    return { ok: true, wpPostId, wpPostUrl: url };
  } catch (err) {
    await query(
      `UPDATE ops_blog_posts SET status='failed', failed_at=NOW(), error=$2, retry_count=retry_count+1, updated_at=NOW() WHERE id=$1`,
      [id, String(err.message || err).slice(0, 500)]
    ).catch((e2) => console.error('[blog-ssh] mark-failure failed', id, e2?.message));
    return { ok: false, reason: 'error' };
  } finally {
    // Best-effort temp cleanup.
    try {
      await withSftp(envId, async (sftp) => {
        await sftp.delete(htmlPath).catch(() => {});
        await sftp.delete(imgPath).catch(() => {});
      });
    } catch { /* ignore */ }
  }
}
```
Confirm against the real `sshClient.js` when editing: `wpcli` returns `{ stdout, stderr, ... }` (use `out.stdout`); `withSftp`'s callback receives the `ssh2-sftp-client` whose `put` accepts a Buffer as the first arg and a remote path as the second, and `delete(remotePath)` exists. If `put`'s arg order/types differ, adjust. (Open item from the spec: if `wp post create <file>` doesn't read content from the positional file on the installed WP-CLI, switch the transport to stdin but keep content out of the inline command.)

- [ ] **Step 4: Run — pass** (the 3 pure tests).

- [ ] **Step 5: Branch `publishBlogPost`**

In `blogPublisher.js`, import at top: `import { publishViaSsh } from './sshPublisher.js';`. Inside `publishBlogPost`, AFTER `post` is loaded (claim/fetch) and BEFORE the `if (!post.oauth_connection_id) throw ...` line, add:
```javascript
    if (post.kinsta_environment_id) {
      return publishViaSsh(id, post);
    }
```
(`publishViaSsh` does its own published/failed UPDATEs; `publishBlogPost` already set `status='publishing'` via the claim. Leave the REST branch unchanged below it.)

- [ ] **Step 6: Verify**

`DATABASE_URL=... node --test server/services/ops/__tests__/blogSshPublisher.test.js` (3 pass). `node --check server/services/ops/blog/sshPublisher.js`. `DATABASE_URL=... node -e "import('./server/services/ops/blog/blogPublisher.js').then(()=>console.log('publisher loads')).catch(e=>{console.error(e.message);process.exit(1)})"` (real module-load — catches import-depth bugs). `DATABASE_URL=... yarn test:ops` (now +3). `yarn lint`.

- [ ] **Step 7: Commit**
```bash
git add server/services/ops/blog/sshPublisher.js server/services/ops/__tests__/blogSshPublisher.test.js server/services/ops/blog/blogPublisher.js
git commit -m "feat(ops): publish blog posts to Kinsta sites via SSH/WP-CLI"
```

---

## Task 3: Endpoints — Kinsta site list + accept kinsta_environment_id

**Files:**
- Modify: `server/routes/ops.js`

**Interfaces:**
- Consumes: `listClientKinstaBlogTargets` (Task 1); `createPost` with `kinstaEnvironmentId` (Task 1).

- [ ] **Step 1: `GET /blog/sites/:clientId` → Kinsta targets**

In `ops.js`, change the import to add `listClientKinstaBlogTargets` (from the blog store module it already imports `listClientWpSites`/`blogCreate` from — match that import line). Replace the `GET /blog/sites/:clientId` handler body to return Kinsta targets:
```javascript
router.get('/blog/sites/:clientId', async (req, res) => {
  if (!isUuid(req.params.clientId)) return badUuid(res, 'clientId');
  try {
    res.json({ sites: await listClientKinstaBlogTargets(req.params.clientId) });
  } catch (err) {
    console.error('[ops] GET /blog/sites failed:', err);
    res.status(500).json({ message: 'Failed to load sites' });
  }
});
```

- [ ] **Step 2: `POST /blog/posts` → accept `kinsta_environment_id`**

In the `POST /blog/posts` handler, add `kinsta_environment_id` to the `blogCreate(...)` call. If present, validate it's a uuid. Updated `blogCreate` call:
```javascript
    if (b.kinsta_environment_id && !isUuid(b.kinsta_environment_id)) return badUuid(res, 'kinsta_environment_id');
    const post = await blogCreate({
      clientId: b.client_user_id, createdBy: req.user.id,
      oauthConnectionId: b.oauth_connection_id || null, siteResourceId: b.site_resource_id || null, siteUrl: b.site_url || null,
      kinstaEnvironmentId: b.kinsta_environment_id || null,
      title: String(b.title || 'Untitled'), contentMarkdown: String(b.content_markdown || ''),
      featuredFileUploadId: b.featured_file_upload_id || null, status, scheduledFor
    });
```
(`blogCreate` is the alias `ops.js` imports for `createPost` — keep the existing name.)

- [ ] **Step 3: Verify**

`yarn build` (frontend) + `yarn lint`. **Module-load check** (catches import bugs): `DATABASE_URL=... node -e "import('./server/routes/ops.js').then(()=>console.log('ops.js loads')).catch(e=>{console.error(e.message);process.exit(1)})"`. `DATABASE_URL=... yarn test:ops` (unchanged). Boot the server; with an admin token, `GET /api/ops/blog/sites/<clientId>` returns Kinsta targets (`[{site_id,kinsta_environment_id,label,primary_domain}]`) for a client with an assigned site; bad uuid → 400.

- [ ] **Step 4: Commit**
```bash
git add server/routes/ops.js
git commit -m "feat(ops): blog endpoints serve Kinsta targets + accept kinsta_environment_id"
```

---

## Task 4: Compose UI — Kinsta site picker

**Files:**
- Modify: `src/views/admin/Operations/Content/blog/BlogCompose.jsx`

**Interfaces:**
- Consumes: `listClientWpSites(clientId)` (api, now returns Kinsta targets `[{site_id,kinsta_environment_id,label,primary_domain}]`); `createBlogPost(body)`.

- [ ] **Step 1: Picker from Kinsta targets**

Read `BlogCompose.jsx` fully. Update:
- The site-load effect: `listClientWpSites(client.id).then((s) => { setSites(s); if (s[0]) setSite(s[0].kinsta_environment_id); })` (value is now `kinsta_environment_id`, not `site_resource_id`).
- The dropdown option `value` → `s.kinsta_environment_id`; option label → `s.label` (with `s.primary_domain` as secondary text if shown).
- The empty-state text `'No WordPress sites for this client'` → `'No Kinsta site with a live environment is assigned — assign one in the Sites tab'`.

- [ ] **Step 2: Payload sends `kinsta_environment_id`**

Update the `createBlogPost({...})` call: replace the REST fields with the Kinsta env id. The `chosen` lookup now finds the selected target by `kinsta_environment_id`:
```javascript
    const chosen = sites.find((s) => s.kinsta_environment_id === site) || {};
    await createBlogPost({
      client_user_id: client.id, action,
      kinsta_environment_id: chosen.kinsta_environment_id || site,
      title, content_markdown: md, featured_file_upload_id: featured?.id || null,
      scheduled_for: action === 'schedule' ? (when ? new Date(when).toISOString() : null) : null
    });
```
(Drop `oauth_connection_id`/`site_resource_id`/`site_url` from the payload — those were the dormant REST fields.)

- [ ] **Step 3: Verify**

`yarn build` + `yarn lint`. Boot; the Blog tab for a client with an assigned Kinsta site now lists that site (label), and Draft/Schedule/Publish-now submit with `kinsta_environment_id`. (Live publish is the human check below.)

- [ ] **Step 4: Commit**
```bash
git add src/views/admin/Operations/Content/blog/BlogCompose.jsx
git commit -m "feat(ops): Blog compose picks a Kinsta site (SSH publish target)"
```

---

## Deployment (after all tasks + final review)

`./scripts/gdeploy.sh` now auto-runs the migration (`kinsta_environment_id`) as admin before deploying. No new secrets. **Human verification (needs a live Kinsta site with SSH):** assign a Kinsta site to a client (Sites tab) → Blog tab → compose a post (text + featured image) → Publish-now → confirm it appears in WordPress; schedule one and confirm the `*/2` cron publishes it; confirm a forced mid-flow failure + retry doesn't create a duplicate (the `wp_post_id` resume).

## Self-Review Notes (spec coverage)

- §3.1 Kinsta site picker → Task 1 (`listClientKinstaBlogTargets`) + Task 3 (endpoint) + Task 4 (UI). §3.2 column → Task 1. §3.3 SSH publisher (draft→image→publish, idempotent resume, temp cleanup) → Task 2. §3.4 branch → Task 2 Step 5. §3.5 compose payload → Task 4. §4 safety (shellQuote injection, temp-file content, write guard via wpcli, audit via kinsta_ssh_command_log, temp cleanup) → Task 2. §5 migration → Task 1. §6 verification (shellQuote/arg-builder tests, module-load check, human live publish) → per-task. Open items (§7): `wpcli` string-arg signature confirmed (string); `wp post create <file>` content-from-file + `wp media import --featured_image` behavior + `/tmp` SFTP writability are flagged in Task 2 Step 3 for the implementer to confirm against the real WP-CLI/Kinsta and adjust transport if needed.
