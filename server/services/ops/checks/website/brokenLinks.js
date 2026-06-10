/**
 * web.broken_links — stub. Crawl + link enumeration is deferred to v2.
 *
 * Registered so run definitions referencing it produce a clean 'skipped'
 * result with a clear reason rather than an "unknown check_id" error.
 */

import { registerCheck } from '../registry.js';

registerCheck('web.broken_links', {
  umbrella: 'website',
  tier: 'monthly_audit',
  costEstimate: 0,
  requires: [],
  handler: async () => ({
    status: 'skipped',
    payload: { reason: 'broken-link crawling deferred to v2' }
  })
});
