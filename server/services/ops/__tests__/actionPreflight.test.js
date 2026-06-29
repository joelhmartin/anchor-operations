import test from 'node:test';
import assert from 'node:assert/strict';
import { runPreflight } from '../actions/preflight.js';

test('happy path returns current state + blast radius', async () => {
  const connector = { actions: { preflight: async (type, args) => ({ currentState: { cache: 'warm' }, assetsAffected: 3, warnings: ['site is live'] }) } };
  const r = await runPreflight({ providerActionType: 'hosting.kinsta.clear_cache', actionArgs: { scope: 'full' }, connector });
  assert.equal(r.ok, true);
  assert.deepEqual(r.currentState, { cache: 'warm' });
  assert.equal(r.blastRadius, 3);
  assert.deepEqual(r.warnings, ['site is live']);
});

test('missing assetsAffected defaults blast radius to 1', async () => {
  const connector = { actions: { preflight: async () => ({ currentState: {} }) } };
  const r = await runPreflight({ providerActionType: 'x', connector });
  assert.equal(r.blastRadius, 1);
});

test('connector without actions.preflight → not ok, never throws', async () => {
  const r = await runPreflight({ providerActionType: 'x', connector: {} });
  assert.equal(r.ok, false);
  assert.match(r.error, /preflight/i);
});

test('a throwing preflight degrades to error', async () => {
  const connector = { actions: { preflight: async () => { throw new Error('api down'); } } };
  const r = await runPreflight({ providerActionType: 'x', connector });
  assert.equal(r.ok, false);
  assert.match(r.error, /api down/);
});
