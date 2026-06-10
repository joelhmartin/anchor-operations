import test from 'node:test';
import assert from 'node:assert/strict';

test('ctm.webhook_sync is registered', async () => {
  const { getCheck } = await import('../checks/registry.js');
  await import('../checks/ctm/webhookSync.js');
  const reg = getCheck('ctm.webhook_sync');
  assert.ok(reg);
  assert.equal(reg.umbrella, 'ctm');
  assert.equal(reg.tier, 'daily_essential');
});
