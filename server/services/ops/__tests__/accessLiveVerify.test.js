import test from 'node:test';
import assert from 'node:assert/strict';
import { checkKinsta, runLiveVerifiers } from '../access/liveVerify.js';

test('checkKinsta: no key → missing (no network)', async () => {
  const r = await checkKinsta({});
  assert.equal(r.status, 'missing');
});

test('checkKinsta: key without agency id → degraded (no network)', async () => {
  const r = await checkKinsta({ KINSTA_API_KEY: 'x' });
  assert.equal(r.status, 'degraded');
});

test('runLiveVerifiers: a throwing verifier degrades to failed, never throws', async () => {
  const out = await runLiveVerifiers({}, { boom: async () => { throw new Error('nope'); } });
  assert.equal(out.boom.status, 'failed');
});

test('runLiveVerifiers default includes kinsta and returns missing offline', async () => {
  const out = await runLiveVerifiers({});
  assert.equal(out.kinsta.status, 'missing');
});
