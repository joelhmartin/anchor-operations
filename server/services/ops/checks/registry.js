/**
 * Operations check registry — F1 reframe.
 *
 * A check is classified by (serviceCategory, provider) and MAY declare
 * requiredCapabilities. The LEGACY `umbrella` field is still accepted: when
 * present, (serviceCategory, provider) are DERIVED from it (spec §4 shim), so
 * every shipped umbrella check registers UNCHANGED.
 *
 * Each registration carries:
 *   - umbrella           'website' | 'google_ads' | 'meta' | 'ctm' (legacy; optional for new checks)
 *   - serviceCategory    e.g. 'website' | 'paid_ads' | 'analytics' (derived from umbrella if omitted)
 *   - provider           e.g. 'public_http' | 'google_ads' | 'ga4' (derived from umbrella if omitted)
 *   - requiredCapabilities  string[] — gate; empty (default) → never gated (legacy behavior)
 *   - tier               'daily_essential' | 'weekly_deep' | 'monthly_audit' | 'on_demand'
 *   - handler            async (ctx) => { status, severity?, payload?, cost_cents? }
 *   - costEstimate       integer cents (rough upper bound, used by budget gate)
 *   - requires           array of platform keys for credential resolution
 */
import { deriveFromUmbrella, umbrellaFromCategoryProvider } from '../connections/umbrellaMap.js';

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
    serviceCategory: explicitCategory,
    provider: explicitProvider,
    requiredCapabilities = [],
    tier,
    handler,
    costEstimate = 0,
    requires = []
  } = definition;

  // --- resolve classification (umbrella shim OR explicit contract) ---
  let serviceCategory = explicitCategory;
  let provider = explicitProvider;

  if (umbrella !== undefined) {
    if (!VALID_UMBRELLAS.has(umbrella)) {
      throw new Error(`registerCheck(${checkId}): invalid umbrella "${umbrella}"`);
    }
    const derived = deriveFromUmbrella(umbrella);
    serviceCategory = serviceCategory || derived.serviceCategory;
    provider = provider || derived.provider;
  }

  if (!serviceCategory || !provider) {
    throw new Error(
      `registerCheck(${checkId}): must provide umbrella OR both serviceCategory and provider`
    );
  }

  // Back-fill a legacy umbrella for ops_check_results.umbrella (NOT NULL). Prefer
  // the explicit umbrella; else reverse-derive; else fall back to serviceCategory.
  const resolvedUmbrella = umbrella || umbrellaFromCategoryProvider(serviceCategory, provider) || serviceCategory;

  if (!VALID_TIERS.has(tier)) {
    throw new Error(`registerCheck(${checkId}): invalid tier "${tier}"`);
  }
  if (typeof handler !== 'function') {
    throw new Error(`registerCheck(${checkId}): handler must be a function`);
  }
  if (!Array.isArray(requires)) {
    throw new Error(`registerCheck(${checkId}): requires must be an array`);
  }
  if (!Array.isArray(requiredCapabilities)) {
    throw new Error(`registerCheck(${checkId}): requiredCapabilities must be an array`);
  }

  REGISTRY.set(checkId, {
    checkId,
    umbrella: resolvedUmbrella,
    serviceCategory,
    provider,
    requiredCapabilities,
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

export function listChecksForServiceCategory(serviceCategory) {
  return Array.from(REGISTRY.values()).filter((c) => c.serviceCategory === serviceCategory);
}

export function listChecksForProvider(provider) {
  return Array.from(REGISTRY.values()).filter((c) => c.provider === provider);
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
