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
