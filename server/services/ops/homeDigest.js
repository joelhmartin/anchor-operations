/**
 * homeDigest.js — curated home-view digest for the Operations workspace.
 *
 * Exports:
 *   shapeHomeDigest({ commandCenter, scheduledBlogs, scheduledSocial })
 *     — pure function, unit-tested in __tests__/homeDigest.test.js
 *   loadHomeDigest(commandCenter)
 *     — async function that fetches today's scheduled content and calls shapeHomeDigest
 */

import { query } from '../../db.js';

/**
 * Pure shaper — groups critical discoveries by client into needsAttention,
 * passes through scheduled content, and surfaces the approvals_waiting KPI.
 */
export function shapeHomeDigest({ commandCenter, scheduledBlogs = [], scheduledSocial = [] }) {
  const byClient = new Map();
  (commandCenter?.discoveries || []).forEach((d) => {
    if (d.severity !== 'critical' || !d.client_user_id) return;
    const cur = byClient.get(d.client_user_id) || { clientUserId: d.client_user_id, criticalCount: 0, top: null };
    cur.criticalCount += 1;
    if (!cur.top) cur.top = d.summary;
    byClient.set(d.client_user_id, cur);
  });
  return {
    needsAttention: [...byClient.values()].sort((a, b) => b.criticalCount - a.criticalCount),
    scheduledToday: { blogs: scheduledBlogs, social: scheduledSocial },
    approvalsWaiting: commandCenter?.kpis?.approvals_waiting ?? 0,
    kpis: commandCenter?.kpis || {}
  };
}

/**
 * Loads today's scheduled blog posts and social posts, then shapes the digest.
 * @param {object} commandCenter - result of loadCommandCenter() from ops.js
 */
export async function loadHomeDigest(commandCenter) {
  const [blogs, social] = await Promise.all([
    query(
      `SELECT id, client_id, title, scheduled_for FROM ops_blog_posts
        WHERE status = 'scheduled'
          AND scheduled_for >= date_trunc('day', NOW())
          AND scheduled_for < date_trunc('day', NOW()) + INTERVAL '1 day'
        ORDER BY scheduled_for ASC LIMIT 50`
    ),
    query(
      `SELECT id, client_id, content, scheduled_for FROM social_posts
        WHERE status = 'scheduled'
          AND scheduled_for >= date_trunc('day', NOW())
          AND scheduled_for < date_trunc('day', NOW()) + INTERVAL '1 day'
        ORDER BY scheduled_for ASC LIMIT 50`
    )
  ]);
  return shapeHomeDigest({ commandCenter, scheduledBlogs: blogs.rows, scheduledSocial: social.rows });
}
