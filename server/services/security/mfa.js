/**
 * Multi-Factor Authentication Service
 *
 * Implements conditional MFA with email OTP as the initial method.
 * Architecture supports future TOTP and WebAuthn expansion.
 */

import crypto from 'crypto';
import { query } from '../../db.js';
import { hashToken } from './tokens.js';
import { logSecurityEvent, SecurityEventTypes, SecurityEventCategories, logMfaChallenge } from './audit.js';
import { isDeviceTrusted, isNewDevice, hasLocationChanged, hasBeenInactive } from './deviceFingerprint.js';
import { sendMailgunMessageWithLogging, isMailgunConfigured } from '../mailgun.js';

// Configuration
const OTP_LENGTH = 6;
const OTP_EXPIRY_MINUTES = parseInt(process.env.MFA_OTP_EXPIRY_MINUTES || '10', 10);
const MAX_OTP_ATTEMPTS = parseInt(process.env.MFA_MAX_ATTEMPTS || '5', 10);
const INACTIVITY_THRESHOLD_DAYS = parseInt(process.env.MFA_INACTIVITY_DAYS || '30', 10);

/**
 * MFA trigger reasons
 */
export const MfaTriggerReasons = {
  NEW_DEVICE: 'new_device',
  NEW_IP: 'new_ip',
  NEW_COUNTRY: 'new_country',
  INACTIVITY: 'inactivity',
  SENSITIVE_ACTION: 'sensitive_action',
  ALWAYS_REQUIRED: 'always_required',
  PASSWORD_LOGIN: 'password_login' // Always require for password auth
};

/**
 * Generate a cryptographically secure OTP
 */
function generateOtp(length = OTP_LENGTH) {
  // Generate random digits
  const digits = '0123456789';
  let otp = '';

  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    otp += digits[randomBytes[i] % 10];
  }

  return otp;
}

/**
 * Get user's MFA settings
 */
export async function getMfaSettings(userId) {
  const { rows } = await query(`SELECT * FROM user_mfa_settings WHERE user_id = $1`, [userId]);

  if (rows.length === 0) {
    // Return default settings
    return {
      userId,
      emailOtpEnabled: false,
      totpEnabled: false,
      webauthnEnabled: false,
      preferredMethod: 'email',
      requireMfaAlways: false,
      hasAnyMfaEnabled: false
    };
  }

  const settings = rows[0];
  return {
    userId,
    emailOtpEnabled: settings.email_otp_enabled,
    totpEnabled: settings.totp_enabled,
    webauthnEnabled: settings.webauthn_enabled,
    preferredMethod: settings.preferred_method,
    requireMfaAlways: settings.require_mfa_always,
    hasAnyMfaEnabled: settings.email_otp_enabled || settings.totp_enabled || settings.webauthn_enabled
  };
}

/**
 * Enable email OTP for a user
 */
export async function enableEmailOtp(userId, context = {}) {
  await query(
    `INSERT INTO user_mfa_settings (user_id, email_otp_enabled, preferred_method)
     VALUES ($1, TRUE, 'email')
     ON CONFLICT (user_id)
     DO UPDATE SET email_otp_enabled = TRUE, updated_at = NOW()`,
    [userId]
  );

  await logSecurityEvent({
    userId,
    eventType: SecurityEventTypes.MFA_ENABLED,
    eventCategory: SecurityEventCategories.MFA,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    success: true,
    details: { method: 'email_otp' }
  });
}

/**
 * Disable email OTP for a user
 */
export async function disableEmailOtp(userId, context = {}) {
  await query(`UPDATE user_mfa_settings SET email_otp_enabled = FALSE, updated_at = NOW() WHERE user_id = $1`, [userId]);

  await logSecurityEvent({
    userId,
    eventType: SecurityEventTypes.MFA_DISABLED,
    eventCategory: SecurityEventCategories.MFA,
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    success: true,
    details: { method: 'email_otp' }
  });
}

/**
 * Determine if MFA is required for this login attempt
 *
 * @param {Object} params
 * @param {string} params.userId - User ID
 * @param {string} params.authProvider - 'local' or 'google' or 'microsoft'
 * @param {Object} params.deviceInfo - Device fingerprint info
 * @param {string} params.ipAddress - Client IP
 * @param {string} params.countryCode - Country from IP
 * @returns {Object} { required: boolean, reason: string|null }
 */
export async function isMfaRequired(params) {
  const { userId, authProvider, deviceInfo, ipAddress, countryCode } = params;

  // Skip MFA entirely in development mode
  if (process.env.NODE_ENV === 'development') {
    return { required: false, reason: null };
  }

  // OAuth users trust provider MFA - no app-level MFA required by default
  if (authProvider === 'google' || authProvider === 'microsoft') {
    // Unless admin has forced app-level MFA
    const settings = await getMfaSettings(userId);
    if (settings.requireMfaAlways) {
      return { required: true, reason: MfaTriggerReasons.ALWAYS_REQUIRED };
    }
    return { required: false, reason: null };
  }

  // Email/password users - check various conditions

  // 1. Check if user has MFA always required (admin setting)
  const settings = await getMfaSettings(userId);
  if (settings.requireMfaAlways) {
    return { required: true, reason: MfaTriggerReasons.ALWAYS_REQUIRED };
  }

  // 2. Check if this is a trusted device
  if (deviceInfo?.deviceId) {
    const trustCheck = await isDeviceTrusted(userId, deviceInfo.deviceId, deviceInfo.fingerprint);
    if (trustCheck.trusted && !trustCheck.fingerprintChanged) {
      // Trusted device - no MFA needed
      return { required: false, reason: null };
    }
  }

  // 3. Check if this is a new device
  if (deviceInfo?.deviceId) {
    const newDevice = await isNewDevice(userId, deviceInfo.deviceId);
    if (newDevice) {
      return { required: true, reason: MfaTriggerReasons.NEW_DEVICE };
    }
  }

  // 4. Check for location change
  if (countryCode) {
    const locationChanged = await hasLocationChanged(userId, countryCode, ipAddress);
    if (locationChanged) {
      return { required: true, reason: MfaTriggerReasons.NEW_COUNTRY };
    }
  }

  // 5. Check for prolonged inactivity
  const inactive = await hasBeenInactive(userId, INACTIVITY_THRESHOLD_DAYS);
  if (inactive) {
    return { required: true, reason: MfaTriggerReasons.INACTIVITY };
  }

  // 6. If user has MFA enabled but none of the above triggered, still require it
  // for password logins (defense in depth)
  if (settings.hasAnyMfaEnabled) {
    return { required: true, reason: MfaTriggerReasons.PASSWORD_LOGIN };
  }

  // No MFA required
  return { required: false, reason: null };
}

/**
 * Create an MFA challenge and send OTP via email
 */
export async function createEmailOtpChallenge(userId, email, context = {}) {
  const { sessionId, ipAddress, userAgent, triggerReason } = context;

  // Generate OTP
  const otp = generateOtp();
  const otpHash = hashToken(otp);
  const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);

  // Invalidate any existing challenges
  await query(`UPDATE mfa_challenges SET expires_at = NOW() WHERE user_id = $1 AND verified_at IS NULL`, [userId]);

  // Create new challenge
  const { rows } = await query(
    `INSERT INTO mfa_challenges (
      user_id, session_id, challenge_type, otp_hash,
      expires_at, max_attempts, trigger_reason, ip_address, user_agent
    ) VALUES ($1, $2, 'email_otp', $3, $4, $5, $6, $7, $8)
    RETURNING id`,
    [userId, sessionId, otpHash, expiresAt, MAX_OTP_ATTEMPTS, triggerReason, ipAddress, userAgent]
  );

  const challengeId = rows[0].id;

  // Send OTP email
  const emailSent = await sendOtpEmail(email, otp, triggerReason);

  // Log the challenge
  await logSecurityEvent({
    userId,
    sessionId,
    eventType: SecurityEventTypes.MFA_CHALLENGE_SENT,
    eventCategory: SecurityEventCategories.MFA,
    ipAddress,
    userAgent,
    success: emailSent,
    details: { challengeType: 'email_otp', triggerReason }
  });

  return {
    challengeId,
    expiresAt,
    emailSent,
    maskedEmail: maskEmail(email)
  };
}

/**
 * Verify an OTP code
 */
export async function verifyOtp(challengeId, code, context = {}) {
  const { ipAddress, userAgent } = context;

  // Get the challenge
  const { rows } = await query(
    `SELECT * FROM mfa_challenges
     WHERE id = $1 AND challenge_type = 'email_otp'`,
    [challengeId]
  );

  if (rows.length === 0) {
    return { success: false, error: 'challenge_not_found' };
  }

  const challenge = rows[0];

  // Check if already verified
  if (challenge.verified_at) {
    return { success: false, error: 'already_verified' };
  }

  // Check if expired
  if (new Date(challenge.expires_at) < new Date()) {
    return { success: false, error: 'expired' };
  }

  // Atomically increment attempts and enforce the limit in a single statement
  // to prevent concurrent requests from bypassing the max_attempts cap.
  // Scope to active challenges only so a verified or expired row can't be
  // re-incremented if its state changed between the initial read and here.
  const { rowCount, rows: updatedRows } = await query(
    `UPDATE mfa_challenges SET attempts = attempts + 1
     WHERE id = $1
       AND verified_at IS NULL
       AND expires_at > NOW()
       AND attempts < max_attempts
     RETURNING attempts, max_attempts`,
    [challengeId]
  );
  if (rowCount === 0) {
    await logMfaChallenge({
      userId: challenge.user_id,
      challengeType: 'email_otp',
      success: false,
      failureReason: 'max_attempts_exceeded',
      ipAddress,
      userAgent,
      triggerReason: challenge.trigger_reason
    });
    return { success: false, error: 'max_attempts_exceeded' };
  }
  const currentAttempts = updatedRows[0].attempts;

  // Verify the code
  const codeHash = hashToken(code);
  if (codeHash !== challenge.otp_hash) {
    await logMfaChallenge({
      userId: challenge.user_id,
      challengeType: 'email_otp',
      success: false,
      failureReason: 'invalid_code',
      ipAddress,
      userAgent,
      triggerReason: challenge.trigger_reason
    });

    const attemptsRemaining = challenge.max_attempts - currentAttempts;
    return { success: false, error: 'invalid_code', attemptsRemaining };
  }

  // Mark as verified
  await query(`UPDATE mfa_challenges SET verified_at = NOW() WHERE id = $1`, [challengeId]);

  await logMfaChallenge({
    userId: challenge.user_id,
    challengeType: 'email_otp',
    success: true,
    ipAddress,
    userAgent,
    triggerReason: challenge.trigger_reason
  });

  return {
    success: true,
    userId: challenge.user_id,
    sessionId: challenge.session_id
  };
}

/**
 * Send OTP email
 */
async function sendOtpEmail(email, otp, triggerReason) {
  if (!isMailgunConfigured()) {
    // eslint-disable-next-line no-console
    console.warn(`[mfa] Email not configured — cannot deliver OTP for ${maskEmail(email)}. Configure Mailgun to enable MFA.`);
    return false;
  }

  const reasonText = getReasonText(triggerReason);

  try {
    await sendMailgunMessageWithLogging(
      {
        to: [email],
        subject: 'Your Anchor verification code',
        text: `Your verification code is: ${otp}

This code expires in ${OTP_EXPIRY_MINUTES} minutes.

${reasonText}

If you didn't request this code, please ignore this email or contact support if you're concerned about your account security.`,
        html: `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #1a1a1a; margin-bottom: 24px;">Verification Code</h2>
  <p style="color: #4a4a4a; font-size: 16px; margin-bottom: 24px;">
    Your verification code is:
  </p>
  <div style="background: #f5f5f5; border-radius: 8px; padding: 24px; text-align: center; margin-bottom: 24px;">
    <span style="font-family: monospace; font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #1a1a1a;">${otp}</span>
  </div>
  <p style="color: #666; font-size: 14px; margin-bottom: 16px;">
    This code expires in ${OTP_EXPIRY_MINUTES} minutes.
  </p>
  <p style="color: #666; font-size: 14px; margin-bottom: 24px;">
    ${reasonText}
  </p>
  <p style="color: #999; font-size: 12px;">
    If you didn't request this code, please ignore this email or contact support if you're concerned about your account security.
  </p>
</div>
`
      },
      {
        emailType: 'mfa_otp',
        recipientName: email,
        metadata: { triggerReason }
      }
    );
    return true;
  } catch (err) {
    console.error('[mfa] Failed to send OTP email:', err.message);
    return false;
  }
}

/**
 * Get human-readable reason text
 */
function getReasonText(reason) {
  switch (reason) {
    case MfaTriggerReasons.NEW_DEVICE:
      return "We noticed you're signing in from a new device.";
    case MfaTriggerReasons.NEW_IP:
      return "We noticed you're signing in from a new location.";
    case MfaTriggerReasons.NEW_COUNTRY:
      return "We noticed you're signing in from a different country.";
    case MfaTriggerReasons.INACTIVITY:
      return "It's been a while since your last sign in.";
    case MfaTriggerReasons.SENSITIVE_ACTION:
      return 'Additional verification is required for this action.';
    case MfaTriggerReasons.ALWAYS_REQUIRED:
      return 'Your account requires verification on each sign in.';
    case MfaTriggerReasons.PASSWORD_LOGIN:
      return 'Please verify your identity to complete sign in.';
    default:
      return 'Please verify your identity to continue.';
  }
}

/**
 * Mask email for display (exported for use in logging to avoid PII exposure)
 */
export function maskEmail(email) {
  if (!email || !email.includes('@')) return '***@***.***';

  const [local, domain] = email.split('@');
  const maskedLocal = local.length > 2 ? `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}` : `${local[0]}*`;

  const domainParts = domain.split('.');
  const maskedDomain = domainParts.length > 1 ? `${domainParts[0][0]}***.${'*'.repeat(2)}` : `${domain[0]}***`;

  return `${maskedLocal}@${maskedDomain}`;
}

/**
 * Check if a pending challenge exists for a user
 */
export async function hasPendingChallenge(userId) {
  const { rows } = await query(
    `SELECT id, expires_at, attempts, max_attempts
     FROM mfa_challenges
     WHERE user_id = $1
       AND verified_at IS NULL
       AND expires_at > NOW()
       AND attempts < max_attempts
     ORDER BY created_at DESC
     LIMIT 1`,
    [userId]
  );

  if (rows.length === 0) {
    return { hasPending: false };
  }

  return {
    hasPending: true,
    challengeId: rows[0].id,
    expiresAt: rows[0].expires_at,
    attemptsRemaining: rows[0].max_attempts - rows[0].attempts
  };
}

/**
 * Resend OTP for an existing challenge
 */
export async function resendOtp(challengeId, email, context = {}) {
  const { ipAddress, userAgent } = context;

  // Get the challenge
  const { rows } = await query(
    `SELECT * FROM mfa_challenges
     WHERE id = $1 AND verified_at IS NULL AND expires_at > NOW()`,
    [challengeId]
  );

  if (rows.length === 0) {
    return { success: false, error: 'challenge_not_found' };
  }

  const challenge = rows[0];

  if (challenge.attempts >= challenge.max_attempts) {
    return { success: false, error: 'max_attempts_exceeded' };
  }

  // Generate new OTP (but keep same challenge ID and expiry)
  const otp = generateOtp();
  const otpHash = hashToken(otp);

  await query(`UPDATE mfa_challenges SET otp_hash = $1 WHERE id = $2`, [otpHash, challengeId]);

  // Send new OTP
  const emailSent = await sendOtpEmail(email, otp, challenge.trigger_reason);

  await logSecurityEvent({
    userId: challenge.user_id,
    eventType: SecurityEventTypes.MFA_CHALLENGE_SENT,
    eventCategory: SecurityEventCategories.MFA,
    ipAddress,
    userAgent,
    success: emailSent,
    details: { challengeType: 'email_otp', isResend: true }
  });

  return {
    success: true,
    emailSent,
    expiresAt: challenge.expires_at
  };
}

/**
 * Clean up expired challenges (run periodically)
 */
export async function cleanupExpiredChallenges() {
  const { rowCount } = await query(`DELETE FROM mfa_challenges WHERE expires_at < NOW() - INTERVAL '1 hour'`);
  return rowCount;
}

