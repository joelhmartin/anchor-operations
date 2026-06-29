/**
 * Reuses the existing ops_tool_approvals four-event audit chain
 * (operations.tool_proposed/approved/executed/rejected). No new event types.
 * `logger` is injectable for tests.
 */
import { logSecurityEvent, SecurityEventTypes, SecurityEventCategories } from '../../security/audit.js';

const CAT = SecurityEventCategories.OPERATIONS;

export async function auditProposed({ userId, clientUserId, recommendationId, approvalId, providerActionType, argsHash }, logger = logSecurityEvent) {
  return logger({
    userId, eventType: SecurityEventTypes.OPERATIONS_TOOL_PROPOSED, eventCategory: CAT, success: true,
    details: { source: 'action_engine', clientUserId: clientUserId || null, recommendationId, approvalId, providerActionType, argsHash }
  });
}

export async function auditApproved({ userId, recommendationId, approvalId, providerActionType }, logger = logSecurityEvent) {
  return logger({
    userId, eventType: SecurityEventTypes.OPERATIONS_TOOL_APPROVED, eventCategory: CAT, success: true,
    details: { source: 'action_engine', recommendationId, approvalId, providerActionType }
  });
}

export async function auditExecuted({ userId, recommendationId, approvalId, providerActionType, success, failureReason = null }, logger = logSecurityEvent) {
  return logger({
    userId, eventType: SecurityEventTypes.OPERATIONS_TOOL_EXECUTED, eventCategory: CAT, success: Boolean(success),
    failureReason: success ? null : String(failureReason || 'action_error').slice(0, 200),
    details: { source: 'action_engine', recommendationId, approvalId, providerActionType }
  });
}

export async function auditRejected({ userId, recommendationId, approvalId, reason }, logger = logSecurityEvent) {
  return logger({
    userId, eventType: SecurityEventTypes.OPERATIONS_TOOL_REJECTED, eventCategory: CAT, success: true,
    details: { source: 'action_engine', recommendationId, approvalId, reason: String(reason || '').slice(0, 200) || null }
  });
}

export default { auditProposed, auditApproved, auditExecuted, auditRejected };
