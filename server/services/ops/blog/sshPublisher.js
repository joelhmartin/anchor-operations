// server/services/ops/blog/sshPublisher.js
import { query } from '../../../db.js';
import { mdToHtml } from './markdown.js';
import { wpcli, withSftp } from '../operations-website/sshClient.js';

// Single-quote a value for safe shell use: ' -> '\'' . Everything else stays literal.
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, "'\\''")}'`;
}

export function wpCreateArgs(htmlPath, title) {
  return `post create ${htmlPath} --post_title=${shellQuote(title)} --post_status=draft --porcelain`;
}

export function wpMediaArgs(imgPath, wpPostId) {
  return `media import ${imgPath} --post_id=${wpPostId} --featured_image --porcelain`;
}

export function wpPublishArgs(wpPostId) {
  return `post update ${wpPostId} --post_status=publish --porcelain`;
}

// Publish a claimed ops_blog_posts row (status='publishing') to its Kinsta site via WP-CLI.
// Idempotent: wp_post_id persisted after the draft create, so a retry resumes (no duplicate).
export async function publishViaSsh(id, post) {
  const envId = post.kinsta_environment_id;
  const htmlPath = `/tmp/ops-blog-${id}.html`;
  const imgPath = `/tmp/ops-blog-${id}-img`;
  try {
    let wpPostId = post.wp_post_id ? String(post.wp_post_id) : '';

    if (!wpPostId) {
      const html = mdToHtml(post.content_markdown);
      await withSftp(envId, async (sftp) => { await sftp.put(Buffer.from(html, 'utf8'), htmlPath); });
      const out = await wpcli(envId, wpCreateArgs(htmlPath, post.title));
      if (out.exitCode !== 0) throw new Error(`wp post create failed: ${String(out.stderr || '').slice(0, 200)}`);
      wpPostId = String(out.stdout || '').trim();
      if (!wpPostId) throw new Error(`wp post create returned no id: ${String(out.stderr || '').slice(0, 200)}`);
      await query(`UPDATE ops_blog_posts SET wp_post_id=$2, updated_at=NOW() WHERE id=$1`, [id, wpPostId]);
    }

    // Invariant: wp_post_id must be a bare integer before it's reused (unquoted) in
    // downstream WP-CLI commands. Covers both the fresh-create and resume paths.
    if (!/^\d+$/.test(wpPostId)) {
      throw new Error(`unexpected wp post id from create: ${String(wpPostId).slice(0, 50)}`);
    }

    if (post.featured_file_upload_id) {
      const { rows } = await query(`SELECT bytes FROM file_uploads WHERE id=$1`, [post.featured_file_upload_id]);
      if (rows.length && rows[0].bytes) {
        await withSftp(envId, async (sftp) => { await sftp.put(rows[0].bytes, imgPath); });
        const med = await wpcli(envId, wpMediaArgs(imgPath, wpPostId));
        if (med.exitCode !== 0) throw new Error(`wp media import failed: ${String(med.stderr || '').slice(0, 200)}`);
      }
    }

    const pub = await wpcli(envId, wpPublishArgs(wpPostId));
    if (pub.exitCode !== 0) throw new Error(`wp publish failed: ${String(pub.stderr || '').slice(0, 200)}`);

    let url = null;
    try {
      const u = await wpcli(envId, `post get ${wpPostId} --field=url`);
      url = String(u.stdout || '').trim() || null;
    } catch { /* url is non-fatal */ }

    await query(
      `UPDATE ops_blog_posts SET status='published', wp_post_id=$2, wp_post_url=$3, published_at=NOW(), error=NULL, updated_at=NOW() WHERE id=$1`,
      [id, wpPostId, url]
    );
    return { ok: true, wpPostId, wpPostUrl: url };
  } catch (err) {
    await query(
      `UPDATE ops_blog_posts SET status='failed', failed_at=NOW(), error=$2, retry_count=retry_count+1, updated_at=NOW() WHERE id=$1`,
      [id, String(err.message || err).slice(0, 500)]
    ).catch((e2) => console.error('[blog-ssh] mark-failure failed', id, e2?.message));
    return { ok: false, reason: 'error' };
  } finally {
    // Best-effort temp cleanup via SFTP.
    try {
      await withSftp(envId, async (sftp) => {
        await sftp.delete(htmlPath).catch(() => {});
        await sftp.delete(imgPath).catch(() => {});
      });
    } catch { /* ignore */ }
  }
}
