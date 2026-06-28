import test from 'node:test';
import assert from 'node:assert/strict';
import { createAuditRun, finishAuditRun, getLatestAuditRun } from '../access/auditStore.js';
import { checkOpsTables, probeReadWrite, REQUIRED_OPS_TABLES } from '../access/databaseAccess.js';

test('audit store: create → finish → latest round-trips', async () => {
  const created = await createAuditRun();
  assert.ok(created.id, 'created row has an id');
  assert.equal(created.status, 'running');

  const finished = await finishAuditRun(created.id, {
    status: 'degraded',
    environment: 'local',
    serviceAccount: 'sa@example.iam.gserviceaccount.com',
    projectId: 'anchor-hub-480305',
    summary: { green: 2, yellow: 1, red: 0 },
    details: { core: { status: 'verified' } },
    missing: ['META: FACEBOOK_SYSTEM_USER_TOKEN'],
    warnings: ['pubsub list skipped (no client)']
  });
  assert.equal(finished.status, 'degraded');
  assert.equal(finished.project_id, 'anchor-hub-480305');
  assert.deepEqual(finished.missing_json, ['META: FACEBOOK_SYSTEM_USER_TOKEN']);
  assert.ok(finished.finished_at, 'finished_at is set');

  const latest = await getLatestAuditRun();
  assert.equal(latest.id, created.id, 'latest returns the row we just finished');
});

test('checkOpsTables reports the audit table as present after migration', async () => {
  const r = await checkOpsTables();
  assert.ok(REQUIRED_OPS_TABLES.includes('ops_access_audit_runs'));
  assert.ok(r.present.includes('ops_access_audit_runs'), 'migrated table is detected');
  assert.equal(r.status === 'verified' || r.status === 'degraded', true);
});

test('checkOpsTables flags a bogus required table as missing', async () => {
  const r = await checkOpsTables(undefined, ['ops_runs', 'definitely_not_a_table_xyz']);
  assert.equal(r.status, 'degraded');
  assert.deepEqual(r.missing, ['definitely_not_a_table_xyz']);
});

test('checkOpsTables degrades to failed when the query throws', async () => {
  const boom = async () => { throw new Error('connection refused'); };
  const r = await checkOpsTables(boom, ['ops_runs']);
  assert.equal(r.status, 'failed');
});

test('probeReadWrite returns verified against the live db', async () => {
  const r = await probeReadWrite();
  assert.equal(r.status, 'verified');
});
