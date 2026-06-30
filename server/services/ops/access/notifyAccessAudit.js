/**
 * Post the latest Access Audit summary to Google Chat via the default webhook.
 * Ties the Access Audit slice to the F5 webhook sender — the first real
 * "agent posts to Chat from the app" path.
 *
 * Webhook URL comes from process.env.GOOGLE_CHAT_WEBHOOK_DEFAULT (mounted from
 * Secret Manager `google-chat-webhook-default`). Never logged.
 */
import { getLatestAuditRun } from './auditStore.js';
import { sendWebhookMessage } from '../notifications/googleChatWebhook.js';

export function formatAuditMessage(audit) {
  const details = audit?.details_json || audit?.details || {};
  const cov = details.clientCoverage || { total: 0, services: {} };
  const env = audit?.environment || details.runtime?.environment || 'unknown';
  const lines = [
    '*Anchor Ops — Access Audit*',
    `Overall: ${audit?.status || 'unknown'} · environment: ${env}`
  ];
  if (cov.total) {
    lines.push('', `*Client access coverage (${cov.total} clients):*`);
    for (const [k, v] of Object.entries(cov.services)) {
      lines.push(`• ${k.replace(/_/g, ' ')}: ${v.connected}/${v.total}`);
    }
  }
  return lines.join('\n');
}

export async function notifyAccessAuditToChat({
  webhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_DEFAULT,
  getAudit = getLatestAuditRun,
  send = sendWebhookMessage
} = {}) {
  if (!webhookUrl) return { ok: false, reason: 'no_webhook_configured' };
  const audit = await getAudit();
  if (!audit) return { ok: false, reason: 'no_audit_yet' };

  await send({
    webhookUrl,
    text: formatAuditMessage(audit),
    clientUserId: null,
    eventType: 'access_audit_summary',
    referenceId: audit.id || null,
    referenceType: 'access_audit_run'
  });
  return { ok: true, reason: 'sent' };
}
