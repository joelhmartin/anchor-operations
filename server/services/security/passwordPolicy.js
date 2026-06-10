/**
 * Password Policy Service
 *
 * Implements strong password requirements:
 * - Minimum 12 characters
 * - At least one uppercase letter
 * - At least one lowercase letter
 * - At least one number
 * - At least one special character
 *
 * Uses Argon2id for password hashing (preferred over bcrypt for new implementations).
 * Falls back to bcrypt for existing passwords during transition.
 */

import argon2 from 'argon2';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

// Password policy configuration
const MIN_LENGTH = parseInt(process.env.PASSWORD_MIN_LENGTH || '12', 10);
const REQUIRE_UPPERCASE = process.env.PASSWORD_REQUIRE_UPPERCASE !== 'false';
const REQUIRE_LOWERCASE = process.env.PASSWORD_REQUIRE_LOWERCASE !== 'false';
const REQUIRE_NUMBER = process.env.PASSWORD_REQUIRE_NUMBER !== 'false';
const REQUIRE_SPECIAL = process.env.PASSWORD_REQUIRE_SPECIAL !== 'false';

// Common passwords list (abbreviated - in production, use a full list)
const COMMON_PASSWORDS = new Set([
  'password123456',
  '123456789012',
  'qwertyuiop12',
  'letmein123456',
  'welcome12345',
  'admin1234567',
  'password1234',
  'changeme1234',
  'iloveyou1234',
  'sunshine1234',
  'princess1234',
  'football1234',
  'monkey1234567',
  'shadow12345678',
  'master12345678'
]);

/**
 * Validate a password against the policy
 *
 * @param {string} password - The password to validate
 * @param {Object} options - Optional validation options
 * @param {string} options.email - User's email to check for inclusion
 * @param {string} options.firstName - User's first name to check for inclusion
 * @param {string} options.lastName - User's last name to check for inclusion
 * @returns {Object} { valid: boolean, errors: string[] }
 */
export function validatePassword(password, options = {}) {
  const errors = [];

  if (!password) {
    return { valid: false, errors: ['Password is required'] };
  }

  // Length check
  if (password.length < MIN_LENGTH) {
    errors.push(`Password must be at least ${MIN_LENGTH} characters`);
  }

  // Character requirements
  if (REQUIRE_UPPERCASE && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter');
  }

  if (REQUIRE_LOWERCASE && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter');
  }

  if (REQUIRE_NUMBER && !/[0-9]/.test(password)) {
    errors.push('Password must contain at least one number');
  }

  if (REQUIRE_SPECIAL && !/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?`~]/.test(password)) {
    errors.push('Password must contain at least one special character');
  }

  // Check for common passwords
  if (COMMON_PASSWORDS.has(password.toLowerCase())) {
    errors.push('This password is too common. Please choose a more unique password.');
  }

  // Check for personal information inclusion
  const { email, firstName, lastName } = options;
  const lowerPassword = password.toLowerCase();

  if (email) {
    const emailLocal = email.split('@')[0].toLowerCase();
    if (emailLocal.length >= 4 && lowerPassword.includes(emailLocal)) {
      errors.push('Password should not contain your email address');
    }
  }

  if (firstName && firstName.length >= 3 && lowerPassword.includes(firstName.toLowerCase())) {
    errors.push('Password should not contain your first name');
  }

  if (lastName && lastName.length >= 3 && lowerPassword.includes(lastName.toLowerCase())) {
    errors.push('Password should not contain your last name');
  }

  // Check for repeated characters
  if (/(.)\1{3,}/.test(password)) {
    errors.push('Password should not contain more than 3 repeated characters');
  }

  // Check for sequential characters
  if (hasSequentialChars(password, 4)) {
    errors.push('Password should not contain sequential characters (e.g., 1234, abcd)');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Check for sequential characters
 */
function hasSequentialChars(str, minLength) {
  const sequences = ['0123456789', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];

  const lower = str.toLowerCase();

  for (const seq of sequences) {
    for (let i = 0; i <= seq.length - minLength; i++) {
      const forward = seq.substring(i, i + minLength);
      const backward = forward.split('').reverse().join('');

      if (lower.includes(forward) || lower.includes(backward)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Calculate password strength score (0-100)
 */
export function getPasswordStrength(password) {
  if (!password) return 0;

  let score = 0;

  // Length scoring (up to 30 points)
  score += Math.min(password.length * 2, 30);

  // Character variety (up to 40 points)
  if (/[a-z]/.test(password)) score += 10;
  if (/[A-Z]/.test(password)) score += 10;
  if (/[0-9]/.test(password)) score += 10;
  if (/[^a-zA-Z0-9]/.test(password)) score += 10;

  // Bonus for mixing (up to 20 points)
  const charTypes = [/[a-z]/.test(password), /[A-Z]/.test(password), /[0-9]/.test(password), /[^a-zA-Z0-9]/.test(password)].filter(
    Boolean
  ).length;

  score += charTypes * 5;

  // Penalty for common patterns
  if (/(.)\1{2,}/.test(password)) score -= 10;
  if (hasSequentialChars(password, 3)) score -= 10;
  if (COMMON_PASSWORDS.has(password.toLowerCase())) score -= 30;

  return Math.max(0, Math.min(100, score));
}

/**
 * Get human-readable strength label
 */
export function getStrengthLabel(score) {
  if (score < 30) return { label: 'Weak', color: '#dc2626' };
  if (score < 50) return { label: 'Fair', color: '#f59e0b' };
  if (score < 70) return { label: 'Good', color: '#10b981' };
  if (score < 90) return { label: 'Strong', color: '#059669' };
  return { label: 'Excellent', color: '#047857' };
}

/**
 * Hash a password using Argon2id
 * This is the recommended algorithm for new passwords
 */
export async function hashPassword(password) {
  try {
    // Argon2id with recommended parameters
    const hash = await argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 65536, // 64 MB
      timeCost: 3,
      parallelism: 4,
      hashLength: 32
    });
    return hash;
  } catch (err) {
    // Fallback to bcrypt if argon2 fails (shouldn't happen but just in case)
    console.warn('[password] Argon2 failed, falling back to bcrypt:', err.message);
    return await bcrypt.hash(password, 12);
  }
}

/**
 * Verify a password against a hash
 * Supports both Argon2 and bcrypt for migration compatibility
 */
export async function verifyPassword(password, hash) {
  if (!password || !hash) return false;

  // Detect hash type
  if (hash.startsWith('$argon2')) {
    // Argon2 hash
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  } else if (hash.startsWith('$2')) {
    // bcrypt hash
    try {
      return await bcrypt.compare(password, hash);
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * Check if a password hash needs to be upgraded (bcrypt → argon2)
 */
export function needsRehash(hash) {
  if (!hash) return true;

  // bcrypt hashes need upgrade
  if (hash.startsWith('$2')) {
    return true;
  }

  // Check if argon2 parameters need updating
  if (hash.startsWith('$argon2')) {
    try {
      return argon2.needsRehash(hash, {
        type: argon2.argon2id,
        memoryCost: 65536,
        timeCost: 3,
        parallelism: 4
      });
    } catch {
      return true;
    }
  }

  return true;
}

/**
 * Generate a secure random password
 */
export function generateSecurePassword(length = 16) {
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const numbers = '0123456789';
  const special = '!@#$%^&*()_+-=[]{}|;:,.<>?';

  const all = lowercase + uppercase + numbers + special;

  // Ensure at least one of each required type
  let password = '';
  password += lowercase[crypto.randomInt(lowercase.length)];
  password += uppercase[crypto.randomInt(uppercase.length)];
  password += numbers[crypto.randomInt(numbers.length)];
  password += special[crypto.randomInt(special.length)];

  // Fill the rest randomly
  for (let i = password.length; i < length; i++) {
    password += all[crypto.randomInt(all.length)];
  }

  // Shuffle the password
  return password
    .split('')
    .sort(() => crypto.randomInt(3) - 1)
    .join('');
}

/**
 * Get password policy requirements for display
 */
export function getPasswordRequirements() {
  return {
    minLength: MIN_LENGTH,
    requireUppercase: REQUIRE_UPPERCASE,
    requireLowercase: REQUIRE_LOWERCASE,
    requireNumber: REQUIRE_NUMBER,
    requireSpecial: REQUIRE_SPECIAL,
    description: `Password must be at least ${MIN_LENGTH} characters and include ${[REQUIRE_UPPERCASE && 'uppercase', REQUIRE_LOWERCASE && 'lowercase', REQUIRE_NUMBER && 'number', REQUIRE_SPECIAL && 'special character'].filter(Boolean).join(', ')}.`
  };
}

