/**
 * Connector registry (spec §5). Connectors register themselves at module load
 * via registerConnector(); the executor/orchestrator discover them by id or by
 * (serviceCategory, provider). F1 ships an EMPTY registry — concrete connectors
 * arrive in F2+.
 */
import { assertValidConnector } from './types/contract.js';

const CONNECTORS = new Map();

export function registerConnector(connector) {
  assertValidConnector(connector);
  if (CONNECTORS.has(connector.id)) {
    console.warn(`[ops/connections] connector already registered: ${connector.id} — overwriting`);
  }
  CONNECTORS.set(connector.id, connector);
}

export function getConnector(id) {
  return CONNECTORS.get(id) || null;
}

export function getConnectorByCategoryProvider(serviceCategory, provider) {
  for (const c of CONNECTORS.values()) {
    if (c.serviceCategory === serviceCategory && c.provider === provider) return c;
  }
  return null;
}

export function listConnectors() {
  return Array.from(CONNECTORS.values());
}

// Test-only escape hatch.
export function _resetConnectorsForTests() {
  CONNECTORS.clear();
}
