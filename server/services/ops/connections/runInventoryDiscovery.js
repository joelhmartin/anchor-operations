/**
 * Inventory discovery harness (spec §5 — Connection → Inventory leg).
 *
 * Calls a connector's discoverInventory(ctx), applies the PHI/PII sanitizer
 * to every row (defense in depth — connectors already avoid collecting PII,
 * this is the belt to that suspenders), and persists the rows once via the
 * inventory store. Connectors themselves never write to the DB.
 */
import { sanitize } from '../payloadSanitizer.js';
import { upsertInventory } from './inventoryStore.js';
import { INVENTORY_CONNECTORS } from './providers/index.js';

export async function discoverAndPersist(connector, ctx = {}, deps = {}) {
  const { upsert = upsertInventory } = deps;

  const raw = await connector.discoverInventory(ctx);
  const rows = (Array.isArray(raw) ? raw : []).map((r) => ({
    ...r,
    name: typeof r.name === 'string' ? sanitize(r.name) : r.name,
    metadata: sanitize(r.metadata || {})
  }));

  const scope = {
    connectionId: ctx.connectionId,
    clientUserId: ctx.clientUserId ?? null,
    serviceCategory: connector.serviceCategory,
    provider: connector.provider
  };

  const { written } = await upsert(scope, rows);
  return { provider: connector.provider, discovered: rows.length, written, rows };
}

/**
 * Run discoverAndPersist for every F2 inventory connector in sequence.
 * The executor calls this to enumerate all known providers for a given ctx.
 */
export async function runAllInventoryDiscovery(ctx = {}, deps = {}) {
  const results = [];
  for (const connector of INVENTORY_CONNECTORS) {
    results.push(await discoverAndPersist(connector, ctx, deps));
  }
  return results;
}
