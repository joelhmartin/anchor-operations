// server/services/socialPublisher.js
//
// Social publishing orchestrator. Claims a social_posts row atomically,
// resolves media URLs fresh (Vimeo links expire, signed upload tokens are
// minted per-attempt), dispatches to Facebook / Instagram via
// metaPagePosting, and finalizes state with retry-policy bookkeeping.
//
// Two entry points:
//   - publishPost(postId, { actorId, skipClaim }) — direct invocation
//   - runDuePosts() — cron entry; uses FOR UPDATE SKIP LOCKED to claim a
//     batch of due rows in a single tx, then dispatches each with
//     skipClaim: true.

import { query, getClient } from '../db.js';
import { postToFacebook, postToInstagram } from './metaPagePosting.js';
import { mintMediaToken } from './socialMediaTokens.js';
import { getDirectFileUrl } from './vimeo.js';
import { logSecurityEvent } from './security/audit.js';

const MEDIA_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour — Meta typically fetches immediately

// ---------------------------------------------------------------------------
// Media resolution
// ---------------------------------------------------------------------------

export async function resolveMediaUrl(item, postId) {
  if (!item || typeof item !== 'object') {
    const err = new Error('Invalid media item');
    err.code = 'UNSUPPORTED_MEDIA';
    throw err;
  }

  if (item.source === 'upload' && item.file_upload_id) {
    const token = await mintMediaToken(item.file_upload_id, {
      ttlMs: MEDIA_TOKEN_TTL_MS,
      postId,
    });
    const base =
      process.env.APP_BASE_URL ||
      process.env.PUBLIC_BASE_URL ||
      process.env.APP_URL ||
      '';
    if (!base) {
      const err = new Error('APP_BASE_URL is not configured');
      err.code = 'APP_BASE_URL_MISSING';
      throw err;
    }
    return `${base.replace(/\/+$/, '')}/api/social/media/${token}`;
  }

  if (item.source === 'vimeo' && item.vimeo_id) {
    const v = await getDirectFileUrl(item.vimeo_id);
    return v.url;
  }

  const err = new Error(`Unsupported media source: ${item.source}`);
  err.code = 'UNSUPPORTED_MEDIA';
  throw err;
}

async function resolveAllMedia(media, postId) {
  const out = [];
  for (const item of media || []) {
    const public_url = await resolveMediaUrl(item, postId);
    out.push({ ...item, public_url });
  }
  return out;
}

// ---------------------------------------------------------------------------
// publishPost
// ---------------------------------------------------------------------------

const CLAIM_SQL = `
  UPDATE social_posts
     SET status = 'publishing', updated_at = NOW()
   WHERE id = $1
     AND status IN ('scheduled', 'draft', 'failed')
   RETURNING id, client_id, page_link_id, platforms, content, link_url, media,
             scheduled_for, retry_count, created_by
`;

const FETCH_SQL = `
  SELECT id, client_id, page_link_id, platforms, content, link_url, media,
         scheduled_for, retry_count, created_by
    FROM social_posts
   WHERE id = $1
`;

export async function publishPost(postId, options = {}) {
  const { actorId, skipClaim = false } = options;

  // 1. Claim (or fetch if cron already claimed)
  let post;
  if (skipClaim) {
    const { rows } = await query(FETCH_SQL, [postId]);
    if (!rows.length) {
      return { ok: false, reason: 'not_found' };
    }
    post = rows[0];
  } else {
    const { rows } = await query(CLAIM_SQL, [postId]);
    if (!rows.length) {
      return { ok: false, reason: 'already_claimed_or_finalized' };
    }
    post = rows[0];
  }

  const auditUserId = actorId || post.created_by || null;
  const platforms = Array.isArray(post.platforms) ? post.platforms : [];

  // 2. Audit attempt
  try {
    await logSecurityEvent({
      eventType: 'social.publish_attempt',
      eventCategory: 'access',
      userId: auditUserId,
      success: true,
      details: {
        post_id: postId,
        client_id: post.client_id,
        platforms,
      },
    });
  } catch (e) {
    // never let audit failure break publishing
    console.error('[social] audit publish_attempt failed', e?.message);
  }

  // 3. Resolve media URLs fresh for this attempt
  let resolvedMedia;
  try {
    resolvedMedia = await resolveAllMedia(post.media || [], postId);
  } catch (e) {
    return await finalizeFailed(postId, auditUserId, post, platforms, e);
  }

  // 4. Dispatch per platform
  let fbResult = null;
  let igResult = null;
  let fbErr = null;
  let igErr = null;

  if (platforms.includes('facebook')) {
    try {
      fbResult = await postToFacebook({
        pageLinkId: post.page_link_id,
        content: post.content,
        linkUrl: post.link_url,
        media: resolvedMedia,
        scheduledFor: null,
      });
    } catch (e) {
      fbErr = e;
      console.error('[social] FB publish failed', postId, e?.message);
    }
  }

  if (platforms.includes('instagram')) {
    try {
      igResult = await postToInstagram({
        pageLinkId: post.page_link_id,
        content: post.content,
        media: resolvedMedia,
      });
    } catch (e) {
      igErr = e;
      console.error('[social] IG publish failed', postId, e?.message);
    }
  }

  // 5. Determine final status
  const fbAttempted = platforms.includes('facebook');
  const igAttempted = platforms.includes('instagram');
  const fbOk = fbAttempted && !fbErr;
  const igOk = igAttempted && !igErr;
  const fbFailed = fbAttempted && !!fbErr;
  const igFailed = igAttempted && !!igErr;

  const anyOk = fbOk || igOk;
  const anyFailed = fbFailed || igFailed;

  let finalStatus;
  if (anyOk && !anyFailed) {
    finalStatus = 'published';
  } else if (anyOk && anyFailed) {
    finalStatus = 'partially_published';
  } else {
    finalStatus = 'failed';
  }

  const fbPostId = fbResult ? (fbResult.post_id || fbResult.id || null) : null;
  const igMediaId = igResult ? (igResult.id || null) : null;
  const partialError = anyFailed
    ? [fbErr ? `facebook: ${fbErr.message}` : null, igErr ? `instagram: ${igErr.message}` : null]
        .filter(Boolean)
        .join('; ')
    : null;

  // 6. Finalize DB state
  if (finalStatus === 'failed') {
    await query(
      `UPDATE social_posts
          SET status = 'failed',
              failed_at = NOW(),
              error = $1,
              retry_count = retry_count + 1,
              updated_at = NOW()
        WHERE id = $2`,
      [partialError || 'Unknown error', postId]
    );
  } else {
    await query(
      `UPDATE social_posts
          SET status = $1,
              fb_post_id = COALESCE($2, fb_post_id),
              ig_media_id = COALESCE($3, ig_media_id),
              published_at = NOW(),
              error = $4,
              updated_at = NOW()
        WHERE id = $5`,
      [finalStatus, fbPostId, igMediaId, partialError, postId]
    );
  }

  // 7. Audit outcome
  try {
    await logSecurityEvent({
      eventType: finalStatus === 'failed' ? 'social.publish_failed' : 'social.publish_success',
      eventCategory: 'access',
      userId: auditUserId,
      success: finalStatus !== 'failed',
      details: {
        post_id: postId,
        client_id: post.client_id,
        platforms,
        final_status: finalStatus,
        fb_post_id: fbPostId,
        ig_media_id: igMediaId,
        error: partialError,
      },
    });
  } catch (e) {
    console.error('[social] audit outcome failed', e?.message);
  }

  return {
    ok: finalStatus !== 'failed',
    status: finalStatus,
    fb_post_id: fbPostId,
    ig_media_id: igMediaId,
    error: partialError,
  };
}

async function finalizeFailed(postId, auditUserId, post, platforms, err) {
  const message = err?.message || 'Failed before dispatch';
  try {
    await query(
      `UPDATE social_posts
          SET status = 'failed',
              failed_at = NOW(),
              error = $1,
              retry_count = retry_count + 1,
              updated_at = NOW()
        WHERE id = $2`,
      [message, postId]
    );
  } catch (e) {
    console.error('[social] failed to mark failed', postId, e?.message);
  }
  try {
    await logSecurityEvent({
      eventType: 'social.publish_failed',
      eventCategory: 'access',
      userId: auditUserId,
      success: false,
      details: {
        post_id: postId,
        client_id: post.client_id,
        platforms,
        final_status: 'failed',
        error: message,
      },
    });
  } catch (e) {
    console.error('[social] audit publish_failed failed', e?.message);
  }
  return { ok: false, status: 'failed', fb_post_id: null, ig_media_id: null, error: message };
}

// ---------------------------------------------------------------------------
// runDuePosts — cron entry point
// ---------------------------------------------------------------------------

export async function runDuePosts() {
  const c = await getClient();
  let ids = [];
  try {
    await c.query('BEGIN');
    const { rows } = await c.query(`
      SELECT id FROM social_posts
       WHERE (
           (status = 'scheduled' AND scheduled_for IS NOT NULL AND scheduled_for <= NOW())
           OR
           (status = 'failed' AND scheduled_for IS NOT NULL AND scheduled_for <= NOW()
            AND retry_count < 3 AND updated_at < NOW() - INTERVAL '15 minutes')
       )
       ORDER BY scheduled_for ASC
       LIMIT 50
       FOR UPDATE SKIP LOCKED
    `);
    ids = rows.map((r) => r.id);
    if (ids.length > 0) {
      await c.query(
        `UPDATE social_posts SET status = 'publishing', updated_at = NOW() WHERE id = ANY($1::uuid[])`,
        [ids]
      );
    }
    await c.query('COMMIT');
  } catch (e) {
    try {
      await c.query('ROLLBACK');
    } catch {
      /* noop */
    }
    c.release();
    throw e;
  }
  c.release();

  for (const id of ids) {
    try {
      await publishPost(id, { skipClaim: true });
    } catch (e) {
      console.error('[social] publishPost', id, e?.message);
    }
  }

  return { processed: ids.length };
}
