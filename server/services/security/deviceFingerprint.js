/**
 * Device Fingerprinting Service
 *
 * Provides device identification and trust management.
 * Used for conditional MFA and session tracking.
 */

import crypto from 'crypto';
import { query } from '../../db.js';
import { notRevoked } from '../queryHelpers.js';
import { logSecurityEvent, SecurityEventTypes, SecurityEventCategories } from './audit.js';

// Trust duration in days
const DEVICE_TRUST_DAYS = parseInt(process.env.DEVICE_TRUST_DAYS || '30', 10);

/**
 * Parse user agent to extract device info
 */
export function parseUserAgent(userAgent) {
  if (!userAgent) {
    return { browser: 'Unknown', os: 'Unknown', deviceName: 'Unknown Device' };
  }

  const ua = userAgent.toLowerCase();

  // Detect browser
  let browser = 'Unknown';
  if (ua.includes('firefox')) browser = 'Firefox';
  else if (ua.includes('edg/')) browser = 'Edge';
  else if (ua.includes('chrome')) browser = 'Chrome';
  else if (ua.includes('safari')) browser = 'Safari';
  else if (ua.includes('opera') || ua.includes('opr')) browser = 'Opera';

  // Detect OS
  let os = 'Unknown';
  if (ua.includes('windows')) os = 'Windows';
  else if (ua.includes('mac os x') || ua.includes('macos')) os = 'macOS';
  else if (ua.includes('linux')) os = 'Linux';
  else if (ua.includes('android')) os = 'Android';
  else if (ua.includes('iphone') || ua.includes('ipad')) os = 'iOS';
  else if (ua.includes('cros')) os = 'ChromeOS';

  const deviceName = `${browser} on ${os}`;

  return { browser, os, deviceName };
}

/**
 * Generate a stable device ID from request characteristics
 * This is sent to the client and stored in localStorage
 */
export function generateDeviceId() {
  return crypto.randomUUID();
}

/**
 * Generate a fingerprint hash from device characteristics
 * Used for detecting device changes even with same device ID
 */
export function generateFingerprint(characteristics) {
  const { userAgent, acceptLanguage, screenResolution, timezone, platform } = characteristics;

  // Create a hash of stable device characteristics
  const data = [userAgent || '', acceptLanguage || '', screenResolution || '', timezone || '', platform || ''].join('|');

  return crypto.createHash('sha256').update(data).digest('hex').substring(0, 32);
}

/**
 * Extract device characteristics from request
 */
export function extractDeviceInfo(req) {
  const userAgent = req.headers['user-agent'] || '';
  const acceptLanguage = req.headers['accept-language'] || '';

  // Client-provided fingerprint data (from frontend)
  const clientFingerprint = req.body?.deviceFingerprint || req.headers['x-device-fingerprint'];
  const clientDeviceId = req.body?.deviceId || req.headers['x-device-id'];

  const { browser, os, deviceName } = parseUserAgent(userAgent);

  // Generate fingerprint from available data
  const fingerprint = clientFingerprint || generateFingerprint({ userAgent, acceptLanguage });

  return {
    deviceId: clientDeviceId || generateDeviceId(),
    fingerprint,
    deviceName,
    browser,
    os,
    userAgent
  };
}

/**
 * Check if a device is trusted for a user
 */
export async function isDeviceTrusted(userId, deviceId, fingerprint = null) {
  const { rows } = await query(
    `SELECT id, device_fingerprint, expires_at
     FROM user_trusted_devices
     WHERE user_id = $1
       AND device_id = $2
       AND ${notRevoked()}
       AND expires_at > NOW()`,
    [userId, deviceId]
  );

  if (rows.length === 0) {
    return { trusted: false, reason: 'not_found' };
  }

  const device = rows[0];

  // Optionally verify fingerprint hasn't changed significantly
  if (fingerprint && device.device_fingerprint !== fingerprint) {
    // Fingerprint changed - could be browser update or suspicious
    // For now, still trust but flag
    return {
      trusted: true,
      fingerprintChanged: true,
      deviceRecordId: device.id
    };
  }

  // Update last used
  await query(`UPDATE user_trusted_devices SET last_used_at = NOW() WHERE id = $1`, [device.id]);

  return {
    trusted: true,
    fingerprintChanged: false,
    deviceRecordId: device.id
  };
}

/**
 * Trust a device for a user
 */
export async function trustDevice(userId, deviceInfo, context = {}) {
  const { deviceId, fingerprint, deviceName } = deviceInfo;
  const { ipAddress, userAgent } = context;

  const expiresAt = new Date(Date.now() + DEVICE_TRUST_DAYS * 24 * 60 * 60 * 1000);

  await query(
    `INSERT INTO user_trusted_devices (user_id, device_id, device_fingerprint, device_name, expires_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, NOW())
     ON CONFLICT (user_id, device_id)
     DO UPDATE SET
       device_fingerprint = $3,
       device_name = $4,
       expires_at = $5,
       last_used_at = NOW(),
       revoked_at = NULL`,
    [userId, deviceId, fingerprint, deviceName, expiresAt]
  );

  await logSecurityEvent({
    userId,
    eventType: SecurityEventTypes.DEVICE_TRUSTED,
    eventCategory: SecurityEventCategories.ACCESS,
    ipAddress,
    userAgent,
    deviceId,
    success: true,
    details: { deviceName, trustDays: DEVICE_TRUST_DAYS }
  });

  return { expiresAt };
}

/**
 * Revoke trust for a device
 */
export async function revokeDeviceTrust(userId, deviceId, context = {}) {
  const { ipAddress, userAgent, adminUserId } = context;

  const { rowCount } = await query(
    `UPDATE user_trusted_devices
     SET revoked_at = NOW()
     WHERE user_id = $1 AND device_id = $2 AND ${notRevoked()}`,
    [userId, deviceId]
  );

  if (rowCount > 0) {
    await logSecurityEvent({
      userId,
      eventType: SecurityEventTypes.DEVICE_REVOKED,
      eventCategory: SecurityEventCategories.ACCESS,
      ipAddress,
      userAgent,
      deviceId,
      success: true,
      details: { revokedBy: adminUserId || userId }
    });
  }

  return rowCount > 0;
}

/**
 * Revoke all trusted devices for a user
 */
export async function revokeAllTrustedDevices(userId, context = {}) {
  const { reason = 'user_revoke' } = context;

  const { rowCount } = await query(
    `UPDATE user_trusted_devices
     SET revoked_at = NOW()
     WHERE user_id = $1 AND ${notRevoked()}`,
    [userId]
  );

  await logSecurityEvent({
    userId,
    eventType: SecurityEventTypes.DEVICE_REVOKED,
    eventCategory: SecurityEventCategories.ACCESS,
    success: true,
    details: { reason, devicesRevoked: rowCount, revokedAll: true }
  });

  return rowCount;
}

/**
 * Get all trusted devices for a user
 */
export async function getUserTrustedDevices(userId) {
  const { rows } = await query(
    `SELECT id, device_id, device_name, trusted_at, expires_at, last_used_at
     FROM user_trusted_devices
     WHERE user_id = $1
       AND ${notRevoked()}
       AND expires_at > NOW()
     ORDER BY last_used_at DESC NULLS LAST`,
    [userId]
  );

  return rows.map((d) => ({
    id: d.id,
    deviceId: d.device_id,
    deviceName: d.device_name || 'Unknown Device',
    trustedAt: d.trusted_at,
    expiresAt: d.expires_at,
    lastUsedAt: d.last_used_at
  }));
}

/**
 * Check if this is a new device for the user
 * (never seen this device ID before)
 */
export async function isNewDevice(userId, deviceId) {
  // Check sessions first
  const { rows: sessionRows } = await query(
    `SELECT id FROM user_sessions WHERE user_id = $1 AND device_id = $2 LIMIT 1`,
    [userId, deviceId]
  );

  if (sessionRows.length > 0) {
    return false;
  }

  // Check trusted devices
  const { rows: trustedRows } = await query(
    `SELECT id FROM user_trusted_devices WHERE user_id = $1 AND device_id = $2 LIMIT 1`,
    [userId, deviceId]
  );

  return trustedRows.length === 0;
}

/**
 * Detect if location has changed significantly
 */
export async function hasLocationChanged(userId, newCountryCode, newIp) {
  if (!newCountryCode) return false;

  // Get recent sessions for comparison
  const { rows } = await query(
    `SELECT DISTINCT country_code
     FROM user_sessions
     WHERE user_id = $1
       AND country_code IS NOT NULL
       AND created_at > NOW() - INTERVAL '30 days'
     LIMIT 10`,
    [userId]
  );

  // If no previous sessions, this is effectively new
  if (rows.length === 0) {
    return false; // Don't flag as change if no history
  }

  // Check if current country is in recent countries
  const recentCountries = rows.map((r) => r.country_code);
  return !recentCountries.includes(newCountryCode);
}

/**
 * Get the time since last activity for a user
 */
export async function getLastActivityTime(userId) {
  const { rows } = await query(
    `SELECT last_activity_at
     FROM user_sessions
     WHERE user_id = $1 AND ${notRevoked()}
     ORDER BY last_activity_at DESC
     LIMIT 1`,
    [userId]
  );

  if (rows.length === 0) {
    // Check last login
    const { rows: userRows } = await query(`SELECT last_login_at FROM users WHERE id = $1`, [userId]);
    return userRows[0]?.last_login_at || null;
  }

  return rows[0].last_activity_at;
}

/**
 * Check if user has been inactive for too long
 */
export async function hasBeenInactive(userId, thresholdDays = 30) {
  const lastActivity = await getLastActivityTime(userId);

  if (!lastActivity) {
    return true; // No activity recorded
  }

  const threshold = new Date(Date.now() - thresholdDays * 24 * 60 * 60 * 1000);
  return new Date(lastActivity) < threshold;
}

