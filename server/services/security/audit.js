/**
 * Security Audit Logging Service
 *
 * Provides immutable audit trail for security-relevant events.
 * Required for HIPAA, SOC 2, and enterprise compliance.
 *
 * IMPORTANT: Never log sensitive data like passwords, tokens, or secrets.
 */

import { query } from '../../db.js';

/**
 * Event types for categorization
 */
export const SecurityEventTypes = {
  // Authentication
  LOGIN_SUCCESS: 'login_success',
  LOGIN_FAILED: 'login_failed',
  LOGOUT: 'logout',
  PASSWORD_RESET_REQUESTED: 'password_reset_requested',
  PASSWORD_RESET_COMPLETED: 'password_reset_completed',
  PASSWORD_CHANGED: 'password_changed',

  // Session
  SESSION_CREATED: 'session_created',
  SESSION_ENDED: 'session_ended',
  SESSION_REVOKED: 'session_revoked',
  SESSION_REFRESH_FAILED: 'session_refresh_failed',
  ALL_SESSIONS_ENDED: 'all_sessions_ended',
  TOKEN_REUSE_DETECTED: 'token_reuse_detected',

  // MFA
  MFA_CHALLENGE_SENT: 'mfa_challenge_sent',
  MFA_CHALLENGE_SUCCESS: 'mfa_challenge_success',
  MFA_CHALLENGE_FAILED: 'mfa_challenge_failed',
  MFA_ENABLED: 'mfa_enabled',
  MFA_DISABLED: 'mfa_disabled',
  MFA_SETTINGS_CHANGED: 'mfa_settings_changed',

  // Account
  ACCOUNT_CREATED: 'account_created',
  ACCOUNT_LOCKED: 'account_locked',
  ACCOUNT_UNLOCKED: 'account_unlocked',
  EMAIL_VERIFIED: 'email_verified',
  EMAIL_CHANGED: 'email_changed',

  // OAuth
  OAUTH_CONNECTED: 'oauth_connected',
  OAUTH_DISCONNECTED: 'oauth_disconnected',
  OAUTH_LOGIN: 'oauth_login',

  // Device Trust
  DEVICE_TRUSTED: 'device_trusted',
  DEVICE_UNTRUSTED: 'device_untrusted',
  DEVICE_REVOKED: 'device_revoked',

  // Access
  SENSITIVE_ACTION: 'sensitive_action',
  PERMISSION_DENIED: 'permission_denied',
  IMPERSONATION_START: 'impersonation_start',
  IMPERSONATION_END: 'impersonation_end',

  // Ownership transfer (privilege change — write to immutable audit trail in addition to activity_log)
  OWNERSHIP_TRANSFERRED: 'ownership_transferred',
  OWNERSHIP_TRANSFER_QUEUED: 'ownership_transfer_queued',
  OWNERSHIP_TRANSFER_COMPLETED: 'ownership_transfer_completed',
  OWNERSHIP_TRANSFER_CANCELED: 'ownership_transfer_canceled',

  // Operations / agent
  OPERATIONS_TOOL_PROPOSED: 'operations.tool_proposed',
  OPERATIONS_TOOL_APPROVED: 'operations.tool_approved',
  OPERATIONS_TOOL_EXECUTED: 'operations.tool_executed',
  OPERATIONS_TOOL_REJECTED: 'operations.tool_rejected',
  OPERATIONS_RUN_MANUAL_OVERRIDE_BUDGET: 'operations.run_manual_override_budget',
  // Command Center pivot — Discovery state machine
  OPERATIONS_DISCOVERY_STATUS_CHANGE: 'operations.discovery_status_change',
  OPERATIONS_DISCOVERY_ASSIGNED: 'operations.discovery_assigned',
  OPERATIONS_DISCOVERY_IGNORED: 'operations.discovery_ignored',
  // Skills management
  OPERATIONS_SKILL_CREATE: 'operations.skill_create',
  OPERATIONS_SKILL_VERSION_SAVE: 'operations.skill_version_save',
  OPERATIONS_SKILL_ARCHIVE: 'operations.skill_archive',
  OPERATIONS_SKILL_SUGGESTION_APPROVE: 'operations.skill_suggestion_approve',
  OPERATIONS_SKILL_SUGGESTION_REJECT: 'operations.skill_suggestion_reject',
  // Recipes management
  OPERATIONS_RECIPE_CREATE: 'operations.recipe_create',
  OPERATIONS_RECIPE_UPDATE: 'operations.recipe_update',
  OPERATIONS_RECIPE_ARCHIVE: 'operations.recipe_archive',
  // Bulk schedules
  OPERATIONS_BULK_SCHEDULE_CREATE: 'operations.bulk_schedule_create',
  OPERATIONS_BULK_SCHEDULE_UPDATE: 'operations.bulk_schedule_update',
  OPERATIONS_BULK_SCHEDULE_DELETE: 'operations.bulk_schedule_delete',
  OPERATIONS_BULK_SCHEDULE_RUN_NOW: 'operations.bulk_schedule_run_now',
  // Credential management
  OPERATIONS_CREDENTIAL_DELETED: 'operations.credential_deleted'
};

/**
 * Event categories for filtering
 */
export const SecurityEventCategories = {
  AUTHENTICATION: 'authentication',
  SESSION: 'session',
  MFA: 'mfa',
  ACCOUNT: 'account',
  ACCESS: 'access',
  OAUTH: 'oauth',
  OPERATIONS: 'operations'
};

/**
 * Log a security event to the audit trail
 *
 * @param {Object} event - The event to log
 * @param {string} event.eventType - Type of event (from SecurityEventTypes)
 * @param {string} event.eventCategory - Category (from SecurityEventCategories)
 * @param {string} [event.userId] - User ID if known
 * @param {string} [event.sessionId] - Session ID if known
 * @param {string} [event.ipAddress] - Client IP address
 * @param {string} [event.userAgent] - Client user agent
 * @param {string} [event.countryCode] - Country code from IP
 * @param {string} [event.deviceId] - Device identifier
 * @param {boolean} event.success - Whether the action succeeded
 * @param {string} [event.failureReason] - Reason for failure if success=false
 * @param {Object} [event.details] - Additional details (no sensitive data!)
 */
export async function logSecurityEvent(event) {
  const {
    userId,
    sessionId,
    eventType,
    eventCategory,
    ipAddress,
    userAgent,
    countryCode,
    deviceId,
    success,
    failureReason,
    details = {}
  } = event;

  // Derive category if not provided
  const category = eventCategory || deriveCategory(eventType);

  // Sanitize details to ensure no sensitive data
  const sanitizedDetails = sanitizeDetails(details);

  try {
    await query(
      `INSERT INTO security_audit_log (
        user_id, session_id, event_type, event_category,
        ip_address, user_agent, country_code, device_id,
        success, failure_reason, details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        userId || null,
        sessionId || null,
        eventType,
        category,
        ipAddress || null,
        userAgent || null,
        countryCode || null,
        deviceId || null,
        success,
        failureReason || null,
        sanitizedDetails
      ]
    );
  } catch (err) {
    // Audit logging should never break the application flow
    // Log to console as fallback
    console.error('[security-audit] Failed to log event:', err.message);
    console.error('[security-audit] Event:', JSON.stringify({ eventType, userId, success }));
  }
}

/**
 * Derive event category from event type
 */
function deriveCategory(eventType) {
  if (eventType.startsWith('login') || eventType.startsWith('logout') || eventType.startsWith('password')) {
    return SecurityEventCategories.AUTHENTICATION;
  }
  if (eventType.startsWith('session') || eventType.includes('token')) {
    return SecurityEventCategories.SESSION;
  }
  if (eventType.startsWith('mfa')) {
    return SecurityEventCategories.MFA;
  }
  if (eventType.startsWith('account') || eventType.startsWith('email')) {
    return SecurityEventCategories.ACCOUNT;
  }
  if (eventType.startsWith('oauth')) {
    return SecurityEventCategories.OAUTH;
  }
  if (eventType.startsWith('operations.')) {
    return SecurityEventCategories.OPERATIONS;
  }
  return SecurityEventCategories.ACCESS;
}

/**
 * Sanitize details object to remove any sensitive data
 */
function sanitizeDetails(details) {
  if (!details || typeof details !== 'object') {
    return {};
  }

  const sensitiveKeys = [
    'password',
    'token',
    'secret',
    'key',
    'hash',
    'otp',
    'code',
    'credential',
    'authorization',
    'cookie',
    'refresh_token',
    'access_token'
  ];

  const sanitized = {};

  for (const [key, value] of Object.entries(details)) {
    const lowerKey = key.toLowerCase();

    // Skip sensitive keys
    if (sensitiveKeys.some((sk) => lowerKey.includes(sk))) {
      continue;
    }

    // Recursively sanitize nested objects
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      sanitized[key] = sanitizeDetails(value);
    } else {
      sanitized[key] = value;
    }
  }

  return sanitized;
}

/**
 * Query audit logs for a specific user
 */
export async function getUserAuditLogs(userId, options = {}) {
  const { limit = 50, offset = 0, category, eventType, startDate, endDate } = options;

  let sql = `
    SELECT id, event_type, event_category, ip_address, user_agent,
           country_code, device_id, success, failure_reason, details, created_at
    FROM security_audit_log
    WHERE user_id = $1
  `;
  const params = [userId];
  let paramIndex = 2;

  if (category) {
    sql += ` AND event_category = $${paramIndex++}`;
    params.push(category);
  }

  if (eventType) {
    sql += ` AND event_type = $${paramIndex++}`;
    params.push(eventType);
  }

  if (startDate) {
    sql += ` AND created_at >= $${paramIndex++}`;
    params.push(startDate);
  }

  if (endDate) {
    sql += ` AND created_at <= $${paramIndex++}`;
    params.push(endDate);
  }

  sql += ` ORDER BY created_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex}`;
  params.push(limit, offset);

  const { rows } = await query(sql, params);
  return rows;
}

/**
 * Get recent security events for admin dashboard
 */
export async function getRecentSecurityEvents(options = {}) {
  const { limit = 100, categories = [], eventTypes = [], success = null } = options;

  let sql = `
    SELECT sal.*, u.email as user_email, u.first_name, u.last_name
    FROM security_audit_log sal
    LEFT JOIN users u ON u.id = sal.user_id
    WHERE 1=1
  `;
  const params = [];
  let paramIndex = 1;

  if (categories.length > 0) {
    sql += ` AND event_category = ANY($${paramIndex++})`;
    params.push(categories);
  }

  if (eventTypes.length > 0) {
    sql += ` AND event_type = ANY($${paramIndex++})`;
    params.push(eventTypes);
  }

  if (success !== null) {
    sql += ` AND success = $${paramIndex++}`;
    params.push(success);
  }

  sql += ` ORDER BY created_at DESC LIMIT $${paramIndex}`;
  params.push(limit);

  const { rows } = await query(sql, params);
  return rows;
}

/**
 * Get security statistics for a time period
 */
export async function getSecurityStats(hours = 24) {
  const { rows } = await query(
    `
    SELECT
      event_type,
      success,
      COUNT(*) as count
    FROM security_audit_log
    WHERE created_at > NOW() - ($1 || ' hours')::INTERVAL
    GROUP BY event_type, success
    ORDER BY count DESC
  `,
    [hours]
  );

  const stats = {
    loginSuccess: 0,
    loginFailed: 0,
    mfaChallenges: 0,
    mfaFailed: 0,
    sessionsCreated: 0,
    sessionsRevoked: 0,
    suspiciousActivity: 0
  };

  for (const row of rows) {
    if (row.event_type === 'login_success' && row.success) {
      stats.loginSuccess = parseInt(row.count, 10);
    } else if (row.event_type === 'login_failed') {
      stats.loginFailed = parseInt(row.count, 10);
    } else if (row.event_type === 'mfa_challenge_sent') {
      stats.mfaChallenges = parseInt(row.count, 10);
    } else if (row.event_type === 'mfa_challenge_failed') {
      stats.mfaFailed = parseInt(row.count, 10);
    } else if (row.event_type === 'session_created') {
      stats.sessionsCreated = parseInt(row.count, 10);
    } else if (row.event_type === 'session_revoked' || row.event_type === 'all_sessions_ended') {
      stats.sessionsRevoked += parseInt(row.count, 10);
    } else if (row.event_type === 'token_reuse_detected') {
      stats.suspiciousActivity += parseInt(row.count, 10);
    }
  }

  return stats;
}

/**
 * Log a login attempt (convenience method)
 */
export async function logLoginAttempt(params) {
  const { userId, success, failureReason, ipAddress, userAgent, deviceId, countryCode, method = 'password' } = params;

  await logSecurityEvent({
    userId,
    eventType: success ? SecurityEventTypes.LOGIN_SUCCESS : SecurityEventTypes.LOGIN_FAILED,
    eventCategory: SecurityEventCategories.AUTHENTICATION,
    ipAddress,
    userAgent,
    deviceId,
    countryCode,
    success,
    failureReason,
    details: { method }
  });
}

/**
 * Log an MFA challenge (convenience method)
 */
export async function logMfaChallenge(params) {
  const { userId, challengeType, success, failureReason, ipAddress, userAgent, triggerReason } = params;

  await logSecurityEvent({
    userId,
    eventType: success ? SecurityEventTypes.MFA_CHALLENGE_SUCCESS : SecurityEventTypes.MFA_CHALLENGE_FAILED,
    eventCategory: SecurityEventCategories.MFA,
    ipAddress,
    userAgent,
    success,
    failureReason,
    details: { challengeType, triggerReason }
  });
}

