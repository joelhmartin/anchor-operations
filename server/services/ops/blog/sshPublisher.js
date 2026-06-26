// server/services/ops/blog/sshPublisher.js
import { query } from '../../../db.js';
import { mdToHtml } from './markdown.js';
import { wpcli, withSftp } from '../operations-website/sshClient.js';

const KNOWN_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const MIME_TO_EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };

// Derive a safe image file extension from the original filename or MIME content-type.
// Returns a dotted extension (e.g. '.jpg') or null if unrecognisable.
export function imageExtFor(originalName, contentType) {
  if (originalName) {
    const dot = originalName.lastIndexOf('.');
    if (dot !== -1) {
      let ext = originalName.slice(dot).toLowerCase();
      if (ext === '.jpeg') ext = '.jpg';
      if (KNOWN_EXTS.has(ext)) return ext;
    }
  }
  if (contentType) {
    const ext = MIME_TO_EXT[contentType.toLowerCase().split(';')[0].trim()];
    if (ext) return ext;
  }
  return null;
}

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
  let imgPathToClean = null;
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
      const { rows } = await query(`SELECT bytes, original_name, content_type FROM file_uploads WHERE id=$1`, [post.featured_file_upload_id]);
      if (rows.length && rows[0].bytes) {
        const ext = imageExtFor(rows[0].original_name, rows[0].content_type);
        if (!ext) throw new Error('Featured image has no recognizable image type/extension');
        const imgPath = `/tmp/ops-blog-${id}-img${ext}`;
        imgPathToClean = imgPath;
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
        if (imgPathToClean) await sftp.delete(imgPathToClean).catch(() => {});
      });
    } catch { /* ignore */ }
  }
}
