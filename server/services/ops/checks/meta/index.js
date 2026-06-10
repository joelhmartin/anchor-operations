/**
 * Meta umbrella check registrations — Phase 5.
 *
 * Importing this module triggers registerCheck() side-effects for every Meta
 * check. Imported by `server/services/ops/index.js` so the registry is
 * populated before any run dispatch.
 *
 * Every check in this umbrella enforces the HIPAA gate (`_hipaaGate.js`)
 * before issuing any Meta API call. Meta does not sign BAAs; medical clients
 * are explicitly skipped with reason 'hipaa_no_meta'.
 */

import './pixel.js';
import './delivery.js';
import './account.js';
