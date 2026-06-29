/**
 * GTM check registrations — side-effect import for runExecutor.js.
 *
 * RECONCILE (F9): gtm.container_health is registered here via
 * serviceCategory+provider (no legacy umbrella needed) because F1's
 * checks/registry.js accepts that form directly.
 *
 * Imported from runExecutor.js alongside the other umbrella shims
 * (website, google_ads, meta, ctm, ga4).
 */

import { registerCheck } from '../registry.js';
import { GTM_CHECKS } from '../../connections/gtm/checks.js';

for (const check of GTM_CHECKS) {
  registerCheck(check.id, {
    serviceCategory: check.serviceCategory,
    provider: check.provider,
    requiredCapabilities: check.requiredCapabilities || [],
    tier: check.tier,
    handler: check.handler,
    costEstimate: check.costEstimate || 0
  });
}
