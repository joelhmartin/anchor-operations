/**
 * website/gsc.js — umbrella shim (spec §4 back-compat).
 *
 * Keeps the four original web.gsc.* check IDs registered under umbrella:'website'
 * so the existing run executor dispatches them unchanged.
 *
 * All logic lives in server/services/ops/connections/gsc/checks.js.
 * Auth is now service-account primary / ADC / OAuth fallback (via resolveGscToken).
 *
 * When F1's connector registry lands, these four checks will be migrated to
 * the connector's checks[] array and this shim can be removed.
 */
import { registerCheck } from '../registry.js';
import {
  makePageIndexingIssueCheck,
  makeConnectionHealthCheck,
  makeZeroClickHighImpressionCheck,
  makeQueryOpportunityCheck
} from '../../connections/gsc/checks.js';

// web.gsc.coverage_errors — connection health proxy (original checked OAuth; now checks SA)
registerCheck('web.gsc.coverage_errors', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: makeConnectionHealthCheck()
});

// web.gsc.manual_actions — not exposed via public API; returns skipped with advisory note
registerCheck('web.gsc.manual_actions', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (_ctx) => ({
    status: 'skipped',
    payload: { reason: 'Manual actions are not exposed via the Search Console API; verify in the Google Search Console UI.' }
  })
});

// web.gsc.crux_lcp — deferred to PSI check; keep registered as skipped placeholder
registerCheck('web.gsc.crux_lcp', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: async (_ctx) => ({
    status: 'skipped',
    payload: { reason: 'CrUX LCP is captured by web.psi; this check is a placeholder for per-page CrUX rollouts.' }
  })
});

// web.gsc.indexed_pages_drop — promoted to the full page indexing check
registerCheck('web.gsc.indexed_pages_drop', {
  umbrella: 'website',
  tier: 'weekly_deep',
  costEstimate: 0,
  requires: [],
  handler: makePageIndexingIssueCheck()
});
