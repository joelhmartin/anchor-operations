/**
 * Pure deterministic risk scorer (north-star §16: NO LLM math). Higher = riskier.
 * Inputs are already-computed numbers; this module never touches DB/LLM/network.
 */
export const SEVERITY_WEIGHTS = { critical: 100, warning: 40, info: 10 };

const TIER_ORDER = ['low', 'medium', 'high', 'critical'];

export function tierFromScore(score) {
  if (score >= 85) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

function bumpTier(tier) {
  const i = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.min(TIER_ORDER.length - 1, (i < 0 ? 0 : i) + 1)];
}

export function scoreRisk(riskInput = {}, context = {}) {
  const {
    severity = 'info',
    affectedPlatformCount = 1,
    businessImpact = false,
    baselineDelta = null
  } = riskInput;
  const {
    clientType = null,
    destructive = false,
    mutating = false,
    budgetDeltaCents = 0
  } = context;

  const severityWeight = SEVERITY_WEIGHTS[severity] ?? 10;
  // Each extra affected platform adds 20%, capped at +60%.
  const platformFactor = 1 + Math.min(0.6, Math.max(0, affectedPlatformCount - 1) * 0.2);
  const impactFactor = businessImpact ? 1.5 : 1.0;
  // F3 baseline: sigma-above-normal. null ⇒ neutral. Each sigma adds 15%, cap +60%.
  const baselineFactor = baselineDelta == null ? 1.0 : 1 + Math.min(0.6, Math.max(0, baselineDelta) * 0.15);
  // Any budget increase adds 30%; mutating but non-budget adds 10%.
  const budgetFactor = budgetDeltaCents > 0 ? 1.3 : (mutating ? 1.1 : 1.0);

  const raw = severityWeight * platformFactor * impactFactor * baselineFactor * budgetFactor;
  const score = Math.round(raw * 100) / 100;

  let tier = tierFromScore(score);
  if (clientType === 'medical') tier = bumpTier(tier);
  if (destructive) tier = 'critical';

  return {
    score,
    tier,
    factors: { severityWeight, platformFactor, impactFactor, baselineFactor, budgetFactor, destructive: Boolean(destructive) }
  };
}

export default { scoreRisk, tierFromScore, SEVERITY_WEIGHTS };
