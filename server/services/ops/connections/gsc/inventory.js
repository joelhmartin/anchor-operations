/**
 * GSC inventory discovery (north-star §6.4 / spec §5 discoverInventory).
 *
 * discoverInventory: lists all site properties the service account can see,
 * matches the best one to the client's website URL, persists the match to
 * ops_gsc_site_inventory, and returns rows conforming to the F1
 * ops_platform_inventory shape.
 *
 * getMatchedSite: reads the cached match; falls back to live discovery when
 * a token + _listSites are provided.
 */
import { query as defaultQuery } from '../../../../db.js';
import { matchProperty, propertyType } from './propertyMatcher.js';
import { resolveClientWebsiteUrl } from '../../checks/website/_lib/httpFetch.js';

const SITES_ENDPOINT = 'https://www.googleapis.com/webmasters/v3/sites';

/**
 * List all GSC site properties accessible to the given Bearer token.
 * Returns [] on any error (caller decides how to surface).
 */
export async function listSites(token, { signal, _fetch = globalThis.fetch } = {}) {
  const res = await _fetch(SITES_ENDPOINT, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    ...(signal ? { signal } : {})
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw Object.assign(new Error(`GSC sites.list ${res.status}`), { status: res.status, body: body.slice(0, 400) });
  }
  const json = await res.json();
  return (json.siteEntry || []);
}

/**
 * Default persistence: upsert into ops_gsc_site_inventory.
 * Injected as _persistInventory in tests.
 */
async function persistInventoryDefault(rows, queryFn) {
  for (const row of rows) {
    const a = row.metadata;
    await queryFn(
      `INSERT INTO ops_gsc_site_inventory
         (client_user_id, site_url, permission_level, property_type,
          match_type, match_confidence, website_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (client_user_id, site_url) DO UPDATE
         SET permission_level   = EXCLUDED.permission_level,
             match_type         = EXCLUDED.match_type,
             match_confidence   = EXCLUDED.match_confidence,
             website_url        = EXCLUDED.website_url,
             discovered_at      = now()`,
      [
        row.client_user_id,
        row.external_id,
        a.permission_level,
        a.property_type,
        a.match_type,
        a.match_confidence,
        a.website_url
      ]
    );
  }
}

/**
 * Discover and persist the GSC property that best matches the client website.
 *
 * @param {object} opts
 * @param {string} opts.clientUserId
 * @param {string} opts.websiteUrl       - e.g. 'https://www.example.com'
 * @param {string} opts.token            - Bearer token
 * @param {string|null} [opts.exactConfig] - Overrides matching (client-configured sc_site_url)
 * @param {function} [opts._listSites]   - Injectable: async (token) => site[]
 * @param {function} [opts._persistInventory] - Injectable: async (rows) => void
 * @param {function} [opts._query]       - Injectable query fn for persistence
 * @returns {Promise<Array>} ops_platform_inventory-shaped rows (0 or 1 entry)
 */
export async function discoverInventory({
  clientUserId,
  websiteUrl,
  token,
  exactConfig = null,
  _listSites = listSites,
  _persistInventory = null,
  _query = defaultQuery
} = {}) {
  let sites;
  try {
    sites = await _listSites(token);
  } catch {
    return [];
  }

  const match = matchProperty(websiteUrl, sites, exactConfig);
  if (match.matchType === 'manual' || !match.siteUrl) return [];

  const ptype = propertyType(match.siteUrl);
  const row = {
    client_user_id: clientUserId,
    connection_id: null,                  // F1 will backfill via ops_service_connections
    service_category: 'organic_search',
    provider: 'search_console',
    object_type: 'site',
    external_id: match.siteUrl,
    name: match.siteUrl,
    metadata: {
      permission_level:  match.permissionLevel,
      property_type:     ptype,
      match_type:        match.matchType,
      match_confidence:  match.confidence,
      website_url:       websiteUrl
    }
  };

  const persistFn = _persistInventory || ((rows) => persistInventoryDefault(rows, _query));
  await persistFn([row]).catch(() => {});   // persistence failure is non-fatal

  return [row];
}

/**
 * Return the cached matched site for a client from ops_gsc_site_inventory.
 * Falls back to live discovery when token + _listSites are provided and cache
 * is empty.
 */
export async function getMatchedSite(clientUserId, {
  _query = defaultQuery,
  token = null,
  _listSites = null,
  websiteUrl = null
} = {}) {
  const resolvedWebsiteUrl =
    websiteUrl || await resolveClientWebsiteUrl(_query, clientUserId).catch(() => null);

  const { rows } = await _query(
    `SELECT site_url, match_type, match_confidence, permission_level, property_type
       FROM ops_gsc_site_inventory
      WHERE client_user_id = $1
        AND ($2::text IS NULL OR website_url = $2)
      ORDER BY match_confidence DESC, discovered_at DESC
      LIMIT 1`,
    [clientUserId, resolvedWebsiteUrl]
  ).catch(() => ({ rows: [] }));

  if (rows[0]) return rows[0];

  // Live fallback when caller supplies auth
  if (!token || !_listSites) return null;

  const discoveredUrl = resolvedWebsiteUrl;
  if (!discoveredUrl) return null;

  const inventoryRows = await discoverInventory({
    clientUserId,
    websiteUrl: discoveredUrl,
    token,
    _listSites,
    _query
  });
  if (!inventoryRows.length) return null;

  const m = inventoryRows[0].metadata;
  return {
    site_url:         inventoryRows[0].external_id,
    match_type:       m.match_type,
    match_confidence: m.match_confidence,
    permission_level: m.permission_level,
    property_type:    m.property_type
  };
}
