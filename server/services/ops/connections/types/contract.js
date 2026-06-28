/**
 * Connector contract (spec §5, LOCKED). Every integration — current and future —
 * implements this one shape. The five-layer law (Connection → Inventory →
 * Snapshot → Checks → Actions) is enforced by REQUIRING verifyConnection and
 * listCapabilities: a connector cannot ship actions/recommendations without a
 * verifiable connection and a capability map first.
 */
export const CONNECTION_TYPES = ['service_account', 'oauth', 'api_key', 'webhook', 'ssh'];

const isNonEmptyString = (v) => typeof v === 'string' && v.trim() !== '';
const isFn = (v) => typeof v === 'function';

export function validateConnector(connector = {}) {
  const errors = [];

  for (const field of ['id', 'serviceCategory', 'provider']) {
    if (!isNonEmptyString(connector[field])) errors.push(`connector.${field} must be a non-empty string`);
  }

  if (!Array.isArray(connector.connectionTypes) || connector.connectionTypes.length === 0) {
    errors.push('connector.connectionTypes must be a non-empty array');
  } else {
    for (const t of connector.connectionTypes) {
      if (!CONNECTION_TYPES.includes(t)) errors.push(`connector.connectionTypes: unknown connectionType "${t}"`);
    }
  }

  // Order law — mandatory first two layers.
  if (!isFn(connector.verifyConnection)) errors.push('connector.verifyConnection must be a function');
  if (!isFn(connector.listCapabilities)) errors.push('connector.listCapabilities must be a function');

  // Optional later-layer methods, validated only if present.
  if (connector.discoverInventory !== undefined && !isFn(connector.discoverInventory)) {
    errors.push('connector.discoverInventory, if present, must be a function');
  }
  if (connector.collectSnapshot !== undefined && !isFn(connector.collectSnapshot)) {
    errors.push('connector.collectSnapshot, if present, must be a function');
  }
  if (connector.actions !== undefined && (typeof connector.actions !== 'object' || connector.actions === null)) {
    errors.push('connector.actions, if present, must be an object');
  }
  if (connector.checks !== undefined && !Array.isArray(connector.checks)) {
    errors.push('connector.checks, if present, must be an array');
  }

  return { valid: errors.length === 0, errors };
}

export function assertValidConnector(connector) {
  const { valid, errors } = validateConnector(connector);
  if (!valid) throw new Error(`invalid connector: ${errors.join('; ')}`);
}
