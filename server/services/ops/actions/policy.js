/**
 * Execution-time policy gate. Reuses the pure decideApproval rules (no duplication)
 * and re-derives the required level at execute time (defense in depth: a stale
 * persisted approval_level can never weaken the live decision).
 */
import { decideApproval, isBlocked } from '../recommendations/policyApplicator.js';

export function gateForExecution(recommendation = {}, context = {}) {
  const { clientType = null, mutationsEnabled = false, actorIsAdmin = false } = context;
  const { approvalLevel: requiredLevel, reasons } = decideApproval(
    {
      abstractActionType: recommendation.abstractActionType,
      mutating: recommendation.mutating,
      destructive: recommendation.destructive,
      budgetDeltaCents: recommendation.budgetDeltaCents,
      riskTier: recommendation.riskTier
    },
    { clientType, mutationsEnabled }
  );

  if (isBlocked(requiredLevel)) return { allow: false, requiredLevel, reasons };
  if (requiredLevel === 'admin_required' && !actorIsAdmin) {
    return { allow: false, requiredLevel, reasons: [...reasons, 'admin approval required'] };
  }
  // none (auto), approval_required (admin clicked approve), admin_required (admin actor).
  return { allow: true, requiredLevel, reasons };
}

export default { gateForExecution };
