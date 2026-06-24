import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Set required env vars before importing modules that read them at load time.
// DATABASE_URL must be truthy so db.js doesn't throw on Pool construction;
// pg.Pool is lazy — it never actually connects unless pool.query() is called,
// which our tests never reach (all four cases throw before the revocation check).
process.env.DATABASE_URL = 'postgresql://localhost/test-dummy-no-connect';
process.env.SOCIAL_MEDIA_SECRET = 'test-secret-please-rotate';

const { verifyMediaToken } = await import('../../socialMediaTokens.js');

// All four cases reject BEFORE verifyMediaToken's DB revocation check, so they
// need no Postgres — they exercise the token security core directly.

test('verifyMediaToken rejects a non-string token', async () => {
  await assert.rejects(() => verifyMediaToken(null), (e) => e.code === 'TOKEN_MALFORMED');
});

test('verifyMediaToken rejects a malformed token (not two parts)', async () => {
  await assert.rejects(() => verifyMediaToken('not-a-valid-token'), (e) => e.code === 'TOKEN_MALFORMED');
});

test('verifyMediaToken rejects a token signed with the wrong secret', async () => {
  const payload = { jti: crypto.randomUUID(), fid: 'file-123', exp: Math.floor(Date.now() / 1000) + 3600 };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const wrongSig = crypto.createHmac('sha256', 'WRONG-secret').update(encoded).digest().toString('base64url');
  await assert.rejects(() => verifyMediaToken(`${encoded}.${wrongSig}`), (e) => e.code === 'TOKEN_BAD_SIGNATURE');
});

test('verifyMediaToken rejects an expired token even with a valid signature', async () => {
  const secret = process.env.SOCIAL_MEDIA_SECRET;
  const payload = { jti: crypto.randomUUID(), fid: 'file-123', exp: Math.floor(Date.now() / 1000) - 10 };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const validSig = crypto.createHmac('sha256', secret).update(encoded).digest().toString('base64url');
  await assert.rejects(() => verifyMediaToken(`${encoded}.${validSig}`), (e) => e.code === 'TOKEN_EXPIRED');
});
