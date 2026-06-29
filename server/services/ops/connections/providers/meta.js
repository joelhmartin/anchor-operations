/**
 * paid_ads/meta connector — discoverInventory (F2).
 *
 * HIPAA gate FIRST: Meta signs no BAA, so a `medical` (or indeterminate)
 * client yields an EMPTY inventory with no Graph call ever issued. Only
 * after the gate passes do we construct the ad-account client and read
 * ad accounts, campaigns, and pixels (read-only).
 */
import { assertNonMedical } from '../../checks/meta/_hipaaGate.js';
import { getAdAccountClient } from '../../checks/meta/_client.js';
import { inventoryRow } from '../inventoryRow.js';

export default {
  id: 'meta',
  serviceCategory: 'paid_ads',
  provider: 'meta',

  async discoverInventory(ctx = {}) {
    const gate = ctx.clients?.assertNonMedical || assertNonMedical;
    const getClient = ctx.clients?.getAdAccountClient || getAdAccountClient;

    // HIPAA gate — must run before any Meta API work.
    const g = await gate(ctx);
    if (g.skipped) return [];

    const client = await getClient(ctx);
    if (!client.ok) return [];

    const acct = client.adAccountId;
    const rows = [];

    const account = await client.graph(`${acct}?fields=id,name,account_status`).catch(() => null);
    if (account) {
      rows.push(inventoryRow({
        object_type: 'ad_account',
        external_id: account.id || acct,
        name: account.name || acct,
        status: String(account.account_status ?? ''),
        metadata: {}
      }));
    }

    const campaigns = await client.graph(`${acct}/campaigns?fields=id,name,status&limit=200`).catch(() => null);
    for (const c of campaigns?.data || []) {
      rows.push(inventoryRow({
        object_type: 'campaign',
        external_id: c.id,
        parent_external_id: acct,
        name: c.name,
        status: String(c.status ?? ''),
        metadata: {}
      }));
    }

    const pixels = await client.graph(`${acct}/adspixels?fields=id,name&limit=100`).catch(() => null);
    for (const p of pixels?.data || []) {
      rows.push(inventoryRow({
        object_type: 'pixel',
        external_id: p.id,
        parent_external_id: acct,
        name: p.name,
        metadata: {}
      }));
    }

    return rows;
  }
};
