import test from 'node:test';
import assert from 'node:assert/strict';
import { detectRuntime } from '../access/runtimeIdentity.js';

test('cloud-run environment resolves SA + project from metadata', async () => {
  const fetchMetadata = async (path) => {
    if (path === 'project/project-id') return 'anchor-hub-480305';
    if (path === 'instance/service-accounts/default/email') return 'ops@anchor-hub-480305.iam.gserviceaccount.com';
    return null;
  };
  const out = await detectRuntime({ env: { K_SERVICE: 'anchor-ops', GOOGLE_CLOUD_PROJECT: '' }, fetchMetadata });
  assert.equal(out.environment, 'cloud-run');
  assert.equal(out.cloudRunService, 'anchor-ops');
  assert.equal(out.projectId, 'anchor-hub-480305');
  assert.equal(out.serviceAccount, 'ops@anchor-hub-480305.iam.gserviceaccount.com');
});

test('local environment: no metadata call, project from env', async () => {
  let called = false;
  const fetchMetadata = async () => { called = true; return null; };
  const out = await detectRuntime({
    env: { DATABASE_URL: 'postgresql://bif@localhost:5432/anchor', GOOGLE_CLOUD_PROJECT: 'anchor-hub-480305' },
    fetchMetadata
  });
  assert.equal(out.environment, 'local');
  assert.equal(out.projectId, 'anchor-hub-480305');
  assert.equal(out.serviceAccount, null);
  assert.equal(called, false, 'metadata server is not queried off Cloud Run');
});

test('unknown environment when neither K_SERVICE nor local DB', async () => {
  const out = await detectRuntime({ env: { DATABASE_URL: 'postgresql://u@prod-host:5432/db' }, fetchMetadata: async () => null });
  assert.equal(out.environment, 'unknown');
});
