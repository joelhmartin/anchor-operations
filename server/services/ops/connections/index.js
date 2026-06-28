/**
 * Public surface of the connection/capability/asset foundation (F1).
 * Future phases (F2+) import connectors + stores from here.
 */
export { registerConnector, getConnector, getConnectorByCategoryProvider, listConnectors } from './registry.js';
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
