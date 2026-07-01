/**
 * Google Chat user → Anchor user resolution + permission enforcement.
 * resolveGoogleChatUser is injectable (queryFn) so unit tests run with zero DB.
 */
import { query } from '../../../db.js';

export class PermissionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionError';
  }
}

export const VIEWER_COMMANDS = new Set([
  'help', 'daily', 'clients', 'client', 'issues', 'approvals', 'connect', 'audit'
]);

const ADMIN_ROLES = new Set(['admin', 'superadmin']);

/**
 * Resolve a Google Chat user ID to an Anchor user.
 * Returns null if: mapping not found, mapping disabled, or anchor user not found.
 * NEVER throws for not-found — callers get null and send a neutral refusal.
 */
export async function resolveGoogleChatUser(googleUserId, { queryFn = query } = {}) {
  if (!googleUserId) return null;

  const { rows: mappingRows } = await queryFn(
    `SELECT id, google_user_id, anchor_user_id, display_name, enabled
       FROM ops_chat_user_mappings
      WHERE google_user_id = $1 LIMIT 1`,
    [googleUserId]
  );
  const mapping = mappingRows[0];
  if (!mapping || !mapping.enabled) return null;

  const { rows: userRows } = await queryFn(
    `SELECT u.id, u.role,
            COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS name,
            u.email, u.created_at
       FROM users u
      WHERE u.id = $1 LIMIT 1`,
    [mapping.anchor_user_id]
  );
  const anchorUser = userRows[0];
  if (!anchorUser) return null;

  return { mapping, anchorUser };
}

/**
 * Assert the anchor user has permission to run a command.
 * Throws PermissionError if denied.
 */
export function assertPermission(anchorUser, command) {
  const role = anchorUser?.role;
  if (ADMIN_ROLES.has(role)) return; // admins can do everything
  if (role === 'ops_viewer' && VIEWER_COMMANDS.has(command)) return;
  throw new PermissionError(
    `Role '${role || 'unknown'}' is not permitted to run command '${command}'.`
  );
}
