import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyConnection, listCapabilities, discoverInventory } from '../connections/vercel/index.js';

function fakeFetch(json, { ok = true, status = 200 } = {}) {
  return async (_url, _opts) => ({
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json)
  });
}

test('verifyConnection: valid token → verified', async () => {
  const fetch = fakeFetch({ user: { name: 'Anchor Corps', username: 'anchorcorps' } });
  const r = await verifyConnection({ env: { VERCEL_API_TOKEN: 'tok_abc' }, fetch });
  assert.equal(r.status, 'verified');
  assert.ok(r.detail.includes('Anchor Corps'), `detail: ${r.detail}`);
  assert.ok(Array.isArray(r.capabilities), 'capabilities should be an array');
  assert.ok(r.capabilities.includes('project.list'));
  assert.ok(r.capabilities.includes('deployment.list'));
});

test('verifyConnection: missing token → missing (no fetch call)', async () => {
  let called = false;
  const fetch = async () => { called = true; return {}; };
  const r = await verifyConnection({ env: {}, fetch });
  assert.equal(r.status, 'missing');
  assert.equal(called, false);
});

test('verifyConnection: blank token → missing', async () => {
  const r = await verifyConnection({ env: { VERCEL_API_TOKEN: '   ' }, fetch: async () => ({}) });
  assert.equal(r.status, 'missing');
});

test('verifyConnection: 403 → failed', async () => {
  const fetch = fakeFetch({ error: { code: 'forbidden', message: 'Forbidden' } }, { ok: false, status: 403 });
  const r = await verifyConnection({ env: { VERCEL_API_TOKEN: 'bad' }, fetch });
  assert.equal(r.status, 'failed');
  assert.ok(r.detail.includes('403'));
});

test('verifyConnection: appends teamId param when VERCEL_TEAM_ID is set', async () => {
  let capturedUrl = null;
  const fetch = async (url, _opts) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ user: { name: 'T', username: 't' } }) };
  };
  await verifyConnection({ env: { VERCEL_API_TOKEN: 'tok', VERCEL_TEAM_ID: 'team_xyz' }, fetch });
  assert.ok(capturedUrl.includes('teamId=team_xyz'), `Expected teamId in URL, got: ${capturedUrl}`);
});

test('listCapabilities: returns deployment capability map', async () => {
  const caps = await listCapabilities({});
  assert.equal(caps['project.list'], true);
  assert.equal(caps['deployment.list'], true);
  assert.equal(caps['deployment.inspect'], true);
});

test('discoverInventory: maps projects to canonical inventory rows', async () => {
  const projects = [{
    id: 'prj_abc123',
    name: 'anchor-hub',
    framework: 'nextjs',
    latestDeployments: [{ url: 'anchor-hub-abc.vercel.app' }],
    targets: { production: { alias: ['anchorcorps.com'] } },
    updatedAt: 1750000000000
  }];
  const fetch = fakeFetch({ projects });
  const rows = await discoverInventory({ env: { VERCEL_API_TOKEN: 'tok' }, fetch });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, 'vercel');
  assert.equal(r.serviceCategory, 'deployment');
  assert.equal(r.object_type, 'project');
  assert.equal(r.external_id, 'prj_abc123');
  assert.equal(r.name, 'anchor-hub');
  assert.equal(r.metadata.framework, 'nextjs');
  assert.equal(r.metadata.latestDeploymentUrl, 'anchor-hub-abc.vercel.app');
  assert.equal(r.metadata.productionUrl, 'anchorcorps.com');
});

test('discoverInventory: projects with no latestDeployments or targets → null meta', async () => {
  const projects = [{ id: 'prj_bare', name: 'bare-project', updatedAt: 0 }];
  const fetch = fakeFetch({ projects });
  const rows = await discoverInventory({ env: { VERCEL_API_TOKEN: 'tok' }, fetch });
  assert.equal(rows[0].metadata.latestDeploymentUrl, null);
  assert.equal(rows[0].metadata.productionUrl, null);
  assert.equal(rows[0].metadata.framework, null);
});

test('discoverInventory: empty projects → empty array', async () => {
  const rows = await discoverInventory({ env: { VERCEL_API_TOKEN: 'tok' }, fetch: fakeFetch({ projects: [] }) });
  assert.deepEqual(rows, []);
});

test('connector self-registers on import', async () => {
  const { getConnector } = await import('../connections/registry.js');
  const c = getConnector('deployment/vercel');
  assert.ok(c, 'deployment/vercel not in registry');
  assert.equal(c.serviceCategory, 'deployment');
  assert.equal(c.provider, 'vercel');
});
