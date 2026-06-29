/**
 * Pure policy applicator (north-star §7.8, §17.4, §17.5).
 * Decides the required approval level for a candidate action. No DB/LLM.
 * Approval vocabulary is locked: none | approval_required | admin_required | blocked.
 */
export const APPROVAL_LEVELS = ['none', 'approval_required', 'admin_required', 'blocked'];

export function escalate(a, b) {
  return APPROVAL_LEVELS[Math.max(APPROVAL_LEVELS.indexOf(a), APPROVAL_LEVELS.indexOf(b))];
}

export function requiresApproval(level) {
  return level === 'approval_required' || level === 'admin_required';
}

export function isBlocked(level) {
  return level === 'blocked';
}

export function decideApproval(action = {}, context = {}) {
  const { abstractActionType = null, mutating = false, destructive = false, budgetDeltaCents = 0, riskTier = 'low' } = action;
  const { clientType = null, mutationsEnabled = false } = context;
  const reasons = [];

  // Rule 1: advisory / non-mutating ⇒ none.
  if (!mutating || !abstractActionType) {
    return { approvalLevel: 'none', reasons: ['advisory recommendation; no mutation proposed'] };
  }

  // Rule 2: destructive ⇒ blocked (terminal).
  if (destructive) {
    return { approvalLevel: 'blocked', reasons: ['destructive action; blocked by policy (spec §8)'] };
  }

  let level = 'none';

  // Rule 3: mutations disabled by default.
  if (!mutationsEnabled) {
    level = escalate(level, 'approval_required');
    reasons.push('mutating action; mutations disabled by default');
  }
  // Rule 4: budget increase.
  if (budgetDeltaCents > 0) {
    level = escalate(level, 'approval_required');
    reasons.push(`budget increase of ${budgetDeltaCents}¢ requires approval`);
  }
  // Rule 5: critical risk.
  if (riskTier === 'critical') {
    level = escalate(level, 'admin_required');
    reasons.push('critical risk tier requires admin approval');
  }
  // Rule 6: medical client is stricter — escalate one step, floor at approval_required.
  if (clientType === 'medical') {
    if (level === 'none') level = 'approval_required';
    else level = escalate(level, 'admin_required');
    reasons.push('healthcare client policy: stricter approval');
  }

  // A mutating action never auto-runs: floor at approval_required.
  level = escalate(level, 'approval_required');
  return { approvalLevel: level, reasons };
}

export default { decideApproval, requiresApproval, isBlocked, escalate, APPROVAL_LEVELS };
