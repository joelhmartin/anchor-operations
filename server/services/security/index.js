/**
 * Security Services Index
 *
 * Central export for all security-related services.
 */

// Token management
export {
  generateSecureToken,
  hashToken,
  signAccessToken,
  verifyAccessToken,
  createSession,
  refreshSession,
  revokeSession,
  revokeAllUserSessions,
  revokeTokenFamily,
  getSession,
  isSessionValid,
  touchSession,
  getUserActiveSessions,
  getTokenConfig
} from './tokens.js';

// Session management
export {
  createAuthenticatedSession,
  refreshAuthenticatedSession,
  endSession,
  endAllSessions,
  listUserSessions,
  revokeUserSession,
  validateSession,
  needsReauthentication,
  onPasswordChange,
  onMfaChange,
  applySyntheticAccessActivation
} from './sessions.js';

// Audit logging
export {
  SecurityEventTypes,
  SecurityEventCategories,
  logSecurityEvent,
  getUserAuditLogs,
  getRecentSecurityEvents,
  getSecurityStats,
  logLoginAttempt,
  logMfaChallenge
} from './audit.js';

// Rate limiting
export {
  checkRateLimit,
  recordAttempt,
  clearRateLimit,
  lockUserAccount,
  isUserLocked,
  unlockUserAccount,
  recordFailedLogin,
  resetFailedLogins,
  cleanupExpiredRateLimits,
  getRateLimitConfig
} from './rateLimit.js';

// Device fingerprinting
export {
  parseUserAgent,
  generateDeviceId,
  generateFingerprint,
  extractDeviceInfo,
  isDeviceTrusted,
  trustDevice,
  revokeDeviceTrust,
  revokeAllTrustedDevices,
  getUserTrustedDevices,
  isNewDevice,
  hasLocationChanged,
  getLastActivityTime,
  hasBeenInactive
} from './deviceFingerprint.js';

// MFA
export {
  MfaTriggerReasons,
  getMfaSettings,
  enableEmailOtp,
  disableEmailOtp,
  isMfaRequired,
  createEmailOtpChallenge,
  verifyOtp,
  hasPendingChallenge,
  resendOtp,
  cleanupExpiredChallenges,
  maskEmail
} from './mfa.js';

// Encryption
export {
  initEncryption,
  isEncryptionEnabled,
  encrypt,
  decrypt,
  isEncrypted,
  encryptFields,
  decryptFields
} from './encryption.js';

// Password policy
export {
  validatePassword,
  getPasswordStrength,
  getStrengthLabel,
  hashPassword,
  verifyPassword,
  needsRehash,
  generateSecurePassword,
  getPasswordRequirements
} from './passwordPolicy.js';

