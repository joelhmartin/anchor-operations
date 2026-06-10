/**
 * Operations rebuild — service barrel.
 *
 * Phase 1 only re-exports the foundation pieces. Subsequent phases will add
 * the run queue (Phase 2), correlator + report renderer (Phase 6), and
 * supervisor agent (Phase 7).
 */

export {
  registerCheck,
  getCheck,
  listChecksForUmbrella,
  listChecksForTier,
  listAllChecks
} from './checks/registry.js';

// Side-effect imports: register all umbrella checks at module load.
import './checks/website/index.js';
import './checks/google_ads/index.js';
import './checks/meta/index.js';
import './checks/ctm/index.js';

export {
  getCredential,
  putCredential,
  validateCredential,
  rotateCredential,
  deleteCredential,
  listCredentialsForClient
} from './credentialStore.js';

export { executeRun } from './runExecutor.js';

export { createCostTracker } from './costTracker.js';

export { enqueueRun, publishCancelSignal } from './runQueue.js';
