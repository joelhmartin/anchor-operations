/**
 * Agency-wide daily digest → Google Chat (north-star §21.2 "Anchor Ops Daily").
 *
 * Summarizes the whole portfolio (clients at risk, approvals waiting, 24h
 * changes) + the clients that need attention, and posts ONE message to the
 * default ops Chat space. Triggered daily by Cloud Scheduler via the internal
 * endpoint; the team reads it where they already work.
 *
 * Render is pure (testable, no PII beyond client display names). Sending reuses
 * the F5 sendWebhookMessage path (persists ops_notification_events; never logs
 * the webhook URL).
 */
import { query } from '../../../db.js';
import { clientLabelJoins } from '../../clientLabel.js';
import { shapeHomeDigest } from '../homeDigest.js';
import { sendWebhookMessage } from './googleChatWebhook.js';

const TOP_N = 8;

/** Pure: build the Chat text from the command-center result + a name map. */
export function renderAgencyDigestText(commandCenter, clientNames = {}) {
  const k = commandCenter?.kpis || {};
  const home = shapeHomeDigest({ commandCenter });
  const lines = ['*Anchor Ops — Daily*'];

  const head = [
    `🔴 ${k.clients_at_risk ?? 0} clients at risk`,
    `🟡 ${k.approvals_waiting ?? 0} approvals waiting`,
    `${k.changes_24h ?? 0} changes in 24h`
  ];
  if (k.automation_stuck) head.push(`⚠️ ${k.automation_stuck} stuck run(s)`);
  lines.push(head.join(' · '));

  if (home.needsAttention.length) {
    lines.push('', '*Needs attention:*');
    for (const c of home.needsAttention.slice(0, TOP_N)) {
      const name = clientNames[c.clientUserId] || c.clientUserId;
      lines.push(`• ${name}: ${c.criticalCount} critical${c.top ? ` — ${c.top}` : ''}`);
    }
    const more = home.needsAttention.length - TOP_N;
    if (more > 0) lines.push(`…and ${more} more`);
  } else {
    lines.push('', 'No open critical issues right now. ✅');
  }

  const base = process.env.APP_BASE_URL || '';
  if (base) lines.push('', `Open the dashboard: ${base}/operations`);
  return lines.join('\n');
}

/** Resolve display names for a set of client user ids. */
export async function resolveClientNames(ids, queryFn = query) {
  if (!ids.length) return {};
  // Non-PII fallback — never egress a client's login email into the team space.
  // `users.name` does NOT exist in prod (the real columns are first_name/last_name);
  // referencing it made this query throw, so the digest silently fell back to
  // 'Client <id8>' for everyone. Resolve the business/display name from the same
  // columns the canonical clientLabel resolver uses, but deliberately stop before
  // the email fallback so no login email is egressed into the team space.
  const { rows } = await queryFn(
    `SELECT u.id AS user_id,
            COALESCE(
              NULLIF(TRIM(cp.client_identifier_value), ''),
              NULLIF(TRIM(ba.business_name), ''),
              NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''),
              'Client ' || left(u.id::text, 8)
            ) AS name
       FROM users u
       ${clientLabelJoins('u.id')}
      WHERE u.id = ANY($1::uuid[])`,
    [ids]
  );
  return Object.fromEntries(rows.map((r) => [r.user_id, r.name]));
}

/**
 * Build + post the agency daily digest to the default Chat space.
 * @returns {{ ok:boolean, reason:string }}
 */
export async function sendAgencyChatDigest({
  commandCenter,
  webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_DEFAULT,
  resolveNames = resolveClientNames,
  send = sendWebhookMessage
} = {}) {
  if (!webhookUrl) return { ok: false, reason: 'no_webhook_configured' };
  if (!commandCenter) return { ok: false, reason: 'no_command_center' };

  const ids = shapeHomeDigest({ commandCenter }).needsAttention.map((c) => c.clientUserId);
  const names = await resolveNames(ids).catch(() => ({}));

  // sendWebhookMessage does NOT throw on a down/4xx/5xx Chat endpoint — it
  // returns { sent:false, reason }. Reflect that so the route (and Cloud
  // Scheduler) can see a real failure instead of a false success.
  const result = await send({
    webhookUrl,
    text: renderAgencyDigestText(commandCenter, names),
    clientUserId: null,
    eventType: 'agency_daily_digest',
    referenceId: null,
    referenceType: 'agency_digest'
  });
  const sent = result?.sent !== false;
  return { ok: sent, reason: sent ? 'sent' : result?.reason || 'send_failed' };
}
