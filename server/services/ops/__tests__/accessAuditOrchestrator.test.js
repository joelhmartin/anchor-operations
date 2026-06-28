import test from 'node:test';
import assert from 'node:assert/strict';
import { runAccessAudit } from '../access/accessAudit.js';

function fakeStore() {
  const state = {};
  return {
    state,
    createAuditRun: async () => { state.id = 'aud-1'; return { id: 'aud-1', status: 'running' }; },
    finishAuditRun: async (id, payload) => { state.finished = { id, ...payload }; return { id, ...payload }; }
  };
}

test('runAccessAudit assembles, classifies, and persists a finished row', async () => {
  const store = fakeStore();
  const out = await runAccessAudit({
    env: { ENCRYPTION_KEY: 'k', JWT_SECRET: 'j', DATABASE_URL: 'postgresql://bif@localhost:5432/anchor', GOOGLE_CLOUD_PROJECT: 'p' },
    detectRuntime: async () => ({ environment: 'local', projectId: 'p', serviceAccount: null, cloudRunService: null }),
    checkOpsTables: async () => ({ status: 'verified', present: ['ops_runs'], missing: [] }),
    probeReadWrite: async () => ({ status: 'verified', detail: 'ok' }),
    pubsubClient: null, // no live listing → pubsub skipped
    createAuditRun: store.createAuditRun,
    finishAuditRun: store.finishAuditRun
  });

  // overall status reflects rollup (missing ad/meta creds → at least degraded)
  assert.ok(['degraded', 'failed'].includes(out.status));
  assert.equal(store.state.finished.environment, 'local');
  // database service classified green
  assert.equal(out.details.services.database.color, 'green');
  // pubsub skipped → gray, recorded as a warning
  assert.equal(out.details.services.pubsub.color, 'gray');
  assert.ok(out.warnings.some((w) => /pubsub/i.test(w)));
  // missing creds surfaced as "service: VAR"
  assert.ok(out.missing.some((m) => /meta: FACEBOOK_SYSTEM_USER_TOKEN/i.test(m)));
  // value-leak guard
  assert.ok(!JSON.stringify(out).includes('postgresql://bif'));
});

test('a checker that throws becomes a failed service, not a thrown audit', async () => {
  const store = fakeStore();
  const out = await runAccessAudit({
    env: { ENCRYPTION_KEY: 'k', JWT_SECRET: 'j', DATABASE_URL: 'x', GOOGLE_CLOUD_PROJECT: 'p' },
    detectRuntime: async () => ({ environment: 'unknown', projectId: 'p', serviceAccount: null, cloudRunService: null }),
    checkOpsTables: async () => { throw new Error('db down'); },
    probeReadWrite: async () => ({ status: 'failed', detail: 'db down' }),
    pubsubClient: null,
    createAuditRun: store.createAuditRun,
    finishAuditRun: store.finishAuditRun
  });
  assert.equal(out.status, 'failed');
  assert.equal(out.details.services.database.color, 'red');
});
