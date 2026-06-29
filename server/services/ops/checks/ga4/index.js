import { registerCheck } from '../registry.js';
import { GA4_CHECKS } from '../../connections/ga4/checks/index.js';

for (const check of GA4_CHECKS) {
  registerCheck(check.id, {
    serviceCategory: 'analytics',
    provider: 'ga4',
    requiredCapabilities: check.requiredCapabilities || [],
    tier: check.tier,
    handler: check.handler
  });
}
