import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverInventory, getMatchedSite } from '../connections/gsc/inventory.js';

const FAKE_SITES = [
  { siteUrl: 'sc-domain:example.com', permissionLevel: 'siteOwner' },
  { siteUrl: 'https://www.example.com/', permissionLevel: 'siteFullUser' }
];

test('discoverInventory returns ops_platform_inventory-shaped row for best match', async () => {
  const persisted = [];
  const rows = await discoverInventory({
    clientUserId: 'cuid-1',
    websiteUrl: 'https://www.example.com',
    token: 'fake-tok',
    _listSites: async () => FAKE_SITES,
    _persistInventory: async (r) => { persisted.push(...r); }
  });
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.client_user_id, 'cuid-1');
  assert.equal(row.connection_id, null);
  assert.equal(row.service_category, 'organic_search');
  assert.equal(row.provider, 'search_console');
  assert.equal(row.object_type, 'site');
  assert.equal(row.external_id, 'sc-domain:example.com');
  assert.equal(row.attributes_json.match_type, 'sc_domain');
  assert.ok(row.attributes_json.match_confidence >= 0.9);
  assert.equal(row.attributes_json.property_type, 'domain');
  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].external_id, 'sc-domain:example.com');
});

test('discoverInventory returns empty array when no property matches', async () => {
  const rows = await discoverInventory({
    clientUserId: 'cuid-2',
    websiteUrl: 'https://www.notfound.com',
    token: 'fake-tok',
    _listSites: async () => FAKE_SITES,
    _persistInventory: async () => {}
  });
  assert.equal(rows.length, 0);
});

test('discoverInventory surfaces listSites errors as empty (never throws)', async () => {
  const rows = await discoverInventory({
    clientUserId: 'cuid-3',
    websiteUrl: 'https://www.example.com',
    token: 'fake-tok',
    _listSites: async () => { throw new Error('GSC 403'); },
    _persistInventory: async () => {}
  });
  assert.equal(rows.length, 0);
});

test('getMatchedSite reads from db cache when row exists', async () => {
  const fakeRow = {
    site_url: 'sc-domain:example.com',
    match_type: 'sc_domain',
    match_confidence: 0.95,
    permission_level: 'siteOwner',
    property_type: 'domain'
  };
  const _query = async () => ({ rows: [fakeRow] });
  const r = await getMatchedSite('cuid-1', { _query });
  assert.equal(r.site_url, 'sc-domain:example.com');
  assert.equal(r.match_type, 'sc_domain');
});

test('getMatchedSite returns null when cache empty and no live discovery deps', async () => {
  const _query = async () => ({ rows: [] });
  const r = await getMatchedSite('cuid-1', { _query });
  assert.equal(r, null);
});

// DB round-trip (requires DATABASE_URL)
test('ops_gsc_site_inventory upsert and read back', async () => {
  const { query } = await import('../../../db.js');
  const uid = '00000000-0000-0000-0001-' + Math.floor(Math.random() * 0xffffffffffff).toString(16).padStart(12, '0');
  await query(
    `INSERT INTO ops_gsc_site_inventory
       (client_user_id, site_url, permission_level, property_type, match_type, match_confidence, website_url)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (client_user_id, site_url) DO UPDATE
       SET match_confidence = EXCLUDED.match_confidence`,
    [uid, 'sc-domain:roundtrip.com', 'siteOwner', 'domain', 'sc_domain', 0.95, 'https://roundtrip.com']
  );
  const { rows } = await query(
    `SELECT * FROM ops_gsc_site_inventory WHERE client_user_id = $1 AND site_url = $2`,
    [uid, 'sc-domain:roundtrip.com']
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].match_type, 'sc_domain');
  assert.ok(Number(rows[0].match_confidence) === 0.95);
  // cleanup
  await query(`DELETE FROM ops_gsc_site_inventory WHERE client_user_id = $1`, [uid]);
});
