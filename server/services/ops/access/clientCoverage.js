/**
 * Client access coverage — the "which platforms are actually connected, across
 * our real clients?" layer of the Access Audit (north-star §0 / §19.3).
 *
 * Unlike the env-presence checks (do we hold an agency credential?), this reads
 * the real per-client access state from `client_profiles` + `kinsta_site_clients`
 * and answers, per service, how many clients are actually connected.
 *
 * Pure over an injected `query` so it can run against the local DB, the prod DB
 * (read-only), or a fake in tests.
 */
import { query as defaultQuery } from '../../../db.js';

// A client counts as "connected" for a service when the real onboarding/access
// columns say access was provided (status sentinel or boolean flag), or a
// concrete identifier/credential is present.
const COVERAGE_SQL = `
  SELECT
    count(*)::int AS total,
    count(*) FILTER (
      WHERE google_ads_access_status = 'provided'
         OR google_ads_access_provided IS TRUE
         OR (google_ads_account_id IS NOT NULL AND google_ads_account_id <> '')
    )::int AS google_ads,
    count(*) FILTER (
      WHERE ga4_access_status = 'provided' OR ga4_access_provided IS TRUE
    )::int AS ga4,
    count(*) FILTER (
      WHERE meta_access_status = 'provided' OR meta_access_provided IS TRUE
    )::int AS meta,
    count(*) FILTER (
      WHERE website_access_status = 'provided' OR website_access_provided IS TRUE
    )::int AS website,
    count(*) FILTER (
      WHERE ctm_api_key IS NOT NULL AND ctm_api_key <> ''
    )::int AS ctm
  FROM client_profiles
`;

function coverageStatus(connected, total) {
  if (!total) return 'missing';
  if (connected === 0) return 'missing';
  if (connected >= total) return 'verified';
  return 'degraded';
}

/**
 * @returns {Promise<{ total:number, services:Record<string,{connected:number,total:number,status:string,detail:string}> }>}
 */
export async function computeClientCoverage(query = defaultQuery) {
  const { rows } = await query(COVERAGE_SQL);
  const r = rows[0] || { total: 0 };
  const total = r.total || 0;

  // Kinsta coverage is a join table, not a column on client_profiles.
  let kinstaClients = 0;
  let kinstaSites = 0;
  try {
    const k = await query(
      `SELECT
         (SELECT count(DISTINCT client_user_id) FROM kinsta_site_clients)::int AS clients,
         (SELECT count(*) FROM kinsta_sites)::int AS sites`
    );
    kinstaClients = k.rows[0]?.clients || 0;
    kinstaSites = k.rows[0]?.sites || 0;
  } catch {
    // kinsta tables absent → leave at 0
  }

  const make = (connected, detailNoun) => ({
    connected,
    total,
    status: coverageStatus(connected, total),
    detail: `${connected}/${total} clients ${detailNoun}`
  });

  const services = {
    google_ads: make(r.google_ads || 0, 'with Google Ads access'),
    ga4: make(r.ga4 || 0, 'with GA4 access'),
    meta: make(r.meta || 0, 'with Meta access'),
    website: make(r.website || 0, 'with website access'),
    ctm: make(r.ctm || 0, 'with CTM credentials'),
    kinsta: {
      connected: kinstaClients,
      total,
      status: coverageStatus(kinstaClients, total),
      detail: `${kinstaClients}/${total} clients linked to ${kinstaSites} Kinsta site(s)`
    }
  };

  return { total, services };
}
