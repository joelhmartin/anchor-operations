import test from 'node:test';
import assert from 'node:assert/strict';
import { sendCriticalAlert } from '../notifications/notificationRouter.js';
import { notifyCriticalFindings } from '../notifications/criticalAlerts.js';

const fakeFinding = { id: 'fnd-1', severity: 'critical', category: 'ctm.x', summary: 'Booking flow down', business_impact: null };
const fakeClient = { display_name: 'ACME Corp' };

function findingQueryFn() {
  return async (sql) => {
    if (sql.includes('ops_findings')) return { rows: [fakeFinding] };
    if (sql.includes('users')) return { rows: [fakeClient] };
    return { rows: [] };
  };
}

test('sendCriticalAlert: falls back to agency default webhook when per-client is null', async () => {
  let sentArgs = null;
  const result = await sendCriticalAlert(
    { clientUserId: 'client-1', findingId: 'fnd-1' },
    {
      resolveWebhookUrl: async () => null,
      defaultWebhookUrl: 'https://chat.example.com/agency-hook',
      sendFn: async (args) => { sentArgs = args; return { sent: true }; },
      queryFn: findingQueryFn()
    }
  );
  assert.equal(result.sent, true);
  assert.ok(sentArgs, 'sender was called via agency fallback');
  assert.equal(sentArgs.eventType, 'critical_alert');
  assert.equal(sentArgs.referenceType, 'finding');
  assert.equal(sentArgs.referenceId, 'fnd-1');
});

test('sendCriticalAlert: prefers the per-client webhook when present', async () => {
  let sawUrl = null;
  await sendCriticalAlert(
    { clientUserId: 'client-1', findingId: 'fnd-1' },
    {
      resolveWebhookUrl: async () => 'https://chat.example.com/client-hook',
      defaultWebhookUrl: 'https://chat.example.com/agency-hook',
      sendFn: async (args) => { sawUrl = args.webhookUrl; return { sent: true }; },
      queryFn: findingQueryFn()
    }
  );
  assert.equal(sawUrl, 'https://chat.example.com/client-hook');
});

test('sendCriticalAlert: skips when both per-client and agency webhook are absent', async () => {
  const result = await sendCriticalAlert(
    { clientUserId: 'client-1', findingId: 'fnd-1' },
    {
      resolveWebhookUrl: async () => null,
      defaultWebhookUrl: undefined,
      queryFn: findingQueryFn()
    }
  );
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no_webhook_url');
});

test('notifyCriticalFindings: sends one alert per un-alerted critical finding', async () => {
  const sent = [];
  const queryFn = async (sql, params) => {
    if (sql.includes('ops_runs')) return { rows: [{ id: 'run-1', client_user_id: 'client-1' }] };
    if (sql.includes('ops_findings')) return { rows: [{ id: 'f1' }, { id: 'f2' }] };
    if (sql.includes('ops_notification_events')) return { rows: [] }; // none alerted yet
    return { rows: [] };
  };
  const result = await notifyCriticalFindings(
    { runId: 'run-1' },
    { queryFn, sendFn: async ({ findingId }) => { sent.push(findingId); return { sent: true }; } }
  );
  assert.deepEqual(sent, ['f1', 'f2']);
  assert.deepEqual(result, { sent: 2, skipped: 0, total: 2 });
});

test('notifyCriticalFindings: skips findings already in ops_notification_events', async () => {
  const sent = [];
  const queryFn = async (sql, params) => {
    if (sql.includes('ops_runs')) return { rows: [{ id: 'run-1', client_user_id: 'client-1' }] };
    if (sql.includes('ops_findings')) return { rows: [{ id: 'f1' }, { id: 'f2' }] };
    if (sql.includes('ops_notification_events')) {
      return { rows: params[0] === 'f1' ? [{ '?column?': 1 }] : [] };
    }
    return { rows: [] };
  };
  const result = await notifyCriticalFindings(
    { runId: 'run-1' },
    { queryFn, sendFn: async ({ findingId }) => { sent.push(findingId); return { sent: true }; } }
  );
  assert.deepEqual(sent, ['f2'], 'only the un-alerted finding is sent');
  assert.deepEqual(result, { sent: 1, skipped: 1, total: 2 });
});

test('notifyCriticalFindings: a send failure for one finding does not stop the others', async () => {
  const sent = [];
  const queryFn = async (sql) => {
    if (sql.includes('ops_runs')) return { rows: [{ id: 'run-1', client_user_id: 'client-1' }] };
    if (sql.includes('ops_findings')) return { rows: [{ id: 'f1' }, { id: 'f2' }, { id: 'f3' }] };
    if (sql.includes('ops_notification_events')) return { rows: [] };
    return { rows: [] };
  };
  const result = await notifyCriticalFindings(
    { runId: 'run-1' },
    {
      queryFn,
      sendFn: async ({ findingId }) => {
        if (findingId === 'f2') throw new Error('chat 500');
        sent.push(findingId);
        return { sent: true };
      }
    }
  );
  assert.deepEqual(sent, ['f1', 'f3'], 'f1 and f3 still sent despite f2 throwing');
  assert.deepEqual(result, { sent: 2, skipped: 1, total: 3 });
});
