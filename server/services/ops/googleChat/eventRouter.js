/**
 * Google Chat inbound event router.
 *
 * Security rules (HARD):
 *  - Every request must pass verifyGoogleChatToken before any user resolution.
 *  - Unknown/unmapped Google user → neutral refusal; never echo client_type.
 *  - CARD_CLICKED: NEVER trust card payload — always reload action from DB.
 *  - Approval: re-verify user, re-verify status=pending, update, persist, audit.
 */
import { query } from '../../../db.js';
import { parseCommand } from './commandParser.js';
import { resolveGoogleChatUser, assertPermission, PermissionError } from './userMapper.js';
import { handleCommand } from './commandHandler.js';
import { renderHelpCard, renderErrorCard } from './cardRenderer.js';
import { renderActionResultCard } from '../notifications/renderGoogleChatDigest.js';
import { logSecurityEvent, SecurityEventTypes, SecurityEventCategories } from '../../security/audit.js';

const NEUTRAL_REFUSAL = "I don't recognize your account. Contact your Anchor administrator to set up access.";
const PERMISSION_DENIED = "You don't have permission to run that command.";

async function defaultVerifyToken(req) {
  const auth = (req?.headers?.authorization || '');
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error('Missing Authorization header');
  const token = m[1];

  const { OAuth2Client } = await import('google-auth-library');
  const client = new OAuth2Client();
  const ticket = await client.verifyIdToken({ idToken: token });
  const payload = ticket.getPayload();
  if (!payload) throw new Error('Empty JWT payload');
  if (payload.iss !== 'chat@system.gserviceaccount.com') {
    throw new Error(`Unexpected issuer: ${payload.iss}`);
  }
  return { googleUserId: payload.sub || null };
}

async function handleCardClicked(event, deps) {
  const { queryFn = query, resolveUser = resolveGoogleChatUser } = deps;
  const googleUserId = event.user?.name || null;

  const resolved = await resolveUser(googleUserId, { queryFn });
  if (!resolved) return { text: NEUTRAL_REFUSAL };

  const { anchorUser } = resolved;
  const actionMethodName = event.action?.actionMethodName;
  const parameters = event.action?.parameters || [];
  const actionId = parameters.find((p) => p.key === 'action_id')?.value;

  if (!actionId || !['approve_action', 'reject_action'].includes(actionMethodName)) {
    return renderErrorCard('Unrecognized card action.');
  }

  const verb = actionMethodName === 'approve_action' ? 'approve' : 'reject';
  try {
    assertPermission(anchorUser, verb);
  } catch (err) {
    if (err instanceof PermissionError) return { text: PERMISSION_DENIED };
    throw err;
  }

  // HARD: reload action from DB — never trust card payload
  const FINAL_STATUSES = new Set(['executed', 'rejected', 'failed', 'blocked', 'superseded']);
  let rec;
  try {
    const { rows } = await queryFn(
      `SELECT id, client_user_id, abstract_action_type AS action_type, risk_tier AS risk_level, summary, status
         FROM ops_action_recommendations
        WHERE id = $1 LIMIT 1`,
      [actionId]
    );
    rec = rows[0];
  } catch (err) {
    if (err.message.includes('does not exist')) return { text: 'Approval system (F4) not yet available.' };
    throw err;
  }

  if (!rec) return renderErrorCard('Action not found.');
  if (FINAL_STATUSES.has(rec.status)) {
    return { text: `This action has already been ${rec.status}. No changes made.` };
  }

  const newStatus = verb === 'approve' ? 'approved' : 'rejected';
  try {
    // Use decided_at — the actual F4 schema column (no approved_by/rejected_by/approved_at/rejected_at).
    await queryFn(
      `UPDATE ops_action_recommendations
          SET status = $2, decided_at = now(), updated_at = now()
        WHERE id = $1 AND status NOT IN ('executed','rejected','failed','blocked','superseded')`,
      [rec.id, newStatus]
    );
  } catch (err) {
    console.warn(`[gchat/event] failed to ${verb} action ${rec.id}: ${err.message}`);
    return renderErrorCard('Failed to record your decision. Please try again.');
  }

  // Persist notification event (no PII)
  try {
    await queryFn(
      `INSERT INTO ops_notification_events
         (channel, event_type, client_user_id, reference_id, reference_type, status, payload_json)
       VALUES ('google_chat', 'action_result', $1, $2, 'action_recommendation', 'sent', $3::jsonb)`,
      [
        rec.client_user_id,
        rec.id,
        JSON.stringify({ outcome: newStatus, action_type: rec.action_type })
      ]
    );
  } catch (err) {
    console.warn(`[gchat/event] failed to persist notification event: ${err.message}`);
  }

  // Security audit
  try {
    await logSecurityEvent({
      userId: anchorUser.id,
      eventType: SecurityEventTypes.SENSITIVE_ACTION,
      eventCategory: SecurityEventCategories.OPERATIONS,
      success: true,
      details: { action: `google_chat_${verb}`, action_recommendation_id: rec.id, action_type: rec.action_type }
    });
  } catch (err) {
    console.warn(`[gchat/event] audit log failed: ${err.message}`);
  }

  return renderActionResultCard({
    actionRecommendationId: rec.id,
    clientName: '',
    actionType: rec.action_type,
    outcome: newStatus,
    detail: `Action ${newStatus} by an authorized operator.`
  });
}

/**
 * Route a Google Chat event to the appropriate handler.
 */
export async function routeEvent(event, deps = {}) {
  const {
    verifyToken = defaultVerifyToken,
    resolveUser = resolveGoogleChatUser,
    handleCommandFn = handleCommand,
    queryFn = query,
    req = null
  } = deps;

  // Verify Google-signed OIDC JWT before any event handling.
  // In production req is the HTTP request object; in tests verifyToken is injected as a mock.
  try {
    await verifyToken(req);
  } catch (err) {
    console.warn(`[gchat/event] JWT verification failed: ${err.message}`);
    return { text: '' };
  }

  const eventType = event?.type;

  if (eventType === 'REMOVED_FROM_SPACE') {
    console.info('[gchat/event] removed from space:', event.space?.name);
    return { text: '' };
  }

  if (!eventType || (!event.message && !event.action && !event.user)) {
    return { text: '' };
  }

  if (eventType === 'ADDED_TO_SPACE') {
    const googleUserId = event.user?.name || null;
    const resolved = await resolveUser(googleUserId, { queryFn });
    if (!resolved) {
      return { text: `👋 Hi! I'm AnchorOps. ${NEUTRAL_REFUSAL}` };
    }
    return renderHelpCard();
  }

  if (eventType === 'CARD_CLICKED') {
    return handleCardClicked(event, deps);
  }

  // MESSAGE or APP_COMMAND
  const googleUserId = event.message?.sender?.name || event.user?.name || null;
  const text = event.message?.text || event.message?.slashCommand?.commandName || '';

  const resolved = await resolveUser(googleUserId, { queryFn });
  if (!resolved) return { text: NEUTRAL_REFUSAL };

  const { anchorUser } = resolved;
  const parsed = parseCommand(text);

  try {
    assertPermission(anchorUser, parsed.command);
  } catch (err) {
    if (err instanceof PermissionError) return { text: PERMISSION_DENIED };
    throw err;
  }

  try {
    return await handleCommandFn({ command: parsed.command, args: parsed.args, anchorUser }, { queryFn });
  } catch (err) {
    if (err instanceof PermissionError) return { text: PERMISSION_DENIED };
    console.warn(`[gchat/event] handleCommand error: ${err?.message || err}`);
    return { text: 'An internal error occurred.' };
  }
}
