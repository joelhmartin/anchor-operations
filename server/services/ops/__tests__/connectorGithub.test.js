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
  assert.equal(r.capabilities['repo.list'], true);
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

test('discoverInventory: maps repos to inventory rows', async () => {
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
  assert.equal(r.externalId, '1001');
  assert.equal(r.name, 'anchorcorps/anchor-operations');
  assert.equal(r.meta.defaultBranch, 'main');
  assert.equal(r.meta.private, true);
  assert.equal(r.meta.language, 'JavaScript');
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
