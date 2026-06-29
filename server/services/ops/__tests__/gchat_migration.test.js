import test from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../../../db.js';

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
