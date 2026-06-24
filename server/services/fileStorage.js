/**
 * File Storage Service
 *
 * Stores uploaded files in PostgreSQL for persistence on ephemeral platforms (Cloud Run).
 * Use this instead of filesystem storage for any uploads that need to persist.
 *
 * Usage:
 *   import { storeFile, getFileUrl, serveFile } from './services/fileStorage.js';
 *
 *   // After multer upload:
 *   const url = await storeFile(req.file, { category: 'group-icon', ownerId: groupId });
 *
 *   // In a GET endpoint:
 *   router.get('/files/:id', (req, res) => serveFile(req.params.id, res));
 */

import { query } from '../db.js';
import fsPromises from 'fs/promises';
import crypto from 'crypto';

function safeDispositionName(name) {
  // original_name is attacker-controlled — strip CR/LF/quotes/control chars to prevent
  // header injection; replace any non-ASCII with '_' for a safe filename token.
  var n = String(name || 'download').replace(/[\r\n"\\]/g, '').replace(/[^\x20-\x7e]/g, '_').trim();
  return n || 'download';
}

/**
 * Store an uploaded file in the database
 *
 * @param {Object} file - Multer file object (req.file)
 * @param {Object} options - { category, ownerId?, ownerType?, metadata? }
 * @returns {Promise<{ id: string, url: string }>}
 */
export async function storeFile(file, options = {}) {
  const { category = 'general', ownerId = null, ownerType = null, metadata = {} } = options;

  if (!file) {
    throw new Error('No file provided');
  }

  // Read bytes from temp file or buffer
  let bytes;
  if (file.buffer) {
    bytes = file.buffer;
  } else if (file.path) {
    bytes = await fsPromises.readFile(file.path);
    // Clean up temp file
    await fsPromises.unlink(file.path).catch(() => {});
  } else {
    throw new Error('File has no buffer or path');
  }

  const contentType = file.mimetype || 'application/octet-stream';
  const originalName = file.originalname || 'upload';
  const sizeBytes = bytes.length;

  // Generate a hash for deduplication (optional future use)
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');

  const { rows } = await query(
    `INSERT INTO file_uploads
       (category, owner_id, owner_type, original_name, content_type, size_bytes, hash, bytes, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [category, ownerId, ownerType, originalName, contentType, sizeBytes, hash, bytes, JSON.stringify(metadata)]
  );

  const fileId = rows[0].id;
  const url = `/api/files/${fileId}`;

  return { id: fileId, url };
}

/**
 * Get a file's URL by ID
 *
 * @param {string} fileId
 * @returns {string}
 */
export function getFileUrl(fileId) {
  return `/api/files/${fileId}`;
}

const STAFF_ROLES = new Set(['superadmin', 'admin', 'team']);

async function userCanAccessFile(file, user, portalUserId) {
  // Group icons are logos (not PHI) — publicly readable like user avatars
  if (file.category === 'group-icon') return true;
  // Client brand display logos are publicly readable so they can render in
  // outgoing emails (no auth headers available in email clients).
  if (file.category === 'brand-display-logo') return true;

  if (!user) return false;
  const role = user.effective_role || user.role;
  if (STAFF_ROLES.has(role)) return true;

  if (!file.owner_id || !file.owner_type) return false;

  if (file.owner_type === 'user') {
    // Owner directly, acting client (impersonation/multi-account), or member of the owner's account.
    if (file.owner_id === user.id) return true;
    if (portalUserId && file.owner_id === portalUserId) return true;
    const { rows } = await query(
      `SELECT 1 FROM client_account_members
       WHERE client_owner_id = $1 AND member_user_id = $2 AND status = 'active'
       LIMIT 1`,
      [file.owner_id, user.id]
    );
    return rows.length > 0;
  }

  if (file.owner_type === 'client_group') {
    const { rows } = await query(
      `SELECT 1 FROM client_group_members
       WHERE client_group_id = $1 AND member_user_id = $2 AND status = 'active'
       LIMIT 1`,
      [file.owner_id, user.id]
    );
    return rows.length > 0;
  }

  return false;
}

/**
 * Serve a file from the database
 * Call this from a route handler: serveFile(req.params.id, res, { user: req.user, portalUserId: req.portalUserId })
 *
 * @param {string} fileId
 * @param {Response} res - Express response object
 * @param {Object} options - { maxAge?, download?, user?, portalUserId? }
 */
// Raster images + PDF are safe to render inline. SVG and HTML are deliberately EXCLUDED —
// they can carry script and would execute in our origin (stored XSS over PHI).
const PREVIEW_SAFE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

export async function serveFile(fileId, res, options = {}) {
  const { maxAge = 86400, download = false, preview = false, user = null, portalUserId = null } = options;

  try {
    const { rows } = await query(
      `SELECT content_type, original_name, bytes, owner_id, owner_type, category
         FROM file_uploads WHERE id = $1`,
      [fileId]
    );

    if (!rows.length) {
      return res.status(404).send('File not found');
    }

    const file = rows[0];

    if (!(await userCanAccessFile(file, user, portalUserId))) {
      return res.status(403).send('Forbidden');
    }

    res.setHeader('Content-Type', file.content_type);
    // Public categories (group icons, brand display logos) need cross-origin
    // + public caching so they can be embedded in emails and external pages.
    const isPublic = file.category === 'group-icon' || file.category === 'brand-display-logo';
    if (isPublic) {
      res.setHeader('Cache-Control', `public, max-age=${maxAge}`);
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    } else {
      res.setHeader('Cache-Control', `private, max-age=${maxAge}`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
    }

    // CTM form uploads are untrusted public/anonymous uploads. Default to forced download
    // (XSS via attacker-controlled HTML/SVG). Allow INLINE rendering only when explicitly
    // requested for preview AND the type is on the raster/PDF allowlist — and harden it with
    // a sandbox CSP so even a mislabeled file cannot execute script in our origin.
    const isUntrustedUpload = file.category === 'ctm-form-upload';
    const canPreviewInline =
      preview && !download && isUntrustedUpload && PREVIEW_SAFE_TYPES.has(String(file.content_type || '').toLowerCase());

    if (canPreviewInline) {
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; object-src 'none'");
      res.setHeader('Content-Disposition', `inline; filename="${safeDispositionName(file.original_name)}"`);
    } else if (download || isUntrustedUpload) {
      res.setHeader('Content-Disposition', `attachment; filename="${safeDispositionName(file.original_name)}"`);
    }

    res.send(file.bytes);
  } catch (err) {
    console.error('[fileStorage:serve]', err);
    res.status(500).send('Failed to load file');
  }
}

/**
 * Delete a file from the database
 *
 * @param {string} fileId
 * @returns {Promise<boolean>}
 */
export async function deleteFile(fileId) {
  const { rowCount } = await query(`DELETE FROM file_uploads WHERE id = $1`, [fileId]);
  return rowCount > 0;
}

/**
 * Delete all files for an owner
 *
 * @param {string} ownerId
 * @param {string} ownerType
 * @returns {Promise<number>} - Number of files deleted
 */
export async function deleteFilesForOwner(ownerId, ownerType) {
  const { rowCount } = await query(
    `DELETE FROM file_uploads WHERE owner_id = $1 AND owner_type = $2`,
    [ownerId, ownerType]
  );
  return rowCount;
}

/**
 * Get file metadata (without bytes)
 *
 * @param {string} fileId
 * @returns {Promise<Object|null>}
 */
export async function getFileMeta(fileId) {
  const { rows } = await query(
    `SELECT id, category, owner_id, owner_type, original_name, content_type, size_bytes, created_at
     FROM file_uploads WHERE id = $1`,
    [fileId]
  );
  return rows[0] || null;
}
