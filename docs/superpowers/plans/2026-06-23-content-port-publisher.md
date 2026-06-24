# Content Sub-project A — Port Social Publisher into anchor-operations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the mature Facebook/Instagram social publisher (services, routes, crons, and Calendar/Queue/Compose UI) from `Anchor-Client-Dashboard` into `anchor-operations` under a new **Content** tab, then remove it from the main app — a faithful lift-and-shift with a hard-removal cutover.

**Architecture:** Backend services land *flat* in `anchor-operations/server/services/` (same relative layout as the source) so their imports stay byte-identical; the only backend code edits are (a) a slim 2-function Meta-Graph shim replacing the 1437-line `oauthIntegration.js`, and (b) wiring in `server/index.js` (router mount + two crons). Frontend components land in `src/views/admin/Operations/Content/` and resolve their shared imports via `baseUrl: src`. The shared Postgres already holds `meta_page_links` / `social_posts` / `social_media_tokens` / `file_uploads`, so there is no data migration — only an `ops_app` role GRANT.

**Tech Stack:** Express 4 / Node 20 ESM, React 19 + Vite 7 + MUI 7, PostgreSQL 15 (shared Cloud SQL via `ops_app` role), `node-cron` (already a dep), `multer` (to add), Meta Graph API v21, AES-256-GCM (`ENCRYPTION_KEY`).

## Global Constraints

- **No automated test suite for UI/integration.** Verification = `yarn build` + `yarn lint` + functional/manual check (project rule; see `.claude/skills/verify-without-tests`). This plan adapts TDD accordingly: each task ends with build+lint + a concrete functional check + commit. One pure-logic unit test is added for the media-token round-trip (fits ops's existing `server/services/ops/__tests__` + `yarn test:ops`).
- **HIPAA / PHI:** No PHI flows through social posts (marketing copy only). Never log post content or tokens in errors. Encrypted page tokens (`page_access_token_encrypted`) must use the SAME `ENCRYPTION_KEY` as the main app or existing rows won't decrypt.
- **Client display name:** use `clientLabel` / `clientLabelSelect` (already in ops) — never `users.email`/name. (CLAUDE.md HARD RULE.)
- **Import paths:** ops `jsconfig.json` has `baseUrl: src` — frontend shared imports resolve as `ui-component/...`, `api/...`, `contexts/...`, `hooks/...`, `utils/...`. No relative `../../..` for shared components.
- **Toast on every state-changing action** (success AND failure) — preserved by the faithful port (components already use `useToast`).
- **Cutover safety:** the `*/2` publish cron must run in exactly one app. Deploy ops with the cron live, then remove from main in the same change window. `runDuePosts()` uses `FOR UPDATE SKIP LOCKED`, so brief overlap cannot double-publish.
- **Refinement vs spec §4:** services go *flat* in `server/services/` (not a `social/` subfolder) to keep import paths byte-identical and minimize port risk. The spec's `social/` subfolder was indicative, not binding.

---

## File Structure

**anchor-operations — backend (create unless noted):**
- `server/services/vimeo.js` — Vimeo direct-file-URL resolver (`getDirectFileUrl`). Verbatim copy.
- `server/services/fileStorage.js` — stores uploaded media into `file_uploads` BYTEA (`storeFile`). Verbatim copy.
- `server/services/metaGraph.js` — slim shim: `fetchFacebookPages`, `fetchInstagramAccountForPage`. New (~40 lines).
- `server/services/metaPagePosting.js` — Graph v21 wrapper. Copy; edit 1 import line.
- `server/services/socialPublisher.js` — publish orchestrator. Verbatim copy.
- `server/services/socialClientLinkSync.js` — link reconciler. Verbatim copy.
- `server/services/socialMediaTokens.js` — HMAC media tokens. Verbatim copy.
- `server/routes/social.js` — `/api/social` router (self-gates auth; public `/media/:token`). Verbatim copy.
- `server/sql/migrate_social_publishing.sql` — schema (idempotent). Verbatim copy.
- `server/migrations.js` — MODIFY: register the migration.
- `server/index.js` — MODIFY: mount router + two crons + startup backfill.
- `infra/sql/ops_app_role.sql` — MODIFY: GRANT on the 4 tables.
- `.env.example` — MODIFY: document new env vars.
- `server/services/ops/__tests__/socialMediaTokens.test.js` — new unit test (token round-trip).

**anchor-operations — frontend (create unless noted):**
- `src/utils/vimeo.js` — `parseVimeoId`. Verbatim copy (5 lines).
- `src/ui-component/extended/Calendar/` — shared calendar component. Verbatim copy (whole dir).
- `src/ui-component/extended/FacebookPostPreview.jsx` — FB preview. Verbatim copy.
- `src/api/social.js` — API client. Verbatim copy.
- `src/views/admin/Operations/Content/ContentTab.jsx` — tab body (adapted from `SocialSection.jsx`; sources clients via `listOpsClients`).
- `src/views/admin/Operations/Content/CalendarView.jsx` — verbatim copy.
- `src/views/admin/Operations/Content/QueueView.jsx` — verbatim copy.
- `src/views/admin/Operations/Content/ComposeDialog.jsx` — verbatim copy.
- `src/views/admin/Operations/Content/MediaPicker.jsx` — verbatim copy.
- `src/views/admin/Operations/index.jsx` — MODIFY: register Content tab.
- `package.json` — MODIFY: add `multer`.

**Anchor-Client-Dashboard — removal (final task):**
- DELETE: `server/services/{socialPublisher,metaPagePosting,socialClientLinkSync,socialMediaTokens}.js`, `server/routes/social.js`, `src/views/admin/AdminHub/social/`, `src/api/social.js`.
- MODIFY: `server/index.js` (remove mount, public-CORS entry, 2 crons, backfill, migration registration), `src/views/admin/AdminHub.jsx` (replace `<SocialSection .../>` with a "moved" notice).

---

## Task 1: Port Vimeo + file-storage services

**Files:**
- Create: `anchor-operations/server/services/vimeo.js`
- Create: `anchor-operations/server/services/fileStorage.js`

**Interfaces:**
- Produces: `getDirectFileUrl(...)` (from vimeo.js), `storeFile(...)` (from fileStorage.js) — consumed by Tasks 2–4.

- [ ] **Step 1: Copy both files verbatim**

```bash
cp "/Volumes/G-DRIVE SSD/DEVELOPER/Anchor-Client-Dashboard/server/services/vimeo.js" \
   "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/server/services/vimeo.js"
cp "/Volumes/G-DRIVE SSD/DEVELOPER/Anchor-Client-Dashboard/server/services/fileStorage.js" \
   "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/server/services/fileStorage.js"
```

- [ ] **Step 2: Verify their imports resolve in ops**

Both import only from `../db.js` (and Node built-ins). Confirm:
```bash
grep -n "^import" "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/server/services/vimeo.js" \
                  "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/server/services/fileStorage.js"
```
Expected: every `import` points to `../db.js` or a Node built-in (`node:crypto`, etc.). `../db.js` exists in ops and exports `query`/`getClient`/`pool`. If either file imports anything else (e.g. another helper), copy that helper too and re-run.

- [ ] **Step 3: Build + lint**

Run: `cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations" && yarn build && yarn lint`
Expected: PASS (no unresolved-import errors for the two new files).

- [ ] **Step 4: Commit**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
git add server/services/vimeo.js server/services/fileStorage.js
git commit -m "feat(content): port vimeo + fileStorage services into ops"
```

---

## Task 2: Create the slim Meta-Graph shim

Replaces the 1437-line `oauthIntegration.js` with just the two functions `metaPagePosting.js` needs (they depend only on a Graph URL constant + global `fetch`). Mirrors ops's existing `services/ctm.js` slim-shim pattern.

**Files:**
- Create: `anchor-operations/server/services/metaGraph.js`

**Interfaces:**
- Produces: `fetchFacebookPages(accessToken)` → array of `{id,name,category,picture,link,accessToken,instagramBusinessAccountId}`; `fetchInstagramAccountForPage(pageAccessToken, instagramAccountId)` → `{id,username,name,picture,followersCount,mediaCount}|null`. Consumed by Task 3.

- [ ] **Step 1: Write the shim** (copy the two functions verbatim from `Anchor-Client-Dashboard/server/services/oauthIntegration.js:576-625`, add the Graph URL constant)

```javascript
// server/services/metaGraph.js
// Slim shim: the two Facebook/Instagram resource fns metaPagePosting.js needs.
// Extracted from the main app's oauthIntegration.js to avoid porting its full
// 1400-line OAuth surface (Google/Microsoft/WordPress) we don't use here.

const FACEBOOK_GRAPH_URL = 'https://graph.facebook.com/v21.0';

/** Fetch Facebook Pages the token can manage. */
export async function fetchFacebookPages(accessToken) {
  const res = await fetch(
    `${FACEBOOK_GRAPH_URL}/me/accounts?fields=id,name,access_token,category,picture,link,instagram_business_account&access_token=${accessToken}`
  );
  if (!res.ok) {
    const text = await res.text();
    console.error('[metaGraph:fetchFacebookPages] Failed:', text);
    if (res.status === 404 || res.status === 403) return [];
    throw new Error(`Failed to fetch Facebook Pages: ${text}`);
  }
  const data = await res.json();
  return (data.data || []).map((page) => ({
    id: page.id,
    name: page.name,
    category: page.category,
    picture: page.picture?.data?.url || '',
    link: page.link,
    accessToken: page.access_token,
    instagramBusinessAccountId: page.instagram_business_account?.id || null
  }));
}

/** Fetch Instagram Business Account details for a Page. */
export async function fetchInstagramAccountForPage(pageAccessToken, instagramAccountId) {
  const res = await fetch(
    `${FACEBOOK_GRAPH_URL}/${instagramAccountId}?fields=id,username,name,profile_picture_url,followers_count,media_count&access_token=${pageAccessToken}`
  );
  if (!res.ok) {
    const text = await res.text();
    console.error('[metaGraph:fetchInstagramAccountForPage] Failed:', text);
    return null;
  }
  const data = await res.json();
  return {
    id: data.id,
    username: data.username,
    name: data.name || data.username,
    picture: data.profile_picture_url || '',
    followersCount: data.followers_count,
    mediaCount: data.media_count
  };
}
```

> **Confirm the Graph version:** open `Anchor-Client-Dashboard/server/services/oauthIntegration.js` and check `FACEBOOK_GRAPH_URL`'s value. If it differs from `v21.0`, match it here AND confirm it agrees with `metaPagePosting.js`'s own graph version so both speak the same API version.

- [ ] **Step 2: Build + lint**

Run: `cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations" && yarn build && yarn lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
git add server/services/metaGraph.js
git commit -m "feat(content): slim Meta-Graph shim (fetchFacebookPages/Ig) for ops"
```

---

## Task 3: Port the four social services

**Files:**
- Create (verbatim copies): `metaPagePosting.js`, `socialPublisher.js`, `socialClientLinkSync.js`, `socialMediaTokens.js` in `anchor-operations/server/services/`
- Modify: the one `oauthIntegration` import in `metaPagePosting.js`

**Interfaces:**
- Consumes: `getDirectFileUrl` (Task 1), `storeFile` (Task 1), `fetchFacebookPages`/`fetchInstagramAccountForPage` (Task 2), plus ops-present `query`/`getClient` (`../db.js`), `activeOnly`/`notRevoked` (`./queryHelpers.js`), `encrypt`/`decrypt` (`./security/encryption.js`), `logSecurityEvent` (`./security/audit.js`).
- Produces: `runDuePosts()`, `publishPost()`, `resolveMediaUrl()` (socialPublisher); `healthCheckPage()`, `listAccessiblePages()`, `linkClient()`, `postToFacebook()`, `postToInstagram()`, `getPageToken()`, `cancelFacebookScheduled()`, `graph()` (metaPagePosting); `syncClientFacebookLinks()`, `setClientPagePublishing()`, `listClientPages()` (socialClientLinkSync); `mintMediaToken()`, `verifyMediaToken()`, `revokeToken()` (socialMediaTokens). Consumed by Tasks 4, 6, the unit test, and main-app removal.

- [ ] **Step 1: Copy the four files verbatim**

```bash
SRC="/Volumes/G-DRIVE SSD/DEVELOPER/Anchor-Client-Dashboard/server/services"
DST="/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/server/services"
cp "$SRC/metaPagePosting.js" "$DST/metaPagePosting.js"
cp "$SRC/socialPublisher.js" "$DST/socialPublisher.js"
cp "$SRC/socialClientLinkSync.js" "$DST/socialClientLinkSync.js"
cp "$SRC/socialMediaTokens.js" "$DST/socialMediaTokens.js"
```

- [ ] **Step 2: Repoint the one stale import in `metaPagePosting.js`**

Change this line:
```javascript
import { fetchFacebookPages, fetchInstagramAccountForPage } from './oauthIntegration.js';
```
to:
```javascript
import { fetchFacebookPages, fetchInstagramAccountForPage } from './metaGraph.js';
```

- [ ] **Step 3: Confirm no other import is unresolved in ops**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
grep -n "^import" server/services/metaPagePosting.js server/services/socialPublisher.js \
  server/services/socialClientLinkSync.js server/services/socialMediaTokens.js
```
Expected imports, all present in ops: `../db.js`, `./queryHelpers.js`, `./security/encryption.js`, `./security/audit.js`, `./vimeo.js`, `./metaPagePosting.js`, `./socialMediaTokens.js`, `./metaGraph.js`, `node:crypto`. If anything else appears, port it before continuing.

- [ ] **Step 4: Build + lint**

Run: `yarn build && yarn lint`
Expected: PASS (all four services resolve).

- [ ] **Step 5: Commit**

```bash
git add server/services/metaPagePosting.js server/services/socialPublisher.js \
        server/services/socialClientLinkSync.js server/services/socialMediaTokens.js
git commit -m "feat(content): port social publisher services into ops"
```

---

## Task 4: Unit-test the media-token round-trip

The token mint/verify is pure crypto + a DB insert — the one piece worth a fast regression test, and it fits ops's existing `yarn test:ops` harness.

**Files:**
- Create: `anchor-operations/server/services/ops/__tests__/socialMediaTokens.test.js`

**Interfaces:**
- Consumes: `mintMediaToken`, `verifyMediaToken` (Task 3).

- [ ] **Step 1: Inspect the existing test harness style**

```bash
ls "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/server/services/ops/__tests__/"
head -30 "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/server/services/ops/__tests__/"*.js | head -40
```
Match whatever runner the existing tests use (node:test, vitest, etc.) and how they mock `db.js`.

- [ ] **Step 2: Write the failing test** (adapt the harness/mocks to match Step 1; this uses `node:test` + a stubbed `query`)

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

// Set the HMAC secret before importing the module under test.
process.env.SOCIAL_MEDIA_SECRET = 'test-secret-please-rotate';

// NOTE: stub ../../db.js the same way the sibling tests do so mintMediaToken's
// INSERT and verifyMediaToken's revocation SELECT resolve. See Step 1.

const { mintMediaToken, verifyMediaToken } = await import('../../socialMediaTokens.js');

test('a freshly minted token verifies and binds to its file_upload', async () => {
  const token = await mintMediaToken({ fileUploadId: 'file-123', postId: 'post-456' });
  const result = await verifyMediaToken(token);
  assert.equal(result.fileUploadId, 'file-123');
});

test('a tampered token fails verification', async () => {
  const token = await mintMediaToken({ fileUploadId: 'file-123', postId: 'post-456' });
  const tampered = token.slice(0, -2) + (token.endsWith('a') ? 'bb' : 'aa');
  const result = await verifyMediaToken(tampered).catch(() => null);
  assert.ok(!result || result.fileUploadId !== 'file-123');
});
```

> Open `socialMediaTokens.js` first and align the exact arg shape of `mintMediaToken` / return shape of `verifyMediaToken` (the example assumes `{ fileUploadId, postId }` in and `{ fileUploadId }` out — adjust to the real signatures).

- [ ] **Step 3: Run it, expect failure first** (proves the test runs and mocks bind)

Run: `cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations" && yarn test:ops`
Expected: the new test executes (may FAIL until mocks/signatures align). Fix the stub/signatures until it runs.

- [ ] **Step 4: Make it pass**

Adjust mocks/signatures so both tests PASS. Do NOT change `socialMediaTokens.js` logic — it's a faithful port; the test conforms to it.

Run: `yarn test:ops`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/__tests__/socialMediaTokens.test.js
git commit -m "test(content): media-token mint/verify round-trip"
```

---

## Task 5: Port the route + add multer

**Files:**
- Create: `anchor-operations/server/routes/social.js` (verbatim copy)
- Modify: `anchor-operations/package.json` (add `multer`)

**Interfaces:**
- Consumes: `requireAuth` (`../middleware/auth.js`), `isStaff` (`../middleware/roles.js`), `query` (`../db.js`), `clientLabelSelect`/`clientLabelExpression`/`clientLabelJoins` (`../services/clientLabel.js`), `activeOnly` (`../services/queryHelpers.js`), `logSecurityEvent` (`../services/security/audit.js`), `storeFile` (`../services/fileStorage.js`), `listAccessiblePages`/`linkClient`/`healthCheckPage` (Task 3), `publishPost` (Task 3), `verifyMediaToken` (Task 3).
- Produces: default export `socialRouter` (Express router). Consumed by Task 6.

- [ ] **Step 1: Add multer**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
yarn add multer
```
This updates `package.json` + `yarn.lock` (lockfile must be committed — CI uses `--immutable`).

- [ ] **Step 2: Copy the router verbatim**

```bash
cp "/Volumes/G-DRIVE SSD/DEVELOPER/Anchor-Client-Dashboard/server/routes/social.js" \
   "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/server/routes/social.js"
```

- [ ] **Step 3: Confirm every import resolves in ops**

```bash
grep -n "^import" "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/server/routes/social.js"
```
Expected (all present in ops): `express`, `multer`, `../middleware/auth.js`, `../middleware/roles.js`, `../db.js`, `../services/clientLabel.js`, `../services/queryHelpers.js`, `../services/security/audit.js`, `../services/fileStorage.js`, `../services/metaPagePosting.js`, `../services/socialPublisher.js`, `../services/socialMediaTokens.js`. Note `isStaff` exists in ops `middleware/roles.js` (`requireRole(['superadmin','admin','team'])`). The router self-gates: `GET /media/:token` is defined *before* `router.use(requireAuth, isStaff)` and stays public — preserve that ordering exactly.

- [ ] **Step 4: Build + lint**

Run: `yarn build && yarn lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/routes/social.js package.json yarn.lock
git commit -m "feat(content): port /api/social router + add multer dep"
```

---

## Task 6: Migration + DB role grants

**Files:**
- Create: `anchor-operations/server/sql/migrate_social_publishing.sql` (verbatim copy)
- Modify: `anchor-operations/server/migrations.js` (register it)
- Modify: `anchor-operations/infra/sql/ops_app_role.sql` (GRANT)

**Interfaces:**
- Produces: tables `meta_page_links`, `social_posts`, `social_media_tokens` available to ops (idempotent in shared prod).

- [ ] **Step 1: Copy the migration**

```bash
cp "/Volumes/G-DRIVE SSD/DEVELOPER/Anchor-Client-Dashboard/server/sql/migrate_social_publishing.sql" \
   "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/server/sql/migrate_social_publishing.sql"
```

- [ ] **Step 2: Register it in `server/migrations.js`** — append to `MIGRATIONS_BEFORE_SEED`

Add `'migrate_social_publishing.sql'` as the last entry of the `MIGRATIONS_BEFORE_SEED` array:
```javascript
  'migrate_ops_skills_and_bulk.sql',
  'migrate_social_publishing.sql'
];
```

- [ ] **Step 3: Add `ops_app` grants** in `infra/sql/ops_app_role.sql`

The existing `DO $$ ... LIKE 'ops\_%' OR LIKE 'kinsta\_%'` loop will NOT match the social tables. Add an explicit grant block after it:
```sql
-- Social publishing tables (shared with the main app; ops now owns publishing).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  meta_page_links,
  social_posts,
  social_media_tokens
TO ops_app;

-- file_uploads holds media bytes served via /api/social/media/:token.
GRANT SELECT, INSERT, UPDATE, DELETE ON file_uploads TO ops_app;
```
> `ops_app_role.sql` is applied by `infra/provision-ops.sh` against prod. Note in the PR description that this role change must be applied (the migration creates tables but the role needs the GRANT). In local dev the `bif` superuser bypasses this.

- [ ] **Step 4: Run migrations locally to confirm idempotency**

Run: `cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations" && yarn db:migrate`
Expected: completes without error; `[migrations] all ops migrations completed`. Re-run once more — still clean (idempotent).

- [ ] **Step 5: Build + lint + commit**

```bash
yarn build && yarn lint
git add server/sql/migrate_social_publishing.sql server/migrations.js infra/sql/ops_app_role.sql
git commit -m "feat(content): register social_publishing migration + ops_app grants"
```

---

## Task 7: Wire the router + crons into `server/index.js`

**Files:**
- Modify: `anchor-operations/server/index.js`

**Interfaces:**
- Consumes: `socialRouter` (Task 5), `runDuePosts`/`syncClientFacebookLinks` (Task 3), `healthCheckPage` (Task 3).

- [ ] **Step 1: Add imports** near the other router/service imports (top of file, alongside `import opsRouter ...`)

```javascript
import cron from 'node-cron';
import socialRouter from './routes/social.js';
import { runDuePosts } from './services/socialPublisher.js';
import { healthCheckPage } from './services/metaPagePosting.js';
import { syncClientFacebookLinks } from './services/socialClientLinkSync.js';
import { query } from './db.js'; // if not already imported at top
```
> If `cron` or `query` is already imported, don't duplicate. Check first: `grep -n "node-cron\|from './db.js'" server/index.js`.

- [ ] **Step 2: Mount the router** next to the other `app.use('/api/...')` lines (after `app.use('/api/operations', operationsRouter);`)

```javascript
app.use('/api/social', socialRouter); // Content suite — FB/IG publishing (ported from main app)
```
> The router self-gates auth and exposes `GET /media/:token` publicly *inside* the router (before its own `requireAuth`), so no app-level public-bypass entry is needed.

- [ ] **Step 3: Add the publish cron** (every 2 minutes) — place near the existing `setInterval(tickBulkSchedules...)` startup section

```javascript
// Content suite — publish due social posts. runDuePosts() claims rows with
// FOR UPDATE SKIP LOCKED, so this is the single publisher (cron lives only here).
cron.schedule('*/2 * * * *', async () => {
  try {
    await runDuePosts();
  } catch (e) {
    console.error('[cron:social-publish]', e?.message);
  }
}, { timezone: 'America/New_York' });
```

- [ ] **Step 4: Add the daily health cron** (4 AM ET)

```javascript
// Content suite — daily health-check of every active page link so token
// problems surface in the UI before a scheduled post fails.
cron.schedule('0 4 * * *', async () => {
  try {
    const { rows } = await query('SELECT id FROM meta_page_links WHERE archived_at IS NULL');
    for (const r of rows) {
      try { await healthCheckPage(r.id); } catch (_) { /* tracked in DB */ }
    }
  } catch (e) {
    console.error('[cron:social-health]', e?.message);
  }
}, { timezone: 'America/New_York' });
```

- [ ] **Step 5: Add the startup backfill** (auto-link single-page clients) — run once after the server is up

```javascript
// Content suite — one-shot backfill: auto-link clients with exactly one FB page.
(async () => {
  try {
    const touched = await syncClientFacebookLinks();
    if (touched) console.warn(`[backfill:social-links] auto-linked ${touched} client(s)`);
  } catch (e) {
    console.error('[backfill:social-links] failed:', e?.message);
  }
})();
```
> Confirm `syncClientFacebookLinks()`'s return value (it may return a count or a summary object). Adjust the log to match; the main app logged `auto-linked N clients`.

- [ ] **Step 6: Build + lint**

Run: `yarn build && yarn lint`
Expected: PASS.

- [ ] **Step 7: Start the server, confirm it boots and the route answers**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
yarn server &  # or ./dev.sh
sleep 4
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/social/pages   # expect 401 (auth-gated)
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:4000/api/social/media/bogus  # expect 401/404 (public route, bad token)
lsof -ti:4000 | xargs kill -9
```
Expected: server boots without crash; `/pages` returns 401 (gate works), `/media/bogus` returns a 4xx from the public handler (not a 401 from a missing route).

- [ ] **Step 8: Commit**

```bash
git add server/index.js
git commit -m "feat(content): mount /api/social + publish/health crons in ops"
```

---

## Task 8: Port frontend shared deps (vimeo util, Calendar, FacebookPostPreview)

**Files:**
- Create: `anchor-operations/src/utils/vimeo.js`
- Create: `anchor-operations/src/ui-component/extended/Calendar/` (whole directory)
- Create: `anchor-operations/src/ui-component/extended/FacebookPostPreview.jsx`

**Interfaces:**
- Produces: `parseVimeoId` (utils/vimeo), default `Calendar` component, default `FacebookPostPreview` component. Consumed by Task 10.

- [ ] **Step 1: Copy the three shared deps verbatim**

```bash
SRC="/Volumes/G-DRIVE SSD/DEVELOPER/Anchor-Client-Dashboard/src"
DST="/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/src"
mkdir -p "$DST/utils"
cp "$SRC/utils/vimeo.js" "$DST/utils/vimeo.js"
cp -R "$SRC/ui-component/extended/Calendar" "$DST/ui-component/extended/Calendar"
cp "$SRC/ui-component/extended/FacebookPostPreview.jsx" "$DST/ui-component/extended/FacebookPostPreview.jsx"
```

- [ ] **Step 2: Check Calendar/FacebookPostPreview imports resolve in ops**

```bash
grep -rn "^import" "$DST/ui-component/extended/Calendar" "$DST/ui-component/extended/FacebookPostPreview.jsx"
```
Expected: imports of `react`, `@mui/material`, `dayjs`, MUI icons — all present in ops. If Calendar imports another shared helper (e.g. a date util or `constants/...`) not in ops, copy that too. `dayjs` is already a dep (QueueView/ComposeDialog use it); confirm with `grep '"dayjs"' package.json`.

- [ ] **Step 3: Build + lint**

Run: `cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations" && yarn build && yarn lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/utils/vimeo.js src/ui-component/extended/Calendar src/ui-component/extended/FacebookPostPreview.jsx
git commit -m "feat(content): port Calendar, FacebookPostPreview, vimeo util into ops"
```

---

## Task 9: Port the social API client

**Files:**
- Create: `anchor-operations/src/api/social.js` (verbatim copy)

**Interfaces:**
- Consumes: `./client` (ops's axios instance — already present, with auth + refresh interceptors).
- Produces: `listPages`, `listLinks`, `createLink`, `updateLink`, `archiveLink`, `checkLinkHealth`, `uploadMedia`, `listPosts`, `createPost`, `cancelPost`, `getClientPages`, `setPagePublishing`, `syncClientPages`. Consumed by Task 10.

- [ ] **Step 1: Copy verbatim**

```bash
cp "/Volumes/G-DRIVE SSD/DEVELOPER/Anchor-Client-Dashboard/src/api/social.js" \
   "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/src/api/social.js"
```
It imports only `import client from './client';` — identical in ops. All calls hit `/social/...` paths, which the ops router now serves.

- [ ] **Step 2: Build + lint + commit**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
yarn build && yarn lint
git add src/api/social.js
git commit -m "feat(content): port social API client into ops"
```

---

## Task 10: Port the Content components

**Files:**
- Create: `anchor-operations/src/views/admin/Operations/Content/ContentTab.jsx` (adapted from `SocialSection.jsx`)
- Create (verbatim copies): `CalendarView.jsx`, `QueueView.jsx`, `ComposeDialog.jsx`, `MediaPicker.jsx` in the same `Content/` dir

**Interfaces:**
- Consumes: `api/social` (Task 9), `ui-component/...` shared components (present in ops), `contexts/ToastContext` (present), `hooks/useClientLabel` (present), `utils/vimeo` + `ui-component/extended/Calendar` + `ui-component/extended/FacebookPostPreview` (Task 8), `listOpsClients` from `api/ops`.
- Produces: default `ContentTab` component. Consumed by Task 11.

- [ ] **Step 1: Copy the four leaf components verbatim**

```bash
SRC="/Volumes/G-DRIVE SSD/DEVELOPER/Anchor-Client-Dashboard/src/views/admin/AdminHub/social"
DST="/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations/src/views/admin/Operations/Content"
mkdir -p "$DST"
cp "$SRC/CalendarView.jsx" "$DST/CalendarView.jsx"
cp "$SRC/QueueView.jsx" "$DST/QueueView.jsx"
cp "$SRC/ComposeDialog.jsx" "$DST/ComposeDialog.jsx"
cp "$SRC/MediaPicker.jsx" "$DST/MediaPicker.jsx"
```
Their imports (`ui-component/...`, `api/social`, `contexts/ToastContext`, `hooks/useClientLabel`, `utils/vimeo`, `@mui/x-date-pickers`, `dayjs`, sibling `./MediaPicker`) all resolve in ops. No edits expected.

- [ ] **Step 2: Create `ContentTab.jsx`** — adapt `SocialSection.jsx` to source clients itself (the main app passed `clients` as a prop; ops fetches them)

```jsx
// src/views/admin/Operations/Content/ContentTab.jsx
import { useEffect, useState } from 'react';
import { Stack, Tabs, Tab, Box, Button } from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import { useToast } from 'contexts/ToastContext';
import { listOpsClients } from 'api/ops';
import QueueView from './QueueView';
import CalendarView from './CalendarView';
import ComposeDialog from './ComposeDialog';

export default function ContentTab() {
  const toast = useToast();
  const [tab, setTab] = useState('calendar');
  const [clients, setClients] = useState([]);
  const [composeOpen, setComposeOpen] = useState(false);
  const [presetDate, setPresetDate] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  useEffect(() => {
    listOpsClients()
      .then((rows) => setClients(rows || []))
      .catch((e) => toast.error(e?.response?.data?.error || 'Could not load clients'));
  }, [toast]);

  const openCompose = (date = null) => {
    setPresetDate(date);
    setComposeOpen(true);
  };
  const handleCreated = () => {
    setComposeOpen(false);
    setRefreshKey((k) => k + 1);
  };

  return (
    <Stack spacing={2}>
      <Stack direction="row" justifyContent="space-between" alignItems="center">
        <Tabs value={tab} onChange={(_, v) => setTab(v)}>
          <Tab value="calendar" label="Calendar" />
          <Tab value="queue" label="Queue" />
        </Tabs>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => openCompose(null)}>
          Compose
        </Button>
      </Stack>

      <Box hidden={tab !== 'calendar'}>
        <CalendarView refreshKey={refreshKey} onDayClick={(d) => openCompose(d)} onEventClick={() => {}} />
      </Box>
      <Box hidden={tab !== 'queue'}>
        <QueueView clients={clients} refreshKey={refreshKey} />
      </Box>

      <ComposeDialog
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        clients={clients}
        presetDate={presetDate}
        onCreated={handleCreated}
      />
    </Stack>
  );
}
```
> Cross-check prop names against the copied children: `CalendarView` expects `refreshKey`/`onEventClick`/`onDayClick`; `QueueView` expects `clients`/`refreshKey`; `ComposeDialog` expects `open`/`onClose`/`clients`/`presetDate`/`onCreated`. If `SocialSection.jsx` wired any prop differently, match the children, not this sketch.
> Confirm `listOpsClients` returns objects carrying `client_identifier_value` (or whatever `clientLabel` reads) so the client dropdowns label correctly. If ops's clients endpoint returns a different shape than the main app's `sortedClientOnly`, map it to the shape `ComposeDialog`/`QueueView` expect (they use `clientLabel(...)` + an id field).

- [ ] **Step 3: Build + lint**

Run: `cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations" && yarn build && yarn lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/views/admin/Operations/Content
git commit -m "feat(content): port Calendar/Queue/Compose/Media components into ops Content tab"
```

---

## Task 11: Register the Content tab

**Files:**
- Modify: `anchor-operations/src/views/admin/Operations/index.jsx`

**Interfaces:**
- Consumes: `ContentTab` (Task 10).

- [ ] **Step 1: Add the lazy import** near the other `lazy(() => import(...))` lines

```javascript
const ContentTab = lazy(() => import('./Content/ContentTab'));
```

- [ ] **Step 2: Add the icon import** (top of file, with the other MUI icon imports)

```javascript
import EditCalendarIcon from '@mui/icons-material/EditCalendar';
```

- [ ] **Step 3: Add the tab to `WORKSPACE_TABS`** (append as the 5th entry)

```javascript
const WORKSPACE_TABS = [
  { value: 'command-center', label: 'Command Center', Icon: DashboardIcon },
  { value: 'discoveries', label: 'Discoveries', Icon: ReportProblemIcon },
  { value: 'agent', label: 'Agent', Icon: ChatIcon },
  { value: 'bulk', label: 'Bulk', Icon: PlayCircleOutlineIcon },
  { value: 'content', label: 'Content', Icon: EditCalendarIcon }
];
```

- [ ] **Step 4: Add the `<TabPanel>`** alongside the others

```jsx
<TabPanel activeTab={activeTab} value="content">
  <ContentTab />
</TabPanel>
```

- [ ] **Step 5: Build + lint**

Run: `yarn build && yarn lint`
Expected: PASS.

- [ ] **Step 6: Functional check (local, against shared/dev DB)**

Start the app (`./dev.sh`), open `http://localhost:3000/operations?tab=content`. Confirm:
- The **Content** tab renders with Calendar / Queue sub-tabs + Compose button.
- Calendar/Queue load existing posts (or an empty state) without console errors.
- Compose opens; the client dropdown is populated and labels show business names.
- (If a connected page exists) create a **draft** → it appears in Queue; cancel works.

- [ ] **Step 7: Commit**

```bash
git add src/views/admin/Operations/index.jsx
git commit -m "feat(content): add Content tab to ops command center"
```

---

## Task 12: Env/secrets + end-to-end publish verification

**Files:**
- Modify: `anchor-operations/.env.example`

- [ ] **Step 1: Document new env vars in `.env.example`**

```bash
# --- Content suite (social publishing, ported from main app) ---
FACEBOOK_SYSTEM_USER_TOKEN=     # long-lived Meta system-user token (list pages, derive page tokens, post)
SOCIAL_MEDIA_SECRET=            # HMAC secret for signed media tokens — MUST match prod / main app's value
VIMEO_ACCESS_TOKEN=             # resolve Vimeo direct file URLs for video posts
# ENCRYPTION_KEY is already required (SSO/decrypt) — it MUST be byte-identical to the
# main app or existing page_access_token_encrypted rows will not decrypt.
```

- [ ] **Step 2: Wire the secrets into Cloud Run** (production — document in PR, run at deploy time)

```bash
gcloud run services update anchor-ops \
  --update-secrets=FACEBOOK_SYSTEM_USER_TOKEN=meta-system-user-token:latest,SOCIAL_MEDIA_SECRET=social-media-secret:latest,VIMEO_ACCESS_TOKEN=vimeo-access-token:latest
# Ensure the anchor-ops service account has secretAccessor on each secret.
```
> `ENCRYPTION_KEY` and `FACEBOOK_SYSTEM_USER_TOKEN` are already shared per the three-app plan; confirm `SOCIAL_MEDIA_SECRET` and `VIMEO_ACCESS_TOKEN` exist in Secret Manager (create from the main app's values if not). If `SOCIAL_MEDIA_SECRET` can't match the main app's exactly, accept that in-flight media tokens (1-hour TTL) issued by the old app will 401 after cutover — drain by waiting one hour or re-minting.

- [ ] **Step 3: End-to-end publish smoke test** (against an internal/test FB page, local or staging)

With `FACEBOOK_SYSTEM_USER_TOKEN`, `SOCIAL_MEDIA_SECRET`, `VIMEO_ACCESS_TOKEN`, `ENCRYPTION_KEY` set:
1. Content tab → `GET /social/pages` lists FB pages + IG accounts.
2. Link a test page; verify `meta_page_links` row created with an encrypted token; health-check shows healthy.
3. Upload an image (`POST /social/media`) → row in `file_uploads`; the `/social/media/:token` URL resolves the bytes.
4. Compose a post scheduled ~3 minutes out against the test page → `social_posts` row `scheduled`.
5. Wait for the `*/2` cron → status flips to `published`; `fb_post_id` (and `ig_media_id` if IG) populated; the post appears on the test page.
6. Compose + **publish-now** → publishes immediately.
7. Confirm a `logSecurityEvent` audit row was written for the publish.

Capture the actual output (status transitions, returned IDs). Per `verify-without-tests`, do not claim success without observing the published post.

- [ ] **Step 4: Commit**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/anchor-operations"
git add .env.example
git commit -m "docs(content): document Content-suite env vars + deploy wiring"
```

- [ ] **Step 5: Push the branch + open PR for ops**

```bash
git push -u origin feat/content-publisher-port
gh pr create --title "feat(content): port social publisher into ops (Content tab)" \
  --body "Sub-project A of the content-marketing suite. Faithful port of FB/IG publishing from the main dashboard into a new Content tab. Requires: ops_app GRANT (infra/sql/ops_app_role.sql), Secret Manager wiring (FACEBOOK_SYSTEM_USER_TOKEN, SOCIAL_MEDIA_SECRET, VIMEO_ACCESS_TOKEN), ENCRYPTION_KEY identical to main. Main-app removal is the paired PR — deploy THIS first with the cron live."
```
> **Deploy gate:** deploy the ops PR (with cron live + verified) BEFORE merging the main-app removal (Task 13), so the publish cron is always running in exactly one app.

---

## Task 13: Remove social from the main app (paired cutover PR)

**Do this only after the ops publisher is deployed and verified in production.** Separate repo, separate branch/PR.

**Files (in `Anchor-Client-Dashboard`):**
- Delete: `server/services/socialPublisher.js`, `server/services/metaPagePosting.js`, `server/services/socialClientLinkSync.js`, `server/services/socialMediaTokens.js`, `server/routes/social.js`, `src/views/admin/AdminHub/social/` (whole dir), `src/api/social.js`
- Modify: `server/index.js`, `src/views/admin/AdminHub.jsx`

- [ ] **Step 1: Branch**

```bash
cd "/Volumes/G-DRIVE SSD/DEVELOPER/Anchor-Client-Dashboard"
git checkout main && git pull
git checkout -b chore/remove-social-moved-to-ops
```

- [ ] **Step 2: Delete the moved files**

```bash
git rm server/services/socialPublisher.js server/services/metaPagePosting.js \
       server/services/socialClientLinkSync.js server/services/socialMediaTokens.js \
       server/routes/social.js src/api/social.js
git rm -r src/views/admin/AdminHub/social
```

- [ ] **Step 3: Remove wiring from `server/index.js`**

Delete these lines (confirm exact text first with `grep -n "social\|runDuePosts\|healthCheckPage\|socialClientLinkSync\|/api/social/media/" server/index.js`):
- imports: `import socialRouter from './routes/social.js';`, `import { runDuePosts } from './services/socialPublisher.js';`, `import { healthCheckPage } from './services/metaPagePosting.js';`
- mount: `app.use('/api/social', socialRouter);`
- the `'/api/social/media/'` entry in the `publicCorsEndpoints` array
- the `*/2 * * * *` social-publish cron block (the one calling `runDuePosts()`), the `0 4 * * *` social-health cron block (calling `healthCheckPage`), and the startup `syncClientFacebookLinks` backfill block
- the `migrate_social_publishing.sql` registration (the `maybe...`/path block around line ~1119–1124) — tables are shared and now owned by ops; the main app no longer needs to run this migration

> Leave `server/sql/migrate_social_publishing.sql` on disk (harmless) unless you also remove its registration cleanly. Do NOT drop the tables — ops uses them.

- [ ] **Step 4: Replace the social section in `AdminHub.jsx` with a "moved" notice**

Remove the import (line ~103) `import SocialSection from './AdminHub/social/SocialSection';` and replace the render at line ~2230:
```jsx
<SocialSection active={hubSection === 3} canAccessHub={canAccessHub} clients={sortedClientOnly} />
```
with an inline notice (keep `hubSection === 3` reachable so the nav item still lands somewhere sensible):
```jsx
{hubSection === 3 && (
  <Alert
    severity="info"
    action={
      <Button color="inherit" size="small" href={import.meta.env.VITE_OPS_APP_URL || 'https://anchor-ops.<your-domain>'} target="_blank" rel="noopener">
        Open Operations
      </Button>
    }
  >
    Social publishing has moved to the Operations app → Content tab.
  </Alert>
)}
```
> Ensure `Alert` and `Button` are imported in `AdminHub.jsx` (they almost certainly already are — confirm). Use the real ops URL or an existing env var if one exists.

- [ ] **Step 5: Build + lint**

Run: `cd "/Volumes/G-DRIVE SSD/DEVELOPER/Anchor-Client-Dashboard" && yarn build && yarn lint`
Expected: PASS — no dangling imports of the removed modules. If lint flags an unused `sortedClientOnly` or now-unused import, clean it up.

- [ ] **Step 6: Grep for stragglers**

```bash
grep -rn "SocialSection\|socialPublisher\|metaPagePosting\|api/social\|/api/social" src/ server/ | grep -v node_modules
```
Expected: no references remain (except possibly the untouched `.sql` file). Resolve any that do.

- [ ] **Step 7: Commit + PR**

```bash
git add -A
git commit -m "chore: remove social publishing (moved to Operations app)"
git push -u origin chore/remove-social-moved-to-ops
gh pr create --title "chore: remove social publishing (moved to ops)" \
  --body "Paired cutover PR. Merge/deploy ONLY AFTER the ops Content publisher is live + verified. Removes services, routes, crons, UI; replaces the AdminHub social section with a redirect notice. Tables stay (shared, owned by ops)."
```

---

## Self-Review

**Spec coverage** (against `2026-06-23-content-port-publisher-design.md`):
- §2 source inventory → Tasks 1–11 cover all four services, the route, the five UI files, and `src/api/social.js`. ✓
- §3 shared-DB / no migration / `ops_app` grants → Task 6 (migration register + GRANT). ✓
- §4 target placement (services flat per refinement, Content tab) → Tasks 1–11; refinement noted in Global Constraints. ✓
- §5 secrets → Task 12 (`.env.example` + Cloud Run wiring). ✓
- §6 hard-removal cutover + safety ordering → Task 13 + deploy gate in Task 12 Step 5. ✓
- §7 compliance (encrypted tokens, public-media HMAC, staff gate) → preserved by faithful port; verified in Tasks 7/12; `compliance-auditor` consult noted (run before merging Task 13). ✓
- §8 verification → build+lint every task + functional checks in Tasks 7, 11, 12. ✓
- §9 open items (env var names, auth pattern, grants, cron convention, icon) → resolved: `SOCIAL_MEDIA_SECRET`/`VIMEO_ACCESS_TOKEN`/`FACEBOOK_SYSTEM_USER_TOKEN`; router self-gates; explicit GRANT added; `node-cron` (already a dep) via `cron.schedule`; `EditCalendarIcon`. ✓

**Placeholder scan:** No "TBD"/"handle edge cases"/"similar to" — verbatim-copy steps name exact source→dest paths; new code (metaGraph shim, crons, ContentTab, moved-notice) is shown in full. The few `>` notes are verification guards (confirm a signature/value), not deferred work.

**Type/name consistency:** Service export names in Task 3 Interfaces match their consumers (`runDuePosts`/`healthCheckPage`/`syncClientFacebookLinks` in Task 7; `verifyMediaToken`/`mintMediaToken` in Task 4; `publishPost`/`listAccessiblePages`/`linkClient` used by the Task 5 router). Frontend prop names in ContentTab (Task 10) flagged to cross-check against the copied children. `listOpsClients` confirmed as ops's real client-list API.

**Known residual risks (called out, not hidden):**
- `listOpsClients` row shape may differ from the main app's `sortedClientOnly`; Task 10 Step 2 includes a mapping guard.
- `Calendar` shared component may pull an extra helper; Task 8 Step 2 guards for it.
- `SOCIAL_MEDIA_SECRET` mismatch → 1-hour token-drain window; noted in Task 12 Step 2.
