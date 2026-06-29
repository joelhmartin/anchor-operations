/**
 * cms/wordpress connector — discoverInventory (F2).
 * Runs read-only WP-CLI over the shipped SSH client to enumerate pages,
 * plugins, and users. PII-safe by construction: the user query requests
 * `ID,roles` ONLY — it never asks WP-CLI for user_email / display_name /
 * user_login, so no patient/staff PII is ever fetched or persisted.
 */
import { wpcli } from '../../operations-website/sshClient.js';
import { inventoryRow } from '../inventoryRow.js';

function parseJson(result) {
  if (!result || result.exitCode !== 0) return [];
  try {
    const v = JSON.parse(result.stdout);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export default {
  id: 'wordpress',
  serviceCategory: 'cms',
  provider: 'wordpress',

  async discoverInventory(ctx = {}) {
    const runWp = ctx.clients?.wpcli || wpcli;
    const envId = ctx.environmentId || ctx.connection?.metadata?.environmentId || null;
    if (!envId) return [];

    const opts = { triggeredBy: 'inventory' };
    const [pagesRes, pluginsRes, usersRes] = await Promise.all([
      runWp(envId, 'post list --post_type=page --fields=ID,post_title,post_status --format=json', opts).catch(() => null),
      runWp(envId, 'plugin list --fields=name,status,version --format=json', opts).catch(() => null),
      // PII-safe: ID + roles ONLY.
      runWp(envId, 'user list --fields=ID,roles --format=json', opts).catch(() => null)
    ]);

    const rows = [];

    for (const p of parseJson(pagesRes)) {
      rows.push(inventoryRow({
        object_type: 'page',
        external_id: p.ID,
        name: p.post_title || `page-${p.ID}`,
        status: p.post_status || null,
        metadata: {}
      }));
    }

    for (const pl of parseJson(pluginsRes)) {
      rows.push(inventoryRow({
        object_type: 'plugin',
        external_id: pl.name,
        name: pl.name,
        status: pl.status || null,
        metadata: { version: pl.version || null }
      }));
    }

    for (const u of parseJson(usersRes)) {
      const roles = Array.isArray(u.roles) ? u.roles : (u.roles ? String(u.roles).split(',').map((s) => s.trim()) : []);
      rows.push(inventoryRow({
        object_type: 'user',
        external_id: u.ID,
        name: null, // PII-safe: never persist username/email
        status: null,
        metadata: { roles }
      }));
    }

    return rows;
  }
};
