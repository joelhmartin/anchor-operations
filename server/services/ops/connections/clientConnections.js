/**
 * Per-client Service Connections (V3).
 *
 * Two responsibilities:
 *   1. getClientConnections(clientUserId, queryFn) — derive each platform's
 *      REAL connection state from the client's own columns + join tables
 *      (client_profiles, kinsta_site_clients, meta_page_links), then overlay
 *      the most recent verify result from ops_service_connections.
 *   2. verifyClientConnection({ clientUserId, provider }, deps) — run a real,
 *      READ-ONLY per-client check (never posts/writes to a vendor) and persist
 *      the outcome into ops_service_connections (upsert per client+provider).
 *
 * Status vocab returned to the UI: 'connected' | 'partial' | 'not_provided'.
 * Persisted vocab (ops_service_connections.status, CHECK-constrained):
 *   'verified' | 'configured' | 'degraded' | 'failed' | 'missing'.
 * We map persisted → UI honestly: a degraded/unknown live result is NOT green.
 */

import { query as defaultQuery } from '../../../db.js';
import { getPageToken as defaultGetPageToken } from '../../metaPagePosting.js';
import { listAllSites as defaultListAllSites } from '../operations-website/kinstaApi.js';
import { getCustomerClient as defaultGetCustomerClient } from '../checks/google_ads/_client.js';

// provider → service_category (matches connectionStore / umbrellaMap conventions)
export const PROVIDER_CATEGORY = {
  google_ads: 'paid_ads',
  ga4: 'analytics',
  meta: 'paid_ads',
  website: 'website',
  ctm: 'call_tracking',
  kinsta: 'hosting'
};

export const PROVIDERS = Object.keys(PROVIDER_CATEGORY);

// Persisted lifecycle status → UI status. Honest: only 'verified' is green.
function persistedToUi(status) {
  switch (status) {
    case 'verified':
      return 'connected';
    case 'configured':
    case 'degraded':
    case 'failed':
      return 'partial';
    case 'missing':
    case 'disabled':
    default:
      return 'not_provided';
  }
}

const isSet = (v) => v !== null && v !== undefined && String(v).trim() !== '';
// "provided"-ish access-status text from the onboarding columns.
const looksProvided = (statusText) =>
  isSet(statusText) && /provided|connected|complete|done|ready|granted|active/i.test(String(statusText));

/**
 * Derive the per-platform connection state purely from the client's own
 * configuration (no network). Returns the UI-facing shape; verify overlays
 * happen in getClientConnections.
 */
function deriveFromColumns({ profile, hasMetaLink, metaPageId, kinstaSiteCount }) {
  const p = profile || {};

  function fromAccess(provided, statusText, { connectedDetail, partialDetail, missingDetail }) {
    if (provided === true || looksProvided(statusText)) {
      return provided === true
        ? { status: 'connected', detail: connectedDetail }
        : { status: 'partial', detail: partialDetail };
    }
    if (isSet(statusText)) return { status: 'partial', detail: `${partialDetail} (status: ${statusText})` };
    return { status: 'not_provided', detail: missingDetail };
  }

  const out = {};

  // google_ads — a linked account id is the strongest signal.
  if (isSet(p.google_ads_account_id)) {
    out.google_ads = {
      status: p.google_ads_access_provided === true ? 'connected' : 'partial',
      detail:
        p.google_ads_access_provided === true
          ? `Account ${p.google_ads_account_id} linked, access provided`
          : `Account ${p.google_ads_account_id} linked, access not yet confirmed`,
      accountRef: String(p.google_ads_account_id)
    };
  } else {
    out.google_ads = {
      ...fromAccess(p.google_ads_access_provided, p.google_ads_access_status, {
        connectedDetail: 'Google Ads access provided',
        partialDetail: 'Google Ads access in progress',
        missingDetail: 'No Google Ads account linked'
      }),
      accountRef: null
    };
  }

  out.ga4 = {
    ...fromAccess(p.ga4_access_provided, p.ga4_access_status, {
      connectedDetail: 'GA4 access provided',
      partialDetail: 'GA4 access in progress',
      missingDetail: 'No GA4 access on file'
    }),
    accountRef: null
  };

  // meta — a meta_page_links row is the real signal; access columns are the fallback.
  if (hasMetaLink) {
    out.meta = {
      status: 'connected',
      detail: `Facebook Page ${metaPageId} linked`,
      accountRef: metaPageId ? String(metaPageId) : null
    };
  } else {
    out.meta = {
      ...fromAccess(p.meta_access_provided, p.meta_access_status, {
        connectedDetail: 'Meta access provided (no Page linked yet)',
        partialDetail: 'Meta access in progress',
        missingDetail: 'No Facebook Page linked'
      }),
      accountRef: null
    };
  }

  out.website = {
    ...fromAccess(p.website_access_provided, p.website_access_status, {
      connectedDetail: 'Website access provided',
      partialDetail: 'Website access in progress',
      missingDetail: 'No website access on file'
    }),
    accountRef: null
  };

  // ctm — per-client api key / account number on client_profiles.
  if (isSet(p.ctm_account_number) || isSet(p.ctm_api_key)) {
    out.ctm = {
      status: 'connected',
      detail: isSet(p.ctm_account_number)
        ? `CTM account ${p.ctm_account_number} configured`
        : 'CTM API key configured',
      accountRef: isSet(p.ctm_account_number)
        ? String(p.ctm_account_number)
        : isSet(p.call_tracking_main_number)
          ? String(p.call_tracking_main_number)
          : null
    };
  } else {
    out.ctm = { status: 'not_provided', detail: 'No CallTrackingMetrics account configured', accountRef: null };
  }

  // kinsta — linked via kinsta_site_clients.
  if (kinstaSiteCount > 0) {
    out.kinsta = {
      status: 'connected',
      detail: `${kinstaSiteCount} Kinsta site${kinstaSiteCount === 1 ? '' : 's'} linked`,
      accountRef: `${kinstaSiteCount} site${kinstaSiteCount === 1 ? '' : 's'}`
    };
  } else {
    out.kinsta = { status: 'not_provided', detail: 'No Kinsta site linked', accountRef: null };
  }

  return out;
}

/**
 * getClientConnections — one row per platform with the REAL derived status,
 * overlaid with the latest persisted verify result when one exists.
 */
export async function getClientConnections(clientUserId, queryFn = defaultQuery) {
  if (!clientUserId) throw new Error('clientConnections: clientUserId required');

  const [{ rows: profileRows }, { rows: metaRows }, { rows: kinstaRows }, { rows: connRows }] = await Promise.all([
    queryFn(
      `SELECT user_id, google_ads_access_status, google_ads_access_provided, google_ads_account_id,
              ga4_access_status, ga4_access_provided, meta_access_status, meta_access_provided,
              website_access_status, website_access_provided,
              ctm_api_key, ctm_account_number, call_tracking_main_number
         FROM client_profiles WHERE user_id = $1`,
      [clientUserId]
    ),
    queryFn(
      `SELECT id, fb_page_id FROM meta_page_links
        WHERE client_id = $1 AND archived_at IS NULL
        ORDER BY created_at DESC LIMIT 1`,
      [clientUserId]
    ),
    queryFn(`SELECT COUNT(*)::int AS n FROM kinsta_site_clients WHERE client_user_id = $1`, [clientUserId]),
    queryFn(
      `SELECT service_category, provider, status, detail, last_verified_at
         FROM ops_service_connections WHERE client_user_id = $1`,
      [clientUserId]
    )
  ]);

  const profile = profileRows[0] || null;
  const metaRow = metaRows[0] || null;
  const kinstaSiteCount = kinstaRows[0]?.n || 0;

  const derived = deriveFromColumns({
    profile,
    hasMetaLink: Boolean(metaRow),
    metaPageId: metaRow?.fb_page_id || null,
    kinstaSiteCount
  });

  // index persisted verify results by provider
  const byProvider = {};
  for (const r of connRows) byProvider[r.provider] = r;

  return PROVIDERS.map((provider) => {
    const base = derived[provider];
    const conn = byProvider[provider];
    if (conn && conn.last_verified_at) {
      // A live verify has run — surface its result (it overrides the static guess).
      return {
        provider,
        service_category: PROVIDER_CATEGORY[provider],
        status: persistedToUi(conn.status),
        detail: conn.detail || base.detail,
        accountRef: base.accountRef,
        lastVerifiedAt: conn.last_verified_at
      };
    }
    return {
      provider,
      service_category: PROVIDER_CATEGORY[provider],
      status: base.status,
      detail: base.detail,
      accountRef: base.accountRef,
      lastVerifiedAt: null
    };
  });
}

/**
 * Upsert a verify result into ops_service_connections. Direct upsert (not the
 * lifecycle-guarded connectionStore) because per-client re-verifies legitimately
 * move between failed/degraded/verified in any order and must never throw.
 */
async function persistVerify(queryFn, { clientUserId, provider, status, detail }) {
  const serviceCategory = PROVIDER_CATEGORY[provider];
  const { rows } = await queryFn(
    `
    INSERT INTO ops_service_connections
      (client_user_id, service_category, provider, connection_type, status, detail, last_verified_at, updated_at)
    VALUES ($1, $2, $3, 'per_client_verify', $4, $5, now(), now())
    ON CONFLICT (client_user_id, service_category, provider) DO UPDATE
      SET status           = EXCLUDED.status,
          detail           = EXCLUDED.detail,
          connection_type  = EXCLUDED.connection_type,
          last_verified_at = EXCLUDED.last_verified_at,
          updated_at       = now()
    RETURNING service_category, provider, status, detail, last_verified_at
    `,
    [clientUserId, serviceCategory, provider, status, detail]
  );
  return rows[0];
}

// --- per-provider live checks (all READ-ONLY) ---------------------------------

async function verifyKinsta(clientUserId, deps) {
  const queryFn = deps.query;
  const { rows } = await queryFn(
    `SELECT ks.kinsta_site_id, ks.site_name
       FROM kinsta_site_clients ksc
       JOIN kinsta_sites ks ON ks.id = ksc.site_id
      WHERE ksc.client_user_id = $1`,
    [clientUserId]
  );
  if (rows.length === 0) return { status: 'missing', detail: 'No Kinsta site linked to this client' };
  const sites = await deps.listAllSites();
  const agencyIds = new Set((sites || []).map((s) => String(s.id)));
  const present = rows.filter((r) => agencyIds.has(String(r.kinsta_site_id)));
  if (present.length === 0) {
    return {
      status: 'degraded',
      detail: `Linked site(s) not visible under the agency Kinsta account (${sites?.length || 0} sites reachable)`
    };
  }
  const names = present.map((r) => r.site_name).filter(Boolean).join(', ');
  return {
    status: 'verified',
    detail: `${present.length} linked Kinsta site${present.length === 1 ? '' : 's'} present${names ? ` — ${names}` : ''} (${sites.length} agency sites)`
  };
}

async function verifyMeta(clientUserId, deps) {
  const queryFn = deps.query;
  const { rows } = await queryFn(
    `SELECT id, fb_page_id FROM meta_page_links
      WHERE client_id = $1 AND archived_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [clientUserId]
  );
  if (rows.length === 0) return { status: 'missing', detail: 'No Facebook Page linked to this client' };
  const link = rows[0];
  try {
    // READ-ONLY: resolves (and refreshes if needed) the page token. No posting.
    const token = await deps.getPageToken(link.id);
    if (!token) return { status: 'failed', detail: `Could not resolve a page token for Page ${link.fb_page_id}` };
    return { status: 'verified', detail: `Page token resolved for Facebook Page ${link.fb_page_id} (read-only)` };
  } catch (err) {
    return { status: 'failed', detail: `Meta token resolve failed: ${err?.message || 'unknown error'}` };
  }
}

async function verifyGoogleAds(clientUserId, deps) {
  const queryFn = deps.query;
  const { rows } = await queryFn(
    `SELECT google_ads_account_id FROM client_profiles WHERE user_id = $1`,
    [clientUserId]
  );
  const accountId = rows[0]?.google_ads_account_id;
  if (!isSet(accountId)) return { status: 'missing', detail: 'No Google Ads account id on file for this client' };
  const customer = deps.getCustomerClient(accountId);
  if (!customer) {
    return { status: 'degraded', detail: 'Google Ads agency credentials not configured — cannot run a live check' };
  }
  try {
    // Tiny read-only GAQL probe.
    const res = await customer.query('SELECT customer.id FROM customer LIMIT 1');
    const ok = Array.isArray(res) ? res.length > 0 : Boolean(res);
    return ok
      ? { status: 'verified', detail: `Reached Google Ads account ${accountId} (read-only GAQL)` }
      : { status: 'degraded', detail: `Google Ads account ${accountId} returned no rows` };
  } catch (err) {
    return { status: 'failed', detail: `Google Ads query failed: ${err?.message || 'unknown error'}` };
  }
}

// ga4 / website / ctm have no per-client live target here — reflect the
// onboarding access columns honestly (never fake 'verified').
async function verifyFromColumns(clientUserId, provider, deps) {
  const queryFn = deps.query;
  const { rows } = await queryFn(
    `SELECT ga4_access_status, ga4_access_provided, website_access_status, website_access_provided,
            ctm_api_key, ctm_account_number
       FROM client_profiles WHERE user_id = $1`,
    [clientUserId]
  );
  const p = rows[0] || {};
  if (provider === 'ctm') {
    if (isSet(p.ctm_account_number) || isSet(p.ctm_api_key)) {
      return {
        status: 'degraded',
        detail: 'CTM credentials present on profile; no per-client live verifier wired — not live-confirmed'
      };
    }
    return { status: 'missing', detail: 'No CallTrackingMetrics account configured' };
  }
  const provided = provider === 'ga4' ? p.ga4_access_provided : p.website_access_provided;
  const statusText = provider === 'ga4' ? p.ga4_access_status : p.website_access_status;
  const label = provider === 'ga4' ? 'GA4' : 'Website';
  if (provided === true || looksProvided(statusText)) {
    return {
      status: 'degraded',
      detail: `${label} access marked provided on profile${isSet(statusText) ? ` (${statusText})` : ''}; no per-client live verifier — not live-confirmed`
    };
  }
  if (isSet(statusText)) return { status: 'configured', detail: `${label} access status: ${statusText}` };
  return { status: 'missing', detail: `No ${label} access on file` };
}

/**
 * Run a real, read-only verify for one provider and persist the result.
 * `deps` lets tests inject query / getPageToken / listAllSites / getCustomerClient.
 */
export async function verifyClientConnection({ clientUserId, provider }, deps = {}) {
  if (!clientUserId) throw new Error('clientConnections: clientUserId required');
  if (!PROVIDERS.includes(provider)) throw new Error(`clientConnections: unknown provider "${provider}"`);

  const resolved = {
    query: deps.query || defaultQuery,
    getPageToken: deps.getPageToken || defaultGetPageToken,
    listAllSites: deps.listAllSites || defaultListAllSites,
    getCustomerClient: deps.getCustomerClient || defaultGetCustomerClient
  };

  let result;
  switch (provider) {
    case 'kinsta':
      result = await verifyKinsta(clientUserId, resolved);
      break;
    case 'meta':
      result = await verifyMeta(clientUserId, resolved);
      break;
    case 'google_ads':
      result = await verifyGoogleAds(clientUserId, resolved);
      break;
    case 'ga4':
    case 'website':
    case 'ctm':
      result = await verifyFromColumns(clientUserId, provider, resolved);
      break;
    default:
      result = { status: 'missing', detail: 'No verifier for this provider' };
  }

  const persisted = await persistVerify(resolved.query, {
    clientUserId,
    provider,
    status: result.status,
    detail: result.detail
  });

  return {
    provider,
    service_category: PROVIDER_CATEGORY[provider],
    status: persistedToUi(persisted.status),
    rawStatus: persisted.status,
    detail: persisted.detail,
    lastVerifiedAt: persisted.last_verified_at
  };
}
