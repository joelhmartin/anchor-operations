// HMAC-SHA256 signed media tokens for the public social media fetch route.
//
// Tokens are stateless: verification recomputes the HMAC over the encoded
// payload and only hits the DB to confirm the jti has not been revoked.
// This keeps the route Meta hits cheap and tractable even on repeat fetches.

import crypto from 'node:crypto';
import { query } from '../db.js';
import { notRevoked } from './queryHelpers.js';

function getSecret() {
  const s = process.env.SOCIAL_MEDIA_SECRET;
  if (!s) {
    const err = new Error('SOCIAL_MEDIA_SECRET not configured');
    err.code = 'SOCIAL_MEDIA_SECRET_MISSING';
    throw err;
  }
  return s;
}

function encodePayload(payload) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function sign(encodedPayload, secret) {
  return crypto.createHmac('sha256', secret).update(encodedPayload).digest();
}

export async function mintMediaToken(fileUploadId, { ttlMs = 60 * 60 * 1000, postId } = {}) {
  const secret = getSecret();
  const jti = crypto.randomUUID();
  const exp = Math.floor((Date.now() + ttlMs) / 1000);
  const payload = { jti, fid: fileUploadId, exp };

  const encodedPayload = encodePayload(payload);
  const sigBuf = sign(encodedPayload, secret);
  const sig = sigBuf.toString('base64url');
  const token = `${encodedPayload}.${sig}`;

  await query(
    `INSERT INTO social_media_tokens (jti, file_upload_id, post_id, expires_at)
     VALUES ($1, $2, $3, to_timestamp($4))`,
    [jti, fileUploadId, postId ?? null, exp]
  );

  return token;
}

export async function verifyMediaToken(token) {
  const secret = getSecret();

  if (typeof token !== 'string') {
    const err = new Error('Token malformed');
    err.code = 'TOKEN_MALFORMED';
    throw err;
  }

  const parts = token.split('.');
  if (parts.length !== 2) {
    const err = new Error('Token malformed');
    err.code = 'TOKEN_MALFORMED';
    throw err;
  }

  const [encodedPayload, providedSig] = parts;

  let payload;
  try {
    const decoded = Buffer.from(encodedPayload, 'base64url').toString('utf8');
    payload = JSON.parse(decoded);
  } catch {
    const err = new Error('Token malformed');
    err.code = 'TOKEN_MALFORMED';
    throw err;
  }

  if (!payload || typeof payload !== 'object' || !payload.jti || !payload.fid || !payload.exp) {
    const err = new Error('Token malformed');
    err.code = 'TOKEN_MALFORMED';
    throw err;
  }

  const expectedSigBuf = sign(encodedPayload, secret);
  const providedSigBuf = Buffer.from(providedSig, 'base64url');

  if (providedSigBuf.length !== expectedSigBuf.length) {
    const err = new Error('Token signature invalid');
    err.code = 'TOKEN_BAD_SIGNATURE';
    throw err;
  }

  if (!crypto.timingSafeEqual(providedSigBuf, expectedSigBuf)) {
    const err = new Error('Token signature invalid');
    err.code = 'TOKEN_BAD_SIGNATURE';
    throw err;
  }

  if (payload.exp * 1000 < Date.now()) {
    const err = new Error('Token expired');
    err.code = 'TOKEN_EXPIRED';
    throw err;
  }

  const { rows } = await query(`SELECT 1 FROM social_media_tokens WHERE jti = $1 AND ${notRevoked()}`, [payload.jti]);
  if (!rows.length) {
    const err = new Error('Token revoked or unknown');
    err.code = 'TOKEN_REVOKED_OR_UNKNOWN';
    throw err;
  }

  return { fileUploadId: payload.fid, jti: payload.jti };
}

export async function revokeToken(jti) {
  await query(`UPDATE social_media_tokens SET revoked_at = NOW() WHERE jti = $1 AND ${notRevoked()}`, [jti]);
}
