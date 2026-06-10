/**
 * Operations check registry — Phase 1 skeleton.
 *
 * Checks register themselves at module load via registerCheck(). The run
 * executor (and Phase 2 orchestrator) discover handlers by check_id.
 *
 * Each registration carries:
 *   - umbrella       'website' | 'google_ads' | 'meta'
 *   - tier           'daily_essential' | 'weekly_deep' | 'monthly_audit' | 'on_demand'
 *   - handler        async (ctx) => { status, severity?, payload?, cost_cents? }
 *   - costEstimate   integer cents (rough upper bound, used by budget gate)
 *   - requires       array of platform keys for credential resolution
 */

const REGISTRY = new Map();

const VALID_UMBRELLAS = new Set(['website', 'google_ads', 'meta', 'ctm']);
const VALID_TIERS = new Set(['daily_essential', 'weekly_deep', 'monthly_audit', 'on_demand']);

export function registerCheck(checkId, definition = {}) {
  if (typeof checkId !== 'string' || !checkId) {
    throw new Error('registerCheck: checkId must be a non-empty string');
  }
  if (REGISTRY.has(checkId)) {
    // Re-registration is permitted (e.g. hot-reload in dev) but warn loudly.
    console.warn(`[ops/registry] check_id already registered: ${checkId} — overwriting`);
  }
  const {
    umbrella,
    tier,
    handler,
    costEstimate = 0,
    requires = []
  } = definition;

  if (!VALID_UMBRELLAS.has(umbrella)) {
    throw new Error(`registerCheck(${checkId}): invalid umbrella "${umbrella}"`);
  }
  if (!VALID_TIERS.has(tier)) {
    throw new Error(`registerCheck(${checkId}): invalid tier "${tier}"`);
  }
  if (typeof handler !== 'function') {
    throw new Error(`registerCheck(${checkId}): handler must be a function`);
  }
  if (!Array.isArray(requires)) {
    throw new Error(`registerCheck(${checkId}): requires must be an array`);
  }

  REGISTRY.set(checkId, {
    checkId,
    umbrella,
    tier,
    handler,
    costEstimate: Number.isFinite(costEstimate) ? costEstimate : 0,
    requires
  });
}

export function getCheck(checkId) {
  return REGISTRY.get(checkId) || null;
}

export function listChecksForUmbrella(umbrella) {
  return Array.from(REGISTRY.values()).filter((c) => c.umbrella === umbrella);
}

export function listChecksForTier(tier) {
  return Array.from(REGISTRY.values()).filter((c) => c.tier === tier);
}

export function listAllChecks() {
  return Array.from(REGISTRY.values());
}

// Test-only escape hatch.
export function _resetRegistryForTests() {
  REGISTRY.clear();
}
