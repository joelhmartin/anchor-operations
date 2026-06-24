// server/services/ops/__tests__/blogWpClient.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

// DATABASE_URL must be truthy so db.js doesn't throw on Pool construction.
// pg.Pool is lazy — it never connects unless pool.query() is called,
// which the basicAuthHeader test never reaches.
process.env.DATABASE_URL = 'postgresql://localhost/test-dummy-no-connect';

const { basicAuthHeader } = await import('../blog/wpClient.js');

test('basicAuthHeader passes a base64 credential straight through as Basic', () => {
  assert.equal(basicAuthHeader('dXNlcjpwYXNz'), 'Basic dXNlcjpwYXNz');
});
