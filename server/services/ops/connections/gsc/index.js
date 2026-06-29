/**
 * Search Console connector — spec §5 locked interface.
 *
 * id:              'search_console'
 * serviceCategory: 'organic_search'
 * provider:        'search_console'
 *
 * checks[] lists the 11 new gsc.* IDs. Registration happens as a side
 * effect of importing checks.js; this array is for the F1 connector registry
 * to declare what this connector owns.
 */
import './checks.js';  // side-effect: registers all 11 gsc.* checks

import { resolveGscToken } from './auth.js';
import { listSites, discoverInventory, getMatchedSite } from './inventory.js';
import { collectSnapshot as collectSnapshotFn } from './snapshot.js';

const connector = {
  id: 'search_console',
  serviceCategory: 'organic_search',
  provider: 'search_console',
  connectionTypes: ['service_account', 'oauth'],

  /**
   * verifyConnection: confirm the token works and the matched property is accessible.
   * ctx: { clientUserId, signal? }
   * → { status: 'verified'|'degraded'|'failed', detail, capabilities }
   */
  async verifyConnection(ctx) {
    const token = await resolveGscToken({ env: process.env }).catch(() => null);
    if (!token) {
      return { status: 'failed', detail: 'No GSC credentials configured (GA4_SERVICE_ACCOUNT_KEY / ADC / OAuth)', capabilities: [] };
    }
    try {
      const sites = await listSites(token, { signal: ctx.signal });
      const matched = await getMatchedSite(ctx.clientUserId);
      if (!matched) {
        return { status: 'degraded', detail: `Authenticated (${sites.length} site(s) accessible) but no property matched to client website`, capabilities: ['read'] };
      }
      return { status: 'verified', detail: `Property ${matched.site_url} accessible (${matched.permission_level})`, capabilities: ['read'] };
    } catch (err) {
      return { status: 'failed', detail: err.message, capabilities: [] };
    }
  },

  /**
   * discoverInventory: match and persist the client's GSC property.
   * ctx: { clientUserId, signal? }
   * → Array of ops_platform_inventory-shaped rows
   */
  async discoverInventory(ctx) {
    const token = await resolveGscToken({ env: process.env }).catch(() => null);
    if (!token) return [];
    const { resolveClientWebsiteUrl } = await import('../../checks/website/_lib/httpFetch.js');
    const { query } = await import('../../../../db.js');
    const websiteUrl = await resolveClientWebsiteUrl(query, ctx.clientUserId).catch(() => null);
    if (!websiteUrl) return [];
    return discoverInventory({ clientUserId: ctx.clientUserId, websiteUrl, token });
  },

  /**
   * collectSnapshot: fetch GSC search analytics for the current date.
   * ctx: { clientUserId, signal? }
   * → Array of ops_daily_snapshots-shaped rows (caller persists)
   */
  async collectSnapshot(ctx) {
    const token = await resolveGscToken({ env: process.env }).catch(() => null);
    if (!token) return [];
    const matched = await getMatchedSite(ctx.clientUserId).catch(() => null);
    if (!matched) return [];
    const date = new Date().toISOString().slice(0, 10);
    return collectSnapshotFn({ clientUserId: ctx.clientUserId, siteUrl: matched.site_url, token, date, signal: ctx.signal });
  },

  /**
   * listCapabilities: what this connector can do given the current connection.
   */
  async listCapabilities(ctx) {
    const token = await resolveGscToken({ env: process.env }).catch(() => null);
    if (!token) return {};
    return { read: true, mutate: false };
  },

  // Mutating actions (submit_sitemap, request_url_inspection) require operator
  // approval and are deferred to a later phase per spec §8.
  actions: {},

  checks: [
    'gsc.connection_health',
    'gsc.site_access_missing',
    'gsc.click_drop',
    'gsc.impression_drop',
    'gsc.page_decline',
    'gsc.query_decline',
    'gsc.query_opportunity',
    'gsc.page_indexing_issue',
    'gsc.canonical_mismatch',
    'gsc.device_specific_drop',
    'gsc.zero_click_high_impression_pages'
  ]
};

export default connector;
