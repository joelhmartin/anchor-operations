/**
 * socialClientLinkSync — keeps meta_page_links in sync with oauth_resources.
 *
 * Source of truth: oauth_resources rows (provider='facebook', resource_type='facebook_page')
 * represent which Facebook Pages a client is connected to. meta_page_links is the
 * publishing-side derivative — a row there means "publishing enabled for this
 * client+page", and the row holds an encrypted system-user-derived per-page token
 * plus scheduling flag + health-check state.
 *
 * Rules:
 *  - When a client has exactly 1 facebook_page oauth_resource and zero non-archived
 *    meta_page_links, auto-create the meta_page_links row (publishing enabled).
 *    Scheduling defaults FALSE per the "no unattended runs" policy.
 *  - When a client has 2+ facebook_page resources, do NOT auto-create — staff
 *    must explicitly enable each page via the drawer toggle.
 *  - When the client has 0 facebook_page resources but >0 non-archived
 *    meta_page_links, archive all of those links (client removed FB connection).
 *  - Legacy/manual meta_page_links rows that have no corresponding oauth_resource
 *    are preserved (the sync never touches links it doesn't see a reason to).
 */

import { query } from '../db.js';
import { activeOnly } from './queryHelpers.js';
import { listAccessiblePages, linkClient } from './metaPagePosting.js';
import { logSecurityEvent } from './security/audit.js';

/**
 * Reconcile meta_page_links against oauth_resources for a single client.
 *
 * @param {string} clientId
 * @param {{ actorId?: string|null, autoEnableSinglePage?: boolean }} [opts]
 * @returns {Promise<{ autoLinked: boolean, archivedCount: number, connected: number, linked: number }>}
 */
export async function syncClientFacebookLinks(clientId, opts = {}) {
  const { actorId = null, autoEnableSinglePage = true } = opts;

  const { rows: connectedRows } = await query(
    `SELECT id, resource_id, resource_name
       FROM oauth_resources
      WHERE client_id = $1
        AND provider = 'facebook'
        AND resource_type = 'facebook_page'
        AND is_enabled = TRUE`,
    [clientId]
  );

  const { rows: linkedRows } = await query(
    `SELECT id, fb_page_id
       FROM meta_page_links
      WHERE client_id = $1 AND ${activeOnly()}`,
    [clientId]
  );

  const summary = {
    autoLinked: false,
    archivedCount: 0,
    connected: connectedRows.length,
    linked: linkedRows.length
  };

  // Case: zero connected pages, but we still have non-archived links → archive them.
  if (connectedRows.length === 0 && linkedRows.length > 0) {
    const { rowCount } = await query(
      `UPDATE meta_page_links
          SET archived_at = NOW(),
              scheduling_enabled = FALSE
        WHERE client_id = $1 AND ${activeOnly()}`,
      [clientId]
    );
    summary.archivedCount = rowCount || 0;
    await logSecurityEvent({
      eventType: 'social.archive_unlinked',
      eventCategory: 'access',
      userId: actorId,
      success: true,
      details: { client_id: clientId, archived_count: summary.archivedCount }
    }).catch(() => {});
    return summary;
  }

  // Case: exactly one connected page, no non-archived link → auto-create it.
  if (autoEnableSinglePage && connectedRows.length === 1 && linkedRows.length === 0) {
    try {
      const created = await linkClient({
        clientId,
        fbPageId: connectedRows[0].resource_id,
        createdBy: actorId
      });
      summary.autoLinked = true;
      summary.linked = 1;
      await logSecurityEvent({
        eventType: 'social.auto_link_single_page',
        eventCategory: 'access',
        userId: actorId,
        success: true,
        details: {
          client_id: clientId,
          fb_page_id: connectedRows[0].resource_id,
          link_id: created.id
        }
      }).catch(() => {});
    } catch (err) {
      // Common case: agency BM doesn't have access to this page yet. Log a
      // security event for visibility but don't throw — admin can resolve by
      // sharing the page with the BM, then re-trigger sync.
      await logSecurityEvent({
        eventType: 'social.auto_link_failed',
        eventCategory: 'access',
        userId: actorId,
        success: false,
        details: {
          client_id: clientId,
          fb_page_id: connectedRows[0].resource_id,
          error: err?.message || String(err),
          code: err?.code || null
        }
      }).catch(() => {});
    }
  }

  return summary;
}

/**
 * Explicitly enable/disable publishing for a single client+page.
 *
 * enabled=true  → create/unarchive a meta_page_links row (via linkClient)
 * enabled=false → archive the row + force scheduling_enabled=false
 *
 * @param {{ clientId: string, fbPageId: string, enabled: boolean, actorId?: string|null }} args
 */
export async function setClientPagePublishing({ clientId, fbPageId, enabled, actorId = null }) {
  if (!clientId || !fbPageId) {
    const err = new Error('clientId and fbPageId required');
    err.code = 'INVALID_ARGS';
    throw err;
  }

  if (enabled) {
    const link = await linkClient({ clientId, fbPageId, createdBy: actorId });
    await logSecurityEvent({
      eventType: 'social.publishing_enabled',
      eventCategory: 'access',
      userId: actorId,
      success: true,
      details: { client_id: clientId, fb_page_id: fbPageId, link_id: link.id }
    }).catch(() => {});
    return link;
  }

  const { rows } = await query(
    `UPDATE meta_page_links
        SET archived_at = NOW(),
            scheduling_enabled = FALSE
      WHERE client_id = $1 AND fb_page_id = $2 AND ${activeOnly()}
      RETURNING id`,
    [clientId, fbPageId]
  );
  await logSecurityEvent({
    eventType: 'social.publishing_disabled',
    eventCategory: 'access',
    userId: actorId,
    success: true,
    details: {
      client_id: clientId,
      fb_page_id: fbPageId,
      link_id: rows[0]?.id || null
    }
  }).catch(() => {});
  return { archived: rows.length > 0, link_id: rows[0]?.id || null };
}

/**
 * Merged view of a client's Facebook Pages — used by both the OAuthIntegrationsTab
 * publishing toggle UI and the ComposeDialog page picker.
 *
 * Joins oauth_resources (facebook_page rows) + meta_page_links (non-archived) +
 * the system user's listAccessiblePages() (to mark which pages the agency BM
 * can actually publish to).
 *
 * Returns one entry per fb_page_id with:
 *  {
 *    fb_page_id, fb_page_name,
 *    ig_user_id, ig_username,
 *    page_link_id, publishing_enabled, scheduling_enabled,
 *    accessible_by_system_user,
 *    last_health_status,
 *    has_oauth_resource, oauth_resource_id
 *  }
 */
export async function listClientPages(clientId) {
  if (!clientId) return [];

  const { rows: resources } = await query(
    `SELECT id, resource_id, resource_name, resource_username
       FROM oauth_resources
      WHERE client_id = $1
        AND provider = 'facebook'
        AND resource_type = 'facebook_page'
        AND is_enabled = TRUE`,
    [clientId]
  );

  const { rows: links } = await query(
    `SELECT id, fb_page_id, fb_page_name, ig_user_id, ig_username,
            scheduling_enabled, last_health_status
       FROM meta_page_links
      WHERE client_id = $1 AND ${activeOnly()}`,
    [clientId]
  );

  // System-user accessible pages — best-effort. If the env isn't configured or
  // the call fails, we still return the merged client-scoped view; we just
  // can't mark `accessible_by_system_user`.
  let systemPages = [];
  try {
    systemPages = await listAccessiblePages();
  } catch (err) {
    console.warn('[social-link-sync] listAccessiblePages failed:', err?.message);
  }
  const systemById = new Map(systemPages.map((p) => [p.fbPageId, p]));

  const byPageId = new Map();

  for (const r of resources) {
    byPageId.set(r.resource_id, {
      fb_page_id: r.resource_id,
      fb_page_name: r.resource_name,
      ig_user_id: null,
      ig_username: r.resource_username || null,
      page_link_id: null,
      publishing_enabled: false,
      scheduling_enabled: false,
      accessible_by_system_user: systemById.has(r.resource_id),
      last_health_status: null,
      has_oauth_resource: true,
      oauth_resource_id: r.id
    });
  }

  for (const l of links) {
    const existing = byPageId.get(l.fb_page_id);
    if (existing) {
      existing.page_link_id = l.id;
      existing.publishing_enabled = true;
      existing.scheduling_enabled = !!l.scheduling_enabled;
      existing.last_health_status = l.last_health_status || null;
      existing.ig_user_id = l.ig_user_id || existing.ig_user_id;
      existing.ig_username = l.ig_username || existing.ig_username;
      if (!existing.fb_page_name) existing.fb_page_name = l.fb_page_name;
    } else {
      // Legacy / manually-created link with no corresponding oauth_resource.
      byPageId.set(l.fb_page_id, {
        fb_page_id: l.fb_page_id,
        fb_page_name: l.fb_page_name,
        ig_user_id: l.ig_user_id || null,
        ig_username: l.ig_username || null,
        page_link_id: l.id,
        publishing_enabled: true,
        scheduling_enabled: !!l.scheduling_enabled,
        accessible_by_system_user: systemById.has(l.fb_page_id),
        last_health_status: l.last_health_status || null,
        has_oauth_resource: false,
        oauth_resource_id: null
      });
    }
  }

  // Enrich IG info from the system-user view where the link didn't have it.
  for (const entry of byPageId.values()) {
    const sys = systemById.get(entry.fb_page_id);
    if (sys) {
      if (!entry.ig_user_id && sys.igUserId) entry.ig_user_id = sys.igUserId;
      if (!entry.ig_username && sys.igUsername) entry.ig_username = sys.igUsername;
    }
  }

  return Array.from(byPageId.values()).sort((a, b) =>
    (a.fb_page_name || '').localeCompare(b.fb_page_name || '')
  );
}
