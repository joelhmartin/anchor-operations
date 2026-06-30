/**
 * resolveClientWebsiteUrl — regression tests.
 *
 * V4 bug: the resolver joined `kinsta_sites ks` and selected `ks.primary_domain`,
 * but that column lives on `kinsta_environments`, not `kinsta_sites`. The query
 * therefore threw "column ks.primary_domain does not exist" at runtime, which
 * propagated out of every website check (uptime/ssl/tracking/psi/schema/semrush)
 * and recorded them all as `error` instead of running. These tests pin the SQL
 * to the correct table and verify scheme normalization + fallback behavior.
 *
 * Pure unit tests (no DB I/O) — a fake `query` captures the SQL.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveClientWebsiteUrl } from '../checks/website/_lib/httpFetch.js';

function fakeQuery(rows) {
  const calls = [];
  const fn = async (sql, params) => {
    calls.push({ sql, params });
    return { rows };
  };
  fn.calls = calls;
  return fn;
}

test('sources primary_domain from kinsta_environments, not kinsta_sites', async () => {
  const query = fakeQuery([{ website_url: 'acme.com' }]);
  await resolveClientWebsiteUrl(query, 'client-1');
  const { sql } = query.calls[0];
  assert.match(sql, /kinsta_environments/, 'must read primary_domain from kinsta_environments');
  assert.match(sql, /is_live\s*=\s*TRUE/i, 'must filter to the live environment (never a staging domain)');
  assert.doesNotMatch(
    sql,
    /\bks\.primary_domain\b/,
    'must NOT reference ks.primary_domain (column does not exist on kinsta_sites)'
  );
});

test('normalizes a bare domain to https://', async () => {
  const query = fakeQuery([{ website_url: 'acme.com' }]);
  const url = await resolveClientWebsiteUrl(query, 'client-1');
  assert.equal(url, 'https://acme.com');
});

test('preserves an explicit scheme', async () => {
  const query = fakeQuery([{ website_url: 'http://acme.com' }]);
  const url = await resolveClientWebsiteUrl(query, 'client-1');
  assert.equal(url, 'http://acme.com');
});

test('returns null when no URL configured', async () => {
  const query = fakeQuery([{ website_url: null }]);
  const url = await resolveClientWebsiteUrl(query, 'client-1');
  assert.equal(url, null);
});

test('passes the client id as the sole bound param', async () => {
  const query = fakeQuery([{ website_url: 'acme.com' }]);
  await resolveClientWebsiteUrl(query, 'client-xyz');
  assert.deepEqual(query.calls[0].params, ['client-xyz']);
});
