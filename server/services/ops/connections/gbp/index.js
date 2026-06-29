/**
 * local/gbp connector — Google Business Profile.
 *
 * PLACEHOLDER ONLY — north-star §14; design spec §8 (non-goals for foundation phases).
 *
 * All methods return stub responses. The capability map returns false for every
 * capability so the F1 capability gate skips any GBP checks.
 *
 * Future credentials:
 *   GBP_SERVICE_ACCOUNT_KEY — JSON string of a GCP service account key.
 *     Required scopes: https://www.googleapis.com/auth/business.manage.
 *
 * DO NOT add live API calls here until a plan explicitly promotes this connector.
 */

import { registerConnector } from '../registry.js';

export async function verifyConnection(_ctx = {}) {
  // STUB: always missing — capability gate never issues GBP checks.
  return {
    status: 'missing',
    detail: 'STUB — local/gbp connector not yet implemented (north-star §14 placeholder)',
    capabilities: {}
  };
}

export async function listCapabilities(_ctx = {}) {
  // STUB: all false — F1 connection card renders this as "pending" state.
  return {
    'gbp.connection_health': false, // STUB
    'gbp.review_summary': false,    // STUB
    'gbp.profile_status': false,    // STUB
    'gbp.hours_mismatch': false     // STUB
  };
}

export async function discoverInventory(_ctx = {}) {
  // STUB: location discovery not implemented.
  return [];
}

export async function collectSnapshot(_ctx = {}) {
  // STUB: snapshot collection not implemented.
  return [];
}

const connector = {
  id: 'local/gbp',
  serviceCategory: 'local',
  provider: 'gbp',
  connectionTypes: ['service_account', 'oauth'],
  verifyConnection,
  listCapabilities,
  discoverInventory,
  collectSnapshot,
  actions: {},
  checks: []
};

registerConnector(connector);
export default connector;
