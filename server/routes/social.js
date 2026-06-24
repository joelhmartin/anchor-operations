import express from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import { isStaff } from '../middleware/roles.js';
import { query } from '../db.js';
import { clientLabelSelect, clientLabelExpression, clientLabelJoins } from '../services/clientLabel.js';
import { activeOnly } from '../services/queryHelpers.js';
import { logSecurityEvent } from '../services/security/audit.js';
import { storeFile } from '../services/fileStorage.js';
import {
  listAccessiblePages,
  linkClient,
  healthCheckPage
} from '../services/metaPagePosting.js';
import { publishPost } from '../services/socialPublisher.js';
import { verifyMediaToken } from '../services/socialMediaTokens.js';

const router = express.Router();

// ─────────────────────────────────────────────────────────────────────
// PUBLIC: HMAC-verified media token endpoint. Mounted BEFORE auth middleware.
// Returns the binary file_uploads bytes for the referenced ID.
// ─────────────────────────────────────────────────────────────────────
router.get('/media/:token', async (req, res) => {
  try {
    const { fileUploadId } = await verifyMediaToken(req.params.token);
    const { rows } = await query(
      'SELECT content_type, bytes FROM file_uploads WHERE id=$1',
      [fileUploadId]
    );
    if (!rows.length) return res.status(404).end();
    res.setHeader('Content-Type', rows[0].content_type);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.send(rows[0].bytes);
  } catch {
    return res.status(403).end();
  }
});

// ─────────────────────────────────────────────────────────────────────
// All endpoints below require staff auth.
// ─────────────────────────────────────────────────────────────────────
router.use(requireAuth, isStaff);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 } // 30 MB
});

// GET /pages — system user's accessible FB Pages + IG accounts
router.get('/pages', async (req, res, next) => {
  try {
    const pages = await listAccessiblePages();
    res.json(pages);
  } catch (e) {
    next(e);
  }
});

// GET /links — all active meta_page_links joined to users for client_name
router.get('/links', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT l.*,
              cp.client_identifier_value,
              u.first_name,
              u.last_name,
              ${clientLabelSelect('client_name')},
              u.email AS client_email
         FROM meta_page_links l
         JOIN users u ON u.id = l.client_id
         ${clientLabelJoins()}
        WHERE ${activeOnly('l')}
        ORDER BY ${clientLabelExpression()}`
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// POST /links — link a client to an FB page (and its IG, via linkClient)
router.post('/links', async (req, res, next) => {
  try {
    const { clientId, fbPageId } = req.body || {};
    if (!clientId || !fbPageId) {
      return res.status(400).json({ error: 'clientId and fbPageId required' });
    }
    const link = await linkClient({ clientId, fbPageId, createdBy: req.user.id });
    await logSecurityEvent({
      eventType: 'social.link_create',
      eventCategory: 'access',
      userId: req.user.id,
      success: true,
      details: { link_id: link.id, client_id: clientId, fb_page_id: fbPageId }
    }).catch(() => {});
    res.json(link);
  } catch (e) {
    next(e);
  }
});

// PATCH /links/:id — toggle scheduling_enabled (v1)
router.patch('/links/:id', async (req, res, next) => {
  try {
    const { scheduling_enabled } = req.body || {};
    if (typeof scheduling_enabled !== 'boolean') {
      return res.status(400).json({ error: 'scheduling_enabled (boolean) required' });
    }
    const { rows } = await query(
      `UPDATE meta_page_links
          SET scheduling_enabled = $1
        WHERE id = $2
        RETURNING *`,
      [scheduling_enabled, req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Link not found' });
    await logSecurityEvent({
      eventType: 'social.link_update',
      eventCategory: 'access',
      userId: req.user.id,
      success: true,
      details: { link_id: rows[0].id, scheduling_enabled }
    }).catch(() => {});
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

// DELETE /links/:id — soft-archive
router.delete('/links/:id', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE meta_page_links SET archived_at = NOW()
        WHERE id = $1 AND ${activeOnly()}
        RETURNING id, client_id`,
      [req.params.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Link not found or already archived' });
    await logSecurityEvent({
      eventType: 'social.link_archive',
      eventCategory: 'access',
      userId: req.user.id,
      success: true,
      details: { link_id: rows[0].id, client_id: rows[0].client_id }
    }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// POST /links/:id/health-check — re-run health check for a single page link
router.post('/links/:id/health-check', async (req, res, next) => {
  try {
    const result = await healthCheckPage(req.params.id);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

// ─────────────────────────────────────────────────────────────────────
// Client-pages — merged view of a client's FB pages, driven by oauth_resources.
// Replaces the global Connections tab; powers the drawer toggle + ComposeDialog.
// ─────────────────────────────────────────────────────────────────────

// GET /client-pages/:clientId — merged FB Page view for this client
router.get('/client-pages/:clientId', async (req, res, next) => {
  try {
    const { listClientPages } = await import('../services/socialClientLinkSync.js');
    const pages = await listClientPages(req.params.clientId);
    res.json(pages);
  } catch (e) {
    next(e);
  }
});

// POST /client-pages/:clientId/:fbPageId/publishing — toggle publishing on/off
router.post('/client-pages/:clientId/:fbPageId/publishing', async (req, res, next) => {
  try {
    const { enabled } = req.body || {};
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ error: 'enabled (boolean) required' });
    }
    const { setClientPagePublishing, listClientPages } = await import('../services/socialClientLinkSync.js');
    await setClientPagePublishing({
      clientId: req.params.clientId,
      fbPageId: req.params.fbPageId,
      enabled,
      actorId: req.user.id
    });
    const pages = await listClientPages(req.params.clientId);
    res.json(pages);
  } catch (e) {
    next(e);
  }
});

// POST /client-pages/:clientId/sync — manual re-run of the auto-sync
router.post('/client-pages/:clientId/sync', async (req, res, next) => {
  try {
    const { syncClientFacebookLinks, listClientPages } = await import('../services/socialClientLinkSync.js');
    await syncClientFacebookLinks(req.params.clientId, { actorId: req.user.id });
    const pages = await listClientPages(req.params.clientId);
    res.json(pages);
  } catch (e) {
    next(e);
  }
});

// POST /media — multipart file upload, returns { fileUploadId }. No public URL.
router.post('/media', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const clientId = req.body?.clientId || null;
    const result = await storeFile(req.file, {
      category: 'social',
      ownerId: clientId,
      ownerType: clientId ? 'user' : null,
      metadata: { uploaded_by: req.user.id }
    });
    res.json({ fileUploadId: result.id });
  } catch (e) {
    next(e);
  }
});

// GET /posts — filtered list
router.get('/posts', async (req, res, next) => {
  try {
    const clientId = req.query.clientId || null;
    const status = req.query.status || null;
    const from = req.query.from || null;
    const to = req.query.to || null;
    const { rows } = await query(
      `SELECT *
         FROM social_posts
        WHERE 1=1
          AND ($1::uuid IS NULL OR client_id = $1)
          AND ($2::text IS NULL OR status = $2)
          AND ($3::timestamptz IS NULL OR COALESCE(scheduled_for, published_at, created_at) >= $3)
          AND ($4::timestamptz IS NULL OR COALESCE(scheduled_for, published_at, created_at) <= $4)
        ORDER BY COALESCE(scheduled_for, published_at, created_at) DESC
        LIMIT 500`,
      [clientId, status, from, to]
    );
    res.json(rows);
  } catch (e) {
    next(e);
  }
});

// POST /posts — create draft / schedule / publish_now
router.post('/posts', async (req, res, next) => {
  try {
    const {
      clientId,
      pageLinkId,
      platforms,
      content,
      linkUrl,
      media,
      scheduledFor,
      action,
      idempotencyKey
    } = req.body || {};

    // Validation
    if (!clientId || !pageLinkId) {
      return res.status(400).json({ error: 'clientId and pageLinkId required' });
    }
    if (!Array.isArray(platforms) || platforms.length === 0) {
      return res.status(400).json({ error: 'platforms must be non-empty array' });
    }
    if (!platforms.every((p) => p === 'facebook' || p === 'instagram')) {
      return res.status(400).json({ error: 'invalid platform' });
    }
    if (!['draft', 'schedule', 'publish_now'].includes(action)) {
      return res.status(400).json({ error: 'invalid action' });
    }
    if (
      action === 'schedule' &&
      (!scheduledFor || new Date(scheduledFor).getTime() < Date.now() + 5 * 60 * 1000)
    ) {
      return res
        .status(400)
        .json({ error: 'scheduledFor must be at least 5 minutes in the future' });
    }

    // Idempotency — replay returns existing row
    if (idempotencyKey) {
      const { rows: existing } = await query(
        'SELECT * FROM social_posts WHERE idempotency_key = $1 AND created_by = $2',
        [idempotencyKey, req.user.id]
      );
      if (existing.length) return res.json(existing[0]);
    }

    const status =
      action === 'publish_now' ? 'scheduled' : action === 'schedule' ? 'scheduled' : 'draft';

    const { rows } = await query(
      `INSERT INTO social_posts
         (client_id, page_link_id, created_by, platforms, content, link_url, media, scheduled_for, status, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
       RETURNING *`,
      [
        clientId,
        pageLinkId,
        req.user.id,
        platforms,
        content || '',
        linkUrl || null,
        JSON.stringify(media || []),
        action === 'publish_now' ? null : scheduledFor || null,
        status,
        idempotencyKey || null
      ]
    );
    const post = rows[0];

    await logSecurityEvent({
      eventType: `social.post_${action}`,
      eventCategory: 'access',
      userId: req.user.id,
      success: true,
      details: { post_id: post.id, client_id: clientId, platforms }
    }).catch(() => {});

    if (action === 'publish_now') {
      const result = await publishPost(post.id, { actorId: req.user.id });
      const { rows: updated } = await query('SELECT * FROM social_posts WHERE id=$1', [post.id]);
      return res.json({ ...updated[0], _publishResult: result });
    }

    res.json(post);
  } catch (e) {
    next(e);
  }
});

// POST /posts/:id/cancel — cancel a draft/scheduled/failed post
router.post('/posts/:id/cancel', async (req, res, next) => {
  try {
    const { rows } = await query(
      `UPDATE social_posts
          SET status='cancelled', updated_at=NOW()
        WHERE id=$1 AND status IN ('scheduled','draft','failed')
        RETURNING *`,
      [req.params.id]
    );
    if (!rows.length) {
      return res.status(409).json({ error: 'Post is not in a cancellable state' });
    }
    await logSecurityEvent({
      eventType: 'social.post_cancel',
      eventCategory: 'access',
      userId: req.user.id,
      success: true,
      details: { post_id: rows[0].id, client_id: rows[0].client_id }
    }).catch(() => {});
    res.json(rows[0]);
  } catch (e) {
    next(e);
  }
});

export default router;
