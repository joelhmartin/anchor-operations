/**
 * Public surface of the connection/capability/asset foundation (F1 + F2).
 * Inventory connectors (F2) are exported here so the executor/orchestrator
 * can iterate them without touching internal provider paths.
 */
export { registerConnector, getConnector, getConnectorByCategoryProvider, listConnectors } from './registry.js';
export { INVENTORY_CONNECTORS } from './providers/index.js';
export { validateConnector, assertValidConnector, CONNECTION_TYPES } from './types/contract.js';
export {
  upsertConnection, getConnection, listConnectionsForClient, setConnectionStatus,
  canTransitionStatus, STATUS_LIFECYCLE
} from './connectionStore.js';
export { evaluateGate, availableCapabilities, USABLE_CONNECTION_STATUSES } from './capabilityMatrix.js';
export { resolveCredentialForConnection, classifyCredentialResolution } from './credentialResolver.js';
export {
  deriveFromUmbrella, umbrellaFromCategoryProvider,
  UMBRELLA_TO_CATEGORY_PROVIDER, SECONDARY_UMBRELLA_CATEGORIES
} from './umbrellaMap.js';
