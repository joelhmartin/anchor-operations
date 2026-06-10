import test from 'node:test';
import assert from 'node:assert/strict';

test('ctm.tracking_number_health is registered', async () => {
  const { getCheck } = await import('../checks/registry.js');
  await import('../checks/ctm/trackingNumberHealth.js');
  const reg = getCheck('ctm.tracking_number_health');
  assert.ok(reg);
  assert.equal(reg.umbrella, 'ctm');
  assert.equal(reg.tier, 'daily_essential');
});

test('ctm.tracking_number_health handler is callable', async () => {
  const { handler } = await import('../checks/ctm/trackingNumberHealth.js');
  assert.equal(typeof handler, 'function');
});
