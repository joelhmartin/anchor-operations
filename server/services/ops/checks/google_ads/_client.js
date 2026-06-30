/**
 * Google Ads adapter helper for ops checks.
 *
 * Reuses the existing analytics googleAdsAdapter (gRPC via google-ads-api).
 * Per CLAUDE.md gotcha #14: Google Ads is gRPC ONLY — REST returns 404.
 *
 * The analytics adapter only exports a few high-level helpers, so this file
 * exposes a low-level `getCustomerClient(customerId)` so ops checks can run
 * arbitrary GAQL queries without bypassing the auth path.
 */

import { GoogleAdsApi } from 'google-ads-api';
import { query } from '../../../../db.js';

const DEVELOPER_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || null;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN || null;
const MANAGER_CUSTOMER_ID = process.env.GOOGLE_ADS_MANAGER_ID || '6996750299';
const CLIENT_ID = process.env.GOOGLE_ADS_CLIENT_ID || null;
const CLIENT_SECRET = process.env.GOOGLE_ADS_CLIENT_SECRET || null;

let cachedClient = null;

function getClient() {
  if (!cachedClient) {
    cachedClient = new GoogleAdsApi({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      developer_token: DEVELOPER_TOKEN,
    });
  }
  return cachedClient;
}

export function hasAgencyCredentials() {
  return Boolean(DEVELOPER_TOKEN && REFRESH_TOKEN && CLIENT_ID && CLIENT_SECRET);
}

/**
 * Returns the google-ads-api Customer instance for the given customer ID.
 * Pass through dashes — the adapter strips them.
 */
export function getCustomerClient(customerId) {
  if (!customerId) return null;
  if (!hasAgencyCredentials()) return null;
  const cleanId = String(customerId).replace(/-/g, '');
  return getClient().Customer({
    customer_id: cleanId,
    refresh_token: REFRESH_TOKEN,
    login_customer_id: MANAGER_CUSTOMER_ID,
  });
}

/**
 * List the customer IDs the agency refresh token can access (for the access
 * audit). Returns an array of resource names (`customers/123...`), or null when
 * agency credentials are not configured.
 */
export async function listAccessibleCustomerIds() {
  if (!hasAgencyCredentials()) return null;
  const res = await getClient().listAccessibleCustomers(REFRESH_TOKEN);
  return Array.isArray(res?.resource_names) ? res.resource_names : [];
}

/**
 * Resolve the Google Ads customer_id configured for a client (via
 * tracking_configs). Returns the most-recent non-null value, or null if
 * the client has no Google Ads link.
 */
export async function resolveCustomerIdForClient(clientUserId) {
  if (!clientUserId) return null;
  const { rows } = await query(
    `SELECT google_ads_customer_id
       FROM tracking_configs
      WHERE user_id = $1
        AND google_ads_customer_id IS NOT NULL
        AND google_ads_customer_id <> ''
      ORDER BY created_at DESC
      LIMIT 1`,
    [clientUserId]
  ).catch(() => ({ rows: [] }));
  return rows[0]?.google_ads_customer_id || null;
}

/**
 * Helper that resolves customer + client and returns either a `{ customer, customerId }`
 * pair or a `{ skipped: true, reason }` outcome. Centralises the boilerplate
 * every check would otherwise repeat.
 */
export async function withCustomer(clientUserId) {
  if (!hasAgencyCredentials()) {
    return { skipped: true, reason: 'Google Ads agency credentials not configured' };
  }
  const customerId = await resolveCustomerIdForClient(clientUserId);
  if (!customerId) {
    return { skipped: true, reason: 'no Google Ads customer_id linked for client' };
  }
  const customer = getCustomerClient(customerId);
  if (!customer) {
    return { skipped: true, reason: 'failed to construct Google Ads customer client' };
  }
  return { customer, customerId };
}

/**
 * Memoised `withCustomer` per ctx — multiple checks in one run share the
 * same Customer instance + customerId so we only resolve once.
 */
export async function withCustomerCached(ctx) {
  if (!ctx) return withCustomer(null);
  if (!ctx._gadsCustomerPromise) {
    ctx._gadsCustomerPromise = withCustomer(ctx.clientUserId);
  }
  return ctx._gadsCustomerPromise;
}
