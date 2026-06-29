import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { query } from '../../../db.js';
import { upsertInventory, listInventory } from '../connections/inventoryStore.js';

// Seed an ops_service_connections row to satisfy the FK on connection_id.
async function seedConnection(serviceCategory = 'hosting', provider = 'kinsta') {
  const clientUserId = randomUUID();
  const { rows: [row] } = await query(
    `INSERT INTO ops_service_connections (client_user_id, service_category, provider)
     VALUES ($1, $2, $3) RETURNING id`,
    [clientUserId, serviceCategory, provider]
  );
  return { connectionId: row.id, clientUserId };
}

test('inventory store: insert → re-upsert is idempotent, refreshes fields', async () => {
  const { connectionId, clientUserId } = await seedConnection();
  const scope = { connectionId, clientUserId, serviceCategory: 'hosting', provider: 'kinsta' };

  const first = await upsertInventory(scope, [
    { object_type: 'site', external_id: 'site-1', name: 'Acme', status: 'active', parent_external_id: null, url: 'https://acme.com', metadata: { company: 'co1' } },
    { object_type: 'environment', external_id: 'env-1', name: 'Live', status: 'live', parent_external_id: 'site-1', url: null, metadata: {} }
  ]);
  assert.equal(first.written, 2);

  // Re-run with one changed field — must update in place, not duplicate.
  const second = await upsertInventory(scope, [
    { object_type: 'site', external_id: 'site-1', name: 'Acme Renamed', status: 'active', parent_external_id: null, url: 'https://acme.com', metadata: { company: 'co1' } }
  ]);
  assert.equal(second.written, 1);

  const rows = await listInventory(connectionId);
  assert.equal(rows.length, 2, 'still two rows — upsert did not duplicate');
  const site = rows.find((r) => r.object_type === 'site');
  assert.equal(site.name, 'Acme Renamed', 'name was updated in place');
  assert.deepEqual(site.metadata, { company: 'co1' });
  const env = rows.find((r) => r.object_type === 'environment');
  assert.equal(env.parent_external_id, 'site-1');
});

test('upsertInventory rejects a scope with no connectionId', async () => {
  await assert.rejects(() => upsertInventory({ serviceCategory: 'hosting', provider: 'kinsta' }, []), /connectionId required/);
});
