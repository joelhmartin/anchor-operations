/**
 * Rate Limiting Service
 *
 * Provides protection against brute force attacks on authentication endpoints.
 * Implements both IP-based and user-based rate limiting.
 */

import crypto from 'crypto';
import { query } from '../../db.js';
import { logSecurityEvent, SecurityEventTypes, SecurityEventCategories } from './audit.js';

// Configuration
const RATE_LIMIT_CONFIG = {
  login_ip: {
    maxAttempts: parseInt(process.env.LOGIN_RATE_LIMIT_IP_MAX || '10', 10),
    windowMinutes: parseInt(process.env.LOGIN_RATE_LIMIT_IP_WINDOW || '15', 10),
    lockoutMinutes: parseInt(process.env.LOGIN_RATE_LIMIT_IP_LOCKOUT || '15', 10)
  },
  login_user: {
    maxAttempts: parseInt(process.env.LOGIN_RATE_LIMIT_USER_MAX || '5', 10),
    windowMinutes: parseInt(process.env.LOGIN_RATE_LIMIT_USER_WINDOW || '15', 10),
    lockoutMinutes: parseInt(process.env.LOGIN_RATE_LIMIT_USER_LOCKOUT || '30', 10)
  },
  mfa_user: {
    maxAttempts: 5,
    windowMinutes: 10,
    lockoutMinutes: 30
  },
  mfa_ip: {
    maxAttempts: 20,
    windowMinutes: 10,
    lockoutMinutes: 30
  },
  password_reset_ip: {
    maxAttempts: 5,
    windowMinutes: 60,
    lockoutMinutes: 60
  },
  ctm_embed_load_ip: {
    maxAttempts: 20,
    windowMinutes: 10,
    lockoutMinutes: 10
  },
  ctm_embed_submit_ip: {
    maxAttempts: 5,
    windowMinutes: 15,
    lockoutMinutes: 15
  },
  operations_assistant_user: {
    maxAttempts: 30,
    windowMinutes: 5,
    lockoutMinutes: 5
  },
  operations_exec_user: {
    maxAttempts: 60,
    windowMinutes: 5,
    lockoutMinutes: 5
  }
};

/**
 * Hash an IP address for storage (privacy consideration)
 */
function hashIp(ip) {
  if (!ip) return 'unknown';
  // Use a keyed hash for IP privacy while maintaining uniqueness
  const key = process.env.RATE_LIMIT_SALT || 'anchor-rate-limit';
  return crypto.createHmac('sha256', key).update(ip).digest('hex').substring(0, 32);
}

/**
 * Get or create a rate limit record
 */
async function getRateLimitRecord(limitKey, limitType) {
  const { rows } = await query(
    `SELECT * FROM auth_rate_limits WHERE limit_key = $1 AND limit_type = $2`,
    [limitKey, limitType]
  );
  return rows[0] || null;
}

/**
 * Check if a rate limit applies and track the attempt
 *
 * @param {string} limitType - Type of limit ('login_ip', 'login_user', 'mfa_user', 'password_reset_ip')
 * @param {string} identifier - The identifier to limit (IP hash, user ID, etc.)
 * @returns {Object} { allowed: boolean, remaining: number, retryAfter: number|null }
 */
export async function checkRateLimit(limitType, identifier) {
  const config = RATE_LIMIT_CONFIG[limitType];
  if (!config) {
    console.warn(`[rate-limit] Unknown limit type: ${limitType}`);
    return { allowed: true, remaining: 999, retryAfter: null };
  }

  const limitKey = limitType.includes('_ip') ? hashIp(identifier) : identifier;
  const record = await getRateLimitRecord(limitKey, limitType);
  const now = new Date();

  // Check if currently locked out
  if (record?.locked_until && new Date(record.locked_until) > now) {
    const retryAfter = Math.ceil((new Date(record.locked_until) - now) / 1000);
    return {
      allowed: false,
      remaining: 0,
      retryAfter,
      locked: true
    };
  }

  // Check if we need to reset the window
  if (record) {
    const windowStart = new Date(record.first_attempt_at);
    const windowEnd = new Date(windowStart.getTime() + config.windowMinutes * 60 * 1000);

    if (now > windowEnd) {
      // Window expired, reset
      await query(`DELETE FROM auth_rate_limits WHERE id = $1`, [record.id]);
      return { allowed: true, remaining: config.maxAttempts - 1, retryAfter: null };
    }

    // Within window, check attempts
    if (record.attempts >= config.maxAttempts) {
      // Lock out
      const lockoutUntil = new Date(now.getTime() + config.lockoutMinutes * 60 * 1000);
      await query(`UPDATE auth_rate_limits SET locked_until = $1 WHERE id = $2`, [lockoutUntil, record.id]);

      return {
        allowed: false,
        remaining: 0,
        retryAfter: config.lockoutMinutes * 60,
        locked: true
      };
    }

    return {
      allowed: true,
      remaining: config.maxAttempts - record.attempts,
      retryAfter: null
    };
  }

  // No record yet
  return { allowed: true, remaining: config.maxAttempts, retryAfter: null };
}

/**
 * Record a rate-limited attempt (call after checkRateLimit if proceeding)
 */
export async function recordAttempt(limitType, identifier) {
  const config = RATE_LIMIT_CONFIG[limitType];
  if (!config) return;

  const limitKey = limitType.includes('_ip') ? hashIp(identifier) : identifier;

  await query(
    `INSERT INTO auth_rate_limits (limit_key, limit_type, attempts, first_attempt_at, last_attempt_at)
     VALUES ($1, $2, 1, NOW(), NOW())
     ON CONFLICT (limit_key, limit_type)
     DO UPDATE SET
       attempts = auth_rate_limits.attempts + 1,
       last_attempt_at = NOW()`,
    [limitKey, limitType]
  );
}

/**
 * Clear rate limit on successful authentication
 */
export async function clearRateLimit(limitType, identifier) {
  const limitKey = limitType.includes('_ip') ? hashIp(identifier) : identifier;
  await query(`DELETE FROM auth_rate_limits WHERE limit_key = $1 AND limit_type = $2`, [limitKey, limitType]);
}

/**
 * Lock a user account after too many failures
 */
export async function lockUserAccount(userId, reason = 'too_many_failed_attempts') {
  const lockoutMinutes = parseInt(process.env.ACCOUNT_LOCKOUT_MINUTES || '30', 10);
  const lockoutUntil = new Date(Date.now() + lockoutMinutes * 60 * 1000);

  await query(`UPDATE users SET locked_until = $1 WHERE id = $2`, [lockoutUntil, userId]);

  await logSecurityEvent({
    userId,
    eventType: SecurityEventTypes.ACCOUNT_LOCKED,
    eventCategory: SecurityEventCategories.ACCOUNT,
    success: true,
    details: { reason, lockoutMinutes }
  });

  return lockoutUntil;
}

/**
 * Check if a user account is locked
 */
export async function isUserLocked(userId) {
  const { rows } = await query(`SELECT locked_until FROM users WHERE id = $1`, [userId]);

  if (!rows[0] || !rows[0].locked_until) {
    return { locked: false };
  }

  const lockedUntil = new Date(rows[0].locked_until);
  if (lockedUntil > new Date()) {
    return {
      locked: true,
      until: lockedUntil,
      retryAfter: Math.ceil((lockedUntil - new Date()) / 1000)
    };
  }

  // Lock expired, clear it
  await query(`UPDATE users SET locked_until = NULL WHERE id = $1`, [userId]);
  return { locked: false };
}

/**
 * Unlock a user account (admin action)
 */
export async function unlockUserAccount(userId, adminId) {
  await query(`UPDATE users SET locked_until = NULL, failed_login_count = 0 WHERE id = $1`, [userId]);

  await logSecurityEvent({
    userId,
    eventType: SecurityEventTypes.ACCOUNT_UNLOCKED,
    eventCategory: SecurityEventCategories.ACCOUNT,
    success: true,
    details: { unlockedBy: adminId }
  });
}

/**
 * Increment failed login count for a user
 */
export async function recordFailedLogin(userId) {
  const { rows } = await query(
    `UPDATE users
     SET failed_login_count = failed_login_count + 1
     WHERE id = $1
     RETURNING failed_login_count`,
    [userId]
  );

  const failedCount = rows[0]?.failed_login_count || 0;
  const maxFailures = parseInt(process.env.MAX_LOGIN_FAILURES || '5', 10);

  // Auto-lock after too many failures
  if (failedCount >= maxFailures) {
    await lockUserAccount(userId, 'too_many_failed_attempts');
    return { locked: true, failedCount };
  }

  return { locked: false, failedCount };
}

/**
 * Reset failed login count (on successful login)
 */
export async function resetFailedLogins(userId) {
  await query(`UPDATE users SET failed_login_count = 0 WHERE id = $1`, [userId]);
}

/**
 * Clean up expired rate limit records (run periodically)
 */
export async function cleanupExpiredRateLimits() {
  const { rowCount } = await query(
    `DELETE FROM auth_rate_limits
     WHERE last_attempt_at < NOW() - INTERVAL '24 hours'
       AND (locked_until IS NULL OR locked_until < NOW())`
  );
  return rowCount;
}

/**
 * Get rate limit status for display
 */
export function getRateLimitConfig(limitType) {
  return RATE_LIMIT_CONFIG[limitType] || null;
}

