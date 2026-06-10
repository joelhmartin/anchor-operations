/**
 * Authentication Middleware
 *
 * Validates access tokens and enforces role-based access control.
 * Works with short-lived JWT access tokens (15 min).
 */

import { query } from '../db.js';
import { resolveActiveClientAccount } from '../services/clientAccounts.js';
import { getEffectiveRole } from '../utils/roles.js';
import {
  verifyAccessToken,
  validateSession,
  touchSession,
  logSecurityEvent,
  SecurityEventCategories,
  hashToken
} from '../services/security/index.js';
import { notRevoked } from '../services/queryHelpers.js';

/**
 * Require authentication via Bearer token
 *
 * Validates the access token and attaches user info to request.
 * For backward compatibility, also supports legacy cookie-based auth during migration.
 */
export async function requireAuth(req, res, next) {
  try {
    let payload = null;

    // Check Authorization header (preferred for API calls)
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const accessToken = authHeader.substring(7);
      payload = verifyAccessToken(accessToken);
    }

    // Fallback: Check session cookie (for browser navigation, e.g., OAuth redirects)
    if (!payload && req.cookies?.session) {
      payload = verifyAccessToken(req.cookies.session);
    }

    // Token not found or invalid
    if (!payload) {
      return res.status(401).json({
        message: 'Authentication required',
        code: 'TOKEN_EXPIRED_OR_INVALID'
      });
    }

    // Validate session is still active (not revoked)
    const sessionCheck = await validateSession(payload.sessionId);
    if (!sessionCheck.valid) {
      return res.status(401).json({
        message: 'Session expired or revoked',
        code: 'SESSION_INVALID',
        reason: sessionCheck.reason
      });
    }

    // Get user details
    const { rows } = await query(
      `SELECT id, first_name, last_name, email, role, created_at, avatar_url, is_demo
       FROM users WHERE id = $1 LIMIT 1`,
      [payload.userId]
    );

    const user = rows[0];
    if (!user) {
      return res.status(401).json({
        message: 'User not found',
        code: 'USER_NOT_FOUND'
      });
    }

    // Get effective role
    const effectiveRole = await getEffectiveRole(user.role);

    // Attach to request
    req.user = {
      ...user,
      effective_role: effectiveRole
    };
    req.sessionId = payload.sessionId;
    req.portalUserId = user.id;
    req.actingClient = null;
    req.activeClientAccountId = null;
    req.clientAccountRole = null; // Role within client account (owner/admin/member)

    // Handle "act as client" for staff (admin/team) viewing client data
    if ((effectiveRole === 'superadmin' || effectiveRole === 'admin' || effectiveRole === 'team') && req.headers['x-acting-user']) {
      const actingId = String(req.headers['x-acting-user']);
      if (actingId && actingId !== user.id) {
        const { rows: actingRows } = await query('SELECT id, role, is_demo FROM users WHERE id = $1 LIMIT 1', [actingId]);
        const target = actingRows[0];
        if (target && target.role === 'client') {
          req.portalUserId = target.id;
          req.actingClient = target;
          logSecurityEvent({
            eventType: 'client_impersonation',
            eventCategory: SecurityEventCategories.ACCESS,
            userId: user.id,
            success: true,
            details: { targetUserId: target.id, targetIsDemo: target.is_demo, method: req.method, path: req.path }
          }).catch(() => {});
        }
      }
    }

    // For any user with an active client_account_members row, resolve portalUserId.
    // This ensures invited members see the same data as the account owner,
    // regardless of whether users.role is 'client' or something else.
    if (!req.actingClient) {
      const requestedClientAccountId = req.headers['x-client-account'] ? String(req.headers['x-client-account']) : null;
      const { activeAccount } = await resolveActiveClientAccount(user.id, requestedClientAccountId, { userRole: user.role });

      if (activeAccount) {
        req.portalUserId = activeAccount.clientOwnerId;
        req.activeClientAccountId = activeAccount.clientOwnerId;
        req.clientAccountRole = activeAccount.membershipRole;
      }
    }

    // Touch session to track activity (async, don't wait)
    touchSession(payload.sessionId).catch(() => {});

    next();
  } catch (err) {
    console.error('[requireAuth]', err);
    return res.status(401).json({
      message: 'Authentication failed',
      code: 'AUTH_ERROR'
    });
  }
}

/**
 * Require admin or superadmin role
 */
export function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: 'Login required', code: 'NOT_AUTHENTICATED' });
  }
  const userRole = req.user.effective_role || req.user.role;
  if (userRole !== 'superadmin' && userRole !== 'admin') {
    return res.status(403).json({ message: 'Admin access required', code: 'FORBIDDEN' });
  }
  next();
}

/**
 * Require superadmin role
 */
export function requireSuperadmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ message: 'Login required', code: 'NOT_AUTHENTICATED' });
  }
  const userRole = req.user.effective_role || req.user.role;
  if (userRole !== 'superadmin') {
    return res.status(403).json({ message: 'Superadmin only', code: 'FORBIDDEN' });
  }
  next();
}

/**
 * Require any of the specified roles
 */
export function requireAnyRole(roles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Login required', code: 'NOT_AUTHENTICATED' });
    }
    const userRole = req.user.effective_role || req.user.role;
    if (!roles.includes(userRole)) {
      return res.status(403).json({
        message: `Access denied. Required roles: ${roles.join(', ')}`,
        code: 'FORBIDDEN'
      });
    }
    next();
  };
}

/**
 * Optional authentication - doesn't fail if no token
 * Useful for routes that work differently for authenticated vs anonymous users
 */
export async function optionalAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
      // No token provided - continue without user
      req.user = null;
      return next();
    }

    const accessToken = authHeader.substring(7);
    const payload = verifyAccessToken(accessToken);

    if (!payload) {
      // Invalid token - continue without user
      req.user = null;
      return next();
    }

    // Validate session
    const sessionCheck = await validateSession(payload.sessionId);
    if (!sessionCheck.valid) {
      req.user = null;
      return next();
    }

    // Get user
    const { rows } = await query(
      `SELECT id, first_name, last_name, email, role, created_at, avatar_url, is_demo
       FROM users WHERE id = $1 LIMIT 1`,
      [payload.userId]
    );

    if (rows.length === 0) {
      req.user = null;
      return next();
    }

    const effectiveRole = await getEffectiveRole(rows[0].role);
    req.user = { ...rows[0], effective_role: effectiveRole };
    req.sessionId = payload.sessionId;
    req.portalUserId = rows[0].id;

    next();
  } catch {
    // On error, continue without user
    req.user = null;
    next();
  }
}

/**
 * Resolve a user + session from the httpOnly `refresh_token` cookie, READ-ONLY.
 *
 * Unlike the /auth/refresh flow this does NOT rotate the token or mint an access
 * token — it only confirms the cookie maps to a live (non-revoked, non-expired)
 * session and returns the owning user/session ids. Safe to call on idempotent GETs
 * (file loads) without risking token churn or racing concurrent refreshes.
 *
 * @returns {{ userId: string, sessionId: string } | null}
 */
async function resolveSessionFromRefreshCookie(refreshToken) {
  if (!refreshToken) return null;
  const tokenHash = hashToken(refreshToken);
  const { rows } = await query(
    `SELECT id, user_id, refresh_expiry_at, absolute_expiry_at
       FROM user_sessions
      WHERE refresh_token_hash = $1 AND ${notRevoked()}
      LIMIT 1`,
    [tokenHash]
  );
  const session = rows[0];
  if (!session) return null;
  const now = new Date();
  if (session.refresh_expiry_at && new Date(session.refresh_expiry_at) < now) return null;
  if (session.absolute_expiry_at && new Date(session.absolute_expiry_at) < now) return null;
  return { userId: session.user_id, sessionId: session.id };
}

/**
 * Attach a resolved user to the request (mirrors optionalAuth's user shape).
 * Returns true on success, false if the user row no longer exists.
 */
async function attachResolvedUser(req, userId, sessionId) {
  const { rows } = await query(
    `SELECT id, first_name, last_name, email, role, created_at, avatar_url, is_demo
       FROM users WHERE id = $1 LIMIT 1`,
    [userId]
  );
  if (!rows.length) return false;
  const effectiveRole = await getEffectiveRole(rows[0].role);
  req.user = { ...rows[0], effective_role: effectiveRole };
  req.sessionId = sessionId;
  req.portalUserId = rows[0].id;
  return true;
}

/**
 * Optional auth for file-serving routes (`/api/files/:id`).
 *
 * Files are linked from the UI as plain `<a href>` / `<img src>` to /api/files/:id,
 * so the request is a top-level browser navigation or subresource load that CANNOT
 * carry an `Authorization: Bearer` header. To authenticate those, we accept either:
 *   1. a Bearer access token (normal XHR/fetch path), or
 *   2. the httpOnly `refresh_token` cookie the browser already holds (navigation path),
 *      validated read-only (no rotation) via resolveSessionFromRefreshCookie().
 *
 * The cookie is SameSite=Lax: it is NOT sent on cross-site subresource loads
 * (`<img>`, fetch, iframe) or non-GET requests, so this cannot be abused to embed/
 * exfiltrate a file from an attacker page. On cross-site top-level navigation the
 * file renders in a new tab the attacker cannot read (CORP same-origin is set).
 *
 * Either way this only grants the access the user's live session already has — the
 * per-file authorization in serveFile()/userCanAccessFile() still runs on top. On
 * any failure req.user stays null and serveFile() responds 403/404.
 */
export async function optionalFileAuth(req, res, next) {
  req.user = null;
  try {
    // 1. Bearer access token (preferred when the request is an XHR/fetch).
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      const payload = verifyAccessToken(authHeader.substring(7));
      if (payload) {
        const sessionCheck = await validateSession(payload.sessionId);
        if (sessionCheck.valid && (await attachResolvedUser(req, payload.userId, payload.sessionId))) {
          return next();
        }
      }
    }

    // 2. Fallback: refresh_token cookie (top-level navigation / <a href> / <img src>).
    const resolved = await resolveSessionFromRefreshCookie(req.cookies?.refresh_token);
    if (resolved) {
      await attachResolvedUser(req, resolved.userId, resolved.sessionId);
    }
  } catch {
    req.user = null;
  }
  return next();
}

/**
 * Require step-up authentication for sensitive actions
 * Checks that the session was recently authenticated (within 5 minutes)
 */
export async function requireRecentAuth(req, res, next) {
  if (!req.user || !req.sessionId) {
    return res.status(401).json({
      message: 'Authentication required',
      code: 'NOT_AUTHENTICATED'
    });
  }

  // Get session last activity
  const { rows } = await query(`SELECT last_activity_at FROM user_sessions WHERE id = $1`, [req.sessionId]);

  if (rows.length === 0) {
    return res.status(401).json({
      message: 'Session not found',
      code: 'SESSION_NOT_FOUND'
    });
  }

  const lastActivity = new Date(rows[0].last_activity_at);
  const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

  if (lastActivity < fiveMinutesAgo) {
    return res.status(403).json({
      message: 'Please re-authenticate to perform this action',
      code: 'REAUTHENTICATION_REQUIRED'
    });
  }

  next();
}

/**
 * Rate-aware middleware that checks if user is being rate limited
 * For use on sensitive endpoints
 */
export function checkUserRateLimit(limitType) {
  return async (req, res, next) => {
    if (!req.user) {
      return next();
    }

    const { checkRateLimit } = await import('../services/security/rateLimit.js');
    const check = await checkRateLimit(limitType, req.user.id);

    if (!check.allowed) {
      return res.status(429).json({
        message: 'Too many requests. Please try again later.',
        retryAfter: check.retryAfter,
        code: 'RATE_LIMIT_EXCEEDED'
      });
    }

    next();
  };
}
