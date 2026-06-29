/**
 * paid_ads/google_ads connector — discoverInventory (F2).
 * Read-only GAQL (gRPC, per the shipped _client) enumerating campaigns,
 * ad groups, and conversion actions. Reuses withCustomerCached for the
 * agency-MCC auth path; returns [] for unlinked/uncredentialed clients.
 */
import { withCustomerCached } from '../../checks/google_ads/_client.js';
import { inventoryRow } from '../inventoryRow.js';

const lastSegment = (resourceName) => String(resourceName || '').split('/').pop() || null;

export default {
  id: 'google_ads',
  serviceCategory: 'paid_ads',
  provider: 'google_ads',

  async discoverInventory(ctx = {}) {
    const resolve = ctx.clients?.withCustomer || withCustomerCached;
    const resolved = await resolve(ctx);
    if (resolved.skipped) return [];

    const { customer } = resolved;
    const rows = [];

    const campaigns = await customer.query(
      'SELECT campaign.id, campaign.name, campaign.status FROM campaign'
    ).catch(() => []);
    for (const r of campaigns) {
      const c = r.campaign || r;
      rows.push(inventoryRow({
        object_type: 'campaign',
        external_id: c.id,
        name: c.name,
        status: String(c.status ?? ''),
        metadata: {}
      }));
    }

    const adGroups = await customer.query(
      'SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.campaign FROM ad_group'
    ).catch(() => []);
    for (const r of adGroups) {
      const g = r.ad_group || r;
      rows.push(inventoryRow({
        object_type: 'ad_group',
        external_id: g.id,
        parent_external_id: lastSegment(g.campaign),
        name: g.name,
        status: String(g.status ?? ''),
        metadata: {}
      }));
    }

    const convs = await customer.query(
      'SELECT conversion_action.id, conversion_action.name, conversion_action.status FROM conversion_action'
    ).catch(() => []);
    for (const r of convs) {
      const ca = r.conversion_action || r;
      rows.push(inventoryRow({
        object_type: 'conversion_action',
        external_id: ca.id,
        name: ca.name,
        status: String(ca.status ?? ''),
        metadata: {}
      }));
    }

    return rows;
  }
};
