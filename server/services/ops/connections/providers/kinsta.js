/**
 * hosting/kinsta connector — discoverInventory (F2).
 * Enumerates a client's Kinsta sites, their environments, and domains.
 * Reuses the shipped kinstaApi client; per-client scope (which sites this
 * connection grants) comes from connection.metadata.kinstaSiteIds when F1
 * provides it, else all agency sites are returned.
 */
import * as kinstaApi from '../../operations-website/kinstaApi.js';
import { inventoryRow } from '../inventoryRow.js';

export default {
  id: 'kinsta',
  serviceCategory: 'hosting',
  provider: 'kinsta',

  async discoverInventory(ctx = {}) {
    const kinsta = ctx.clients?.kinsta || kinstaApi;
    const scopeIds = ctx.connection?.metadata?.kinstaSiteIds || null;

    const sites = await kinsta.listAllSites().catch(() => []);
    const rows = [];

    for (const site of sites) {
      if (scopeIds && !scopeIds.includes(site.id)) continue;

      const primaryDomain = site.primaryDomain?.name || site.primary_domain?.name || null;
      rows.push(inventoryRow({
        object_type: 'site',
        external_id: site.id,
        name: site.display_name || site.name || site.id,
        status: site.status || 'active',
        url: primaryDomain ? `https://${primaryDomain}` : null,
        metadata: { company: site.company || null }
      }));

      for (const env of site.environments || []) {
        const summary = kinsta.pickKinstaEnvironmentSummary(env);
        rows.push(inventoryRow({
          object_type: 'environment',
          external_id: env.id,
          parent_external_id: site.id,
          name: summary.environment_name,
          status: summary.is_live ? 'live' : 'staging',
          url: summary.primary_domain ? `https://${summary.primary_domain}` : null,
          metadata: { is_live: summary.is_live, ssh_host: summary.ssh_host || null }
        }));

        const domains = (env.domains && env.domains.length)
          ? env.domains
          : (summary.primary_domain ? [{ name: summary.primary_domain, type: 'live' }] : []);
        for (const d of domains) {
          if (!d?.name) continue;
          rows.push(inventoryRow({
            object_type: 'domain',
            external_id: d.name,
            parent_external_id: env.id,
            name: d.name,
            status: d.type || 'live',
            url: `https://${d.name}`,
            metadata: {}
          }));
        }
      }
    }

    return rows;
  }
};
