// server/services/ops/blog/blogPublisher.js
import { query, getClient } from '../../../db.js';
import { resolveWpConnection, wpCreatePost, wpUploadMedia } from './wpClient.js';
import { mdToHtml } from './markdown.js';

const FETCH_SQL = `SELECT * FROM ops_blog_posts WHERE id = $1 AND status = 'publishing'`;
const CLAIM_SQL = `UPDATE ops_blog_posts SET status='publishing', updated_at=NOW()
  WHERE id=$1 AND status IN ('scheduled','draft','failed') RETURNING *`;

export async function publishBlogPost(id, options = {}) {
  const { skipClaim = false } = options;
  let post;
  if (skipClaim) {
    const { rows } = await query(FETCH_SQL, [id]);
    if (!rows.length) return { ok: false, reason: 'not_found' };
    post = rows[0];
  } else {
    const { rows } = await query(CLAIM_SQL, [id]);
    if (!rows.length) return { ok: false, reason: 'already_claimed_or_finalized' };
    post = rows[0];
  }
  try {
    if (!post.oauth_connection_id) throw new Error('No WordPress connection selected');
    const { auth, siteUrl } = await resolveWpConnection(post.oauth_connection_id);
    const target = post.site_url || siteUrl;

    let featuredMediaId = null;
    if (post.featured_file_upload_id) {
      const { rows: f } = await query(`SELECT bytes, content_type, original_name FROM file_uploads WHERE id=$1`, [post.featured_file_upload_id]);
      if (f.length) {
        const up = await wpUploadMedia(target, auth, { bytes: f[0].bytes, filename: f[0].original_name, contentType: f[0].content_type });
        featuredMediaId = up.id;
      }
    }

    const html = mdToHtml(post.content_markdown);
    const created = await wpCreatePost(target, auth, { title: post.title, html, featuredMediaId });

    await query(
      `UPDATE ops_blog_posts SET status='published', wp_post_id=$2, wp_post_url=$3, published_at=NOW(), error=NULL, updated_at=NOW() WHERE id=$1`,
      [id, created.id, created.url]
    );
    return { ok: true, wpPostId: created.id, wpPostUrl: created.url };
  } catch (err) {
    try {
      await query(
        `UPDATE ops_blog_posts SET status='failed', failed_at=NOW(), error=$2, retry_count=retry_count+1, updated_at=NOW() WHERE id=$1`,
        [id, String(err.message || err).slice(0, 500)]
      );
    } catch (e2) {
      console.error('[blog] failed to mark failure', id, e2?.message);
    }
    return { ok: false, reason: 'error' };
  }
}

export async function runDueBlogPosts(testHooks = {}) {
  const getClientFn = testHooks.__getClientForTest || getClient;
  const publishFn = testHooks.__publishForTest || ((postId) => publishBlogPost(postId, { skipClaim: true }));
  const c = await getClientFn();
  let ids = [];
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(`
      SELECT id FROM ops_blog_posts
       WHERE (
           (status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= NOW())
           OR
           (status = 'failed' AND scheduled_for IS NOT NULL AND scheduled_for <= NOW()
            AND retry_count < 3 AND updated_at < NOW() - INTERVAL '15 minutes')
       )
       ORDER BY scheduled_for ASC LIMIT 50 FOR UPDATE SKIP LOCKED`);
    ids = rows.map((r) => r.id);
    if (ids.length) {
      await c.query(`UPDATE ops_blog_posts SET status='publishing', updated_at=NOW() WHERE id = ANY($1::uuid[])`, [ids]);
    }
    await c.query('COMMIT');
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    c.release();
    throw e;
  }
  c.release();
  for (const id of ids) {
    try { await publishFn(id); } catch (e) { console.error('[blog] publishBlogPost', id, e?.message); }
  }
  return { processed: ids.length };
}
