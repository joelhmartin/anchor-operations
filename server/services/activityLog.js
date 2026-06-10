/**
 * User Activity Logging Service
 *
 * Comprehensive activity tracking for all user actions.
 * Provides audit trail for admin visibility into user behavior.
 * 30-day data retention with automatic cleanup.
 *
 * IMPORTANT: Never log PHI, passwords, tokens, or secrets in details.
 */

import { query } from '../db.js';

/**
 * Activity action types
 */
export const ActivityEventTypes = {
  // Authentication
  LOGIN: 'login',
  LOGOUT: 'logout',

  // Client operations
  VIEW_CLIENT: 'view_client',
  EDIT_CLIENT: 'edit_client',
  CREATE_CLIENT: 'create_client',
  DELETE_CLIENT: 'delete_client',
  ACTIVATE_CLIENT: 'activate_client',
  DEACTIVATE_CLIENT: 'deactivate_client',

  // Task operations
  VIEW_TASK: 'view_task',
  CREATE_TASK: 'create_task',
  UPDATE_TASK: 'update_task',
  COMPLETE_TASK: 'complete_task',
  DELETE_TASK: 'delete_task',

  // Document operations
  UPLOAD_DOCUMENT: 'upload_document',
  VIEW_DOCUMENT: 'view_document',
  DELETE_DOCUMENT: 'delete_document',

  // Form operations
  VIEW_FORM: 'view_form',
  SUBMIT_FORM: 'submit_form',
  CREATE_FORM: 'create_form',
  EDIT_FORM: 'edit_form',
  DELETE_FORM: 'delete_form',

  // Review operations
  VIEW_REVIEW: 'view_review',
  RESPOND_REVIEW: 'respond_review',

  // Admin operations
  IMPERSONATE_START: 'impersonate_start',
  IMPERSONATE_END: 'impersonate_end',
  EXPORT_DATA: 'export_data',

  // Navigation
  PAGE_VIEW: 'page_view',

  // Team operations
  INVITE_TEAM_MEMBER: 'invite_team_member',
  REMOVE_TEAM_MEMBER: 'remove_team_member',
  LEAVE_TEAM: 'leave_team',

  // Ownership transfer lifecycle
  OWNERSHIP_TRANSFERRED: 'ownership_transferred',
  OWNERSHIP_TRANSFER_QUEUED: 'ownership_transfer_queued',
  OWNERSHIP_TRANSFER_COMPLETED: 'ownership_transfer_completed',
  OWNERSHIP_TRANSFER_COMPLETED_DISPLACED_GONE: 'ownership_transfer_completed_displaced_gone',
  OWNERSHIP_TRANSFER_CANCELED: 'ownership_transfer_canceled',

  // Notification settings
  UPDATE_NOTIFICATION_SETTINGS: 'update_notification_settings',

  // Additional form operations
  PUBLISH_FORM: 'publish_form',
  ARCHIVE_FORM: 'archive_form',
  DUPLICATE_FORM: 'duplicate_form',

  // Call log lifecycle
  HIDE_CALL: 'hide_call',
  HIDE_CALL_SINGLE: 'hide_call_single',
  UNHIDE_CALL: 'unhide_call',

  // Lead journey lifecycle
  START_JOURNEY: 'start_journey',
  ADVANCE_JOURNEY_STAGE: 'advance_journey_stage',
  SEND_JOURNEY_EMAIL: 'send_journey_email',
  LOG_JOURNEY_CALL: 'log_journey_call',
  ADD_JOURNEY_NOTE: 'add_journey_note',
  ADD_LEAD_NOTE: 'add_lead_note',
  ARCHIVE_JOURNEY: 'archive_journey',
  CONVERT_TO_CLIENT: 'convert_to_client'
};

/**
 * Activity categories for filtering
 */
export const ActivityCategories = {
  AUTHENTICATION: 'authentication',
  CLIENT: 'client',
  TASK: 'task',
  DOCUMENT: 'document',
  FORM: 'form',
  REVIEW: 'review',
  ADMIN: 'admin',
  TEAM: 'team',
  NAVIGATION: 'navigation',
  LEAD: 'lead'
};

/**
 * Human-friendly labels for CSV export (server-owned mirror of the frontend display maps in
 * src/api/activityLogs.js — server cannot import from src/). Keep roughly in sync; exact string
 * parity is not load-bearing. Falls back to a title-cased action key when unmapped.
 */
export const ACTION_LABELS = {
  login: 'Logged In',
  logout: 'Logged Out',
  view_client: 'Viewed Client',
  edit_client: 'Edited Client',
  create_client: 'Created Client',
  delete_client: 'Deleted Client',
  activate_client: 'Activated Client',
  deactivate_client: 'Deactivated Client',
  view_task: 'Viewed Task',
  create_task: 'Created Task',
  update_task: 'Updated Task',
  complete_task: 'Completed Task',
  delete_task: 'Deleted Task',
  upload_document: 'Uploaded Document',
  view_document: 'Viewed Document',
  delete_document: 'Deleted Document',
  view_form: 'Viewed Form',
  submit_form: 'Submitted Form',
  create_form: 'Created Form',
  edit_form: 'Edited Form',
  delete_form: 'Deleted Form',
  publish_form: 'Published Form',
  archive_form: 'Archived Form',
  duplicate_form: 'Duplicated Form',
  view_review: 'Viewed Review',
  respond_review: 'Responded to Review',
  page_view: 'Viewed Page',
  invite_team_member: 'Invited Team Member',
  remove_team_member: 'Removed Team Member',
  leave_team: 'Left Team',
  update_notification_settings: 'Updated Notification Settings',
  start_journey: 'Started Lead Journey',
  advance_journey_stage: 'Advanced Journey Stage',
  send_journey_email: 'Sent Journey Email',
  log_journey_call: 'Logged Journey Call',
  add_journey_note: 'Added Journey Note',
  add_lead_note: 'Added Lead Note',
  archive_journey: 'Archived Journey',
  convert_to_client: 'Converted to Client',
  hide_call: 'Hid Call',
  hide_call_single: 'Hid Call',
  unhide_call: 'Unhid Call'
};

export const CATEGORY_LABELS = {
  authentication: 'Authentication',
  client: 'Client',
  task: 'Task',
  document: 'Document',
  form: 'Form',
  review: 'Review',
  admin: 'Admin',
  team: 'Team',
  navigation: 'Navigation',
  lead: 'Lead'
};

/** Friendly label for an action_type, with a title-cased fallback for unmapped keys. */
export function getActionLabel(actionType) {
  if (!actionType) return '';
  return ACTION_LABELS[actionType] || String(actionType).replace(/_/g, ' ').replace(/\b\w/g, (l) => l.toUpperCase());
}

/** Friendly label for an action_category, with a title-cased fallback. */
export function getCategoryLabel(category) {
  if (!category) return '';
  return CATEGORY_LABELS[category] || String(category).replace(/\b\w/g, (l) => l.toUpperCase());
}

/**
 * Log a user activity event
 *
 * @param {Object} event - The activity event to log
 * @param {string} event.userId - ID of the user performing the action
 * @param {string} event.actionType - Type of action (from ActivityEventTypes)
 * @param {string} event.actionCategory - Category (from ActivityCategories)
 * @param {string} [event.targetUserId] - ID of target user (for client operations)
 * @param {string} [event.targetEntityType] - Type of entity ('task', 'form', 'document', 'review')
 * @param {string} [event.targetEntityId] - ID of the target entity
 * @param {string} [event.ipAddress] - Client IP address
 * @param {string} [event.userAgent] - Client user agent
 * @param {Object} [event.details] - Additional details (no PHI or secrets!)
 */
export async function logUserActivity(event) {
  const { userId, actionType, actionCategory, targetUserId, targetEntityType, targetEntityId, ipAddress, userAgent, details = {} } = event;

  // Derive category if not provided
  const category = actionCategory || deriveCategory(actionType);

  // Sanitize details to ensure no sensitive data
  const sanitizedDetails = sanitizeDetails(details);

  try {
    await query(
      `INSERT INTO user_activity_logs (
        user_id, target_user_id, target_entity_type, target_entity_id,
        action_type, action_category, ip_address, user_agent, details
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        userId,
        targetUserId || null,
        targetEntityType || null,
        targetEntityId || null,
        actionType,
        category,
        ipAddress || null,
        userAgent || null,
        sanitizedDetails
      ]
    );
  } catch (err) {
    // Activity logging should never break the application flow
    console.error('[activity-log] Failed to log event:', err.message);
    console.error('[activity-log] Event:', JSON.stringify({ actionType, userId, category }));
  }
}

/**
 * Derive category from action type
 */
function deriveCategory(actionType) {
  if (actionType === 'login' || actionType === 'logout') {
    return ActivityCategories.AUTHENTICATION;
  }
  if (actionType === 'page_view') {
    return ActivityCategories.NAVIGATION;
  }
  if (actionType.includes('team') || actionType.includes('member') || actionType.includes('invite') || actionType.includes('leave')) {
    return ActivityCategories.TEAM;
  }
  if (actionType === 'update_notification_settings') {
    return ActivityCategories.CLIENT;
  }
  if (actionType === 'convert_to_client') {
    return ActivityCategories.CLIENT; // it creates a client
  }
  if (actionType.includes('journey') || actionType === 'add_lead_note') {
    return ActivityCategories.LEAD;
  }
  if (actionType.includes('client')) {
    return ActivityCategories.CLIENT;
  }
  if (actionType.includes('task')) {
    return ActivityCategories.TASK;
  }
  if (actionType.includes('document')) {
    return ActivityCategories.DOCUMENT;
  }
  if (actionType.includes('form')) {
    return ActivityCategories.FORM;
  }
  if (actionType.includes('review')) {
    return ActivityCategories.REVIEW;
  }
  if (actionType.includes('impersonate') || actionType.includes('export')) {
    return ActivityCategories.ADMIN;
  }
  return ActivityCategories.CLIENT; // Default
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
    'access_token',
    'ssn',
    'social_security',
    'dob',
    'date_of_birth',
    'medical',
    'diagnosis',
    'health',
    'insurance_id',
    'phone',
    'note',
    'body',
    'subject',
    'message',
    'address'
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
 * Log client-related activity (convenience method)
 *
 * @param {Object} params - Activity parameters
 * @param {string} params.userId - User performing the action
 * @param {string} params.actionType - The action type
 * @param {string} params.targetUserId - The client being acted upon
 * @param {string} [params.ipAddress] - Client IP
 * @param {string} [params.userAgent] - Client user agent
 * @param {Object} [params.details] - Additional details
 */
export async function logClientActivity(params) {
  const { userId, actionType, targetUserId, ipAddress, userAgent, details = {} } = params;

  await logUserActivity({
    userId,
    actionType,
    actionCategory: ActivityCategories.CLIENT,
    targetUserId,
    ipAddress,
    userAgent,
    details
  });
}

/**
 * Log task-related activity (convenience method)
 */
export async function logTaskActivity(params) {
  const { userId, actionType, taskId, taskName, ipAddress, userAgent, details = {} } = params;

  await logUserActivity({
    userId,
    actionType,
    actionCategory: ActivityCategories.TASK,
    targetEntityType: 'task',
    targetEntityId: taskId,
    ipAddress,
    userAgent,
    details: { taskName, ...details }
  });
}

/**
 * Log form-related activity (convenience method)
 */
export async function logFormActivity(params) {
  const { userId, actionType, formId, formName, submissionId, ipAddress, userAgent, details = {} } = params;

  await logUserActivity({
    userId,
    actionType,
    actionCategory: ActivityCategories.FORM,
    targetEntityType: submissionId ? 'form_submission' : 'form',
    targetEntityId: submissionId || formId,
    ipAddress,
    userAgent,
    details: { formName, formId, ...details }
  });
}

/**
 * Log document-related activity (convenience method)
 */
export async function logDocumentActivity(params) {
  const { userId, actionType, documentId, documentName, ipAddress, userAgent, details = {} } = params;

  await logUserActivity({
    userId,
    actionType,
    actionCategory: ActivityCategories.DOCUMENT,
    targetEntityType: 'document',
    targetEntityId: documentId,
    ipAddress,
    userAgent,
    details: { documentName, ...details }
  });
}

/**
 * Log review-related activity (convenience method)
 */
export async function logReviewActivity(params) {
  const { userId, actionType, reviewId, ipAddress, userAgent, details = {} } = params;

  await logUserActivity({
    userId,
    actionType,
    actionCategory: ActivityCategories.REVIEW,
    targetEntityType: 'review',
    targetEntityId: reviewId,
    ipAddress,
    userAgent,
    details
  });
}

/**
 * Log authentication activity (convenience method)
 */
export async function logAuthActivity(params) {
  const { userId, actionType, ipAddress, userAgent, details = {} } = params;

  await logUserActivity({
    userId,
    actionType,
    actionCategory: ActivityCategories.AUTHENTICATION,
    ipAddress,
    userAgent,
    details
  });
}

/**
 * Fetch activity logs with pagination, filtering, and search
 *
 * @param {Object} options - Query options
 * @param {string} [options.userId] - Filter by specific user
 * @param {number} [options.page=1] - Page number
 * @param {number} [options.limit=50] - Results per page
 * @param {string} [options.search] - Search in details
 * @param {string} [options.category] - Filter by category
 * @param {string} [options.actionType] - Filter by action type
 * @param {string} [options.startDate] - Filter from date (ISO string)
 * @param {string} [options.endDate] - Filter to date (ISO string)
 * @returns {Object} { logs, pagination }
 */
export async function fetchActivityLogs(options = {}) {
  const {
    userId,
    accountOwnerId,
    includeOwner = false,
    excludeCategories,
    omitNetworkFields = false,
    page = 1,
    limit = 50,
    search,
    category,
    actionType,
    startDate,
    endDate
  } = options;

  // Return empty results structure for graceful degradation
  const emptyResult = {
    logs: [],
    pagination: {
      page,
      limit,
      total: 0,
      totalPages: 0,
      hasMore: false
    }
  };

  try {
    const offset = (page - 1) * limit;
    const params = [];
    let paramIndex = 1;

    // Build WHERE clause
    let whereClause = 'WHERE 1=1';

    if (accountOwnerId) {
      // Admin callers get members-only scope (existing behavior). Portal callers pass
      // includeOwner so the account owner's own rows are included alongside active members.
      if (includeOwner) {
        whereClause += ` AND (
          ual.user_id = $${paramIndex}
          OR ual.user_id IN (
            SELECT member_user_id FROM client_account_members
            WHERE client_owner_id = $${paramIndex} AND status = 'active'
          )
        )`;
        paramIndex++;
      } else {
        whereClause += ` AND ual.user_id IN (
          SELECT member_user_id FROM client_account_members
          WHERE client_owner_id = $${paramIndex++} AND status = 'active'
        )`;
      }
      params.push(accountOwnerId);
    } else if (userId) {
      whereClause += ` AND ual.user_id = $${paramIndex++}`;
      params.push(userId);
    }

    if (Array.isArray(excludeCategories) && excludeCategories.length) {
      whereClause += ` AND ual.action_category <> ALL($${paramIndex++})`;
      params.push(excludeCategories);
    }

    if (category) {
      whereClause += ` AND ual.action_category = $${paramIndex++}`;
      params.push(category);
    }

    if (actionType) {
      whereClause += ` AND ual.action_type = $${paramIndex++}`;
      params.push(actionType);
    }

    if (startDate) {
      whereClause += ` AND ual.created_at >= $${paramIndex++}`;
      params.push(startDate);
    }

    if (endDate) {
      whereClause += ` AND ual.created_at <= $${paramIndex++}`;
      params.push(endDate);
    }

    if (search) {
      // Search in details JSONB and action_type
      whereClause += ` AND (
        ual.details::text ILIKE $${paramIndex} OR
        ual.action_type ILIKE $${paramIndex}
      )`;
      params.push(`%${search}%`);
      paramIndex++;
    }

    // Count total
    const countSql = `
      SELECT COUNT(*) as total
      FROM user_activity_logs ual
      ${whereClause}
    `;
    const { rows: countRows } = await query(countSql, params);
    const total = parseInt(countRows[0].total, 10);

    // Fetch logs with user info
    const logsSql = `
      SELECT
        ual.id,
        ual.user_id,
        ual.target_user_id,
        ual.target_entity_type,
        ual.target_entity_id,
        ual.action_type,
        ual.action_category,
        ${omitNetworkFields ? '' : 'ual.ip_address,\n        ual.user_agent,'}
        ual.details,
        ual.created_at,
        u.email as user_email,
        u.first_name as user_first_name,
        u.last_name as user_last_name,
        tu.email as target_user_email,
        tu.first_name as target_user_first_name,
        tu.last_name as target_user_last_name
      FROM user_activity_logs ual
      LEFT JOIN users u ON u.id = ual.user_id
      LEFT JOIN users tu ON tu.id = ual.target_user_id
      ${whereClause}
      ORDER BY ual.created_at DESC
      LIMIT $${paramIndex++} OFFSET $${paramIndex}
    `;
    params.push(limit, offset);

    const { rows: logs } = await query(logsSql, params);

    const totalPages = Math.ceil(total / limit);

    return {
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasMore: page < totalPages
      }
    };
  } catch (err) {
    // If table doesn't exist or other error, return empty results gracefully
    // This prevents the feature from breaking the app if not yet migrated
    console.error('[activity-log] Failed to fetch logs:', err.message);
    return emptyResult;
  }
}

/**
 * Purge activity logs older than the retention period
 *
 * @param {number} retentionDays - Days to retain (default 30)
 * @returns {Object} { deleted: number }
 */
export async function purgeOldActivityLogs(retentionDays = 30) {
  try {
    const { rows } = await query(
      `DELETE FROM user_activity_logs
       WHERE created_at < NOW() - ($1 || ' days')::INTERVAL
       RETURNING id`,
      [retentionDays]
    );

    const deleted = rows.length;
    if (deleted > 0) {
      console.log(`[activity-log] Purged ${deleted} logs older than ${retentionDays} days`);
    }

    return { deleted };
  } catch (err) {
    console.error('[activity-log] Failed to purge old logs:', err.message);
    return { deleted: 0, error: err.message };
  }
}

/**
 * Get activity statistics for a time period
 *
 * @param {number} hours - Time period in hours (default 24)
 * @returns {Object} Stats by category and action type
 */
export async function getActivityStats(hours = 24) {
  const { rows } = await query(
    `SELECT
      action_category,
      action_type,
      COUNT(*) as count
    FROM user_activity_logs
    WHERE created_at > NOW() - ($1 || ' hours')::INTERVAL
    GROUP BY action_category, action_type
    ORDER BY count DESC`,
    [hours]
  );

  const stats = {
    total: 0,
    byCategory: {},
    byActionType: {}
  };

  for (const row of rows) {
    const count = parseInt(row.count, 10);
    stats.total += count;
    stats.byCategory[row.action_category] = (stats.byCategory[row.action_category] || 0) + count;
    stats.byActionType[row.action_type] = count;
  }

  return stats;
}
