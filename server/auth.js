/**
 * Authentication Routes
 *
 * Implements secure authentication with:
 * - Short-lived access tokens (15 min) + rotating refresh tokens
 * - Conditional MFA (email OTP)
 * - Rate limiting
 * - Session management
 * - Audit logging
 */

import cookieParser from 'cookie-parser';
import crypto from 'crypto';
import { Router } from 'express';
import { z } from 'zod';

import { query, getClient } from './db.js';
import { requireAuth } from './middleware/auth.js';
import { isAdminOrEditor } from './middleware/roles.js';
import { loginRateLimiter, passwordResetRateLimiter, mfaRateLimiter, recordFailedLoginAttempt, getClientIp } from './middleware/rateLimit.js';
import {
  // Password
  validatePassword,
  hashPassword,
  verifyPassword,
  needsRehash,
  getPasswordRequirements,
  // Sessions
  createAuthenticatedSession,
  refreshAuthenticatedSession,
  endSession,
  endAllSessions,
  listUserSessions,
  revokeUserSession,
  validateSession,
  onPasswordChange,
  applySyntheticAccessActivation,
  // Tokens
  hashToken,
  verifyAccessToken,
  // Rate limiting
  clearRateLimit,
  recordFailedLogin,
  resetFailedLogins,
  isUserLocked,
  // MFA
  isMfaRequired,
  createEmailOtpChallenge,
  verifyOtp,
  resendOtp,
  getMfaSettings,
  maskEmail,
  // Device
  extractDeviceInfo,
  trustDevice,
  getUserTrustedDevices,
  revokeDeviceTrust,
  // Audit
  logSecurityEvent,
  SecurityEventTypes,
  SecurityEventCategories,
  logLoginAttempt
} from './services/security/index.js';
import { resolveActiveClientAccount } from './services/clientAccounts.js';
import { isMailgunConfigured, sendMailgunMessageWithLogging } from './services/mailgun.js';
import { isDemoMode } from './services/demoMode.js';
import { getEffectiveRole } from './utils/roles.js';
import { logAuthActivity, ActivityEventTypes } from './services/activityLog.js';

const router = Router();
router.use(cookieParser());

// ============================================================================
// SCHEMAS
// ============================================================================

const dateToString = (val) => (val instanceof Date ? val.toISOString() : val);

const userSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  role: z.string().default('client'),
  avatar_url: z.string().optional().nullable(),
  is_demo: z.boolean().optional().default(false),
  onboarding_completed_at: z.preprocess(dateToString, z.string().optional().nullable()),
  activated_at: z.preprocess(dateToString, z.string().optional().nullable()),
  created_at: z.preprocess(dateToString, z.string()),
  clientAccountRole: z.string().optional().nullable(),
  activeClientAccountId: z.string().optional().nullable(),
  availableClientAccounts: z
    .array(
      z.object({
        clientOwnerId: z.string(),
        membershipRole: z.string(),
        businessName: z.string().optional().nullable(),
        displayName: z.string(),
        ownerName: z.string().optional().nullable(),
        ownerEmail: z.string().email(),
        isSelfOwner: z.boolean()
      })
    )
    .optional()
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1, 'Password is required'),
  deviceId: z.string().optional(),
  deviceFingerprint: z.string().optional(),
  trustDevice: z.boolean().optional().default(false)
});

const mfaVerifySchema = z.object({
  challengeId: z.string().uuid(),
  code: z.string().length(6, 'Code must be 6 digits'),
  trustDevice: z.boolean().optional().default(false)
});

const passwordResetRequestSchema = z.object({
  email: z.string().email()
});

const passwordResetSchema = z.object({
  token: z.string().min(10, 'Reset token is required'),
  password: z.string().min(12, 'Password must be at least 12 characters')
});

const emailVerificationSchema = z.object({
  email: z.string().email()
});

// ============================================================================
// COOKIE CONFIGURATION
// ============================================================================

const REFRESH_COOKIE_NAME = 'refresh_token';
const IMPERSONATOR_COOKIE = 'impersonator';
const REFRESH_COOKIE_MAX_AGE_REMEMBERED = 1000 * 60 * 60 * 24 * 30; // 30 days (remember me)
const REFRESH_COOKIE_MAX_AGE_SESSION = 1000 * 60 * 60 * 24; // 24 hours (session only)
const PASSWORD_RESET_TTL_MINUTES = parseInt(process.env.PASSWORD_RESET_TTL_MINUTES || '60', 10);

/**
 * Set refresh token cookie
 * @param {Response} res - Express response
 * @param {string} token - Refresh token
 * @param {boolean} rememberDevice - If true, cookie persists 30 days; if false, 24 hours
 */
function setRefreshCookie(res, token, rememberDevice = true) {
  const isProd = process.env.NODE_ENV === 'production';
  const maxAge = rememberDevice ? REFRESH_COOKIE_MAX_AGE_REMEMBERED : REFRESH_COOKIE_MAX_AGE_SESSION;
  res.cookie(REFRESH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax', // 'lax' is HIPAA-compliant and prevents cross-site navigation issues
    maxAge,
    path: '/'
  });
}

function setImpersonatorCookie(res, userId) {
  const isProd = process.env.NODE_ENV === 'production';
  res.cookie(IMPERSONATOR_COOKIE, userId || '', {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax', // 'lax' prevents cross-site navigation issues while remaining secure
    maxAge: REFRESH_COOKIE_MAX_AGE_REMEMBERED,
    path: '/'
  });
}

function clearAuthCookies(res) {
  res.clearCookie(REFRESH_COOKIE_NAME, { httpOnly: true, sameSite: 'lax', path: '/' });
  res.clearCookie(IMPERSONATOR_COOKIE, { httpOnly: true, sameSite: 'lax', path: '/' });
}

// ============================================================================
// HELPERS
// ============================================================================

function normalizeBase(value) {
  if (!value) return null;
  let base = String(value).trim();
  if (!/^https?:\/\//i.test(base)) {
    const isLocal = base.startsWith('localhost') || base.startsWith('127.0.0.1');
    base = `${isLocal ? 'http' : 'https'}://${base}`;
  }
  return base.replace(/\/$/, '');
}

function resolveAppBaseUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const isLocalHost = host && (host.includes('localhost') || host.includes('127.0.0.1'));

  const localOverride = normalizeBase(process.env.LOCAL_APP_BASE_URL);
  if (isLocalHost && localOverride) return localOverride;

  if (isLocalHost && process.env.NODE_ENV !== 'production') {
    return 'http://localhost:3000';
  }

  const fromEnv = normalizeBase(process.env.APP_BASE_URL || process.env.CLIENT_APP_URL);
  if (fromEnv) return fromEnv;

  if (host) return normalizeBase(`${proto}://${host}`);

  return 'http://localhost:3000';
}

async function findUserByEmail(email) {
  const { rows } = await query(
    `SELECT u.*, cp.onboarding_completed_at, cp.activated_at
     FROM users u
     LEFT JOIN client_profiles cp ON cp.user_id = u.id
     WHERE u.email = $1
     LIMIT 1`,
    [email.toLowerCase()]
  );
  return rows[0] || null;
}

async function findUserById(id) {
  const { rows } = await query(
    `SELECT u.*, cp.onboarding_completed_at, cp.activated_at
     FROM users u
     LEFT JOIN client_profiles cp ON cp.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function pruneExpiredResetTokens(userId) {
  if (userId) {
    await query('DELETE FROM password_reset_tokens WHERE user_id = $1 AND (used_at IS NOT NULL OR expires_at < NOW())', [userId]);
    return;
  }
  await query('DELETE FROM password_reset_tokens WHERE expires_at < NOW()');
}

async function createPasswordResetToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60 * 1000);
  await pruneExpiredResetTokens(userId);
  await query(
    `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, $3)`,
    [userId, tokenHash, expiresAt]
  );
  return { token, expiresAt };
}

async function findValidResetToken(token) {
  const tokenHash = hashToken(token);
  const { rows } = await query(
    `SELECT id, user_id
     FROM password_reset_tokens
     WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function markResetTokenUsed(record) {
  if (!record?.id || !record?.user_id) return;
  await query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [record.id]);
  await pruneExpiredResetTokens(record.user_id);
}

async function pruneExpiredEmailVerificationTokens(userId) {
  if (userId) {
    await query('DELETE FROM email_verification_tokens WHERE user_id = $1 AND (verified_at IS NOT NULL OR expires_at < NOW())', [userId]);
    return;
  }
  await query('DELETE FROM email_verification_tokens WHERE expires_at < NOW()');
}

async function createEmailVerificationToken(userId, email) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 60 minutes
  await pruneExpiredEmailVerificationTokens(userId);
  await query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, email, expires_at)
     VALUES ($1, $2, $3, $4)`,
    [userId, tokenHash, email, expiresAt]
  );
  return { token, expiresAt };
}

async function findValidEmailVerificationToken(token) {
  const tokenHash = hashToken(token);
  const { rows } = await query(
    `SELECT id, user_id, email
     FROM email_verification_tokens
     WHERE token_hash = $1 AND verified_at IS NULL AND expires_at > NOW()
     LIMIT 1`,
    [tokenHash]
  );
  return rows[0] || null;
}

async function markEmailVerified(record) {
  if (!record?.id || !record?.user_id) return;
  await query('UPDATE email_verification_tokens SET verified_at = NOW() WHERE id = $1', [record.id]);
  await query('UPDATE users SET email_verified_at = NOW() WHERE id = $1', [record.user_id]);
  await pruneExpiredEmailVerificationTokens(record.user_id);
}

async function sendEmailVerificationEmail(user, token, baseUrl) {
  const verifyUrl = `${baseUrl}/api/auth/verify-email?token=${token}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || 'there';

  if (!isMailgunConfigured()) {
    console.warn(`[email-verify] Mail provider not configured. Verify URL: ${verifyUrl}`);
    return { delivered: false, verifyUrl };
  }

  await sendMailgunMessageWithLogging(
    {
      to: [user.email],
      subject: 'Verify your Anchor email',
      text: `Hi ${name},

Thanks for creating your Anchor account. Please verify your email address using the link below:
${verifyUrl}

If you did not create this account, you can safely ignore this email.`,
      html: `<p>Hi ${name},</p>
<p>Thanks for creating your Anchor account. Please verify your email address using the link below:</p>
<p><a href="${verifyUrl}" target="_blank" rel="noopener">Verify your email</a></p>
<p>If you did not create this account, you can safely ignore this email.</p>`
    },
    {
      emailType: 'email_verification',
      recipientName: name,
      clientId: user.id,
      metadata: { verify_url: verifyUrl }
    }
  );

  return { delivered: true, verifyUrl };
}

async function sendPasswordResetEmail(user, token, baseUrl) {
  const resetUrl = `${baseUrl}/pages/forgot-password?token=${token}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || 'there';

  console.log(`[password-reset] Attempting to send email to ${maskEmail(user.email)}`);

  if (!isMailgunConfigured()) {
    console.warn(`[password-reset] Mail provider not configured. Reset URL: ${resetUrl}`);
    return { delivered: false, resetUrl };
  }

  console.log(`[password-reset] Mailgun configured, sending email...`);

  try {
    await sendMailgunMessageWithLogging(
      {
        to: [user.email],
        subject: 'Reset your Anchor password',
        text: `Hi ${name},

We received a request to reset your Anchor password. Use the link below to set a new password:
${resetUrl}

If you did not request this, you can safely ignore this email.`,
        html: `<p>Hi ${name},</p>
<p>We received a request to reset your Anchor password. Use the link below to set a new password:</p>
<p><a href="${resetUrl}" target="_blank" rel="noopener">Reset your password</a></p>
<p>If you did not request this, you can safely ignore this email.</p>`
      },
      {
        emailType: 'password_reset',
        recipientName: name,
        clientId: user.id,
        metadata: { reset_url: resetUrl }
      }
    );
    console.log(`[password-reset] Email sent successfully to ${maskEmail(user.email)}`);
    return { delivered: true, resetUrl };
  } catch (err) {
    console.error(`[password-reset] Failed to send email to ${maskEmail(user.email)}:`, err.message);
    return { delivered: false, resetUrl, error: err.message };
  }
}

// ============================================================================
// ROUTES
// ============================================================================

/**
 * GET /api/auth/me
 * Get current user from access token (via Authorization header)
 */
router.get('/me', async (req, res) => {
  try {
    // Try Authorization header first (preferred)
    const authHeader = req.headers.authorization;
    let accessToken = null;

    if (authHeader?.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7);
    }

    if (!accessToken) {
      return res.status(401).json({ message: 'Not authenticated', code: 'NO_TOKEN' });
    }

    const payload = verifyAccessToken(accessToken);
    if (!payload) {
      return res.status(401).json({ message: 'Token expired or invalid', code: 'TOKEN_INVALID' });
    }

    if (payload.sessionId) {
      const sessionCheck = await validateSession(payload.sessionId);
      if (!sessionCheck.valid) {
        return res.status(401).json({ message: 'Session revoked or expired', code: 'SESSION_INVALID' });
      }
    }

    let user = await findUserById(payload.userId);
    if (!user) {
      return res.status(401).json({ message: 'Session invalid', code: 'USER_NOT_FOUND' });
    }
    user = await applySyntheticAccessActivation(user);

    const effectiveRole = await getEffectiveRole(user.role);

    const requestedClientAccountId = req.headers['x-client-account'] ? String(req.headers['x-client-account']) : null;
    const { accounts, activeAccount } = await resolveActiveClientAccount(user.id, requestedClientAccountId, { userRole: user.role });
    const clientAccountRole = activeAccount?.membershipRole || null;

    res.json({
      user: userSchema.parse({
        ...user,
        role: user.role,
        clientAccountRole,
        activeClientAccountId: activeAccount?.clientOwnerId || null,
        availableClientAccounts: accounts
      }),
      effectiveRole,
      clientAccountRole,
      impersonator: req.cookies?.[IMPERSONATOR_COOKIE] || null
    });
  } catch (err) {
    console.error('[auth/me]', err);
    res.status(401).json({ message: 'Session expired or invalid', code: 'SESSION_ERROR' });
  }
});

/**
 * POST /api/auth/login
 * Authenticate with email/password
 * May return MFA challenge if required
 */
router.post('/login', loginRateLimiter(), async (req, res) => {
  try {
    const payload = loginSchema.parse(req.body);
    const ipAddress = getClientIp(req);
    const deviceInfo = extractDeviceInfo(req);

    let user = await findUserByEmail(payload.email);

    if (!user) {
      await recordFailedLoginAttempt(req);
      await logLoginAttempt({
        success: false,
        failureReason: 'user_not_found',
        ipAddress,
        userAgent: req.headers['user-agent'],
        deviceId: deviceInfo.deviceId
      });
      return res.status(401).json({ message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
    }

    // Check if account is locked
    const lockStatus = await isUserLocked(user.id);
    if (lockStatus.locked) {
      await logLoginAttempt({
        userId: user.id,
        success: false,
        failureReason: 'account_locked',
        ipAddress,
        userAgent: req.headers['user-agent'],
        deviceId: deviceInfo.deviceId
      });
      return res.status(423).json({
        message: 'Account temporarily locked due to too many failed attempts.',
        retryAfter: lockStatus.retryAfter,
        code: 'ACCOUNT_LOCKED'
      });
    }

    // Verify password
    const isValid = user.password_hash && (await verifyPassword(payload.password, user.password_hash));
    if (!isValid) {
      await recordFailedLoginAttempt(req);
      const { locked } = await recordFailedLogin(user.id);

      await logLoginAttempt({
        userId: user.id,
        success: false,
        failureReason: 'invalid_password',
        ipAddress,
        userAgent: req.headers['user-agent'],
        deviceId: deviceInfo.deviceId
      });

      if (locked) {
        return res.status(423).json({
          message: 'Account locked due to too many failed attempts.',
          code: 'ACCOUNT_LOCKED'
        });
      }

      return res.status(401).json({ message: 'Invalid email or password', code: 'INVALID_CREDENTIALS' });
    }

    // Check if email verified (local accounts)
    if ((user.auth_provider || 'local') === 'local' && !user.email_verified_at) {
      return res.status(403).json({
        message: 'Please verify your email before signing in.',
        code: 'EMAIL_NOT_VERIFIED'
      });
    }

    // Team members (non-owner members of a client account) bypass onboarding/activation.
    // This MUST run before the activation check so team members aren't blocked.
    user = await applySyntheticAccessActivation(user);

    // Check if client account is activated (after team member bypass above)
    if (user.role === 'client' && user.onboarding_completed_at && !user.activated_at) {
      return res.status(403).json({
        message:
          'Your account is currently being set up by our team. We will notify you when it is ready to access. Thank you for your patience!',
        code: 'ACCOUNT_PENDING_ACTIVATION'
      });
    }

    // Check if password needs rehash (bcrypt → argon2)
    if (needsRehash(user.password_hash)) {
      const newHash = await hashPassword(payload.password);
      await query('UPDATE users SET password_hash = $1 WHERE id = $2', [newHash, user.id]);
    }

    // Check if MFA is required
    const mfaCheck = await isMfaRequired({
      userId: user.id,
      authProvider: user.auth_provider || 'local',
      deviceInfo,
      ipAddress,
      countryCode: null // Would come from IP geolocation service
    });

    // In the demo deployment, never challenge for MFA: the email OTP can't be delivered
    // (no Mailgun creds + DEMO_MODE suppresses all sends), so a challenge would dead-end
    // every coworker on a "new device". The demo account is a public, shared, no-PHI
    // login, so skipping the second factor is acceptable here and ONLY here.
    // Skip MFA ONLY for demo-account logins on the demo deployment. On prod (DEMO_MODE
    // unset) this is always false, so MFA is always enforced — including for the demo
    // account that the seed also maintains on prod.
    if (mfaCheck.required && !(isDemoMode() && user.is_demo)) {
      // Create MFA challenge
      const challenge = await createEmailOtpChallenge(user.id, user.email, {
        ipAddress,
        userAgent: req.headers['user-agent'],
        triggerReason: mfaCheck.reason
      });

      return res.status(200).json({
        requiresMfa: true,
        mfaType: 'email_otp',
        challengeId: challenge.challengeId,
        maskedEmail: challenge.maskedEmail,
        expiresAt: challenge.expiresAt,
        reason: mfaCheck.reason,
        code: 'MFA_REQUIRED'
      });
    }

    // No MFA required - create session
    const session = await createAuthenticatedSession(user, deviceInfo, {
      trustDevice: payload.trustDevice,
      ipAddress,
      userAgent: req.headers['user-agent']
    });

    // Set cookies (longer expiry if "Keep me logged in" is checked)
    setRefreshCookie(res, session.refreshToken, payload.trustDevice);
    setImpersonatorCookie(res, '');

    // Clear rate limits
    await clearRateLimit('login_ip', ipAddress);
    await clearRateLimit('login_user', payload.email.toLowerCase());
    await resetFailedLogins(user.id);

    // Trust device if requested
    if (payload.trustDevice) {
      await trustDevice(user.id, deviceInfo, { ipAddress, userAgent: req.headers['user-agent'] });
    }

    await logLoginAttempt({
      userId: user.id,
      success: true,
      ipAddress,
      userAgent: req.headers['user-agent'],
      deviceId: deviceInfo.deviceId,
      method: 'password'
    });

    // Log user activity
    await logAuthActivity({
      userId: user.id,
      actionType: ActivityEventTypes.LOGIN,
      ipAddress,
      userAgent: req.headers['user-agent'],
      details: { method: 'password' }
    });

    res.json({
      user: session.user,
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      impersonator: null
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.issues[0]?.message || 'Invalid payload', code: 'VALIDATION_ERROR' });
    }
    console.error('[login]', err);
    res.status(500).json({ message: 'Unable to login right now', code: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/auth/mfa/verify
 * Verify MFA code and complete login
 */
router.post('/mfa/verify', mfaRateLimiter(), async (req, res) => {
  try {
    const payload = mfaVerifySchema.parse(req.body);
    const ipAddress = getClientIp(req);

    const result = await verifyOtp(payload.challengeId, payload.code, {
      ipAddress,
      userAgent: req.headers['user-agent']
    });

    if (!result.success) {
      const errorMessages = {
        challenge_not_found: 'Verification session expired. Please login again.',
        already_verified: 'Code already used. Please login again.',
        expired: 'Code expired. Please request a new one.',
        max_attempts_exceeded: 'Too many attempts. Please login again.',
        invalid_code: `Invalid code. ${result.attemptsRemaining} attempts remaining.`
      };

      return res.status(400).json({
        message: errorMessages[result.error] || 'Verification failed',
        error: result.error,
        attemptsRemaining: result.attemptsRemaining,
        code: 'MFA_FAILED'
      });
    }

    // MFA verified - create session
    const user = await findUserById(result.userId);
    if (!user) {
      return res.status(401).json({ message: 'User not found', code: 'USER_NOT_FOUND' });
    }

    const deviceInfo = extractDeviceInfo(req);
    const session = await createAuthenticatedSession(user, deviceInfo, {
      trustDevice: payload.trustDevice,
      ipAddress,
      userAgent: req.headers['user-agent'],
      mfaVerified: true
    });

    // Set cookies (longer expiry if "Keep me logged in" is checked)
    setRefreshCookie(res, session.refreshToken, payload.trustDevice);
    setImpersonatorCookie(res, '');

    // Trust device if requested
    if (payload.trustDevice) {
      await trustDevice(user.id, deviceInfo, { ipAddress, userAgent: req.headers['user-agent'] });
    }

    // Clear rate limits
    await clearRateLimit('login_ip', ipAddress);
    await clearRateLimit('login_user', user.email);
    await resetFailedLogins(user.id);

    // Log user activity (login via MFA)
    await logAuthActivity({
      userId: user.id,
      actionType: ActivityEventTypes.LOGIN,
      ipAddress,
      userAgent: req.headers['user-agent'],
      details: { method: 'mfa' }
    });

    res.json({
      user: session.user,
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      impersonator: null
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.issues[0]?.message || 'Invalid payload', code: 'VALIDATION_ERROR' });
    }
    console.error('[mfa/verify]', err);
    res.status(500).json({ message: 'Unable to verify code right now', code: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/auth/mfa/resend
 * Resend MFA code
 */
router.post('/mfa/resend', async (req, res) => {
  try {
    const { challengeId } = req.body;
    if (!challengeId) {
      return res.status(400).json({ message: 'Challenge ID required', code: 'MISSING_CHALLENGE' });
    }

    // Get the challenge to find the user
    const { rows } = await query(
      `SELECT mc.user_id, u.email
       FROM mfa_challenges mc
       JOIN users u ON u.id = mc.user_id
       WHERE mc.id = $1`,
      [challengeId]
    );

    if (rows.length === 0) {
      return res.status(400).json({ message: 'Challenge not found', code: 'CHALLENGE_NOT_FOUND' });
    }

    const ipAddress = getClientIp(req);
    const result = await resendOtp(challengeId, rows[0].email, {
      ipAddress,
      userAgent: req.headers['user-agent']
    });

    if (!result.success) {
      return res.status(400).json({
        message: 'Unable to resend code. Please login again.',
        error: result.error,
        code: 'RESEND_FAILED'
      });
    }

    res.json({
      message: 'Code sent',
      expiresAt: result.expiresAt
    });
  } catch (err) {
    console.error('[mfa/resend]', err);
    res.status(500).json({ message: 'Unable to resend code', code: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/auth/refresh
 * Exchange refresh token for new access token
 */
// Demo deployment auto-login: mint a session for the single shared demo client so the
// portal opens straight into the client view with no login screen. Gated to isDemoMode()
// (DEMO_MODE env, only on anchor-hub-demo) — never reachable on prod. Access to the demo
// URL is gated upstream by Cloud Run IAP (Google sign-in restricted to @anchorcorps.com),
// so this just removes the redundant in-app login step. Returns true if it sent a response.
const DEMO_LOGIN_EMAIL = 'demo@anchorcorps.com';
async function issueDemoSession(req, res) {
  // Defense-in-depth: never mint a credential-less session outside the demo deployment,
  // independent of call-site guards. If this is ever reached on prod, it's a no-op.
  if (!isDemoMode()) return false;
  let user = await findUserByEmail(DEMO_LOGIN_EMAIL);
  if (!user) return false;
  user = await applySyntheticAccessActivation(user);
  const deviceInfo = extractDeviceInfo(req);
  const session = await createAuthenticatedSession(user, deviceInfo, {
    ipAddress: getClientIp(req),
    userAgent: req.headers['user-agent']
  });
  setRefreshCookie(res, session.refreshToken);
  res.json({ user: session.user, accessToken: session.accessToken, expiresIn: session.expiresIn, impersonator: null });
  return true;
}

router.post('/refresh', async (req, res) => {
  try {
    console.log('[auth:refresh] Attempting to refresh session...');
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME];
    console.log(`[auth:refresh] Refresh token cookie: ${refreshToken ? 'present' : 'missing'}`);
    if (!refreshToken) {
      // Fresh demo visitor (no session cookie yet) → auto-mint the demo client session.
      if (isDemoMode() && (await issueDemoSession(req, res))) return;
      return res.status(401).json({ message: 'No refresh token', code: 'NO_REFRESH_TOKEN' });
    }

    const ipAddress = getClientIp(req);
    const result = await refreshAuthenticatedSession(refreshToken, {
      ipAddress,
      userAgent: req.headers['user-agent'],
      clientAccountId: req.headers['x-client-account'] ? String(req.headers['x-client-account']) : null
    });

    if (result.error) {
      clearAuthCookies(res);
      // Demo: a stale/invalid cookie shouldn't bounce to the login screen — re-mint the
      // shared demo client session so the portal just reopens.
      if (isDemoMode() && (await issueDemoSession(req, res))) return;

      const errorMessages = {
        invalid_token: 'Session expired. Please login again.',
        session_revoked: 'Session was terminated. Please login again.',
        refresh_expired: 'Session expired. Please login again.',
        session_expired: 'Session expired. Please login again.'
      };

      return res.status(401).json({
        message: errorMessages[result.error] || 'Session invalid',
        error: result.error,
        code: 'REFRESH_FAILED'
      });
    }

    // Block session refresh for non-team clients who completed onboarding but aren't activated.
    // refreshAuthenticatedSession already applied applySyntheticAccessActivation, so the dates
    // on result.user reflect both real and synthesized state.
    if (result.user?.role === 'client' && result.user.onboarding_completed_at && !result.user.activated_at) {
      clearAuthCookies(res);
      return res.status(403).json({
        message: 'Your account is being set up by our team. We will notify you when it is ready.',
        code: 'ACCOUNT_PENDING_ACTIVATION'
      });
    }

    // Set new refresh token cookie
    setRefreshCookie(res, result.refreshToken);

    console.log(`[auth:refresh] Success! User ID: ${result.user?.id}`);
    res.json({
      accessToken: result.accessToken,
      expiresIn: result.expiresIn,
      user: result.user
    });
  } catch (err) {
    console.error('[auth:refresh] Error:', err);
    clearAuthCookies(res);
    res.status(500).json({ message: 'Unable to refresh session', code: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/auth/verify-email
 * Verify email with token
 */
router.get('/verify-email', async (req, res) => {
  try {
    const token = String(req.query?.token || '');
    const baseUrl = resolveAppBaseUrl(req);
    if (!token) {
      return res.redirect(`${baseUrl}/pages/login?verified=0`);
    }

    const record = await findValidEmailVerificationToken(token);
    if (!record) {
      return res.redirect(`${baseUrl}/pages/login?verified=0`);
    }

    await markEmailVerified(record);

    await logSecurityEvent({
      userId: record.user_id,
      eventType: SecurityEventTypes.EMAIL_VERIFIED,
      eventCategory: SecurityEventCategories.ACCOUNT,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
      success: true
    });

    res.redirect(`${baseUrl}/pages/login?verified=1`);
  } catch (err) {
    console.error('[verify-email]', err);
    const baseUrl = resolveAppBaseUrl(req);
    res.redirect(`${baseUrl}/pages/login?verified=0`);
  }
});

/**
 * POST /api/auth/resend-verification
 * Resend verification email
 */
router.post('/resend-verification', passwordResetRateLimiter(), async (req, res) => {
  try {
    const { email } = emailVerificationSchema.parse(req.body);
    const user = await findUserByEmail(email);
    const appBaseUrl = resolveAppBaseUrl(req);

    const genericResponse = {
      message: 'If an account exists with that email, a verification email was sent.'
    };

    if (!user || user.email_verified_at) {
      return res.json(genericResponse);
    }

    const { token } = await createEmailVerificationToken(user.id, user.email);
    await sendEmailVerificationEmail(user, token, appBaseUrl);

    await logSecurityEvent({
      userId: user.id,
      eventType: SecurityEventTypes.EMAIL_CHANGED,
      eventCategory: SecurityEventCategories.ACCOUNT,
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent'],
      success: true,
      details: { action: 'resend_verification' }
    });

    res.json(genericResponse);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.issues[0]?.message || 'Invalid payload', code: 'VALIDATION_ERROR' });
    }
    console.error('[resend-verification]', err);
    res.status(500).json({ message: 'Unable to resend verification email', code: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/auth/logout
 * End current session
 */
router.post('/logout', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    let userId = null;
    let sessionRevoked = false;

    // Try access token first (most reliable when token is still valid)
    if (authHeader?.startsWith('Bearer ')) {
      const accessToken = authHeader.substring(7);
      const payload = verifyAccessToken(accessToken);
      if (payload?.sessionId && payload?.userId) {
        userId = payload.userId;
        await endSession(payload.sessionId, payload.userId, {
          ipAddress: getClientIp(req),
          userAgent: req.headers['user-agent']
        });
        sessionRevoked = true;
      }
    }

    // Fallback: revoke session via refresh token when access token is expired
    if (!sessionRevoked && req.cookies?.refresh_token) {
      const refreshHash = hashToken(req.cookies.refresh_token);
      const { rows } = await query(
        `SELECT id AS session_id, user_id FROM user_sessions
         WHERE refresh_token_hash = $1 AND revoked_at IS NULL
         LIMIT 1`,
        [refreshHash]
      );
      if (rows[0]?.session_id && rows[0]?.user_id) {
        userId = rows[0].user_id;
        await endSession(rows[0].session_id, rows[0].user_id, {
          ipAddress: getClientIp(req),
          userAgent: req.headers['user-agent']
        });
      }
    }

    if (userId) {
      await logAuthActivity({
        userId,
        actionType: ActivityEventTypes.LOGOUT,
        ipAddress: getClientIp(req),
        userAgent: req.headers['user-agent']
      });
    }

    clearAuthCookies(res);
    res.status(204).send();
  } catch (err) {
    console.error('[logout]', err);
    clearAuthCookies(res);
    res.status(204).send();
  }
});

/**
 * POST /api/auth/logout-all
 * End all sessions for current user
 */
router.post('/logout-all', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      clearAuthCookies(res);
      return res.status(204).send();
    }

    const accessToken = authHeader.substring(7);
    const payload = verifyAccessToken(accessToken);

    if (payload?.userId) {
      const keepCurrent = req.body?.keepCurrent === true;
      await endAllSessions(
        payload.userId,
        {
          ipAddress: getClientIp(req),
          userAgent: req.headers['user-agent']
        },
        keepCurrent ? payload.sessionId : null
      );
    }

    if (!req.body?.keepCurrent) {
      clearAuthCookies(res);
    }

    res.json({ message: 'All sessions terminated' });
  } catch (err) {
    console.error('[logout-all]', err);
    clearAuthCookies(res);
    res.status(500).json({ message: 'Unable to logout', code: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/auth/forgot-password
 * Request password reset
 */
router.post('/forgot-password', passwordResetRateLimiter(), async (req, res) => {
  try {
    const { email } = passwordResetRequestSchema.parse(req.body);
    const user = await findUserByEmail(email);
    const appBaseUrl = resolveAppBaseUrl(req);
    const ipAddress = getClientIp(req);

    const genericResponse = {
      message: 'If an account exists with that email, we sent password reset instructions.'
    };

    await logSecurityEvent({
      userId: user?.id,
      eventType: SecurityEventTypes.PASSWORD_RESET_REQUESTED,
      eventCategory: SecurityEventCategories.AUTHENTICATION,
      ipAddress,
      userAgent: req.headers['user-agent'],
      success: true,
      details: { emailProvided: email }
    });

    if (!user) {
      return res.json(genericResponse);
    }

    const { token } = await createPasswordResetToken(user.id);
    const { resetUrl } = await sendPasswordResetEmail(user, token, appBaseUrl);
    const responsePayload = { ...genericResponse };

    if (!isMailgunConfigured() && process.env.NODE_ENV !== 'production') {
      responsePayload.resetUrl = resetUrl;
      responsePayload.token = token;
    }

    res.json(responsePayload);
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.issues[0]?.message || 'Invalid payload', code: 'VALIDATION_ERROR' });
    }
    console.error('[forgot-password]', err);
    res.status(500).json({ message: 'Unable to process password reset right now', code: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/auth/reset-password
 * Complete password reset
 */
router.post('/reset-password', async (req, res) => {
  let dbClient;
  try {
    const { token, password } = passwordResetSchema.parse(req.body);
    const tokenHash = hashToken(token);

    // Atomically lock and consume the reset token to prevent double-use race.
    dbClient = await getClient();
    await dbClient.query('BEGIN');

    const { rows: tokenRows } = await dbClient.query(
      `SELECT id, user_id
       FROM password_reset_tokens
       WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
       LIMIT 1
       FOR UPDATE SKIP LOCKED`,
      [tokenHash]
    );

    const record = tokenRows[0] || null;
    if (!record) {
      await dbClient.query('ROLLBACK');
      return res.status(400).json({ message: 'Reset link is invalid or expired', code: 'INVALID_TOKEN' });
    }

    const { rows: userRows } = await dbClient.query(
      `SELECT id, email, first_name, last_name, role, avatar_url, password_hash, is_demo,
              auth_provider, email_verified_at, last_login_at
       FROM users WHERE id = $1 LIMIT 1`,
      [record.user_id]
    );
    const user = userRows[0] || null;
    if (!user) {
      await dbClient.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [record.id]);
      await dbClient.query('COMMIT');
      return res.status(404).json({ message: 'User for this reset link could not be found', code: 'USER_NOT_FOUND' });
    }

    // Validate password strength
    const passwordValidation = validatePassword(password, {
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name
    });

    if (!passwordValidation.valid) {
      await dbClient.query('ROLLBACK');
      return res.status(400).json({
        message: passwordValidation.errors[0],
        errors: passwordValidation.errors,
        code: 'WEAK_PASSWORD'
      });
    }

    // Hash with Argon2 and consume token atomically
    const passwordHash = await hashPassword(password);
    await dbClient.query('UPDATE users SET password_hash = $1, updated_at = NOW(), password_changed_at = NOW() WHERE id = $2', [
      passwordHash,
      record.user_id
    ]);
    await dbClient.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [record.id]);
    await dbClient.query('COMMIT');

    const ipAddress = getClientIp(req);
    const deviceInfo = extractDeviceInfo(req);

    // Revoke all other sessions (security best practice)
    await onPasswordChange(user.id, null, {
      ipAddress,
      userAgent: req.headers['user-agent']
    });

    // Create new session
    const session = await createAuthenticatedSession(user, deviceInfo, {
      ipAddress,
      userAgent: req.headers['user-agent']
    });

    setRefreshCookie(res, session.refreshToken);
    setImpersonatorCookie(res, '');

    await logSecurityEvent({
      userId: user.id,
      eventType: SecurityEventTypes.PASSWORD_RESET_COMPLETED,
      eventCategory: SecurityEventCategories.AUTHENTICATION,
      ipAddress,
      userAgent: req.headers['user-agent'],
      deviceId: deviceInfo.deviceId,
      success: true
    });

    // Prune expired tokens (non-blocking)
    pruneExpiredResetTokens(user.id).catch(() => {});

    res.json({
      message: 'Password updated successfully',
      user: session.user,
      accessToken: session.accessToken,
      expiresIn: session.expiresIn
    });
  } catch (err) {
    await dbClient?.query('ROLLBACK').catch(() => {});
    if (err instanceof z.ZodError) {
      return res.status(400).json({ message: err.issues[0]?.message || 'Invalid payload', code: 'VALIDATION_ERROR' });
    }
    console.error('[reset-password]', err);
    res.status(500).json({ message: 'Unable to reset password right now', code: 'SERVER_ERROR' });
  } finally {
    dbClient?.release();
  }
});

/**
 * GET /api/auth/password-requirements
 * Get password policy for display
 */
router.get('/password-requirements', (req, res) => {
  res.json(getPasswordRequirements());
});

/**
 * GET /api/auth/sessions
 * List active sessions for current user
 */
router.get('/sessions', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Not authenticated', code: 'NO_TOKEN' });
    }

    const accessToken = authHeader.substring(7);
    const payload = verifyAccessToken(accessToken);
    if (!payload) {
      return res.status(401).json({ message: 'Token invalid', code: 'TOKEN_INVALID' });
    }

    const sessions = await listUserSessions(payload.userId, payload.sessionId);
    res.json({ sessions });
  } catch (err) {
    console.error('[sessions]', err);
    res.status(500).json({ message: 'Unable to list sessions', code: 'SERVER_ERROR' });
  }
});

/**
 * DELETE /api/auth/sessions/:id
 * Revoke a specific session
 */
router.delete('/sessions/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Not authenticated', code: 'NO_TOKEN' });
    }

    const accessToken = authHeader.substring(7);
    const payload = verifyAccessToken(accessToken);
    if (!payload) {
      return res.status(401).json({ message: 'Token invalid', code: 'TOKEN_INVALID' });
    }

    const result = await revokeUserSession(payload.userId, req.params.id, {
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent']
    });

    if (result.error) {
      return res.status(result.error === 'forbidden' ? 403 : 404).json({
        message: result.error === 'forbidden' ? 'Not authorized to revoke this session' : 'Session not found',
        code: result.error.toUpperCase()
      });
    }

    res.json({ message: 'Session revoked' });
  } catch (err) {
    console.error('[sessions/delete]', err);
    res.status(500).json({ message: 'Unable to revoke session', code: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/auth/devices
 * List trusted devices for current user
 */
router.get('/devices', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Not authenticated', code: 'NO_TOKEN' });
    }

    const accessToken = authHeader.substring(7);
    const payload = verifyAccessToken(accessToken);
    if (!payload) {
      return res.status(401).json({ message: 'Token invalid', code: 'TOKEN_INVALID' });
    }

    const devices = await getUserTrustedDevices(payload.userId);
    res.json({ devices });
  } catch (err) {
    console.error('[devices]', err);
    res.status(500).json({ message: 'Unable to list devices', code: 'SERVER_ERROR' });
  }
});

/**
 * DELETE /api/auth/devices/:id
 * Revoke a trusted device
 */
router.delete('/devices/:id', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Not authenticated', code: 'NO_TOKEN' });
    }

    const accessToken = authHeader.substring(7);
    const payload = verifyAccessToken(accessToken);
    if (!payload) {
      return res.status(401).json({ message: 'Token invalid', code: 'TOKEN_INVALID' });
    }

    const success = await revokeDeviceTrust(payload.userId, req.params.id, {
      ipAddress: getClientIp(req),
      userAgent: req.headers['user-agent']
    });

    if (!success) {
      return res.status(404).json({ message: 'Device not found', code: 'NOT_FOUND' });
    }

    res.json({ message: 'Device removed from trusted list' });
  } catch (err) {
    console.error('[devices/delete]', err);
    res.status(500).json({ message: 'Unable to remove device', code: 'SERVER_ERROR' });
  }
});

/**
 * GET /api/auth/mfa/settings
 * Get MFA settings for current user
 */
router.get('/mfa/settings', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'Not authenticated', code: 'NO_TOKEN' });
    }

    const accessToken = authHeader.substring(7);
    const payload = verifyAccessToken(accessToken);
    if (!payload) {
      return res.status(401).json({ message: 'Token invalid', code: 'TOKEN_INVALID' });
    }

    const settings = await getMfaSettings(payload.userId);
    res.json(settings);
  } catch (err) {
    console.error('[mfa/settings]', err);
    res.status(500).json({ message: 'Unable to get MFA settings', code: 'SERVER_ERROR' });
  }
});

/**
 * POST /api/auth/impersonate
 * Admin impersonation (for support)
 */
router.post('/impersonate', requireAuth, isAdminOrEditor, async (req, res) => {
  try {
    const targetId = req.body?.user_id;
    if (!targetId) {
      return res.status(400).json({ message: 'Missing user_id', code: 'MISSING_USER_ID' });
    }

    const target = await findUserById(targetId);
    if (!target) {
      return res.status(404).json({ message: 'User not found', code: 'USER_NOT_FOUND' });
    }

    if (target.role !== 'client') {
      return res.status(403).json({ message: 'Can only impersonate client users', code: 'INVALID_TARGET_ROLE' });
    }

    const ipAddress = getClientIp(req);
    const deviceInfo = extractDeviceInfo(req);

    // Create session for target user
    const session = await createAuthenticatedSession(target, deviceInfo, {
      ipAddress,
      userAgent: req.headers['user-agent']
    });

    setRefreshCookie(res, session.refreshToken);
    setImpersonatorCookie(res, req.user.id);

    await logSecurityEvent({
      userId: target.id,
      eventType: SecurityEventTypes.IMPERSONATION_START,
      eventCategory: SecurityEventCategories.ACCESS,
      ipAddress,
      userAgent: req.headers['user-agent'],
      success: true,
      details: { impersonatedBy: req.user.id }
    });

    res.json({
      user: session.user,
      accessToken: session.accessToken,
      expiresIn: session.expiresIn,
      impersonator: req.user?.id || null
    });
  } catch (err) {
    console.error('[impersonate]', err);
    res.status(500).json({ message: 'Unable to impersonate', code: 'SERVER_ERROR' });
  }
});

export default router;
