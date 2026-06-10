import test from 'node:test';
import assert from 'node:assert/strict';

test('ctm.form_flow is registered', async () => {
  const { getCheck } = await import('../checks/registry.js');
  await import('../checks/ctm/formFlow.js');
  const reg = getCheck('ctm.form_flow');
  assert.ok(reg);
  assert.equal(reg.umbrella, 'ctm');
  assert.equal(reg.tier, 'daily_essential');
});
