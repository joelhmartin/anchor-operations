import test from 'node:test';
import assert from 'node:assert/strict';
import ctm from '../connections/providers/ctm.js';

test('ctm connector emits tracking_number/form_reactor/webhook rows with NO PII', async () => {
  const fakeNumbers = async () => ([
    { id: 'num-1', formatted_number: '+1 (555) 867-5309', phone_number: '+15558675309', status: 'active' }
  ]);
  const fakeQuery = async (sql) => {
    if (/FROM ctm_forms/.test(sql)) return { rows: [{ id: 'form-1', name: 'Contact Us', autoresponder_enabled: true }] };
    if (/FROM call_logs/.test(sql)) return { rows: [{ last_at: '2026-06-27T10:00:00Z', calls_30d: 12 }] };
    return { rows: [] };
  };

  const rows = await ctm.discoverInventory({ clientUserId: 5, clients: { listTrackingNumbers: fakeNumbers, query: fakeQuery } });

  const num = rows.find((r) => r.object_type === 'tracking_number');
  assert.equal(num.external_id, 'num-1');
  assert.equal(num.name, null, 'PII-safe: phone number is never persisted as a name');
  assert.equal(num.status, 'active');

  const form = rows.find((r) => r.object_type === 'form_reactor');
  assert.equal(form.external_id, 'form-1');
  assert.deepEqual(form.metadata, { autoresponder_enabled: true });

  const webhook = rows.find((r) => r.object_type === 'webhook');
  assert.equal(webhook.status, 'active');
  assert.equal(webhook.metadata.calls_30d, 12);

  // Hard PII guard: no phone digits anywhere in the emitted inventory.
  const serialized = JSON.stringify(rows);
  assert.ok(!serialized.includes('5558675309'), 'no raw phone digits leaked');
  assert.ok(!serialized.includes('867-5309'), 'no formatted phone leaked');
});

test('ctm connector returns [] when there is no client', async () => {
  const rows = await ctm.discoverInventory({ clients: { listTrackingNumbers: async () => [], query: async () => ({ rows: [] }) } });
  assert.deepEqual(rows, []);
});
