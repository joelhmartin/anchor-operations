// server/services/ops/blog/blogStore.js
import { query } from '../../../db.js';

export async function createPost({ clientId, createdBy, oauthConnectionId, siteResourceId, siteUrl, kinstaEnvironmentId, title, contentMarkdown, featuredFileUploadId, status, scheduledFor }) {
  const { rows } = await query(
    `INSERT INTO ops_blog_posts
      (client_id, created_by, oauth_connection_id, site_resource_id, site_url, kinsta_environment_id, title, content_markdown, featured_file_upload_id, status, scheduled_for)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [clientId, createdBy, oauthConnectionId || null, siteResourceId || null, siteUrl || null, kinstaEnvironmentId || null, title, contentMarkdown || '', featuredFileUploadId || null, status || 'draft', scheduledFor || null]
  );
  return rows[0];
}

export async function updatePost(id, fields) {
  const allowed = ['title', 'content_markdown', 'oauth_connection_id', 'site_resource_id', 'site_url', 'kinsta_environment_id', 'featured_file_upload_id', 'status', 'scheduled_for'];
  const sets = []; const vals = []; let i = 1;
  for (const k of allowed) { if (k in fields) { sets.push(`${k} = $${i++}`); vals.push(fields[k]); } }
  if (!sets.length) return getPost(id);
  vals.push(id);
  const { rows } = await query(`UPDATE ops_blog_posts SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${i} RETURNING *`, vals);
  return rows[0] || null;
}

export async function cancelPost(id) {
  const { rows } = await query(`UPDATE ops_blog_posts SET status='cancelled', updated_at=NOW() WHERE id=$1 AND status IN ('draft','scheduled','failed') RETURNING *`, [id]);
  return rows[0] || null;
}

export async function deletePost(id) {
  await query(`DELETE FROM ops_blog_posts WHERE id=$1`, [id]);
  return { ok: true };
}

export async function getPost(id) {
  const { rows } = await query(`SELECT * FROM ops_blog_posts WHERE id=$1`, [id]);
  return rows[0] || null;
}

export async function listPosts(clientId) {
  const { rows } = await query(
    `SELECT * FROM ops_blog_posts WHERE ($1::uuid IS NULL OR client_id=$1) ORDER BY COALESCE(scheduled_for, published_at, created_at) DESC LIMIT 200`,
    [clientId || null]
  );
  return rows;
}

// A client's connected WordPress sites (connection + resource).
export async function listClientWpSites(clientId) {
  const { rows } = await query(
    `SELECT r.id AS site_resource_id, r.resource_url AS site_url, r.resource_name AS site_name, r.is_primary,
            oc.id AS oauth_connection_id
       FROM oauth_resources r
       JOIN oauth_connections oc ON r.oauth_connection_id = oc.id
      WHERE r.client_id = $1 AND r.provider = 'wordpress' AND r.resource_type = 'wordpress_site'
        AND oc.provider = 'wordpress'
      ORDER BY r.is_primary DESC NULLS LAST, r.resource_name ASC`,
    [clientId]
  );
  return rows;
}

// A client's assigned Kinsta sites (live environment only, for blog publishing).
export async function listClientKinstaBlogTargets(clientId) {
  const { rows } = await query(
    `SELECT s.id AS site_id,
            e.id AS kinsta_environment_id,
            COALESCE(NULLIF(s.display_name, ''), s.site_name) AS label,
            e.primary_domain
       FROM kinsta_site_clients ksc
       JOIN kinsta_sites s ON s.id = ksc.site_id
       JOIN kinsta_environments e ON e.site_id = s.id AND e.is_live = TRUE
      WHERE ksc.client_user_id = $1 AND s.archived_at IS NULL
      ORDER BY label ASC`,
    [clientId]
  );
  return rows;
}
