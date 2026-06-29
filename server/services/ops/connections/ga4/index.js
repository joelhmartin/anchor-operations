import { buildGa4Client } from './client.js';
import { discoverInventory } from './inventory.js';
import { collectSnapshot } from './snapshot.js';
import { GA4_CHECKS } from './checks/index.js';

async function verifyConnection(ctx = {}) {
  const { env = process.env, propertyId, ga4Client: injected = null } = ctx;
  if (!propertyId) {
    return { status: 'failed', detail: 'verifyConnection: propertyId is required in ctx', capabilities: [] };
  }
  try {
    const client = buildGa4Client({ env, ga4Client: injected });
    await client.runReport({
      property: `properties/${propertyId}`,
      dateRanges: [{ startDate: 'yesterday', endDate: 'yesterday' }],
      metrics: [{ name: 'sessions' }],
      limit: 1
    });
    return {
      status: 'verified',
      detail: `GA4 Data API reachable for property ${propertyId}`,
      capabilities: ['read']
    };
  } catch (err) {
    return {
      status: 'failed',
      detail: err?.message || String(err),
      capabilities: []
    };
  }
}

async function listCapabilities(_ctx = {}) {
  return {
    read: true,
    mutate: false,
    crawl: false,
    inspect_html: false
  };
}

export default {
  id: 'ga4',
  serviceCategory: 'analytics',
  provider: 'ga4',
  connectionTypes: ['service_account'],
  verifyConnection,
  discoverInventory,
  collectSnapshot,
  listCapabilities,
  checks: GA4_CHECKS
};
