/**
 * call_tracking/ctm connector — discoverInventory (F2).
 *
 * Sanitized aggregates ONLY — no PII ever leaves CTM here:
 *   - tracking_number: persists the DB id + active/inactive status. The phone
 *     digits are NEVER persisted (no name, no metadata number).
 *   - form_reactor: persists the form id/name + autoresponder flag only — no
 *     submission content.
 *   - webhook: a single aggregate row (last call timestamp + 30-day count) —
 *     no caller identity, number, or transcript.
 */
import { query } from '../../../../db.js';
import { listTrackingNumbers } from '../../../ctm.js';
import { inventoryRow } from '../inventoryRow.js';

export default {
  id: 'ctm',
  serviceCategory: 'call_tracking',
  provider: 'ctm',

  async discoverInventory(ctx = {}) {
    const clientUserId = ctx.clientUserId;
    if (!clientUserId) return [];

    const listNumbers = ctx.clients?.listTrackingNumbers || listTrackingNumbers;
    const dbQuery = ctx.clients?.query || query;

    const rows = [];

    // Tracking numbers — id + status only. NEVER the phone digits.
    const numbers = await listNumbers({ clientUserId }).catch(() => []);
    for (const n of numbers) {
      rows.push(inventoryRow({
        object_type: 'tracking_number',
        external_id: n.id,
        name: null,
        status: n.status || null,
        metadata: {}
      }));
    }

    // Form reactors — config flag only, no submission content.
    const formsRes = await dbQuery(
      `SELECT id, name, autoresponder_enabled
         FROM ctm_forms
        WHERE org_id = $1 AND status != 'archived'`,
      [clientUserId]
    ).catch(() => ({ rows: [] }));
    for (const f of formsRes.rows) {
      rows.push(inventoryRow({
        object_type: 'form_reactor',
        external_id: f.id,
        name: f.name || `form-${f.id}`,
        metadata: { autoresponder_enabled: Boolean(f.autoresponder_enabled) }
      }));
    }

    // Webhook delivery — single aggregate, no caller PII.
    const aggRes = await dbQuery(
      `SELECT MAX(created_at) AS last_at,
              COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days') AS calls_30d
         FROM call_logs
        WHERE owner_user_id = $1`,
      [clientUserId]
    ).catch(() => ({ rows: [{}] }));
    const agg = aggRes.rows[0] || {};
    rows.push(inventoryRow({
      object_type: 'webhook',
      external_id: `ctm-webhook-${clientUserId}`,
      name: 'CTM call webhook',
      status: agg.last_at ? 'active' : 'idle',
      metadata: { last_call_at: agg.last_at || null, calls_30d: Number(agg.calls_30d || 0) }
    }));

    return rows;
  }
};
