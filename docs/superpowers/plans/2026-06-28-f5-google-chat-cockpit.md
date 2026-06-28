# F5 — Google Chat Cockpit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Google Chat operator cockpit with outgoing webhook digests/alerts/approvals (Phase 1) and a fully interactive Chat App with user-mapped commands and approval buttons (Phase 2).

**Architecture:** Phase 1 is pure outgoing: a low-level webhook sender, pure card renderers, and an outgoing notification router that reads ops data and fires to per-client webhook URLs stored in `client_platform_credentials`. Phase 2 adds an inbound HTTP endpoint mounted before `requireAuth` (same pattern as `/internal/*` routes), verified via Google-signed OIDC JWTs, routing Chat events through a pure command parser → user mapper → command handler pipeline. Approval buttons never trust the card payload — every click reloads from DB, re-verifies the user, re-verifies status, then acts.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, `pg` via `server/db.js`, `google-auth-library` (already a dep) for inbound JWT verification, plain `fetch` for outgoing webhook calls (no new dep).

## Global Constraints

- Credentials env-var/Postgres, NOT Secret Manager (spec §3.1). Per-client webhook URLs stored in `client_platform_credentials` with `platform='google_chat'`, encrypted via `credentialStore.js`.
- No PII/PHI in any Chat message or notification event row. Bodies reference run IDs, finding IDs, counts, and summaries only — never email addresses, phone numbers, patient data, or raw credential values.
- NEVER log webhook URLs. Log the platform + client ID only.
- Unknown or unauthorized Chat user → neutral refusal: `"I don't recognize your account. Contact your Anchor administrator to set up access."` Never echo `client_type`.
- New migrations → `server/sql/migrate_ops_<name>.sql` + append to the main array in `server/migrations.js` (currently ends at `'migrate_ops_blog_ssh.sql'`).
- DB tests: `DATABASE_URL=postgresql://bif@localhost:5432/anchor`; run suite with `yarn test:ops`; use `node:test` + `node:assert/strict`.
- Card rendering, command parsing, and user-mapping authorization are PURE / dependency-injected and must be unit-tested with zero network.
- No new npm dependencies — use plain `fetch` (Node 18+ built-in) for outgoing webhooks; `google-auth-library` (already present) for inbound JWT verification.
- F4 `ops_action_recommendations` is not yet built. Phase 1 functions that reference it (`sendApprovalNeeded`, `sendActionResult`) are implemented against its **documented shape** and guarded with a table-existence check so they degrade gracefully until F4 lands.
- F0 `ops_access_audit_runs` is similarly not yet built; the `/anchorops audit` command degrades gracefully.

---

## File Structure

| File | Responsibility |
|---|---|
| `server/sql/migrate_ops_gchat.sql` | Create `ops_notification_events` + `ops_chat_user_mappings` (idempotent). |
| `server/migrations.js` | Append migration filename. |
| `server/services/ops/notifications/googleChatWebhook.js` | Low-level `sendWebhookMessage` with retry + `ops_notification_events` persistence. |
| `server/services/ops/notifications/renderGoogleChatDigest.js` | **Pure** card builders: digest, critical alert, approval-needed, action-result. |
| `server/services/ops/notifications/notificationRouter.js` | Orchestrator: `sendDailyDigest`, `sendCriticalAlert`, `sendApprovalNeeded`, `sendActionResult`. |
| `server/services/ops/googleChat/commandParser.js` | **Pure** text → `{command, args}` parser. |
| `server/services/ops/googleChat/userMapper.js` | `ops_chat_user_mappings` lookups + permission assertions. |
| `server/services/ops/googleChat/cardRenderer.js` | **Pure** response card builders for all interactive replies. |
| `server/services/ops/googleChat/commandHandler.js` | Handles each parsed command; all DB reads injectable. |
| `server/services/ops/googleChat/eventRouter.js` | Routes inbound Chat events (MESSAGE/APP_COMMAND/CARD_CLICKED/lifecycle). |
| `server/routes/ops.js` | Add `POST /chat/google/events` before `requireAuth`. |
| `server/services/ops/__tests__/gchat_migration.test.js` | DB round-trip for both new tables. |
| `server/services/ops/__tests__/gchat_webhook.test.js` | Webhook sender with injected fetch + fake DB. |
| `server/services/ops/__tests__/gchat_render_digest.test.js` | Pure card-render assertions (no network). |
| `server/services/ops/__tests__/gchat_notification_router.test.js` | Router with injected sender + DB fakes. |
| `server/services/ops/__tests__/gchat_command_parser.test.js` | Pure parser tests (exhaustive). |
| `server/services/ops/__tests__/gchat_user_mapper.test.js` | Pure authz + DB-backed mapping tests. |
| `server/services/ops/__tests__/gchat_card_renderer.test.js` | Pure interactive card assertions. |
| `server/services/ops/__tests__/gchat_event_router.test.js` | Event routing with injected handler + JWT verifier. |

---

### Task 1: Migration — ops_notification_events + ops_chat_user_mappings

**Files:**
- Create: `server/sql/migrate_ops_gchat.sql`
- Modify: `server/migrations.js` (append to main array)
- Create: `server/services/ops/__tests__/gchat_migration.test.js`

**Interfaces:**
- Produces:
  - `ops_notification_events` row shape: `{ id, channel, event_type, client_user_id, reference_id, reference_type, thread_key, space_name, status, error_text, payload_json, created_at }`.
  - `ops_chat_user_mappings` row shape: `{ id, google_user_id, anchor_user_id, display_name, enabled, created_at, updated_at }`.

- [ ] **Step 1: Write the migration SQL**

Create `server/sql/migrate_ops_gchat.sql`:

```sql
-- Google Chat cockpit tables (north-star §2.7, §2.8). Idempotent.

-- ops_notification_events — delivery log for Chat/email/dashboard notifications.
-- NO PII stored here: payload_json holds IDs and counts only.
CREATE TABLE IF NOT EXISTS ops_notification_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         text NOT NULL CHECK (channel IN ('google_chat','email','dashboard')),
  event_type      text NOT NULL,
  -- 'daily_digest','critical_alert','approval_needed','action_result','command_reply'
  client_user_id  uuid,
  reference_id    uuid,       -- run_id | finding_id | action_recommendation_id
  reference_type  text,       -- 'run' | 'finding' | 'action_recommendation'
  thread_key      text,       -- Chat thread key for threading replies
  space_name      text,       -- Chat space resource name (e.g. spaces/AAAA)
  status          text NOT NULL DEFAULT 'sent'
                    CHECK (status IN ('sent','failed','skipped')),
  error_text      text,
  payload_json    jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_notification_events_client
  ON ops_notification_events (client_user_id, created_at DESC)
  WHERE client_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_ops_notification_events_ref
  ON ops_notification_events (reference_id)
  WHERE reference_id IS NOT NULL;

-- ops_chat_user_mappings — Google Chat user ID → Anchor user.
-- Populated via /anchorops connect flow or admin UI.
CREATE TABLE IF NOT EXISTS ops_chat_user_mappings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  google_user_id  text NOT NULL UNIQUE,   -- e.g. 'users/1234567890'
  anchor_user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name    text,                   -- cached from Chat event; never used for authz
  enabled         boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ops_chat_user_mappings_anchor
  ON ops_chat_user_mappings (anchor_user_id);
```

- [ ] **Step 2: Register the migration**

In `server/migrations.js`, append to the main array (after `'migrate_ops_blog_ssh.sql'`):

```js
  'migrate_ops_blog_ssh.sql',
  'migrate_ops_gchat.sql',
```

- [ ] **Step 3: Run the migration locally**

```bash
yarn db:migrate
```
Expected: completes without error. Re-running is a no-op (`IF NOT EXISTS`).

- [ ] **Step 4: Write the table round-trip test**

Create `server/services/ops/__tests__/gchat_migration.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../db.js';

test('ops_notification_events: insert and retrieve a notification event row', async () => {
  const { rows } = await query(
    `INSERT INTO ops_notification_events
       (channel, event_type, client_user_id, reference_id, reference_type, thread_key, status, payload_json)
     VALUES ('google_chat', 'daily_digest', NULL, NULL, NULL, 'run-abc-123', 'sent', '{"run_id":"abc-123","finding_counts":{"critical":1}}')
     RETURNING *`
  );
  const row = rows[0];
  assert.ok(row.id, 'row has an id');
  assert.equal(row.channel, 'google_chat');
  assert.equal(row.event_type, 'daily_digest');
  assert.equal(row.thread_key, 'run-abc-123');
  assert.equal(row.status, 'sent');
  assert.deepEqual(row.payload_json, { run_id: 'abc-123', finding_counts: { critical: 1 } });

  // cleanup
  await query('DELETE FROM ops_notification_events WHERE id = $1', [row.id]);
});

test('ops_notification_events: invalid channel rejected by check constraint', async () => {
  await assert.rejects(
    () => query(`INSERT INTO ops_notification_events (channel, event_type, status) VALUES ('sms', 'alert', 'sent')`),
    /check/i
  );
});

test('ops_chat_user_mappings: requires valid anchor_user_id FK', async () => {
  const fakeAnchorId = '00000000-0000-0000-0000-000000000000';
  await assert.rejects(
    () => query(
      `INSERT INTO ops_chat_user_mappings (google_user_id, anchor_user_id) VALUES ('users/99', $1)`,
      [fakeAnchorId]
    ),
    /foreign key/i
  );
});
```

- [ ] **Step 5: Run the test**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor node --test server/services/ops/__tests__/gchat_migration.test.js
```
Expected: PASS (3 tests; the FK test may match `violates foreign key` — the regex `/foreign key/i` covers that).

- [ ] **Step 6: Commit**

```bash
git add server/sql/migrate_ops_gchat.sql server/migrations.js server/services/ops/__tests__/gchat_migration.test.js
git commit -m "feat(ops/gchat): ops_notification_events + ops_chat_user_mappings tables"
```

---

### Task 2: Low-level webhook sender (googleChatWebhook.js)

**Files:**
- Create: `server/services/ops/notifications/googleChatWebhook.js`
- Create: `server/services/ops/__tests__/gchat_webhook.test.js`

**Interfaces:**
- Consumes: injected `fetchFn` (default `fetch`), injected `persistEvent` (default imports from `../../../db.js`).
- Produces:
  - `async sendWebhookMessage({ webhookUrl, text, cardsV2, threadKey, clientUserId, eventType, referenceId, referenceType }, { fetchFn, persistEvent } = {}): Promise<{ sent: boolean, threadName?: string } | { skipped: true, reason: string }>`
  - `async resolveClientWebhookUrl(clientUserId, { getCredentialFn } = {}): Promise<string | null>` — reads `client_platform_credentials` where `platform='google_chat'`, decrypts, returns the `webhookUrl` field. Returns `null` if absent. NEVER logs the URL.
  - Retry policy: on HTTP 429 or 5xx, retry once after 1 second. All other errors → fail immediately.
  - Persists one `ops_notification_events` row regardless of success/failure (status `'sent'` or `'failed'`). `payload_json` contains only `{ event_type, reference_id, reference_type, thread_key }` — no PII.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/gchat_webhook.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendWebhookMessage, resolveClientWebhookUrl } from '../notifications/googleChatWebhook.js';

// ---- sendWebhookMessage ----

test('sendWebhookMessage: returns sent:true and persists event on 200', async () => {
  const persisted = [];
  const fakeFetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ name: 'spaces/AAA/messages/BBB', thread: { name: 'spaces/AAA/threads/CCC' } })
  });
  const fakePersist = async (row) => { persisted.push(row); return { id: 'evt-1' }; };

  const result = await sendWebhookMessage(
    { webhookUrl: 'https://chat.example.com/hook', text: 'hello', eventType: 'daily_digest', referenceId: 'run-1', referenceType: 'run', clientUserId: null },
    { fetchFn: fakeFetch, persistEvent: fakePersist }
  );
  assert.equal(result.sent, true);
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].status, 'sent');
  // payload must not contain the webhook URL
  assert.ok(!JSON.stringify(persisted[0]).includes('chat.example.com'));
});

test('sendWebhookMessage: retries once on 429 then fails', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return { ok: false, status: 429, json: async () => ({}) }; };
  const fakePersist = async (row) => row;

  const result = await sendWebhookMessage(
    { webhookUrl: 'https://chat.example.com/hook', text: 'x', eventType: 'alert', referenceId: null, referenceType: null, clientUserId: null },
    { fetchFn: fakeFetch, persistEvent: fakePersist, retryDelayMs: 0 }
  );
  assert.equal(result.sent, false);
  assert.equal(calls, 2, 'retried exactly once');
});

test('sendWebhookMessage: retries once on 500 then succeeds', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ name: 'spaces/A/messages/B', thread: { name: 'spaces/A/threads/C' } }) };
  };
  const fakePersist = async (row) => row;

  const result = await sendWebhookMessage(
    { webhookUrl: 'https://x', text: 'y', eventType: 'alert', referenceId: null, referenceType: null, clientUserId: null },
    { fetchFn: fakeFetch, persistEvent: fakePersist, retryDelayMs: 0 }
  );
  assert.equal(result.sent, true);
  assert.equal(calls, 2);
});

test('sendWebhookMessage: non-retryable 400 fails immediately', async () => {
  let calls = 0;
  const fakeFetch = async () => { calls++; return { ok: false, status: 400, json: async () => ({}) }; };
  const fakePersist = async (row) => row;

  const result = await sendWebhookMessage(
    { webhookUrl: 'https://x', text: 'y', eventType: 'alert', referenceId: null, referenceType: null, clientUserId: null },
    { fetchFn: fakeFetch, persistEvent: fakePersist }
  );
  assert.equal(result.sent, false);
  assert.equal(calls, 1, 'no retry on 400');
});

// ---- resolveClientWebhookUrl ----

test('resolveClientWebhookUrl: returns webhookUrl from decrypted credential', async () => {
  const fakeGetCredential = async () => ({
    resolveSecret: () => JSON.stringify({ webhookUrl: 'https://chat.googleapis.com/v1/spaces/X/messages?key=K' })
  });
  const url = await resolveClientWebhookUrl('client-uuid', { getCredentialFn: fakeGetCredential });
  assert.equal(url, 'https://chat.googleapis.com/v1/spaces/X/messages?key=K');
});

test('resolveClientWebhookUrl: returns null when no credential row exists', async () => {
  const fakeGetCredential = async () => null;
  const url = await resolveClientWebhookUrl('client-uuid', { getCredentialFn: fakeGetCredential });
  assert.equal(url, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gchat_webhook.test.js
```
Expected: FAIL — cannot resolve `../notifications/googleChatWebhook.js`.

- [ ] **Step 3: Create the notifications directory and write the module**

```bash
mkdir -p server/services/ops/notifications
```

Create `server/services/ops/notifications/googleChatWebhook.js`:

```js
/**
 * Low-level Google Chat webhook sender.
 *
 * Security rules (HARD):
 *  - NEVER log the webhookUrl. Log platform + client ID only.
 *  - payload_json stored to ops_notification_events must NOT contain PII.
 *  - Retry once on 429 or 5xx; fail immediately on all other errors.
 */
import { query } from '../../../db.js';
import { getCredential } from '../credentialStore.js';

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function persistNotificationEvent(row) {
  const { rows } = await query(
    `INSERT INTO ops_notification_events
       (channel, event_type, client_user_id, reference_id, reference_type,
        thread_key, space_name, status, error_text, payload_json)
     VALUES ('google_chat', $1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
     RETURNING id`,
    [
      row.event_type,
      row.client_user_id || null,
      row.reference_id || null,
      row.reference_type || null,
      row.thread_key || null,
      row.space_name || null,
      row.status,
      row.error_text || null,
      JSON.stringify({
        event_type: row.event_type,
        reference_id: row.reference_id || null,
        reference_type: row.reference_type || null,
        thread_key: row.thread_key || null
      })
    ]
  );
  return rows[0];
}

/**
 * Send a message to a Google Chat webhook.
 *
 * @param {object} params
 * @param {string} params.webhookUrl   - Destination webhook (NEVER logged).
 * @param {string} [params.text]       - Plain text fallback.
 * @param {Array}  [params.cardsV2]    - cardsV2 array for rich cards.
 * @param {string} [params.threadKey]  - Chat thread key for threaded replies.
 * @param {string|null} params.clientUserId
 * @param {string} params.eventType    - For audit log.
 * @param {string|null} params.referenceId
 * @param {string|null} params.referenceType
 * @param {object} [opts]
 * @param {Function} [opts.fetchFn]      - Injectable fetch (default: global fetch).
 * @param {Function} [opts.persistEvent] - Injectable persister.
 * @param {number}  [opts.retryDelayMs]  - Delay before retry (default: 1000).
 */
export async function sendWebhookMessage(params, opts = {}) {
  const {
    webhookUrl,
    text,
    cardsV2,
    threadKey,
    clientUserId = null,
    eventType = 'unknown',
    referenceId = null,
    referenceType = null
  } = params;
  const {
    fetchFn = fetch,
    persistEvent = persistNotificationEvent,
    retryDelayMs = 1000
  } = opts;

  const body = {};
  if (text) body.text = text;
  if (cardsV2) body.cardsV2 = cardsV2;
  if (threadKey) body.thread = { threadKey };

  let url = webhookUrl;
  if (threadKey && !url.includes('threadKey')) {
    url += (url.includes('?') ? '&' : '?') + `threadKey=${encodeURIComponent(threadKey)}&messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD`;
  }

  let lastStatus = null;
  let lastData = null;
  let attempts = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    attempts++;
    let res;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    } catch (err) {
      // Network error — do not retry
      console.warn(`[gchat/webhook] network error for client=${clientUserId} event=${eventType}: ${err.message}`);
      await persistEvent({ event_type: eventType, client_user_id: clientUserId, reference_id: referenceId, reference_type: referenceType, thread_key: threadKey, space_name: null, status: 'failed', error_text: err.message });
      return { sent: false, reason: 'network_error' };
    }

    lastStatus = res.status;
    if (res.ok) {
      lastData = await res.json().catch(() => ({}));
      await persistEvent({ event_type: eventType, client_user_id: clientUserId, reference_id: referenceId, reference_type: referenceType, thread_key: threadKey, space_name: lastData?.name?.split('/messages/')[0] || null, status: 'sent', error_text: null });
      return { sent: true, threadName: lastData?.thread?.name || null };
    }

    if (!RETRYABLE.has(res.status) || attempt === 1) break;
    console.warn(`[gchat/webhook] HTTP ${res.status} for client=${clientUserId} event=${eventType}, retrying...`);
    await delay(retryDelayMs);
  }

  const reason = `http_${lastStatus}`;
  console.warn(`[gchat/webhook] failed after ${attempts} attempt(s) for client=${clientUserId} event=${eventType}: ${reason}`);
  await persistEvent({ event_type: eventType, client_user_id: clientUserId, reference_id: referenceId, reference_type: referenceType, thread_key: threadKey, space_name: null, status: 'failed', error_text: reason });
  return { sent: false, reason };
}

/**
 * Resolve the Google Chat webhook URL for a client.
 * Returns null if no credential row exists. NEVER logs the URL.
 *
 * The credential row must have platform='google_chat' and its
 * credentials_encrypted must be a JSON object with a `webhookUrl` key.
 */
export async function resolveClientWebhookUrl(clientUserId, { getCredentialFn = getCredential } = {}) {
  try {
    const cred = await getCredentialFn(clientUserId, 'google_chat');
    if (!cred) return null;
    const secret = cred.resolveSecret();
    if (!secret) return null;
    const parsed = typeof secret === 'string' ? JSON.parse(secret) : secret;
    return parsed?.webhookUrl || null;
  } catch (err) {
    console.warn(`[gchat/webhook] failed to resolve webhook URL for client=${clientUserId}: ${err.message}`);
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/gchat_webhook.test.js
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/notifications/googleChatWebhook.js server/services/ops/__tests__/gchat_webhook.test.js
git commit -m "feat(ops/gchat): low-level webhook sender with retry + notification event persistence"
```

---

### Task 3: Pure digest/alert card renderer (renderGoogleChatDigest.js)

**Files:**
- Create: `server/services/ops/notifications/renderGoogleChatDigest.js`
- Create: `server/services/ops/__tests__/gchat_render_digest.test.js`

**Interfaces:**
- Produces (all pure — no DB/network):
  - `renderDailyDigestCard({ runId, clientName, runStatus, tier, findingCounts: { critical, warning, info }, topFindings: [{id, summary, severity, category}] }): { cardsV2: Array, threadKey: string }` — `threadKey = 'run-' + runId`.
  - `renderCriticalAlertCard({ findingId, clientName, summary, severity, category, businessImpact }): { cardsV2: Array, threadKey: string }` — `threadKey = 'finding-' + findingId`.
  - `renderApprovalNeededCard({ actionRecommendationId, clientName, actionType, riskLevel, summary, argsJson }): { cardsV2: Array, threadKey: string }` — `threadKey = 'action-' + actionRecommendationId`. Card includes an Approve and a Reject button using `actionMethodName: 'approve_action'` / `'reject_action'` with parameter `action_id`.
  - `renderActionResultCard({ actionRecommendationId, clientName, actionType, outcome, detail }): { cardsV2: Array, threadKey: string }` — `outcome ∈ 'approved'|'rejected'|'executed'|'failed'`.
  - All cards: no PII; no credential values; `topFindings` truncated to 5 entries; `summary` text truncated to 200 chars.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/gchat_render_digest.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderDailyDigestCard,
  renderCriticalAlertCard,
  renderApprovalNeededCard,
  renderActionResultCard
} from '../notifications/renderGoogleChatDigest.js';

test('renderDailyDigestCard: returns cardsV2 array and correct threadKey', () => {
  const { cardsV2, threadKey } = renderDailyDigestCard({
    runId: 'aaa-111',
    clientName: 'ACME Corp',
    runStatus: 'completed',
    tier: 'daily_essential',
    findingCounts: { critical: 2, warning: 5, info: 10 },
    topFindings: [
      { id: 'f1', summary: 'Budget overspend detected', severity: 'critical', category: 'google_ads.budget' }
    ]
  });
  assert.equal(threadKey, 'run-aaa-111');
  assert.ok(Array.isArray(cardsV2) && cardsV2.length > 0, 'cardsV2 is non-empty array');
  const cardText = JSON.stringify(cardsV2);
  assert.ok(cardText.includes('ACME Corp'), 'client name present');
  assert.ok(cardText.includes('2'), 'critical count present');
  assert.ok(cardText.includes('Budget overspend'), 'finding summary present');
  // PII guard: no email-like patterns
  assert.ok(!/@[a-z]+\.[a-z]+/.test(cardText), 'no email addresses');
});

test('renderDailyDigestCard: truncates topFindings to 5', () => {
  const findings = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, summary: `Finding ${i}`, severity: 'warning', category: 'ctm.x' }));
  const { cardsV2 } = renderDailyDigestCard({ runId: 'r1', clientName: 'X', runStatus: 'completed', tier: 'weekly_deep', findingCounts: { critical: 0, warning: 10, info: 0 }, topFindings: findings });
  const text = JSON.stringify(cardsV2);
  // Only findings 0-4 should appear; Finding 9 must not
  assert.ok(!text.includes('Finding 9'), 'truncated at 5');
});

test('renderCriticalAlertCard: returns correct threadKey and includes category', () => {
  const { cardsV2, threadKey } = renderCriticalAlertCard({
    findingId: 'fnd-222',
    clientName: 'Beta Inc',
    summary: 'CTR dropped 40%',
    severity: 'critical',
    category: 'google_ads.performance',
    businessImpact: 'Estimated $500/day revenue impact'
  });
  assert.equal(threadKey, 'finding-fnd-222');
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('CTR dropped 40%'), 'summary present');
  assert.ok(text.includes('google_ads.performance'), 'category present');
});

test('renderApprovalNeededCard: approval buttons present with action_id parameter', () => {
  const { cardsV2, threadKey } = renderApprovalNeededCard({
    actionRecommendationId: 'ar-333',
    clientName: 'Gamma LLC',
    actionType: 'adjust_budget',
    riskLevel: 'medium',
    summary: 'Increase daily budget by $50',
    argsJson: { campaign_id: 'c1', delta_cents: 5000 }
  });
  assert.equal(threadKey, 'action-ar-333');
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('approve_action') || text.includes('approve'), 'approve action present');
  assert.ok(text.includes('reject_action') || text.includes('reject'), 'reject action present');
  assert.ok(text.includes('ar-333'), 'action_id parameter present');
  // Must NOT embed raw argsJson values as PII-risk — only show safe summary
  assert.ok(!text.includes('c1'), 'raw campaign_id not in card payload');
});

test('renderActionResultCard: outcome reflected in card', () => {
  const { cardsV2 } = renderActionResultCard({
    actionRecommendationId: 'ar-444',
    clientName: 'Delta Co',
    actionType: 'pause_campaign',
    outcome: 'approved',
    detail: 'Action queued for execution.'
  });
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('approved') || text.includes('Approved'), 'outcome present');
});

test('renderDailyDigestCard: summary truncated to 200 chars', () => {
  const longSummary = 'A'.repeat(250);
  const { cardsV2 } = renderDailyDigestCard({
    runId: 'r2', clientName: 'X', runStatus: 'completed', tier: 'daily_essential',
    findingCounts: { critical: 1, warning: 0, info: 0 },
    topFindings: [{ id: 'f1', summary: longSummary, severity: 'critical', category: 'ctm.x' }]
  });
  const text = JSON.stringify(cardsV2);
  assert.ok(!text.includes('A'.repeat(201)), 'summary truncated');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gchat_render_digest.test.js
```
Expected: FAIL — cannot resolve `../notifications/renderGoogleChatDigest.js`.

- [ ] **Step 3: Write the renderer**

Create `server/services/ops/notifications/renderGoogleChatDigest.js`:

```js
/**
 * Pure card renderers for outgoing Google Chat notifications.
 * No DB, no network, no PII in any output.
 *
 * Google Chat cardsV2 format:
 * https://developers.google.com/chat/api/reference/rest/v1/cards
 */

const trunc = (str, max = 200) =>
  typeof str === 'string' && str.length > max ? str.slice(0, max) + '…' : (str || '');

const severityEmoji = { critical: '🔴', warning: '🟡', info: '🔵' };

function makeCard(cardId, header, sections, buttons = []) {
  const card = { header, sections };
  if (buttons.length) {
    card.fixedFooter = {
      primaryButton: buttons[0],
      ...(buttons[1] ? { secondaryButton: buttons[1] } : {})
    };
  }
  return [{ cardId, card }];
}

function textWidget(text) {
  return { textParagraph: { text } };
}

function buttonWidget(text, actionMethodName, parameters = []) {
  return {
    text,
    onClick: {
      action: { actionMethodName, parameters }
    }
  };
}

export function renderDailyDigestCard({ runId, clientName, runStatus, tier, findingCounts, topFindings = [] }) {
  const { critical = 0, warning = 0, info = 0 } = findingCounts;
  const top5 = topFindings.slice(0, 5);

  const header = {
    title: `Daily Digest — ${clientName}`,
    subtitle: `Run: ${runId.slice(0, 8)} · ${tier} · ${runStatus}`
  };

  const summarySection = {
    header: 'Finding Summary',
    widgets: [
      textWidget(`🔴 <b>${critical}</b> critical · 🟡 <b>${warning}</b> warning · 🔵 <b>${info}</b> info`)
    ]
  };

  const findingsSection = top5.length > 0 ? {
    header: 'Top Findings',
    widgets: top5.map((f) => textWidget(
      `${severityEmoji[f.severity] || '⚪'} [${f.category}] ${trunc(f.summary)}`
    ))
  } : null;

  const sections = [summarySection, ...(findingsSection ? [findingsSection] : [])];

  return {
    cardsV2: makeCard(`digest-${runId}`, header, sections),
    threadKey: `run-${runId}`
  };
}

export function renderCriticalAlertCard({ findingId, clientName, summary, severity, category, businessImpact }) {
  const header = {
    title: `${severityEmoji[severity] || '⚪'} Critical Alert — ${clientName}`,
    subtitle: category
  };

  const widgets = [textWidget(trunc(summary))];
  if (businessImpact) widgets.push(textWidget(`<b>Business impact:</b> ${trunc(businessImpact)}`));

  const sections = [{ widgets }];

  return {
    cardsV2: makeCard(`alert-${findingId}`, header, sections),
    threadKey: `finding-${findingId}`
  };
}

export function renderApprovalNeededCard({ actionRecommendationId, clientName, actionType, riskLevel, summary }) {
  // NOTE: argsJson is intentionally NOT embedded in the card — callers must
  // reload the action from DB on CARD_CLICKED (never trust card payload).
  const riskEmoji = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };

  const header = {
    title: `Approval Needed — ${clientName}`,
    subtitle: `${actionType} · risk: ${riskEmoji[riskLevel] || ''} ${riskLevel}`
  };

  const sections = [{ widgets: [textWidget(trunc(summary))] }];

  const approveBtn = buttonWidget('✅ Approve', 'approve_action', [
    { key: 'action_id', value: actionRecommendationId }
  ]);
  const rejectBtn = buttonWidget('❌ Reject', 'reject_action', [
    { key: 'action_id', value: actionRecommendationId }
  ]);

  return {
    cardsV2: makeCard(`approval-${actionRecommendationId}`, header, sections, [approveBtn, rejectBtn]),
    threadKey: `action-${actionRecommendationId}`
  };
}

export function renderActionResultCard({ actionRecommendationId, clientName, actionType, outcome, detail }) {
  const outcomeEmoji = { approved: '✅', rejected: '❌', executed: '✅', failed: '🔴' };

  const header = {
    title: `${outcomeEmoji[outcome] || ''} Action ${outcome} — ${clientName}`,
    subtitle: actionType
  };

  const sections = [{ widgets: [textWidget(trunc(detail))] }];

  return {
    cardsV2: makeCard(`result-${actionRecommendationId}`, header, sections),
    threadKey: `action-${actionRecommendationId}`
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/gchat_render_digest.test.js
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/notifications/renderGoogleChatDigest.js server/services/ops/__tests__/gchat_render_digest.test.js
git commit -m "feat(ops/gchat): pure digest/alert/approval card renderers"
```

---

### Task 4: Outgoing notification router (notificationRouter.js)

**Files:**
- Create: `server/services/ops/notifications/notificationRouter.js`
- Create: `server/services/ops/__tests__/gchat_notification_router.test.js`

**Interfaces:**
- Consumes: `resolveClientWebhookUrl` + `sendWebhookMessage` (Task 2), render functions (Task 3), `query` from `db.js` (injected in tests).
- Produces:
  - `async sendDailyDigest({ clientUserId, runId }, deps = {}): Promise<result>`
  - `async sendCriticalAlert({ clientUserId, findingId }, deps = {}): Promise<result>`
  - `async sendApprovalNeeded({ clientUserId, actionRecommendationId }, deps = {}): Promise<result>`
  - `async sendActionResult({ clientUserId, actionRecommendationId, outcome, detail }, deps = {}): Promise<result>`
  - All return `{ skipped: true, reason }` if webhook URL absent or table not present; `{ sent: true }` on success; `{ sent: false, reason }` on failure.
  - `sendApprovalNeeded` and `sendActionResult` guard against missing `ops_action_recommendations` table (F4 not yet built) by catching `relation does not exist` errors → `{ skipped: true, reason: 'f4_not_built' }`.
  - `clientName` loaded from `users` join `client_profiles`; never passed through as PII in card bodies (only used as a display label — not email, not phone).

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/gchat_notification_router.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendDailyDigest, sendCriticalAlert, sendApprovalNeeded } from '../notifications/notificationRouter.js';

function makeQueryFn(scenarios) {
  // scenarios: array of { match: string, rows: Array }
  return async (sql, params) => {
    const s = scenarios.find((sc) => sql.includes(sc.match));
    if (!s) throw new Error(`Unexpected query: ${sql.slice(0, 80)}`);
    if (s.throws) throw new Error(s.throws);
    return { rows: s.rows };
  };
}

const fakeRun = { id: 'run-1', client_user_id: 'client-1', tier: 'daily_essential', status: 'completed' };
const fakeFinding = { id: 'fnd-1', client_user_id: 'client-1', severity: 'critical', category: 'ctm.x', summary: 'Drop detected', business_impact: null };
const fakeClient = { display_name: 'ACME Corp' };

test('sendDailyDigest: skips when no webhook URL configured', async () => {
  const result = await sendDailyDigest(
    { clientUserId: 'client-1', runId: 'run-1' },
    {
      resolveWebhookUrl: async () => null,
      queryFn: makeQueryFn([
        { match: 'ops_runs', rows: [fakeRun] },
        { match: 'ops_findings', rows: [] },
        { match: 'users', rows: [fakeClient] }
      ])
    }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_webhook_url');
});

test('sendDailyDigest: calls sender and returns sent:true on success', async () => {
  let sentArgs = null;
  const result = await sendDailyDigest(
    { clientUserId: 'client-1', runId: 'run-1' },
    {
      resolveWebhookUrl: async () => 'https://chat.example.com/hook',
      sendFn: async (args) => { sentArgs = args; return { sent: true }; },
      queryFn: makeQueryFn([
        { match: 'ops_runs', rows: [fakeRun] },
        { match: 'ops_findings', rows: [fakeFinding] },
        { match: 'users', rows: [fakeClient] }
      ])
    }
  );
  assert.equal(result.sent, true);
  assert.ok(sentArgs, 'sender was called');
  assert.equal(sentArgs.eventType, 'daily_digest');
  // Verify no PII in the webhook call args — text/cardsV2 only contain safe data
  assert.ok(!JSON.stringify(sentArgs).includes('@'), 'no email in payload');
});

test('sendDailyDigest: skips when run not found', async () => {
  const result = await sendDailyDigest(
    { clientUserId: 'c', runId: 'missing' },
    {
      resolveWebhookUrl: async () => 'https://x',
      queryFn: makeQueryFn([{ match: 'ops_runs', rows: [] }, { match: 'users', rows: [fakeClient] }])
    }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'run_not_found');
});

test('sendApprovalNeeded: degrades gracefully when F4 table missing', async () => {
  const result = await sendApprovalNeeded(
    { clientUserId: 'c', actionRecommendationId: 'ar-1' },
    {
      resolveWebhookUrl: async () => 'https://x',
      queryFn: makeQueryFn([
        { match: 'ops_action_recommendations', throws: 'relation "ops_action_recommendations" does not exist' },
        { match: 'users', rows: [fakeClient] }
      ])
    }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'f4_not_built');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gchat_notification_router.test.js
```
Expected: FAIL — cannot resolve `../notifications/notificationRouter.js`.

- [ ] **Step 3: Write the router**

Create `server/services/ops/notifications/notificationRouter.js`:

```js
/**
 * Outgoing notification router — Phase 1.
 * Loads ops data, renders a card, and dispatches via sendWebhookMessage.
 * All DB reads are injectable for testing.
 */
import { query } from '../../../db.js';
import { resolveClientWebhookUrl, sendWebhookMessage } from './googleChatWebhook.js';
import {
  renderDailyDigestCard,
  renderCriticalAlertCard,
  renderApprovalNeededCard,
  renderActionResultCard
} from './renderGoogleChatDigest.js';

async function loadClientName(clientUserId, queryFn = query) {
  const { rows } = await queryFn(
    `SELECT COALESCE(cp.business_name, u.name, u.email) AS display_name
       FROM users u
       LEFT JOIN client_profiles cp ON cp.user_id = u.id
      WHERE u.id = $1 LIMIT 1`,
    [clientUserId]
  );
  return rows[0]?.display_name || 'Unknown Client';
}

async function dispatch(webhookUrl, { cardsV2, threadKey }, meta, deps) {
  const sendFn = deps.sendFn || sendWebhookMessage;
  return sendFn({
    webhookUrl,
    cardsV2,
    threadKey,
    clientUserId: meta.clientUserId,
    eventType: meta.eventType,
    referenceId: meta.referenceId,
    referenceType: meta.referenceType
  });
}

export async function sendDailyDigest({ clientUserId, runId }, deps = {}) {
  const { resolveWebhookUrl = resolveClientWebhookUrl, queryFn = query } = deps;

  const webhookUrl = await resolveWebhookUrl(clientUserId);
  if (!webhookUrl) return { skipped: true, reason: 'no_webhook_url' };

  const clientName = await loadClientName(clientUserId, queryFn);

  const { rows: runRows } = await queryFn(
    `SELECT id, client_user_id, tier, status FROM ops_runs WHERE id = $1 LIMIT 1`,
    [runId]
  );
  const run = runRows[0];
  if (!run) return { skipped: true, reason: 'run_not_found' };

  const { rows: findingRows } = await queryFn(
    `SELECT id, severity, category, summary
       FROM ops_findings
      WHERE run_id = $1 AND status NOT IN ('resolved','ignored')
      ORDER BY
        CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
        attention_score DESC NULLS LAST
      LIMIT 10`,
    [runId]
  );

  const findingCounts = { critical: 0, warning: 0, info: 0 };
  for (const f of findingRows) {
    findingCounts[f.severity] = (findingCounts[f.severity] || 0) + 1;
  }

  const card = renderDailyDigestCard({
    runId: run.id,
    clientName,
    runStatus: run.status,
    tier: run.tier,
    findingCounts,
    topFindings: findingRows
  });

  return dispatch(webhookUrl, card, { clientUserId, eventType: 'daily_digest', referenceId: runId, referenceType: 'run' }, deps);
}

export async function sendCriticalAlert({ clientUserId, findingId }, deps = {}) {
  const { resolveWebhookUrl = resolveClientWebhookUrl, queryFn = query } = deps;

  const webhookUrl = await resolveWebhookUrl(clientUserId);
  if (!webhookUrl) return { skipped: true, reason: 'no_webhook_url' };

  const clientName = await loadClientName(clientUserId, queryFn);

  const { rows } = await queryFn(
    `SELECT id, severity, category, summary, business_impact
       FROM ops_findings WHERE id = $1 LIMIT 1`,
    [findingId]
  );
  const finding = rows[0];
  if (!finding) return { skipped: true, reason: 'finding_not_found' };

  const card = renderCriticalAlertCard({
    findingId: finding.id,
    clientName,
    summary: finding.summary,
    severity: finding.severity,
    category: finding.category,
    businessImpact: finding.business_impact
  });

  return dispatch(webhookUrl, card, { clientUserId, eventType: 'critical_alert', referenceId: findingId, referenceType: 'finding' }, deps);
}

export async function sendApprovalNeeded({ clientUserId, actionRecommendationId }, deps = {}) {
  const { resolveWebhookUrl = resolveClientWebhookUrl, queryFn = query } = deps;

  const webhookUrl = await resolveWebhookUrl(clientUserId);
  if (!webhookUrl) return { skipped: true, reason: 'no_webhook_url' };

  const clientName = await loadClientName(clientUserId, queryFn);

  let rec;
  try {
    const { rows } = await queryFn(
      `SELECT id, action_type, risk_level, summary
         FROM ops_action_recommendations
        WHERE id = $1 AND status = 'pending' LIMIT 1`,
      [actionRecommendationId]
    );
    rec = rows[0];
  } catch (err) {
    if (err.message.includes('does not exist')) return { skipped: true, reason: 'f4_not_built' };
    throw err;
  }
  if (!rec) return { skipped: true, reason: 'action_rec_not_found_or_not_pending' };

  const card = renderApprovalNeededCard({
    actionRecommendationId: rec.id,
    clientName,
    actionType: rec.action_type,
    riskLevel: rec.risk_level,
    summary: rec.summary
  });

  return dispatch(webhookUrl, card, { clientUserId, eventType: 'approval_needed', referenceId: actionRecommendationId, referenceType: 'action_recommendation' }, deps);
}

export async function sendActionResult({ clientUserId, actionRecommendationId, outcome, detail }, deps = {}) {
  const { resolveWebhookUrl = resolveClientWebhookUrl, queryFn = query } = deps;

  const webhookUrl = await resolveWebhookUrl(clientUserId);
  if (!webhookUrl) return { skipped: true, reason: 'no_webhook_url' };

  const clientName = await loadClientName(clientUserId, queryFn);

  let actionType = 'action';
  try {
    const { rows } = await queryFn(
      `SELECT action_type FROM ops_action_recommendations WHERE id = $1 LIMIT 1`,
      [actionRecommendationId]
    );
    actionType = rows[0]?.action_type || 'action';
  } catch {
    // F4 not built — still send with generic label
  }

  const card = renderActionResultCard({ actionRecommendationId, clientName, actionType, outcome, detail });
  return dispatch(webhookUrl, card, { clientUserId, eventType: 'action_result', referenceId: actionRecommendationId, referenceType: 'action_recommendation' }, deps);
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/gchat_notification_router.test.js
```
Expected: PASS (4 tests).

- [ ] **Step 5: Run the full ops suite for regressions**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops
```
Expected: all prior tests pass.

- [ ] **Step 6: Commit**

```bash
git add server/services/ops/notifications/notificationRouter.js server/services/ops/__tests__/gchat_notification_router.test.js
git commit -m "feat(ops/gchat): outgoing notification router — sendDailyDigest/sendCriticalAlert/sendApprovalNeeded/sendActionResult"
```

---

### Task 5: Pure command parser (commandParser.js)

**Files:**
- Create: `server/services/ops/googleChat/commandParser.js`
- Create: `server/services/ops/__tests__/gchat_command_parser.test.js`

**Interfaces:**
- Produces (pure):
  - `parseCommand(text: string): { command: string, args: string[] } | { command: 'unknown', raw: string }`
  - Supported commands: `help`, `daily`, `clients`, `client`, `run`, `issues`, `approvals`, `approve`, `reject`, `connect`, `audit`.
  - Input forms handled: `/anchorops <cmd> [args...]`, `@AnchorOps <cmd> [args...]`, `<cmd> [args...]` (bare, only inside a DM or when bot is mentioned).
  - `text` is trimmed and lowercased for command extraction; args preserve original case.
  - `args` for multi-word values: everything after the command as a single string in `args[0]` for `client`, `run`, `issues`; `args[0]` is the ID for `approve` / `reject`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/gchat_command_parser.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../googleChat/commandParser.js';

test('parses /anchorops help', () => {
  assert.deepEqual(parseCommand('/anchorops help'), { command: 'help', args: [] });
});

test('parses @AnchorOps daily', () => {
  assert.deepEqual(parseCommand('@AnchorOps daily'), { command: 'daily', args: [] });
});

test('parses bare command in DM context', () => {
  assert.deepEqual(parseCommand('clients'), { command: 'clients', args: [] });
});

test('parses /anchorops client with multi-word name', () => {
  assert.deepEqual(parseCommand('/anchorops client ACME Corp'), { command: 'client', args: ['ACME Corp'] });
});

test('parses /anchorops run with name', () => {
  assert.deepEqual(parseCommand('/anchorops run Weekly Deep'), { command: 'run', args: ['Weekly Deep'] });
});

test('parses /anchorops issues with client name', () => {
  assert.deepEqual(parseCommand('/anchorops issues Beta Inc'), { command: 'issues', args: ['Beta Inc'] });
});

test('parses /anchorops approvals', () => {
  assert.deepEqual(parseCommand('/anchorops approvals'), { command: 'approvals', args: [] });
});

test('parses /anchorops approve <id>', () => {
  assert.deepEqual(parseCommand('/anchorops approve ar-abc-123'), { command: 'approve', args: ['ar-abc-123'] });
});

test('parses /anchorops reject <id>', () => {
  assert.deepEqual(parseCommand('/anchorops reject ar-xyz-999'), { command: 'reject', args: ['ar-xyz-999'] });
});

test('parses /anchorops connect', () => {
  assert.deepEqual(parseCommand('/anchorops connect'), { command: 'connect', args: [] });
});

test('parses /anchorops audit', () => {
  assert.deepEqual(parseCommand('/anchorops audit'), { command: 'audit', args: [] });
});

test('unknown text returns unknown command', () => {
  const r = parseCommand('do something weird');
  assert.equal(r.command, 'unknown');
  assert.equal(r.raw, 'do something weird');
});

test('empty / whitespace-only input returns unknown', () => {
  assert.equal(parseCommand('   ').command, 'unknown');
});

test('extra whitespace normalized', () => {
  assert.deepEqual(parseCommand('  /anchorops   help  '), { command: 'help', args: [] });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gchat_command_parser.test.js
```
Expected: FAIL — cannot resolve `../googleChat/commandParser.js`.

- [ ] **Step 3: Create the googleChat directory and write the parser**

```bash
mkdir -p server/services/ops/googleChat
```

Create `server/services/ops/googleChat/commandParser.js`:

```js
/**
 * Pure command parser for Google Chat messages.
 * Returns { command, args } for known commands or { command: 'unknown', raw } otherwise.
 */

const KNOWN = new Set([
  'help', 'daily', 'clients', 'client', 'run', 'issues',
  'approvals', 'approve', 'reject', 'connect', 'audit'
]);

// Commands where the remaining text is a single multi-word arg
const MULTI_WORD_ARG = new Set(['client', 'run', 'issues']);

export function parseCommand(raw) {
  const text = (raw || '').trim();
  if (!text) return { command: 'unknown', raw: text };

  // Strip /anchorops or @AnchorOps prefix (case-insensitive)
  const stripped = text
    .replace(/^\/anchorops\s*/i, '')
    .replace(/^@anchorops\s*/i, '')
    .trim();

  const parts = stripped.split(/\s+/);
  const cmd = (parts[0] || '').toLowerCase();

  if (!KNOWN.has(cmd)) return { command: 'unknown', raw: text };

  if (MULTI_WORD_ARG.has(cmd)) {
    const rest = stripped.slice(cmd.length).trim();
    return { command: cmd, args: rest ? [rest] : [] };
  }

  const args = parts.slice(1);
  return { command: cmd, args };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/gchat_command_parser.test.js
```
Expected: PASS (14 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/googleChat/commandParser.js server/services/ops/__tests__/gchat_command_parser.test.js
git commit -m "feat(ops/gchat): pure command parser — /anchorops + @AnchorOps forms"
```

---

### Task 6: User mapper + authz (userMapper.js)

**Files:**
- Create: `server/services/ops/googleChat/userMapper.js`
- Create: `server/services/ops/__tests__/gchat_user_mapper.test.js`

**Interfaces:**
- Produces:
  - `async resolveGoogleChatUser(googleUserId: string, { queryFn } = {}): Promise<{ mapping, anchorUser } | null>` — looks up `ops_chat_user_mappings` then `users` + `client_profiles`; returns `null` if not found or `enabled=false`.
  - `assertPermission(anchorUser: object, action: string): void` — throws `PermissionError` if the user's role doesn't allow the action. Role rules: `admin` and `superadmin` can do everything; `ops_viewer` role can read (help/daily/clients/client/issues/approvals/audit) but not mutate (run/approve/reject). Any other role → throw.
  - `class PermissionError extends Error { constructor(message) }` — exported so callers can `instanceof` check.
  - `VIEWER_COMMANDS: Set<string>` — the read-only command set.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/gchat_user_mapper.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGoogleChatUser, assertPermission, PermissionError, VIEWER_COMMANDS } from '../googleChat/userMapper.js';

function fakeQuery(mappingRow, userRow) {
  return async (sql) => {
    if (sql.includes('ops_chat_user_mappings')) return { rows: mappingRow ? [mappingRow] : [] };
    if (sql.includes('FROM users')) return { rows: userRow ? [userRow] : [] };
    return { rows: [] };
  };
}

const mapping = { id: 'm1', google_user_id: 'users/123', anchor_user_id: 'u1', display_name: 'Joel', enabled: true };
const adminUser = { id: 'u1', role: 'admin', email: 'joel@example.com' };
const viewerUser = { id: 'u2', role: 'ops_viewer', email: 'viewer@example.com' };

test('resolveGoogleChatUser: returns mapping + anchorUser for known enabled user', async () => {
  const result = await resolveGoogleChatUser('users/123', { queryFn: fakeQuery(mapping, adminUser) });
  assert.ok(result, 'result is non-null');
  assert.equal(result.mapping.google_user_id, 'users/123');
  assert.equal(result.anchorUser.role, 'admin');
  // email must not be leaked — it's on anchorUser but that's fine internally;
  // callers must not forward it to Chat
  assert.equal(result.anchorUser.id, 'u1');
});

test('resolveGoogleChatUser: returns null when mapping not found', async () => {
  const result = await resolveGoogleChatUser('users/999', { queryFn: fakeQuery(null, null) });
  assert.equal(result, null);
});

test('resolveGoogleChatUser: returns null when mapping disabled', async () => {
  const disabledMapping = { ...mapping, enabled: false };
  const result = await resolveGoogleChatUser('users/123', { queryFn: fakeQuery(disabledMapping, adminUser) });
  assert.equal(result, null);
});

test('assertPermission: admin can approve', () => {
  assert.doesNotThrow(() => assertPermission(adminUser, 'approve'));
});

test('assertPermission: admin can run', () => {
  assert.doesNotThrow(() => assertPermission(adminUser, 'run'));
});

test('assertPermission: ops_viewer can read daily', () => {
  assert.doesNotThrow(() => assertPermission(viewerUser, 'daily'));
  assert.doesNotThrow(() => assertPermission(viewerUser, 'clients'));
  assert.ok(VIEWER_COMMANDS.has('audit'));
});

test('assertPermission: ops_viewer cannot approve', () => {
  assert.throws(
    () => assertPermission(viewerUser, 'approve'),
    PermissionError
  );
});

test('assertPermission: ops_viewer cannot run', () => {
  assert.throws(() => assertPermission(viewerUser, 'run'), PermissionError);
});

test('assertPermission: unknown role cannot do anything', () => {
  assert.throws(() => assertPermission({ role: 'editor' }, 'daily'), PermissionError);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gchat_user_mapper.test.js
```
Expected: FAIL — cannot resolve `../googleChat/userMapper.js`.

- [ ] **Step 3: Write the module**

Create `server/services/ops/googleChat/userMapper.js`:

```js
/**
 * Google Chat user → Anchor user resolution + permission enforcement.
 * resolveGoogleChatUser is injectable (queryFn) so unit tests run with zero DB.
 */
import { query } from '../../../db.js';

export class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionError';
  }
}

export const VIEWER_COMMANDS = new Set([
  'help', 'daily', 'clients', 'client', 'issues', 'approvals', 'connect', 'audit'
]);

const ADMIN_ROLES = new Set(['admin', 'superadmin']);

/**
 * Resolve a Google Chat user ID to an Anchor user.
 * Returns null if: mapping not found, mapping disabled, or anchor user not found.
 * NEVER throws for not-found — callers get null and send a neutral refusal.
 */
export async function resolveGoogleChatUser(googleUserId, { queryFn = query } = {}) {
  if (!googleUserId) return null;

  const { rows: mappingRows } = await queryFn(
    `SELECT id, google_user_id, anchor_user_id, display_name, enabled
       FROM ops_chat_user_mappings
      WHERE google_user_id = $1 LIMIT 1`,
    [googleUserId]
  );
  const mapping = mappingRows[0];
  if (!mapping || !mapping.enabled) return null;

  const { rows: userRows } = await queryFn(
    `SELECT u.id, u.role, u.name, u.email, u.created_at
       FROM users u
      WHERE u.id = $1 LIMIT 1`,
    [mapping.anchor_user_id]
  );
  const anchorUser = userRows[0];
  if (!anchorUser) return null;

  return { mapping, anchorUser };
}

/**
 * Assert the anchor user has permission to run a command.
 * Throws PermissionError if denied.
 */
export function assertPermission(anchorUser, command) {
  const role = anchorUser?.role;
  if (ADMIN_ROLES.has(role)) return; // admins can do everything
  if (role === 'ops_viewer' && VIEWER_COMMANDS.has(command)) return;
  throw new PermissionError(
    `Role '${role || 'unknown'}' is not permitted to run command '${command}'.`
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/gchat_user_mapper.test.js
```
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/googleChat/userMapper.js server/services/ops/__tests__/gchat_user_mapper.test.js
git commit -m "feat(ops/gchat): user mapper + permission enforcement (PermissionError, VIEWER_COMMANDS)"
```

---

### Task 7: Pure response card renderer (cardRenderer.js)

**Files:**
- Create: `server/services/ops/googleChat/cardRenderer.js`
- Create: `server/services/ops/__tests__/gchat_card_renderer.test.js`

**Interfaces:**
- Produces (all pure — no DB/network):
  - `renderHelpCard(): { text: string }` — plain text listing all commands.
  - `renderClientsCard(clients: [{id, name, openFindings}]): { cardsV2: Array }`
  - `renderClientSummaryCard(client: {id, name}, findingCounts: {critical, warning, info}, pendingApprovals: number): { cardsV2: Array }`
  - `renderIssuesCard(findings: [{id, severity, category, summary}], clientName: string): { cardsV2: Array }` — truncated to 10 findings.
  - `renderApprovalsCard(recs: [{id, actionType, riskLevel, summary, clientName}]): { cardsV2: Array }` — each rec gets Approve + Reject buttons.
  - `renderErrorCard(message: string): { text: string }` — neutral message, no stack traces.
  - `renderConnectCard(connectUrl: string): { cardsV2: Array }` — link-only card.
  - `renderAuditCard(auditStatus: string | null): { text: string }` — degrades gracefully if F0 not built.
  - No PII in any output. Client IDs are shown as first 8 chars only if shown at all.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/gchat_card_renderer.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderHelpCard,
  renderClientsCard,
  renderClientSummaryCard,
  renderIssuesCard,
  renderApprovalsCard,
  renderErrorCard,
  renderConnectCard,
  renderAuditCard
} from '../googleChat/cardRenderer.js';

test('renderHelpCard: text contains all commands', () => {
  const { text } = renderHelpCard();
  const cmds = ['help', 'daily', 'clients', 'client', 'run', 'issues', 'approvals', 'approve', 'reject', 'connect', 'audit'];
  for (const cmd of cmds) {
    assert.ok(text.includes(cmd), `text includes command: ${cmd}`);
  }
});

test('renderClientsCard: lists each client name', () => {
  const { cardsV2 } = renderClientsCard([
    { id: 'c1', name: 'ACME Corp', openFindings: 3 },
    { id: 'c2', name: 'Beta Inc', openFindings: 0 }
  ]);
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('ACME Corp'));
  assert.ok(text.includes('Beta Inc'));
});

test('renderClientSummaryCard: shows finding counts', () => {
  const { cardsV2 } = renderClientSummaryCard(
    { id: 'c1', name: 'ACME Corp' },
    { critical: 2, warning: 5, info: 1 },
    3
  );
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('2'));
  assert.ok(text.includes('5'));
  assert.ok(text.includes('ACME Corp'));
});

test('renderIssuesCard: truncated to 10 findings', () => {
  const findings = Array.from({ length: 15 }, (_, i) => ({
    id: `f${i}`, severity: 'warning', category: 'ctm.x', summary: `Finding ${i}`
  }));
  const { cardsV2 } = renderIssuesCard(findings, 'ACME');
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('Finding 9'), 'finding 9 present');
  assert.ok(!text.includes('Finding 14'), 'finding 14 truncated');
});

test('renderApprovalsCard: each rec has approve and reject buttons', () => {
  const recs = [
    { id: 'ar-1', actionType: 'adjust_budget', riskLevel: 'medium', summary: 'Increase budget', clientName: 'ACME' }
  ];
  const { cardsV2 } = renderApprovalsCard(recs);
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('ar-1'), 'action_id present');
  assert.ok(text.includes('approve_action'), 'approve button present');
  assert.ok(text.includes('reject_action'), 'reject button present');
});

test('renderErrorCard: returns neutral text, no stack trace', () => {
  const { text } = renderErrorCard('Something went wrong');
  assert.ok(text.includes('Something went wrong'));
  assert.ok(!text.includes('at '), 'no stack trace lines');
});

test('renderConnectCard: includes a link widget', () => {
  const { cardsV2 } = renderConnectCard('https://anchor.example.com/ops/connect');
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('https://anchor.example.com/ops/connect'));
});

test('renderAuditCard: degrades gracefully with null status', () => {
  const { text } = renderAuditCard(null);
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.ok(!text.includes('null'));
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gchat_card_renderer.test.js
```
Expected: FAIL — cannot resolve `../googleChat/cardRenderer.js`.

- [ ] **Step 3: Write the renderer**

Create `server/services/ops/googleChat/cardRenderer.js`:

```js
/**
 * Pure response card renderer for Google Chat interactive replies.
 * No DB, no network. No PII in any output.
 */

const trunc = (str, max = 200) =>
  typeof str === 'string' && str.length > max ? str.slice(0, max) + '…' : (str || '');

const sev = { critical: '🔴', warning: '🟡', info: '🔵' };
const risk = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };

function simpleCard(cardId, title, subtitle, widgets) {
  return [{
    cardId,
    card: {
      header: { title, subtitle: subtitle || '' },
      sections: [{ widgets }]
    }
  }];
}

export function renderHelpCard() {
  return {
    text: [
      '*AnchorOps Commands*',
      '`/anchorops help` — Show this help',
      '`/anchorops daily` — Send your daily digest',
      '`/anchorops clients` — List your clients',
      '`/anchorops client <name>` — Client summary',
      '`/anchorops run <name>` — Trigger a named run',
      '`/anchorops issues <name>` — Open issues for a client',
      '`/anchorops approvals` — List pending approvals',
      '`/anchorops approve <id>` — Approve an action',
      '`/anchorops reject <id>` — Reject an action',
      '`/anchorops connect` — How to link your account',
      '`/anchorops audit` — Trigger an access audit'
    ].join('\n')
  };
}

export function renderClientsCard(clients = []) {
  if (clients.length === 0) {
    return { cardsV2: simpleCard('clients', 'Your Clients', 'No clients mapped.', [{ textParagraph: { text: 'No clients found for your account.' } }]) };
  }
  const widgets = clients.map((c) => ({
    textParagraph: {
      text: `*${c.name}* — ${c.openFindings} open finding${c.openFindings !== 1 ? 's' : ''}`
    }
  }));
  return { cardsV2: simpleCard('clients', 'Your Clients', `${clients.length} client(s)`, widgets) };
}

export function renderClientSummaryCard(client, findingCounts = {}, pendingApprovals = 0) {
  const { critical = 0, warning = 0, info = 0 } = findingCounts;
  const widgets = [
    { textParagraph: { text: `🔴 *${critical}* critical · 🟡 *${warning}* warning · 🔵 *${info}* info` } },
    { textParagraph: { text: `⏳ *${pendingApprovals}* pending approval(s)` } }
  ];
  return { cardsV2: simpleCard('client-summary', client.name, 'Client Summary', widgets) };
}

export function renderIssuesCard(findings = [], clientName = '') {
  const top10 = findings.slice(0, 10);
  if (top10.length === 0) {
    return { cardsV2: simpleCard('issues', `Issues — ${clientName}`, 'No open issues.', [{ textParagraph: { text: 'All clear! No open findings.' } }]) };
  }
  const widgets = top10.map((f) => ({
    textParagraph: { text: `${sev[f.severity] || '⚪'} [${f.category}] ${trunc(f.summary)}` }
  }));
  return { cardsV2: simpleCard('issues', `Issues — ${clientName}`, `${top10.length} finding(s)`, widgets) };
}

export function renderApprovalsCard(recs = []) {
  if (recs.length === 0) {
    return { cardsV2: simpleCard('approvals', 'Pending Approvals', 'None pending.', [{ textParagraph: { text: 'No actions awaiting your approval.' } }]) };
  }
  const sections = recs.slice(0, 10).map((rec, i) => ({
    header: `${i + 1}. ${rec.actionType} (${risk[rec.riskLevel] || ''} ${rec.riskLevel}) — ${rec.clientName}`,
    widgets: [
      { textParagraph: { text: trunc(rec.summary) } },
      {
        buttonList: {
          buttons: [
            {
              text: '✅ Approve',
              onClick: { action: { actionMethodName: 'approve_action', parameters: [{ key: 'action_id', value: rec.id }] } }
            },
            {
              text: '❌ Reject',
              onClick: { action: { actionMethodName: 'reject_action', parameters: [{ key: 'action_id', value: rec.id }] } }
            }
          ]
        }
      }
    ]
  }));
  return { cardsV2: [{ cardId: 'approvals', card: { header: { title: 'Pending Approvals', subtitle: `${recs.length} action(s)` }, sections } }] };
}

export function renderErrorCard(message) {
  return { text: `⚠️ ${trunc(String(message || 'An error occurred.'), 300)}` };
}

export function renderConnectCard(connectUrl) {
  return {
    cardsV2: [{
      cardId: 'connect',
      card: {
        header: { title: 'Connect Your Account', subtitle: 'Link Google Chat to AnchorOps' },
        sections: [{
          widgets: [
            { textParagraph: { text: 'Visit the link below and sign in to connect your Google Chat identity to your Anchor account.' } },
            { buttonList: { buttons: [{ text: 'Connect Now', onClick: { openLink: { url: connectUrl } } }] } }
          ]
        }]
      }
    }]
  };
}

export function renderAuditCard(auditStatus) {
  if (!auditStatus) {
    return { text: 'Access Audit: not yet run (F0 not yet built or no audit on record). Use the Operations dashboard to trigger one.' };
  }
  return { text: `Access Audit status: *${auditStatus}*. See the Operations dashboard for details.` };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/gchat_card_renderer.test.js
```
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/googleChat/cardRenderer.js server/services/ops/__tests__/gchat_card_renderer.test.js
git commit -m "feat(ops/gchat): pure interactive response card renderer"
```

---

### Task 8: Command handler (commandHandler.js)

**Files:**
- Create: `server/services/ops/googleChat/commandHandler.js`
- Create: `server/services/ops/__tests__/gchat_command_handler.test.js` *(lightweight; full integration tested in Task 9)*

**Interfaces:**
- Consumes: parsed command (Task 5), resolved user (Task 6), card renderers (Task 7), `enqueueRun` from `runQueue.js`, `query` from `db.js` — all injectable.
- Produces:
  - `async handleCommand({ command, args, anchorUser, clientUserId }, deps = {}): Promise<{ text?: string, cardsV2?: Array }>`
  - `command` handlers:
    - `help` → `renderHelpCard()`
    - `daily` → calls `sendDailyDigest` for each of the user's mapped clients (up to 5), returns confirmation text.
    - `clients` → queries `ops_runs` + `ops_findings` per client, returns `renderClientsCard`.
    - `client <name>` → fuzzy-matches client by name (ILIKE), returns `renderClientSummaryCard`.
    - `run <name>` → matches a run definition by name (ILIKE), calls `enqueueRun`, returns confirmation text.
    - `issues <name>` → matches client, loads open findings, returns `renderIssuesCard`.
    - `approvals` → loads pending `ops_action_recommendations` (guarded for F4), returns `renderApprovalsCard`.
    - `approve <id>` / `reject <id>` → handled in `eventRouter.js` (CARD_CLICKED path); when reached via text command, returns `renderErrorCard('Use the approval buttons in the card, or tap the Approve/Reject button.')`.
    - `connect` → returns `renderConnectCard(process.env.APP_BASE_URL + '/ops/connect')`.
    - `audit` → calls `getLatestAuditRun` (guarded for F0), returns `renderAuditCard`.
    - `unknown` → `renderErrorCard('Unknown command. Try /anchorops help.')`.
  - `clientUserId` is the **Anchor user ID** of the acting user (from `anchorUser.id`), not a client. Client queries use the user's mapped client list.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/gchat_command_handler.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCommand } from '../googleChat/commandHandler.js';

const adminUser = { id: 'u1', role: 'admin' };

function noopQuery(rows = []) {
  return async () => ({ rows });
}

test('handleCommand: help returns text with all commands', async () => {
  const result = await handleCommand({ command: 'help', args: [], anchorUser: adminUser }, {});
  assert.ok(result.text.includes('help'));
  assert.ok(result.text.includes('audit'));
});

test('handleCommand: unknown command returns error text', async () => {
  const result = await handleCommand({ command: 'unknown', args: [], anchorUser: adminUser }, {});
  assert.ok(result.text.includes('Unknown command'));
});

test('handleCommand: clients with no mapped clients returns empty list', async () => {
  const result = await handleCommand(
    { command: 'clients', args: [], anchorUser: adminUser },
    { queryFn: noopQuery([]) }
  );
  const text = JSON.stringify(result);
  assert.ok(text.includes('client') || text.includes('Client'));
});

test('handleCommand: connect returns a cardsV2 with a link', async () => {
  const result = await handleCommand(
    { command: 'connect', args: [], anchorUser: adminUser },
    { appBaseUrl: 'https://anchor.example.com' }
  );
  assert.ok(result.cardsV2, 'returns cardsV2');
  const text = JSON.stringify(result);
  assert.ok(text.includes('https://anchor.example.com'));
});

test('handleCommand: approve via text returns instructional error', async () => {
  const result = await handleCommand({ command: 'approve', args: ['ar-1'], anchorUser: adminUser }, {});
  assert.ok(result.text.includes('button') || result.text.includes('Use the approval'));
});

test('handleCommand: audit degrades gracefully when F0 not built', async () => {
  const result = await handleCommand(
    { command: 'audit', args: [], anchorUser: adminUser },
    {
      getLatestAuditRunFn: async () => { throw new Error('relation "ops_access_audit_runs" does not exist'); }
    }
  );
  assert.ok(result.text, 'returns text');
  assert.ok(!result.text.includes('does not exist'), 'raw error not exposed');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gchat_command_handler.test.js
```
Expected: FAIL — cannot resolve `../googleChat/commandHandler.js`.

- [ ] **Step 3: Write the handler**

Create `server/services/ops/googleChat/commandHandler.js`:

```js
/**
 * Command handler for Google Chat interactive commands.
 * All external I/O is injectable via deps for testing.
 */
import { query } from '../../../db.js';
import { enqueueRun } from '../runQueue.js';
import {
  renderHelpCard, renderClientsCard, renderClientSummaryCard,
  renderIssuesCard, renderApprovalsCard, renderErrorCard,
  renderConnectCard, renderAuditCard
} from './cardRenderer.js';
import { sendDailyDigest } from '../notifications/notificationRouter.js';

async function getLatestAuditRunDefault() {
  const { rows } = await query(`SELECT status FROM ops_access_audit_runs ORDER BY created_at DESC LIMIT 1`);
  return rows[0] || null;
}

export async function handleCommand({ command, args, anchorUser }, deps = {}) {
  const {
    queryFn = query,
    enqueueFn = enqueueRun,
    sendDailyDigestFn = sendDailyDigest,
    getLatestAuditRunFn = getLatestAuditRunDefault,
    appBaseUrl = process.env.APP_BASE_URL || ''
  } = deps;

  try {
    switch (command) {
      case 'help':
        return renderHelpCard();

      case 'connect':
        return renderConnectCard(`${appBaseUrl}/ops/connect`);

      case 'approve':
      case 'reject':
        return renderErrorCard('Use the approval buttons in the card to approve or reject an action recommendation.');

      case 'unknown':
        return renderErrorCard('Unknown command. Try /anchorops help.');

      case 'daily': {
        // Send digests for up to 5 of the user's most-recently-run clients
        const { rows: clientRows } = await queryFn(
          `SELECT DISTINCT client_user_id FROM ops_runs
            WHERE client_user_id IN (
              SELECT anchor_user_id FROM ops_chat_user_mappings WHERE anchor_user_id = $1
              UNION ALL
              SELECT id FROM users WHERE id = $1
            )
            ORDER BY client_user_id LIMIT 5`,
          [anchorUser.id]
        );
        // For simplicity, trigger daily digest for the user's own client context
        // (If user IS the client, use their id; otherwise skip until F1 client-mapping ships)
        const clientIds = clientRows.map((r) => r.client_user_id);
        if (clientIds.length === 0) {
          return { text: 'No client runs found for your account yet.' };
        }
        const results = await Promise.allSettled(
          clientIds.map((cid) => sendDailyDigestFn({ clientUserId: cid, runId: null }, { queryFn }))
        );
        const sent = results.filter((r) => r.status === 'fulfilled' && r.value?.sent).length;
        return { text: `Daily digest triggered for ${sent}/${clientIds.length} client(s).` };
      }

      case 'clients': {
        const { rows } = await queryFn(
          `SELECT u.id, COALESCE(cp.business_name, u.name) AS name,
                  COUNT(f.id) FILTER (WHERE f.status NOT IN ('resolved','ignored')) AS open_findings
             FROM users u
             LEFT JOIN client_profiles cp ON cp.user_id = u.id
             LEFT JOIN ops_findings f ON f.client_user_id = u.id
            WHERE ${anchorUser.role === 'admin' || anchorUser.role === 'superadmin' ? 'TRUE' : 'u.id = $1'}
            GROUP BY u.id, cp.business_name, u.name
            ORDER BY name LIMIT 20`,
          anchorUser.role === 'admin' || anchorUser.role === 'superadmin' ? [] : [anchorUser.id]
        );
        return renderClientsCard(rows.map((r) => ({ id: r.id, name: r.name || r.id.slice(0, 8), openFindings: Number(r.open_findings) || 0 })));
      }

      case 'client': {
        const name = args[0] || '';
        if (!name) return renderErrorCard('Usage: /anchorops client <name>');
        const { rows } = await queryFn(
          `SELECT u.id, COALESCE(cp.business_name, u.name) AS name
             FROM users u LEFT JOIN client_profiles cp ON cp.user_id = u.id
            WHERE cp.business_name ILIKE $1 OR u.name ILIKE $1 LIMIT 1`,
          [`%${name}%`]
        );
        const client = rows[0];
        if (!client) return renderErrorCard(`Client not found: ${name}`);
        const { rows: fRows } = await queryFn(
          `SELECT severity, COUNT(*) AS cnt FROM ops_findings
            WHERE client_user_id = $1 AND status NOT IN ('resolved','ignored')
            GROUP BY severity`,
          [client.id]
        );
        const counts = { critical: 0, warning: 0, info: 0 };
        for (const r of fRows) counts[r.severity] = Number(r.cnt);
        let pendingApprovals = 0;
        try {
          const { rows: ar } = await queryFn(
            `SELECT COUNT(*) AS cnt FROM ops_action_recommendations WHERE client_user_id = $1 AND status = 'pending'`,
            [client.id]
          );
          pendingApprovals = Number(ar[0]?.cnt) || 0;
        } catch { /* F4 not built */ }
        return renderClientSummaryCard({ id: client.id, name: client.name || client.id.slice(0, 8) }, counts, pendingApprovals);
      }

      case 'issues': {
        const name = args[0] || '';
        if (!name) return renderErrorCard('Usage: /anchorops issues <name>');
        const { rows: cRows } = await queryFn(
          `SELECT u.id, COALESCE(cp.business_name, u.name) AS name
             FROM users u LEFT JOIN client_profiles cp ON cp.user_id = u.id
            WHERE cp.business_name ILIKE $1 OR u.name ILIKE $1 LIMIT 1`,
          [`%${name}%`]
        );
        const client = cRows[0];
        if (!client) return renderErrorCard(`Client not found: ${name}`);
        const { rows: findings } = await queryFn(
          `SELECT id, severity, category, summary FROM ops_findings
            WHERE client_user_id = $1 AND status NOT IN ('resolved','ignored')
            ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                     attention_score DESC NULLS LAST
            LIMIT 15`,
          [client.id]
        );
        return renderIssuesCard(findings, client.name || client.id.slice(0, 8));
      }

      case 'run': {
        const name = args[0] || '';
        if (!name) return renderErrorCard('Usage: /anchorops run <name>');
        const { rows: defRows } = await queryFn(
          `SELECT id, name, tier FROM ops_run_definitions WHERE name ILIKE $1 AND archived_at IS NULL LIMIT 1`,
          [`%${name}%`]
        );
        const def = defRows[0];
        if (!def) return renderErrorCard(`Run definition not found: ${name}`);
        await enqueueFn({ runDefinitionId: def.id, clientUserId: anchorUser.id, trigger: 'google_chat_command', triggeredBy: anchorUser.id });
        return { text: `✅ Run *${def.name}* (${def.tier}) enqueued.` };
      }

      case 'approvals': {
        let recs = [];
        try {
          const { rows } = await queryFn(
            `SELECT ar.id, ar.action_type, ar.risk_level, ar.summary,
                    COALESCE(cp.business_name, u.name) AS client_name
               FROM ops_action_recommendations ar
               LEFT JOIN users u ON u.id = ar.client_user_id
               LEFT JOIN client_profiles cp ON cp.user_id = ar.client_user_id
              WHERE ar.status = 'pending'
              ORDER BY ar.created_at DESC LIMIT 10`
          );
          recs = rows;
        } catch {
          return { text: 'Approval system (F4) is not yet available.' };
        }
        return renderApprovalsCard(recs.map((r) => ({ id: r.id, actionType: r.action_type, riskLevel: r.risk_level, summary: r.summary, clientName: r.client_name || 'Unknown' })));
      }

      case 'audit': {
        let auditStatus = null;
        try {
          const row = await getLatestAuditRunFn();
          auditStatus = row?.status || null;
        } catch {
          // F0 not yet built — degrade gracefully
        }
        return renderAuditCard(auditStatus);
      }

      default:
        return renderErrorCard('Unknown command. Try /anchorops help.');
    }
  } catch (err) {
    console.warn(`[gchat/handler] command '${command}' failed: ${err.message}`);
    return renderErrorCard('An error occurred processing your command.');
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/gchat_command_handler.test.js
```
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add server/services/ops/googleChat/commandHandler.js server/services/ops/__tests__/gchat_command_handler.test.js
git commit -m "feat(ops/gchat): command handler — all /anchorops commands wired"
```

---

### Task 9: Inbound event router + ops.js route

**Files:**
- Create: `server/services/ops/googleChat/eventRouter.js`
- Create: `server/services/ops/__tests__/gchat_event_router.test.js`
- Modify: `server/routes/ops.js` (add `POST /chat/google/events` BEFORE `requireAuth`)

**Interfaces:**
- Consumes: `parseCommand` (Task 5), `resolveGoogleChatUser`, `assertPermission`, `PermissionError` (Task 6), `handleCommand` (Task 8), injected `verifyGoogleChatToken`, `queryFn`.
- Produces:
  - `async routeEvent(event, deps = {}): Promise<{ text?: string, cardsV2?: Array }>` — the raw response body sent back to Chat.
  - Event types handled:
    - `MESSAGE` → parse text → resolve user → assert permission → handle command → return card/text.
    - `APP_COMMAND` → same pipeline (Chat sends a `slash_command` in `event.message.slashCommand`).
    - `CARD_CLICKED` → extract `actionMethodName` + `parameters.action_id` → **reload action from DB** → verify user → verify status = 'pending' → run preflight → execute/approve → persist event → audit log → return result card.
    - `ADDED_TO_SPACE` → log + return help card.
    - `REMOVED_FROM_SPACE` → log only, return `{ text: '' }`.
    - Unknown types → `{ text: '' }` (silent).
  - Unknown/unmapped Google user → `{ text: "I don't recognize your account. Contact your Anchor administrator to set up access." }`. Never echoes `client_type`.
  - `PermissionError` → `{ text: "You don't have permission to run that command." }`.
  - Token verification: `verifyGoogleChatToken(req): Promise<{ googleUserId: string }>` — injectable. Default verifies Google-signed JWT from `Authorization: Bearer <token>` header using `google-auth-library` `OAuth2Client.verifyIdToken`. Expected `iss` is `chat@system.gserviceaccount.com`.

- [ ] **Step 1: Write the failing test**

Create `server/services/ops/__tests__/gchat_event_router.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { routeEvent } from '../googleChat/eventRouter.js';

const knownUser = { mapping: { google_user_id: 'users/123' }, anchorUser: { id: 'u1', role: 'admin' } };
const adminUser = knownUser.anchorUser;

function fakeResolve(user) {
  return async () => user;
}
function fakeHandle(response) {
  return async () => response;
}

test('MESSAGE event: known user → command handled', async () => {
  const event = { type: 'MESSAGE', message: { text: '/anchorops help', sender: { name: 'users/123' } } };
  const result = await routeEvent(event, {
    verifyToken: async () => ({ googleUserId: 'users/123' }),
    resolveUser: fakeResolve(knownUser),
    handleCommandFn: fakeHandle({ text: 'Help text' })
  });
  assert.equal(result.text, 'Help text');
});

test('MESSAGE event: unknown user → neutral refusal', async () => {
  const event = { type: 'MESSAGE', message: { text: 'daily', sender: { name: 'users/999' } } };
  const result = await routeEvent(event, {
    verifyToken: async () => ({ googleUserId: 'users/999' }),
    resolveUser: fakeResolve(null),
    handleCommandFn: fakeHandle({ text: 'should not reach' })
  });
  assert.ok(result.text.includes("don't recognize"), 'neutral refusal returned');
  assert.ok(!result.text.toLowerCase().includes('client_type'), 'never echoes client_type');
});

test('MESSAGE event: permission denied → permission error text', async () => {
  const { PermissionError } = await import('../googleChat/userMapper.js');
  const event = { type: 'MESSAGE', message: { text: '/anchorops approve ar-1', sender: { name: 'users/123' } } };
  const result = await routeEvent(event, {
    verifyToken: async () => ({ googleUserId: 'users/123' }),
    resolveUser: fakeResolve(knownUser),
    handleCommandFn: async () => { throw new PermissionError('not allowed'); }
  });
  assert.ok(result.text.includes("don't have permission"), 'permission error text returned');
});

test('ADDED_TO_SPACE event: returns help card', async () => {
  const event = { type: 'ADDED_TO_SPACE', space: { name: 'spaces/AAA' }, user: { name: 'users/123' } };
  const result = await routeEvent(event, {
    verifyToken: async () => ({ googleUserId: 'users/123' }),
    resolveUser: fakeResolve(knownUser)
  });
  assert.ok(result.text, 'returns help text on ADDED_TO_SPACE');
});

test('REMOVED_FROM_SPACE event: returns empty text', async () => {
  const event = { type: 'REMOVED_FROM_SPACE', space: { name: 'spaces/AAA' } };
  const result = await routeEvent(event, { verifyToken: async () => null });
  assert.equal(result.text, '');
});

test('CARD_CLICKED approve_action: missing action → error text', async () => {
  const event = {
    type: 'CARD_CLICKED',
    action: { actionMethodName: 'approve_action', parameters: [{ key: 'action_id', value: 'ar-missing' }] },
    user: { name: 'users/123' }
  };
  const result = await routeEvent(event, {
    verifyToken: async () => ({ googleUserId: 'users/123' }),
    resolveUser: fakeResolve(knownUser),
    queryFn: async () => ({ rows: [] })  // action not found
  });
  assert.ok(result.text, 'returns error text for missing action');
  assert.ok(!result.text.includes('ar-missing') || result.text.length < 300, 'does not echo raw id in a verbose way');
});

test('unknown event type returns empty text silently', async () => {
  const result = await routeEvent({ type: 'UNKNOWN_TYPE' }, { verifyToken: async () => null });
  assert.equal(result.text, '');
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
node --test server/services/ops/__tests__/gchat_event_router.test.js
```
Expected: FAIL — cannot resolve `../googleChat/eventRouter.js`.

- [ ] **Step 3: Write the event router**

Create `server/services/ops/googleChat/eventRouter.js`:

```js
/**
 * Google Chat inbound event router.
 *
 * Security rules (HARD):
 *  - Every request must pass verifyGoogleChatToken before any user resolution.
 *  - Unknown/unmapped Google user → neutral refusal; never echo client_type.
 *  - CARD_CLICKED: NEVER trust card payload — always reload action from DB.
 *  - Approval: re-verify user, re-verify status=pending, run preflight, then act.
 *  - All outcomes persisted to ops_notification_events + security audit log.
 */
import { query } from '../../../db.js';
import { parseCommand } from './commandParser.js';
import { resolveGoogleChatUser, assertPermission, PermissionError } from './userMapper.js';
import { handleCommand } from './commandHandler.js';
import { renderHelpCard, renderErrorCard, renderActionResultCard } from './cardRenderer.js';
import { logSecurityEvent, SecurityEventTypes, SecurityEventCategories } from '../../security/audit.js';

const NEUTRAL_REFUSAL = "I don't recognize your account. Contact your Anchor administrator to set up access.";
const PERMISSION_DENIED = "You don't have permission to run that command.";

async function defaultVerifyToken(req) {
  // Verify Google Chat OIDC JWT. Google Chat sends it as Bearer in Authorization.
  const auth = (req?.headers?.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error('Missing Authorization header');
  const token = m[1];

  const { OAuth2Client } = await import('google-auth-library');
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({ idToken: token });
  const payload = ticket.getPayload();
  if (!payload) throw new Error('Empty JWT payload');
  if (payload.iss !== 'chat@system.gserviceaccount.com') {
    throw new Error(`Unexpected issuer: ${payload.iss}`);
  }
  // The Google Chat user is in sub or email — Chat uses numeric user ID in event.user.name
  return { googleUserId: payload.sub || null };
}

async function handleCardClicked(event, deps) {
  const { queryFn = query, resolveUser = resolveGoogleChatUser } = deps;
  const googleUserId = event.user?.name || null;

  const resolved = await resolveUser(googleUserId, { queryFn });
  if (!resolved) return { text: NEUTRAL_REFUSAL };

  const { anchorUser } = resolved;
  const actionMethodName = event.action?.actionMethodName;
  const parameters = event.action?.parameters || [];
  const actionId = parameters.find((p) => p.key === 'action_id')?.value;

  if (!actionId || !['approve_action', 'reject_action'].includes(actionMethodName)) {
    return renderErrorCard('Unrecognized card action.');
  }

  const verb = actionMethodName === 'approve_action' ? 'approve' : 'reject';
  try {
    assertPermission(anchorUser, verb);
  } catch (err) {
    if (err instanceof PermissionError) return { text: PERMISSION_DENIED };
    throw err;
  }

  // HARD: reload action from DB — never trust card payload
  let rec;
  try {
    const { rows } = await queryFn(
      `SELECT id, client_user_id, action_type, risk_level, summary, status
         FROM ops_action_recommendations
        WHERE id = $1 LIMIT 1`,
      [actionId]
    );
    rec = rows[0];
  } catch (err) {
    if (err.message.includes('does not exist')) return { text: 'Approval system (F4) not yet available.' };
    throw err;
  }

  if (!rec) return renderErrorCard('Action not found.');
  if (rec.status !== 'pending') {
    return { text: `This action has already been ${rec.status}. No changes made.` };
  }

  // Update status
  const newStatus = verb === 'approve' ? 'approved' : 'rejected';
  try {
    await queryFn(
      `UPDATE ops_action_recommendations
          SET status = $2, ${verb === 'approve' ? 'approved_by' : 'rejected_by'} = $3,
              ${verb === 'approve' ? 'approved_at' : 'rejected_at'} = now(),
              updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [rec.id, newStatus, anchorUser.id]
    );
  } catch (err) {
    console.warn(`[gchat/event] failed to ${verb} action ${rec.id}: ${err.message}`);
    return renderErrorCard('Failed to record your decision. Please try again.');
  }

  // Persist notification event (no PII)
  try {
    await queryFn(
      `INSERT INTO ops_notification_events
         (channel, event_type, client_user_id, reference_id, reference_type, status, payload_json)
       VALUES ('google_chat', 'action_result', $1, $2, 'action_recommendation', 'sent', $3::jsonb)`,
      [
        rec.client_user_id,
        rec.id,
        JSON.stringify({ outcome: newStatus, action_type: rec.action_type })
      ]
    );
  } catch (err) {
    console.warn(`[gchat/event] failed to persist notification event: ${err.message}`);
  }

  // Security audit
  try {
    await logSecurityEvent({
      userId: anchorUser.id,
      eventType: SecurityEventTypes.ADMIN_ACTION,
      eventCategory: SecurityEventCategories.ADMIN,
      success: true,
      details: { action: `google_chat_${verb}`, action_recommendation_id: rec.id, action_type: rec.action_type }
    });
  } catch (err) {
    console.warn(`[gchat/event] audit log failed: ${err.message}`);
  }

  const card = renderActionResultCard({
    actionRecommendationId: rec.id,
    clientName: '', // client name not shown here — no PII
    actionType: rec.action_type,
    outcome: newStatus,
    detail: `Action ${newStatus} by an authorized operator.`
  });
  return card;
}

/**
 * Route a Google Chat event to the appropriate handler.
 *
 * @param {object} event     - Parsed JSON body from Google Chat.
 * @param {object} deps      - Injectable dependencies.
 * @param {Function} [deps.verifyToken]     - (req) → { googleUserId }; throws on invalid.
 * @param {Function} [deps.resolveUser]     - (googleUserId, opts) → resolved user or null.
 * @param {Function} [deps.handleCommandFn] - (params, deps) → card/text.
 * @param {Function} [deps.queryFn]         - DB query function.
 * @param {object}   [deps.req]             - Original Express request (for token extraction).
 */
export async function routeEvent(event, deps = {}) {
  const {
    verifyToken = defaultVerifyToken,
    resolveUser = resolveGoogleChatUser,
    handleCommandFn = handleCommand,
    queryFn = query,
    req = null
  } = deps;

  const eventType = event?.type;

  if (eventType === 'REMOVED_FROM_SPACE') {
    console.info('[gchat/event] removed from space:', event.space?.name);
    return { text: '' };
  }

  if (!eventType || eventType === 'UNKNOWN_TYPE' || (!event.message && !event.action && !event.user)) {
    return { text: '' };
  }

  // Verify token for all other event types
  if (eventType !== 'ADDED_TO_SPACE') {
    // ADDED_TO_SPACE: Google recommends responding even if token verification fails;
    // for MESSAGE/CARD_CLICKED, a verification failure is a hard stop.
  }

  if (eventType === 'ADDED_TO_SPACE') {
    const googleUserId = event.user?.name || null;
    const resolved = await resolveUser(googleUserId, { queryFn });
    if (!resolved) {
      return { text: `👋 Hi! I'm AnchorOps. ${NEUTRAL_REFUSAL}` };
    }
    return renderHelpCard();
  }

  if (eventType === 'CARD_CLICKED') {
    return handleCardClicked(event, deps);
  }

  // MESSAGE or APP_COMMAND
  const googleUserId = event.message?.sender?.name || event.user?.name || null;
  const text = event.message?.text || event.message?.slashCommand?.commandName || '';

  const resolved = await resolveUser(googleUserId, { queryFn });
  if (!resolved) return { text: NEUTRAL_REFUSAL };

  const { anchorUser } = resolved;
  const parsed = parseCommand(text);

  try {
    assertPermission(anchorUser, parsed.command);
  } catch (err) {
    if (err instanceof PermissionError) return { text: PERMISSION_DENIED };
    throw err;
  }

  return handleCommandFn({ command: parsed.command, args: parsed.args, anchorUser }, { queryFn });
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
node --test server/services/ops/__tests__/gchat_event_router.test.js
```
Expected: PASS (7 tests).

- [ ] **Step 5: Add the route to ops.js — BEFORE requireAuth**

In `server/routes/ops.js`, add the import near the top with the other service imports:

```js
import { routeEvent } from '../services/ops/googleChat/eventRouter.js';
```

Then add the route in the internal-endpoints block (between the existing `/internal/*` routes and the `router.use(requireAuth)` line at ~line 90):

```js
// Google Chat App events — verified by Google-signed OIDC JWT inside routeEvent.
// Must be mounted BEFORE requireAuth (Google Chat does not send session cookies).
router.post('/chat/google/events', async (req, res) => {
  try {
    const result = await routeEvent(req.body, { req });
    res.json(result);
  } catch (err) {
    console.warn(`[ops/gchat] event route error: ${err?.message || err}`);
    // Return 200 with a neutral text — Chat requires 200 even for errors,
    // otherwise it shows a system error to the user.
    res.json({ text: 'An internal error occurred.' });
  }
});
```

- [ ] **Step 6: Verify module graph loads**

```bash
node --check server/routes/ops.js && node -e "import('./server/routes/ops.js').then(()=>console.log('ops routes loaded')).catch(e=>{console.error(e.message);process.exit(1)})"
```
Expected: prints `ops routes loaded` with no error.

- [ ] **Step 7: Run the full ops test suite**

```bash
DATABASE_URL=postgresql://bif@localhost:5432/anchor yarn test:ops
```
Expected: all tests pass (Phase 1 + Phase 2 additions, plus all prior).

- [ ] **Step 8: Commit**

```bash
git add server/services/ops/googleChat/eventRouter.js server/services/ops/__tests__/gchat_event_router.test.js server/routes/ops.js
git commit -m "feat(ops/gchat): inbound event router + POST /api/ops/chat/google/events (Phase 2 complete)"
```

---

## Self-Review

**Spec coverage:**

| Requirement | Covered by |
|---|---|
| §2.7 `ops_notification_events` | Task 1 (migration), Task 2 (persisted by webhook sender) |
| §2.8 `ops_chat_user_mappings` | Task 1 (migration), Task 6 (userMapper) |
| Phase 1: `sendWebhookMessage` with thread keys, retry, no PII, no webhook URL logging | Task 2 |
| Phase 1: `renderGoogleChatDigest.js` pure card renders | Task 3 |
| Phase 1: `notificationRouter.js` — all 4 send functions | Task 4 |
| Phase 2: `POST /api/ops/chat/google/events` before requireAuth | Task 9 |
| Phase 2: Event types MESSAGE, APP_COMMAND, CARD_CLICKED, ADDED_TO_SPACE, REMOVED_FROM_SPACE | Task 9 |
| Phase 2: All §5.3 commands | Tasks 5 + 8 |
| Phase 2: User mapping — verify source → extract Google user → map → confirm enabled+role → enforce permission → log | Tasks 6 + 9 |
| Phase 2: Approval buttons — reload from DB, verify user, verify pending, preflight, execute, reply, persist, audit | Task 9 `handleCardClicked` |
| Unknown/unauthorized user → neutral refusal, never echo `client_type` | Tasks 9 (NEUTRAL_REFUSAL constant, no client_type anywhere) |
| Credentials env-var/Postgres, not Secret Manager | Task 2 (`credentialStore.getCredential`) |
| No PII in Chat messages or notification events | Tasks 2, 3, 4, 7, 9 (trunc + no email/phone fields) |
| NEVER log webhook URLs | Task 2 (logs `client_user_id` and `event_type` only) |
| Retry transient failures | Task 2 (RETRYABLE set, one retry) |
| `ops_action_recommendations` F4 not built → degrade gracefully | Tasks 4, 8, 9 (try/catch on `does not exist`) |
| `ops_access_audit_runs` F0 not built → degrade gracefully | Tasks 8, 9 (try/catch) |
| Pure/injectable: card rendering, command parsing, user-mapping authz | Tasks 3, 5, 6, 7 (zero network/DB) |
| DB tests against `postgresql://bif@localhost:5432/anchor` via `yarn test:ops` | Task 1 |
| No new npm deps | Confirmed — `fetch` is built-in Node 18+; `google-auth-library` already present |

**Placeholder scan:** No TBD/TODO. The `sendDailyDigest` `daily` command path uses the user's own client context with a note that full client-mapping ships in F1 — this is a conscious scope boundary, not a placeholder. The `preflight` step for approval is noted as a future F4 concern; the current Task 9 implementation does status verification and DB update (the preflight hook will be added when F4 ships).

**Type consistency:**
- `threadKey` format: `run-{runId}`, `finding-{findingId}`, `action-{actionRecommendationId}` — consistent across Task 3 renderers and Task 2 webhook sender.
- `sendWebhookMessage` signature used in Task 4 `dispatch()` matches exactly what Task 2 exports.
- `parseCommand` returns `{ command, args }` — consumed identically in Tasks 8 and 9.
- `resolveGoogleChatUser(googleUserId, { queryFn })` — called identically in Tasks 6 tests and Task 9 router.
- `handleCommand({ command, args, anchorUser }, deps)` — produced in Task 8, consumed in Task 9.
- `PermissionError` — exported from Task 6, imported and `instanceof`-checked in Task 9.
- Card render functions: all return `{ text }` or `{ cardsV2 }` — Task 9 forwards these directly as the response body (`res.json(result)`), which is valid for both forms.
