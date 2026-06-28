import test from 'node:test';
import assert from 'node:assert/strict';
import { checkPubSubTopics, listTopicShortNames } from '../access/pubsubAccess.js';

test('all expected topics present → verified', () => {
  const r = checkPubSubTopics({ actual: ['ops.run.requested', 'ops.run.cancel', 'extra'], expected: ['ops.run.requested', 'ops.run.cancel'] });
  assert.equal(r.status, 'verified');
  assert.deepEqual(r.missing, []);
});

test('some expected topics missing → degraded', () => {
  const r = checkPubSubTopics({ actual: ['ops.run.requested'], expected: ['ops.run.requested', 'ops.run.cancel'] });
  assert.equal(r.status, 'degraded');
  assert.deepEqual(r.missing, ['ops.run.cancel']);
});

test('null actual (no client) → skipped', () => {
  const r = checkPubSubTopics({ actual: null, expected: ['ops.run.requested'] });
  assert.equal(r.status, 'skipped');
});

test('listTopicShortNames maps full resource paths to short names', async () => {
  const fakeClient = { getTopics: async () => [[{ name: 'projects/p/topics/ops.run.requested' }, { name: 'projects/p/topics/ops.run.cancel' }]] };
  assert.deepEqual(await listTopicShortNames(fakeClient), ['ops.run.requested', 'ops.run.cancel']);
});
