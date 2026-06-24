// server/services/ops/__tests__/blogPublisher.test.js
import test from 'node:test';
import assert from 'node:assert/strict';

// DATABASE_URL must be truthy so db.js doesn't throw on Pool construction.
// pg.Pool is lazy — it never connects unless pool.query() is called,
// which this test never reaches (we inject a fake getClient).
process.env.DATABASE_URL = 'postgresql://localhost/test-dummy-no-connect';

// Top-level await: module evaluated once; injection hooks replace runtime fns.
const { runDueBlogPosts } = await import('../blog/blogPublisher.js');

test('runDueBlogPosts claims scheduled + retry-eligible failed posts', async () => {
  const calls = [];
  const fakeGetClient = async () => ({
    query: async (sql, params) => {
      calls.push({ sql, params });
      // Return one row for the due-select so the UPDATE + publish loop executes.
      if (/SELECT id FROM ops_blog_posts/i.test(sql)) return { rows: [{ id: 'b1' }] };
      return { rows: [] };
    },
    release() {}
  });

  await runDueBlogPosts({
    __getClientForTest: fakeGetClient,
    __publishForTest: async () => ({ ok: true })
  });

  const sel = calls.find((c) => /SELECT id FROM ops_blog_posts/i.test(c.sql));
  assert.ok(sel, 'ran a select against ops_blog_posts');
  assert.match(sel.sql, /status = 'scheduled'/);
  assert.match(sel.sql, /FOR UPDATE SKIP LOCKED/);
});
