/**
 * ctm.form_flow
 *
 * Verifies CTM forms for the client are receiving submissions, autoresponders
 * are configured, and reply-to + subject settings are present.
 *
 * Schema adaptations (vs. original task template):
 *   - Owner field is `org_id`, not `owner_user_id`.
 *   - Archival is `status != 'archived'`, not `archived_at IS NULL`.
 *   - Autoresponder settings are top-level columns (autoresponder_enabled,
 *     autoresponder_reply_to, autoresponder_subject), NOT inside a settings_json
 *     JSONB column. The task template's settings_json path does not exist.
 *   - Form identifier used in findings is `name` (no `slug` column).
 */
import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';

async function handler({ clientUserId }) {
  const { rows: forms } = await query(`
    SELECT f.id, f.name,
           f.autoresponder_enabled,
           f.autoresponder_reply_to,
           f.autoresponder_subject,
           (SELECT COUNT(*) FROM ctm_form_submissions s WHERE s.form_id = f.id AND s.created_at >= now() - interval '7 days') AS subs_7d
      FROM ctm_forms f
     WHERE f.org_id = $1 AND f.status != 'archived'
  `, [clientUserId]);

  const findings = [];
  for (const f of forms) {
    if (f.autoresponder_enabled && (!f.autoresponder_reply_to?.length || !f.autoresponder_subject)) {
      findings.push({ severity: 'warning', form: f.name, reason: 'autoresponder enabled but reply-to or subject missing' });
    }
    if (Number(f.subs_7d) === 0) {
      findings.push({ severity: 'info', form: f.name, reason: 'no submissions in 7d' });
    }
  }

  return {
    status: findings.length ? 'warn' : 'ok',
    severity: findings.some((x) => x.severity === 'warning') ? 'warning' : 'info',
    payload: { forms_checked: forms.length, findings },
    cost_cents: 0
  };
}

registerCheck('ctm.form_flow', {
  umbrella: 'ctm',
  tier: 'daily_essential',
  handler,
  costEstimate: 0,
  requires: ['ctm']
});

export { handler };
