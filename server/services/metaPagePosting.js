/**
 * Meta Page Posting — token resolution + link/health helpers.
 *
 * - Resolves per-Page tokens from the system user (lazy refresh on miss).
 * - Stores tokens AES-256-GCM encrypted via services/security/encryption.
 * - Throws typed errors matching Meta Graph API's error envelope so callers
 *   can branch on `code` (190 = token expired) and HTTP status.
 */

import { query } from '../db.js';
import { activeOnly } from './queryHelpers.js';
import { encrypt, decrypt } from './security/encryption.js';
import { fetchFacebookPages, fetchInstagramAccountForPage } from './metaGraph.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

/**
 * Low-level Graph API helper. Throws typed errors on non-2xx:
 *   err.status, err.code, err.subcode, err.fbtrace
 */
export async function graph(pathStr, { params = {}, method = 'GET', body = null } = {}) {
  const url = new URL(`${GRAPH}/${pathStr.replace(/^\//, '')}`);
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined) continue;
    url.searchParams.set(key, String(value));
  }

  const init = { method, headers: {} };
  if (body !== null && (method === 'POST' || method === 'DELETE' || method === 'PUT')) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }

  const res = await fetch(url.toString(), init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON body
  }

  if (!res.ok) {
    const errEnvelope = json && json.error ? json.error : {};
    const err = new Error(errEnvelope.message || `Graph API ${res.status}: ${text || res.statusText}`);
    err.status = res.status;
    err.code = errEnvelope.code;
    err.subcode = errEnvelope.error_subcode;
    err.fbtrace = errEnvelope.fbtrace_id;
    throw err;
  }

  return json;
}

/**
 * List Facebook Pages accessible to the system user, enriched with IG details
 * for any Page that has an Instagram Business Account.
 */
export async function listAccessiblePages() {
  const systemToken = process.env.FACEBOOK_SYSTEM_USER_TOKEN;
  if (!systemToken) {
    const err = new Error('FACEBOOK_SYSTEM_USER_TOKEN is not configured');
    err.code = 'META_NOT_CONFIGURED';
    throw err;
  }

  const pages = await fetchFacebookPages(systemToken);
  const enriched = [];
  for (const page of pages) {
    let igUserId = page.instagramBusinessAccountId || null;
    let igUsername = null;
    if (igUserId) {
      const ig = await fetchInstagramAccountForPage(page.accessToken, igUserId);
      if (ig) {
        igUserId = ig.id;
        igUsername = ig.username || null;
      }
    }
    enriched.push({
      fbPageId: page.id,
      fbPageName: page.name,
      fbPageToken: page.accessToken,
      igUserId,
      igUsername,
      picture: page.picture || ''
    });
  }
  return enriched;
}

/**
 * Link a client to a Facebook Page. Encrypts the page-specific token and
 * upserts a meta_page_links row.
 */
export async function linkClient({ clientId, fbPageId, createdBy }) {
  const pages = await listAccessiblePages();
  const match = pages.find((p) => p.fbPageId === fbPageId);
  if (!match) {
    const err = new Error(`FB Page ${fbPageId} not accessible to system user`);
    err.code = 'META_PAGE_NOT_ACCESSIBLE';
    throw err;
  }

  const encrypted = encrypt(match.fbPageToken);
  if (!encrypted) {
    const err = new Error('Failed to encrypt page access token');
    err.code = 'META_ENCRYPTION_FAILED';
    throw err;
  }

  const { rows } = await query(
    `INSERT INTO meta_page_links
       (client_id, fb_page_id, fb_page_name, ig_user_id, ig_username,
        page_access_token_encrypted, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (client_id, fb_page_id) DO UPDATE SET
       fb_page_name = EXCLUDED.fb_page_name,
       ig_user_id = EXCLUDED.ig_user_id,
       ig_username = EXCLUDED.ig_username,
       page_access_token_encrypted = EXCLUDED.page_access_token_encrypted,
       archived_at = NULL
     RETURNING *`,
    [clientId, match.fbPageId, match.fbPageName, match.igUserId, match.igUsername, encrypted, createdBy || null]
  );
  return rows[0];
}

/**
 * Resolve a decrypted page token by page_link id. Lazily re-fetches from the
 * system user if the encrypted column is missing (e.g. after a forced clear).
 */
export async function getPageToken(pageLinkId) {
  const { rows } = await query(
    `SELECT id, fb_page_id, page_access_token_encrypted
       FROM meta_page_links
       WHERE id = $1 AND ${activeOnly()}`,
    [pageLinkId]
  );
  if (!rows[0]) {
    const err = new Error('Page link not found');
    err.code = 'META_PAGE_LINK_NOT_FOUND';
    throw err;
  }
  const row = rows[0];

  if (row.page_access_token_encrypted) {
    const decrypted = decrypt(row.page_access_token_encrypted);
    if (decrypted) return decrypted;
    // fall through to lazy refresh on decrypt failure
  }

  const pages = await listAccessiblePages();
  const match = pages.find((p) => p.fbPageId === row.fb_page_id);
  if (!match) {
    const err = new Error(`Page ${row.fb_page_id} no longer accessible to system user`);
    err.code = 'META_PAGE_LOST_ACCESS';
    throw err;
  }
  const encrypted = encrypt(match.fbPageToken);
  if (encrypted) {
    await query(`UPDATE meta_page_links SET page_access_token_encrypted = $1 WHERE id = $2`, [encrypted, row.id]);
  }
  return match.fbPageToken;
}

/**
 * Health-check a linked Page by fetching /{fb_page_id}?fields=id,name with
 * the cached token. Updates last_health_* columns and returns the result.
 */
export async function healthCheckPage(pageLinkId) {
  const { rows } = await query(`SELECT id, fb_page_id FROM meta_page_links WHERE id = $1`, [pageLinkId]);
  if (!rows[0]) {
    const err = new Error('Page link not found');
    err.code = 'META_PAGE_LINK_NOT_FOUND';
    throw err;
  }
  const fbPageId = rows[0].fb_page_id;

  try {
    const token = await getPageToken(pageLinkId);
    await graph(fbPageId, { params: { fields: 'id,name', access_token: token } });
    await query(
      `UPDATE meta_page_links
          SET last_health_check_at = NOW(),
              last_health_status = 'ok',
              last_health_error = NULL
        WHERE id = $1`,
      [pageLinkId]
    );
    return { ok: true };
  } catch (err) {
    let status = 'unknown';
    if (err.code === 190) status = 'token_expired';
    else if (err.status === 403) status = 'page_unauthorized';

    await query(
      `UPDATE meta_page_links
          SET last_health_check_at = NOW(),
              last_health_status = $1,
              last_health_error = $2
        WHERE id = $3`,
      [status, err.message || String(err), pageLinkId]
    );
    return { ok: false, status, error: err.message || String(err) };
  }
}

// ---------------------------------------------------------------------------
// Publishing — Facebook + Instagram
// ---------------------------------------------------------------------------

async function getPageLinkRow(pageLinkId) {
  const { rows } = await query(`SELECT id, fb_page_id, ig_user_id FROM meta_page_links WHERE id = $1 AND ${activeOnly()}`, [
    pageLinkId
  ]);
  if (!rows[0]) {
    const err = new Error('Page link not found or archived');
    err.code = 'EMPTY_PAGE_LINK';
    throw err;
  }
  return rows[0];
}

function toUnixSeconds(scheduledFor) {
  if (!scheduledFor) return null;
  const d = scheduledFor instanceof Date ? scheduledFor : new Date(scheduledFor);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor(d.getTime() / 1000);
}

function classifyMedia(media) {
  const list = Array.isArray(media) ? media.filter(Boolean) : [];
  if (list.length === 0) return { kind: 'none', list };
  if (list.length === 1) {
    const m = list[0];
    if (m.type === 'image') return { kind: 'single_image', list };
    if (m.type === 'video') return { kind: 'single_video', list };
    const err = new Error(`Unknown media type: ${m.type}`);
    err.code = 'INVALID_MEDIA_COMBINATION';
    throw err;
  }
  // 2+ items
  if (list.length > 10) {
    const err = new Error('Carousel supports up to 10 items');
    err.code = 'INVALID_MEDIA_COMBINATION';
    throw err;
  }
  const allImages = list.every((m) => m.type === 'image');
  if (!allImages) {
    const err = new Error('Mixed media types not supported (carousel requires all images)');
    err.code = 'INVALID_MEDIA_COMBINATION';
    throw err;
  }
  return { kind: 'carousel', list };
}

/**
 * Post to a Facebook Page. Supports text/link, single image, image carousel,
 * and single video. `scheduledFor` (Date | ISO string) — if present, the final
 * post is created as unpublished with scheduled_publish_time set.
 *
 * Returns the raw Graph response (usually `{ id }` or `{ id, post_id }`).
 */
export async function postToFacebook({ pageLinkId, content, linkUrl, media, scheduledFor }) {
  const row = await getPageLinkRow(pageLinkId);
  const token = await getPageToken(pageLinkId);
  const pageId = row.fb_page_id;
  const scheduledUnix = toUnixSeconds(scheduledFor);
  const { kind, list } = classifyMedia(media);

  // Single image — POST /{pageId}/photos
  if (kind === 'single_image') {
    const params = {
      url: list[0].public_url,
      caption: content || '',
      access_token: token
    };
    if (scheduledUnix) {
      params.published = false;
      params.scheduled_publish_time = scheduledUnix;
    }
    return graph(`${pageId}/photos`, { method: 'POST', params });
  }

  // Single video — POST /{pageId}/videos
  if (kind === 'single_video') {
    const params = {
      file_url: list[0].public_url,
      description: content || '',
      access_token: token
    };
    if (scheduledUnix) {
      params.published = false;
      params.scheduled_publish_time = scheduledUnix;
    }
    return graph(`${pageId}/videos`, { method: 'POST', params });
  }

  // Carousel — stage children unpublished, then attach to feed post
  if (kind === 'carousel') {
    const mediaFbids = [];
    for (const m of list) {
      const child = await graph(`${pageId}/photos`, {
        method: 'POST',
        params: { url: m.public_url, published: false, access_token: token }
      });
      mediaFbids.push({ media_fbid: child.id });
    }
    const params = {
      message: content || '',
      attached_media: JSON.stringify(mediaFbids),
      access_token: token
    };
    if (linkUrl) params.link = linkUrl;
    if (scheduledUnix) {
      params.published = false;
      params.scheduled_publish_time = scheduledUnix;
    }
    return graph(`${pageId}/feed`, { method: 'POST', params });
  }

  // Text / link-only — POST /{pageId}/feed
  const params = {
    message: content || '',
    access_token: token
  };
  if (linkUrl) params.link = linkUrl;
  if (scheduledUnix) {
    params.published = false;
    params.scheduled_publish_time = scheduledUnix;
  }
  return graph(`${pageId}/feed`, { method: 'POST', params });
}

/**
 * Cancel a Facebook-side scheduled post. Used only by future code; the v1
 * publisher uses internal scheduling and passes scheduledFor: null.
 */
export async function cancelFacebookScheduled({ pageLinkId, fbScheduledId }) {
  const token = await getPageToken(pageLinkId);
  return graph(fbScheduledId, { method: 'DELETE', params: { access_token: token } });
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

async function waitForContainerReady(containerId, token, { timeoutMs = 120000, intervalMs = 2000 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await graph(containerId, {
      params: { fields: 'status_code,status', access_token: token }
    });
    if (res.status_code === 'FINISHED') return;
    if (res.status_code === 'ERROR' || res.status_code === 'EXPIRED') {
      const err = new Error(`IG container ${containerId} ${res.status_code}: ${res.status || ''}`);
      err.code = 'IG_CONTAINER_' + res.status_code;
      throw err;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  const err = new Error(`IG container ${containerId} did not finish in ${timeoutMs}ms`);
  err.code = 'IG_CONTAINER_TIMEOUT';
  throw err;
}

/**
 * Post to Instagram via the Graph API two-step container/publish flow.
 * Supports single image, single video/Reel, and image carousel (2–10).
 */
export async function postToInstagram({ pageLinkId, content, media }) {
  const row = await getPageLinkRow(pageLinkId);
  if (!row.ig_user_id) {
    const err = new Error('No Instagram account linked to this Page');
    err.code = 'NO_IG_ACCOUNT';
    throw err;
  }
  const token = await getPageToken(pageLinkId);
  const igUserId = row.ig_user_id;
  const { kind, list } = classifyMedia(media);

  if (kind === 'none') {
    const err = new Error('Instagram requires at least one media item');
    err.code = 'IG_REQUIRES_MEDIA';
    throw err;
  }

  // Single image
  if (kind === 'single_image') {
    const container = await graph(`${igUserId}/media`, {
      method: 'POST',
      params: { image_url: list[0].public_url, caption: content || '', access_token: token }
    });
    await waitForContainerReady(container.id, token);
    return graph(`${igUserId}/media_publish`, {
      method: 'POST',
      params: { creation_id: container.id, access_token: token }
    });
  }

  // Single video / Reel
  if (kind === 'single_video') {
    const container = await graph(`${igUserId}/media`, {
      method: 'POST',
      params: {
        media_type: 'REELS',
        video_url: list[0].public_url,
        caption: content || '',
        access_token: token
      }
    });
    await waitForContainerReady(container.id, token, { timeoutMs: 600000 });
    return graph(`${igUserId}/media_publish`, {
      method: 'POST',
      params: { creation_id: container.id, access_token: token }
    });
  }

  // Carousel — stage children, wait for all, then create parent CAROUSEL container
  if (kind === 'carousel') {
    const childIds = [];
    for (const m of list) {
      const child = await graph(`${igUserId}/media`, {
        method: 'POST',
        params: { image_url: m.public_url, is_carousel_item: true, access_token: token }
      });
      childIds.push(child.id);
    }
    for (const cid of childIds) {
      await waitForContainerReady(cid, token);
    }
    const parent = await graph(`${igUserId}/media`, {
      method: 'POST',
      params: {
        media_type: 'CAROUSEL',
        caption: content || '',
        children: childIds.join(','),
        access_token: token
      }
    });
    await waitForContainerReady(parent.id, token);
    return graph(`${igUserId}/media_publish`, {
      method: 'POST',
      params: { creation_id: parent.id, access_token: token }
    });
  }

  const err = new Error(`Unhandled IG media kind: ${kind}`);
  err.code = 'INVALID_MEDIA_COMBINATION';
  throw err;
}
