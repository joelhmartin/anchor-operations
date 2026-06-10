/**
 * Encryption Service for Sensitive Data
 *
 * Provides AES-256-GCM encryption for sensitive data at rest.
 * Used for CTM API credentials, OAuth tokens, and other secrets.
 *
 * IMPORTANT: Set ENCRYPTION_KEY in environment (32-byte hex string or 64 hex chars)
 * Generate a key: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */

import crypto from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16; // 128 bits
const AUTH_TAG_LENGTH = 16; // 128 bits
const KEY_LENGTH = 32; // 256 bits

/**
 * Get encryption key from environment
 * Falls back to a derived key from DATABASE_URL in development (not recommended for production)
 */
function getEncryptionKey() {
  const envKey = process.env.ENCRYPTION_KEY;

  if (envKey) {
    // Key should be 64 hex characters (32 bytes)
    if (envKey.length === 64 && /^[0-9a-fA-F]+$/.test(envKey)) {
      return Buffer.from(envKey, 'hex');
    }
    // Or could be a passphrase - derive key from it
    return crypto.scryptSync(envKey, 'anchor-salt', KEY_LENGTH);
  }

  // In production, require explicit key
  if (process.env.NODE_ENV === 'production') {
    console.error('[encryption] ENCRYPTION_KEY not set in production - credential encryption disabled');
    return null;
  }

  // Development fallback - derive from DATABASE_URL (NOT secure, just for dev convenience)
  const dbUrl = process.env.DATABASE_URL || 'development-fallback-key';
  console.warn('[encryption] Using derived key from DATABASE_URL - set ENCRYPTION_KEY for production');
  return crypto.scryptSync(dbUrl, 'anchor-dev-salt', KEY_LENGTH);
}

let encryptionKey = null;

/**
 * Initialize encryption key (call on startup)
 */
export function initEncryption() {
  encryptionKey = getEncryptionKey();
  if (encryptionKey) {
    console.log('[encryption] Encryption key initialized');
  }
  return !!encryptionKey;
}

/**
 * Check if encryption is available
 */
export function isEncryptionEnabled() {
  if (!encryptionKey) {
    encryptionKey = getEncryptionKey();
  }
  return !!encryptionKey;
}

/**
 * Encrypt a string value
 * Returns base64-encoded string: iv:authTag:ciphertext
 *
 * @param {string} plaintext - The value to encrypt
 * @returns {string|null} - Encrypted value or null if encryption unavailable
 */
export function encrypt(plaintext) {
  if (!plaintext) return null;

  if (!encryptionKey) {
    encryptionKey = getEncryptionKey();
  }

  if (!encryptionKey) {
    // Encryption not available - return null (caller should handle)
    return null;
  }

  try {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, encryptionKey, iv);

    let encrypted = cipher.update(plaintext, 'utf8', 'base64');
    encrypted += cipher.final('base64');

    const authTag = cipher.getAuthTag();

    // Format: iv:authTag:ciphertext (all base64)
    return `${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
  } catch (err) {
    console.error('[encryption] Encryption failed:', err.message);
    return null;
  }
}

/**
 * Decrypt an encrypted value
 *
 * @param {string} encryptedValue - The encrypted value (iv:authTag:ciphertext format)
 * @returns {string|null} - Decrypted plaintext or null if decryption fails
 */
export function decrypt(encryptedValue) {
  if (!encryptedValue) return null;

  // Check if value looks encrypted (has our format)
  if (!encryptedValue.includes(':')) {
    // Value is not encrypted (plaintext) - return as-is for migration compatibility
    return encryptedValue;
  }

  if (!encryptionKey) {
    encryptionKey = getEncryptionKey();
  }

  if (!encryptionKey) {
    console.error('[encryption] Cannot decrypt - encryption key not available');
    return null;
  }

  try {
    const parts = encryptedValue.split(':');
    if (parts.length !== 3) {
      // Not our format - return as-is (might be plaintext)
      return encryptedValue;
    }

    const [ivBase64, authTagBase64, ciphertext] = parts;

    const iv = Buffer.from(ivBase64, 'base64');
    const authTag = Buffer.from(authTagBase64, 'base64');

    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
      // Invalid format - return as-is
      return encryptedValue;
    }

    const decipher = crypto.createDecipheriv(ALGORITHM, encryptionKey, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'base64', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  } catch (err) {
    // Decryption failed - could be wrong key or corrupted data
    console.error('[encryption] Decryption failed:', err.message);
    return null;
  }
}

/**
 * Check if a value appears to be encrypted
 *
 * @param {string} value - The value to check
 * @returns {boolean} - True if value appears encrypted
 */
export function isEncrypted(value) {
  if (!value || typeof value !== 'string') return false;

  const parts = value.split(':');
  if (parts.length !== 3) return false;

  try {
    const iv = Buffer.from(parts[0], 'base64');
    const authTag = Buffer.from(parts[1], 'base64');
    return iv.length === IV_LENGTH && authTag.length === AUTH_TAG_LENGTH;
  } catch {
    return false;
  }
}

/**
 * Encrypt an object's sensitive fields
 *
 * @param {object} obj - Object containing sensitive data
 * @param {string[]} fields - Field names to encrypt
 * @returns {object} - Object with encrypted fields
 */
export function encryptFields(obj, fields) {
  if (!obj) return obj;

  const result = { ...obj };
  for (const field of fields) {
    if (result[field] && !isEncrypted(result[field])) {
      const encrypted = encrypt(result[field]);
      if (encrypted) {
        result[field] = encrypted;
      }
    }
  }
  return result;
}

/**
 * Decrypt an object's encrypted fields
 *
 * @param {object} obj - Object with encrypted data
 * @param {string[]} fields - Field names to decrypt
 * @returns {object} - Object with decrypted fields
 */
export function decryptFields(obj, fields) {
  if (!obj) return obj;

  const result = { ...obj };
  for (const field of fields) {
    if (result[field]) {
      const decrypted = decrypt(result[field]);
      if (decrypted !== null) {
        result[field] = decrypted;
      }
    }
  }
  return result;
}
