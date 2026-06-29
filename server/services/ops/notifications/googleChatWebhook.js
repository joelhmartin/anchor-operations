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
