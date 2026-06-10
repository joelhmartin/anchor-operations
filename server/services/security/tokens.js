/**
 * Token Service - Access Token & Refresh Token Management
 *
 * Implements:
 * - Short-lived JWT access tokens (15 minutes)
 * - Opaque refresh tokens with rotation
 * - Token family tracking for reuse detection
 */

import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { query } from '../../db.js';
import { notRevoked } from '../queryHelpers.js';

// Configuration (can be overridden via environment)
const ACCESS_TOKEN_LIFETIME_SEC = parseInt(process.env.ACCESS_TOKEN_LIFETIME_SEC || '900', 10); // 15 minutes
const REFRESH_TOKEN_LIFETIME_DAYS = parseInt(process.env.REFRESH_TOKEN_LIFETIME_DAYS || '30', 10);
const ABSOLUTE_SESSION_LIFETIME_DAYS = parseInt(process.env.ABSOLUTE_SESSION_LIFETIME_DAYS || '90', 10);

/**
 * Generate a cryptographically secure random token
 */
export function generateSecureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * Hash a token for storage (never store tokens in plaintext)
 */
export function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Sign a short-lived JWT access token
 */
export function signAccessToken(payload) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  const { userId, sessionId, role, effectiveRole } = payload;

  return jwt.sign(
    {
      sub: userId,
      sid: sessionId,
      role,
      eff: effectiveRole,
      type: 'access'
    },
    process.env.JWT_SECRET,
    {
      expiresIn: ACCESS_TOKEN_LIFETIME_SEC,
      algorithm: 'HS256'
    }
  );
}

/**
 * Verify and decode an access token
 * Returns the payload if valid, null if invalid/expired
 */
export function verifyAccessToken(token) {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET, {
      algorithms: ['HS256']
    });

    // Ensure it's an access token
    if (payload.type !== 'access') {
      return null;
    }

    return {
      userId: payload.sub,
      sessionId: payload.sid,
      role: payload.role,
      effectiveRole: payload.eff
    };
  } catch (err) {
    // Token is invalid or expired
    return null;
  }
}

/**
 * Create a new session with refresh token
 * Returns both the raw refresh token (to send to client) and session details
 */
export async function createSession({
  userId,
  deviceId,
  deviceFingerprint,
  deviceName,
  ipAddress,
  userAgent,
  countryCode,
  city,
  isTrusted = false
}) {
  const refreshToken = generateSecureToken(32);
  const refreshTokenHash = hashToken(refreshToken);
  const tokenFamily = crypto.randomUUID();

  const now = new Date();
  const refreshExpiry = new Date(now.getTime() + REFRESH_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
  const absoluteExpiry = new Date(now.getTime() + ABSOLUTE_SESSION_LIFETIME_DAYS * 24 * 60 * 60 * 1000);
  const trustedUntil = isTrusted ? new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000) : null;

  const { rows } = await query(
    `INSERT INTO user_sessions (
      user_id, refresh_token_hash, refresh_token_family,
      device_id, device_fingerprint, device_name,
      ip_address, user_agent, country_code, city,
      is_trusted, trusted_until,
      absolute_expiry_at, refresh_expiry_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
    RETURNING id, created_at`,
    [
      userId,
      refreshTokenHash,
      tokenFamily,
      deviceId,
      deviceFingerprint,
      deviceName,
      ipAddress,
      userAgent,
      countryCode,
      city,
      isTrusted,
      trustedUntil,
      absoluteExpiry,
      refreshExpiry
    ]
  );

  const session = rows[0];

  return {
    sessionId: session.id,
    refreshToken,
    refreshExpiry,
    absoluteExpiry,
    createdAt: session.created_at
  };
}

/**
 * Refresh a session - rotate the refresh token
 * Implements token rotation with reuse detection
 *
 * @returns null if token is invalid/revoked/reused
 * @returns session data with new refresh token if valid
 */
export async function refreshSession(oldRefreshToken, { ipAddress, userAgent }) {
  const oldTokenHash = hashToken(oldRefreshToken);

  // Find the session by current refresh token hash
  let { rows: sessionRows } = await query(
    `SELECT s.*, u.role, u.email, u.first_name, u.last_name, u.avatar_url, u.is_demo,
            cp.onboarding_completed_at, cp.activated_at
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN client_profiles cp ON cp.user_id = u.id
     WHERE s.refresh_token_hash = $1
     LIMIT 1`,
    [oldTokenHash]
  );

  // Grace period: if the current token doesn't match but the previous one does
  // (concurrent refresh rotated the token), accept it within a 60-second window.
  // This prevents logouts caused by visibility/focus/interval handlers racing.
  if (!sessionRows[0]) {
    const { rows: graceRows } = await query(
      `SELECT s.*, u.role, u.email, u.first_name, u.last_name, u.avatar_url, u.is_demo,
              cp.onboarding_completed_at, cp.activated_at
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
       LEFT JOIN client_profiles cp ON cp.user_id = u.id
       WHERE s.prev_refresh_token_hash = $1
         AND s.last_activity_at > NOW() - INTERVAL '60 seconds'
         AND ${notRevoked('s')}
       LIMIT 1`,
      [oldTokenHash]
    );
    sessionRows = graceRows;
  }

  const session = sessionRows[0];

  if (!session) {
    return { error: 'invalid_token', session: null };
  }

  // Check if session is revoked
  if (session.revoked_at) {
    return { error: 'session_revoked', session: null, reason: session.revoked_reason };
  }

  // Check if refresh token is expired
  if (new Date(session.refresh_expiry_at) < new Date()) {
    return { error: 'refresh_expired', session: null };
  }

  // Check absolute session lifetime
  if (new Date(session.absolute_expiry_at) < new Date()) {
    // Revoke the session
    await query(
      `UPDATE user_sessions SET revoked_at = NOW(), revoked_reason = 'absolute_expiry' WHERE id = $1`,
      [session.id]
    );
    return { error: 'session_expired', session: null };
  }

  // Token is valid - rotate it
  const newRefreshToken = generateSecureToken(32);
  const newRefreshTokenHash = hashToken(newRefreshToken);
  const newRefreshExpiry = new Date(Date.now() + REFRESH_TOKEN_LIFETIME_DAYS * 24 * 60 * 60 * 1000);

  // Don't extend beyond absolute expiry
  const effectiveRefreshExpiry =
    newRefreshExpiry > new Date(session.absolute_expiry_at)
      ? new Date(session.absolute_expiry_at)
      : newRefreshExpiry;

  await query(
    `UPDATE user_sessions
     SET prev_refresh_token_hash = refresh_token_hash,
         refresh_token_hash = $1,
         refresh_expiry_at = $2,
         last_activity_at = NOW(),
         ip_address = COALESCE($3, ip_address),
         user_agent = COALESCE($4, user_agent)
     WHERE id = $5`,
    [newRefreshTokenHash, effectiveRefreshExpiry, ipAddress, userAgent, session.id]
  );

  return {
    error: null,
    session: {
      id: session.id,
      userId: session.user_id,
      role: session.role,
      email: session.email,
      first_name: session.first_name,
      last_name: session.last_name,
      avatar_url: session.avatar_url,
      is_demo: session.is_demo || false,
      deviceId: session.device_id,
      isTrusted: session.is_trusted,
      onboarding_completed_at: session.onboarding_completed_at || null,
      activated_at: session.activated_at || null
    },
    newRefreshToken,
    refreshExpiry: effectiveRefreshExpiry
  };
}

/**
 * Detect refresh token reuse (same family, different token)
 * If detected, revoke ALL sessions in that family
 */
export async function detectTokenReuse(refreshToken) {
  const tokenHash = hashToken(refreshToken);

  // Check if this exact token exists
  const { rows: exactMatch } = await query(
    `SELECT id, refresh_token_family FROM user_sessions WHERE refresh_token_hash = $1`,
    [tokenHash]
  );

  if (exactMatch.length > 0) {
    // Token exists, no reuse detected
    return false;
  }

  // Token doesn't exist - but we can't detect reuse without the family
  // This is handled in refreshSession - if token not found, it's either
  // already rotated (reuse) or never existed (invalid)
  return true;
}

/**
 * Revoke a specific session
 */
export async function revokeSession(sessionId, reason = 'logout') {
  const { rowCount } = await query(
    `UPDATE user_sessions
     SET revoked_at = NOW(), revoked_reason = $1
     WHERE id = $2 AND ${notRevoked()}`,
    [reason, sessionId]
  );
  return rowCount > 0;
}

/**
 * Revoke all sessions for a user
 * Optionally exclude current session
 */
export async function revokeAllUserSessions(userId, reason = 'logout_all', exceptSessionId = null) {
  if (exceptSessionId) {
    const { rowCount } = await query(
      `UPDATE user_sessions
       SET revoked_at = NOW(), revoked_reason = $1
       WHERE user_id = $2 AND ${notRevoked()} AND id != $3`,
      [reason, userId, exceptSessionId]
    );
    return rowCount;
  }

  const { rowCount } = await query(
    `UPDATE user_sessions
     SET revoked_at = NOW(), revoked_reason = $1
     WHERE user_id = $2 AND ${notRevoked()}`,
    [reason, userId]
  );
  return rowCount;
}

/**
 * Revoke all sessions in a token family (for reuse detection)
 */
export async function revokeTokenFamily(familyId) {
  const { rowCount } = await query(
    `UPDATE user_sessions
     SET revoked_at = NOW(), revoked_reason = 'reuse_detected'
     WHERE refresh_token_family = $1 AND ${notRevoked()}`,
    [familyId]
  );
  return rowCount;
}

/**
 * Get session by ID (for validation)
 */
export async function getSession(sessionId) {
  const { rows } = await query(
    `SELECT s.*, u.role, u.email, u.first_name, u.last_name
     FROM user_sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = $1`,
    [sessionId]
  );
  return rows[0] || null;
}

/**
 * Check if a session is valid (not revoked, not expired)
 */
export async function isSessionValid(sessionId) {
  const { rows } = await query(
    `SELECT id FROM user_sessions
     WHERE id = $1
       AND ${notRevoked()}
       AND refresh_expiry_at > NOW()
       AND absolute_expiry_at > NOW()`,
    [sessionId]
  );
  return rows.length > 0;
}

/**
 * Update session last activity timestamp
 */
export async function touchSession(sessionId) {
  await query(`UPDATE user_sessions SET last_activity_at = NOW() WHERE id = $1`, [sessionId]);
}

/**
 * Get all active sessions for a user
 */
export async function getUserActiveSessions(userId) {
  const { rows } = await query(
    `SELECT id, device_id, device_name, device_fingerprint,
            ip_address, user_agent, country_code, city,
            is_trusted, created_at, last_activity_at
     FROM user_sessions
     WHERE user_id = $1
       AND ${notRevoked()}
       AND refresh_expiry_at > NOW()
       AND absolute_expiry_at > NOW()
     ORDER BY last_activity_at DESC`,
    [userId]
  );
  return rows;
}

/**
 * Get token expiry times for configuration
 */
export function getTokenConfig() {
  return {
    accessTokenLifetimeSec: ACCESS_TOKEN_LIFETIME_SEC,
    refreshTokenLifetimeDays: REFRESH_TOKEN_LIFETIME_DAYS,
    absoluteSessionLifetimeDays: ABSOLUTE_SESSION_LIFETIME_DAYS
  };
}

