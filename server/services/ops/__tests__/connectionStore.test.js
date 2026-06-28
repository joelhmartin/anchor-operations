import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  upsertConnection, setConnectionStatus, getConnection, listConnectionsForClient,
  canTransitionStatus, STATUS_LIFECYCLE
} from '../connections/connectionStore.js';

test('canTransitionStatus enforces the locked lifecycle (pure)', () => {
  assert.equal(canTransitionStatus('missing', 'configured'), true);
  assert.equal(canTransitionStatus('configured', 'verified'), true);
  assert.equal(canTransitionStatus('verified', 'degraded'), true);
  assert.equal(canTransitionStatus('degraded', 'failed'), true);
  assert.equal(canTransitionStatus('failed', 'disabled'), true);
  assert.equal(canTransitionStatus('verified', 'verified'), true); // self-transition ok
  assert.equal(canTransitionStatus(null, 'configured'), true);     // first set ok
  assert.equal(canTransitionStatus('missing', 'verified'), false); // cannot skip configured
  assert.ok(STATUS_LIFECYCLE.verified.includes('degraded'));
});

test('upsert → status transition → list round-trips (DB)', async () => {
  const clientUserId = randomUUID();
  const created = await upsertConnection({
    clientUserId,
    serviceCategory: 'cms',
    provider: 'wordpress',
    connectionType: 'ssh',
    status: 'configured',
    capabilities: ['read'],
    detail: 'seeded'
  });
  assert.ok(created.id);
  assert.equal(created.status, 'configured');
  assert.deepEqual(created.capabilities, ['read']);

  const verified = await setConnectionStatus(created.id, 'verified', {
    detail: 'ping ok',
    capabilities: ['read', 'run_wp_cli'],
    lastVerifiedAt: new Date()
  });
  assert.equal(verified.status, 'verified');
  assert.deepEqual(verified.capabilities, ['read', 'run_wp_cli']);
  assert.ok(verified.last_verified_at);

  const fetched = await getConnection(clientUserId, 'cms', 'wordpress');
  assert.equal(fetched.id, created.id);

  const list = await listConnectionsForClient(clientUserId);
  assert.equal(list.length, 1);
  assert.deepEqual(list[0].capabilities, ['read', 'run_wp_cli']);
});

test('upsert is idempotent on (client, category, provider) (DB)', async () => {
  const clientUserId = randomUUID();
  const a = await upsertConnection({ clientUserId, serviceCategory: 'paid_ads', provider: 'meta', status: 'configured' });
  const b = await upsertConnection({ clientUserId, serviceCategory: 'paid_ads', provider: 'meta', status: 'configured', detail: 'again' });
  assert.equal(a.id, b.id, 'same row updated, not duplicated');
  assert.equal(b.detail, 'again');
});

test('setConnectionStatus rejects an illegal transition (DB)', async () => {
  const clientUserId = randomUUID();
  const c = await upsertConnection({ clientUserId, serviceCategory: 'hosting', provider: 'kinsta', status: 'missing' });
  await assert.rejects(
    () => setConnectionStatus(c.id, 'verified', {}), // missing → verified is illegal
    /illegal status transition/i
  );
});

test('upsert rejects illegal status transition on existing row (DB)', async () => {
  const clientUserId = randomUUID();
  await upsertConnection({ clientUserId, serviceCategory: 'cms', provider: 'wordpress', status: 'missing' });
  await assert.rejects(
    () => upsertConnection({ clientUserId, serviceCategory: 'cms', provider: 'wordpress', status: 'verified' }),
    /illegal status transition/i
  );
});
