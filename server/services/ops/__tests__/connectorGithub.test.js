import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyConnection, listCapabilities, discoverInventory } from '../connections/github/index.js';

function fakeFetch(json, { ok = true, status = 200 } = {}) {
  return async (_url, _opts) => ({
    ok,
    status,
    json: async () => json,
    text: async () => JSON.stringify(json)
  });
}

test('verifyConnection: valid token → verified', async () => {
  const fetch = fakeFetch({ id: 1, login: 'anchorcorps', name: 'Anchor Corps' });
  const r = await verifyConnection({ env: { GITHUB_TOKEN: 'ghp_test123' }, fetch });
  assert.equal(r.status, 'verified');
  assert.ok(r.detail.includes('@anchorcorps'), `detail: ${r.detail}`);
  assert.ok(Array.isArray(r.capabilities), 'capabilities should be an array');
  assert.ok(r.capabilities.includes('repo.list'), 'should include repo.list');
});

test('verifyConnection: with GITHUB_ORG set also checks org endpoint', async () => {
  const calls = [];
  const fetch = async (url, _opts) => {
    calls.push(url);
    return { ok: true, json: async () => ({ id: 1, login: 'anchorcorps', name: 'Anchor Corps' }) };
  };
  const r = await verifyConnection({ env: { GITHUB_TOKEN: 'ghp_test', GITHUB_ORG: 'anchorcorps' }, fetch });
  assert.equal(r.status, 'verified');
  assert.ok(calls.some((u) => u.includes('/orgs/anchorcorps/repos')), 'should call org repos endpoint');
});

test('verifyConnection: GITHUB_ORG set but org not accessible → failed', async () => {
  const fetch = async (url, _opts) => {
    if (url.includes('/orgs/')) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, json: async () => ({ id: 1, login: 'anchorcorps', name: 'Anchor Corps' }) };
  };
  const r = await verifyConnection({ env: { GITHUB_TOKEN: 'ghp_test', GITHUB_ORG: 'anchorcorps' }, fetch });
  assert.equal(r.status, 'failed');
  assert.ok(r.detail.includes('anchorcorps'), `detail: ${r.detail}`);
});

test('verifyConnection: missing token → missing (no fetch call)', async () => {
  let called = false;
  const fetch = async () => { called = true; return {}; };
  const r = await verifyConnection({ env: {}, fetch });
  assert.equal(r.status, 'missing');
  assert.equal(called, false);
});

test('verifyConnection: blank token → missing', async () => {
  const r = await verifyConnection({ env: { GITHUB_TOKEN: '  ' }, fetch: async () => ({}) });
  assert.equal(r.status, 'missing');
});

test('verifyConnection: 401 → failed', async () => {
  const fetch = fakeFetch({ message: 'Bad credentials' }, { ok: false, status: 401 });
  const r = await verifyConnection({ env: { GITHUB_TOKEN: 'bad' }, fetch });
  assert.equal(r.status, 'failed');
  assert.ok(r.detail.includes('401'));
});

test('listCapabilities: returns repo capability map', async () => {
  const caps = await listCapabilities({});
  assert.equal(caps['repo.list'], true);
  assert.equal(caps['repo.inspect'], true);
});

test('discoverInventory: maps repos to canonical inventory rows', async () => {
  const repos = [{
    id: 1001,
    full_name: 'anchorcorps/anchor-operations',
    default_branch: 'main',
    private: true,
    language: 'JavaScript',
    updated_at: '2026-06-28T00:00:00Z',
    html_url: 'https://github.com/anchorcorps/anchor-operations'
  }];
  const fetch = fakeFetch(repos);
  const rows = await discoverInventory({ env: { GITHUB_TOKEN: 'tok' }, fetch });
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.provider, 'github');
  assert.equal(r.serviceCategory, 'repo');
  assert.equal(r.object_type, 'repo');
  assert.equal(r.external_id, '1001');
  assert.equal(r.name, 'anchorcorps/anchor-operations');
  assert.equal(r.metadata.defaultBranch, 'main');
  assert.equal(r.metadata.private, true);
  assert.equal(r.metadata.language, 'JavaScript');
});

test('discoverInventory: uses org endpoint when GITHUB_ORG is set', async () => {
  let capturedUrl = null;
  const fetch = async (url, _opts) => {
    capturedUrl = url;
    return { ok: true, json: async () => [] };
  };
  await discoverInventory({ env: { GITHUB_TOKEN: 'tok', GITHUB_ORG: 'anchorcorps' }, fetch });
  assert.ok(
    capturedUrl.includes('/orgs/anchorcorps/repos'),
    `Expected org repos URL, got: ${capturedUrl}`
  );
});

test('discoverInventory: uses user repos endpoint when GITHUB_ORG is absent', async () => {
  let capturedUrl = null;
  const fetch = async (url, _opts) => {
    capturedUrl = url;
    return { ok: true, json: async () => [] };
  };
  await discoverInventory({ env: { GITHUB_TOKEN: 'tok' }, fetch });
  assert.ok(
    capturedUrl.includes('/user/repos'),
    `Expected user repos URL, got: ${capturedUrl}`
  );
});

test('discoverInventory: empty repos → empty array', async () => {
  const rows = await discoverInventory({ env: { GITHUB_TOKEN: 'tok' }, fetch: fakeFetch([]) });
  assert.deepEqual(rows, []);
});

test('connector self-registers on import', async () => {
  const { getConnector } = await import('../connections/registry.js');
  const c = getConnector('repo/github');
  assert.ok(c, 'repo/github not in registry');
  assert.equal(c.serviceCategory, 'repo');
  assert.equal(c.provider, 'github');
});
