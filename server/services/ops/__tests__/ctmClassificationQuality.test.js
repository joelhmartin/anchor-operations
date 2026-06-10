import test from 'node:test';
import assert from 'node:assert/strict';

test('ctm.classification_quality is registered', async () => {
  const { getCheck } = await import('../checks/registry.js');
  await import('../checks/ctm/classificationQuality.js');
  const reg = getCheck('ctm.classification_quality');
  assert.ok(reg);
  assert.equal(reg.umbrella, 'ctm');
  assert.equal(reg.tier, 'daily_essential');
});
