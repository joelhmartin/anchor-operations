/**
 * Command handler for Google Chat interactive commands.
 * All external I/O is injectable via deps for testing.
 */
import { query } from '../../../db.js';
import { clientLabelExpression, clientLabelJoins } from '../../clientLabel.js';
import { enqueueRun } from '../runQueue.js';
import {
  renderHelpCard, renderClientsCard, renderClientSummaryCard,
  renderIssuesCard, renderApprovalsCard, renderErrorCard,
  renderConnectCard, renderAuditCard
} from './cardRenderer.js';
import { sendDailyDigest } from '../notifications/notificationRouter.js';

async function getLatestAuditRunDefault() {
  const { rows } = await query(`SELECT status FROM ops_access_audit_runs ORDER BY created_at DESC LIMIT 1`);
  return rows[0] || null;
}

async function defaultEnqueueFn({ runDefinitionId, clientUserId, tier, trigger, triggeredBy }, queryFn = query) {
  const { rows } = await queryFn(
    `INSERT INTO ops_runs (client_user_id, run_definition_id, tier, status, trigger, triggered_by, metadata)
     VALUES ($1, $2, $3, 'queued', $4, $5, '{}')
     RETURNING id`,
    [clientUserId, runDefinitionId, tier, trigger, triggeredBy]
  );
  const runId = rows[0]?.id;
  if (runId) await enqueueRun(runId);
  return { ok: true, runId };
}

export async function handleCommand({ command, args, anchorUser }, deps = {}) {
  const {
    queryFn = query,
    enqueueFn,
    sendDailyDigestFn = sendDailyDigest,
    getLatestAuditRunFn = getLatestAuditRunDefault,
    appBaseUrl = process.env.APP_BASE_URL || ''
  } = deps;

  // Default enqueueFn needs queryFn in scope
  const resolvedEnqueueFn = enqueueFn || ((params) => defaultEnqueueFn(params, queryFn));

  try {
    switch (command) {
      case 'help':
        return renderHelpCard();

      case 'connect':
        return renderConnectCard(`${appBaseUrl}/ops/connect`);

      case 'approve':
      case 'reject':
        return renderErrorCard('Use the approval buttons in the card to approve or reject an action recommendation.');

      case 'unknown':
        return renderErrorCard('Unknown command. Try /anchorops help.');

      case 'daily': {
        // Trigger daily digest for clients the user has run data for
        const { rows: clientRows } = await queryFn(
          `SELECT DISTINCT client_user_id FROM ops_runs
            WHERE client_user_id = $1
            ORDER BY client_user_id LIMIT 5`,
          [anchorUser.id]
        );
        const clientIds = clientRows.map((r) => r.client_user_id);
        if (clientIds.length === 0) {
          return { text: 'No client runs found for your account yet.' };
        }
        const results = await Promise.allSettled(
          clientIds.map(async (cid) => {
            // Load latest completed run for this client; skip if none found.
            const { rows: runRows } = await queryFn(
              `SELECT id FROM ops_runs WHERE client_user_id = $1 ORDER BY created_at DESC LIMIT 1`,
              [cid]
            );
            const runId = runRows[0]?.id || null;
            if (!runId) return { skipped: true, reason: 'no_runs' };
            return sendDailyDigestFn({ clientUserId: cid, runId }, { queryFn });
          })
        );
        const sent = results.filter((r) => r.status === 'fulfilled' && r.value?.sent).length;
        return { text: `Daily digest triggered for ${sent}/${clientIds.length} client(s).` };
      }

      case 'clients': {
        const isAdmin = anchorUser.role === 'admin' || anchorUser.role === 'superadmin';
        const { rows } = isAdmin
          ? await queryFn(
              `SELECT u.id, ${clientLabelExpression()} AS name,
                      COUNT(f.id) FILTER (WHERE f.status NOT IN ('resolved','ignored')) AS open_findings
                 FROM users u
                 ${clientLabelJoins('u.id')}
                 LEFT JOIN ops_findings f ON f.client_user_id = u.id
                GROUP BY u.id, cp.client_identifier_value, ba.business_name
                ORDER BY name LIMIT 20`
            )
          : await queryFn(
              `SELECT u.id, ${clientLabelExpression()} AS name,
                      COUNT(f.id) FILTER (WHERE f.status NOT IN ('resolved','ignored')) AS open_findings
                 FROM users u
                 ${clientLabelJoins('u.id')}
                 LEFT JOIN ops_findings f ON f.client_user_id = u.id
                WHERE u.id = $1
                GROUP BY u.id, cp.client_identifier_value, ba.business_name
                ORDER BY name LIMIT 20`,
              [anchorUser.id]
            );
        return renderClientsCard(rows.map((r) => ({ id: r.id, name: r.name || r.id.slice(0, 8), openFindings: Number(r.open_findings) || 0 })));
      }

      case 'client': {
        const name = args[0] || '';
        if (!name) return renderErrorCard('Usage: /anchorops client <name>');
        const { rows } = await queryFn(
          `SELECT u.id, ${clientLabelExpression()} AS name
             FROM users u
             ${clientLabelJoins('u.id')}
            WHERE cp.client_identifier_value ILIKE $1
               OR ba.business_name ILIKE $1
               OR (u.first_name || ' ' || u.last_name) ILIKE $1
               OR u.email ILIKE $1
            LIMIT 1`,
          [`%${name}%`]
        );
        const client = rows[0];
        if (!client) return renderErrorCard(`Client not found: ${name}`);
        const { rows: fRows } = await queryFn(
          `SELECT severity, COUNT(*) AS cnt FROM ops_findings
            WHERE client_user_id = $1 AND status NOT IN ('resolved','ignored')
            GROUP BY severity`,
          [client.id]
        );
        const counts = { critical: 0, warning: 0, info: 0 };
        for (const r of fRows) counts[r.severity] = Number(r.cnt);
        let pendingApprovals = 0;
        try {
          const { rows: ar } = await queryFn(
            `SELECT COUNT(*) AS cnt FROM ops_action_recommendations WHERE client_user_id = $1 AND status = 'proposed'`,
            [client.id]
          );
          pendingApprovals = Number(ar[0]?.cnt) || 0;
        } catch { /* F4 not built */ }
        return renderClientSummaryCard({ id: client.id, name: client.name || client.id.slice(0, 8) }, counts, pendingApprovals);
      }

      case 'issues': {
        const name = args[0] || '';
        if (!name) return renderErrorCard('Usage: /anchorops issues <name>');
        const { rows: cRows } = await queryFn(
          `SELECT u.id, ${clientLabelExpression()} AS name
             FROM users u
             ${clientLabelJoins('u.id')}
            WHERE cp.client_identifier_value ILIKE $1
               OR ba.business_name ILIKE $1
               OR (u.first_name || ' ' || u.last_name) ILIKE $1
               OR u.email ILIKE $1
            LIMIT 1`,
          [`%${name}%`]
        );
        const client = cRows[0];
        if (!client) return renderErrorCard(`Client not found: ${name}`);
        const { rows: findings } = await queryFn(
          `SELECT id, severity, category, summary FROM ops_findings
            WHERE client_user_id = $1 AND status NOT IN ('resolved','ignored')
            ORDER BY CASE severity WHEN 'critical' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                     attention_score DESC NULLS LAST
            LIMIT 15`,
          [client.id]
        );
        return renderIssuesCard(findings, client.name || client.id.slice(0, 8));
      }

      case 'run': {
        const name = args[0] || '';
        if (!name) return renderErrorCard('Usage: /anchorops run <name>');
        const { rows: defRows } = await queryFn(
          `SELECT id, name, tier FROM ops_run_definitions WHERE name ILIKE $1 AND archived_at IS NULL LIMIT 1`,
          [`%${name}%`]
        );
        const def = defRows[0];
        if (!def) return renderErrorCard(`Run definition not found: ${name}`);
        await resolvedEnqueueFn({ runDefinitionId: def.id, clientUserId: anchorUser.id, tier: def.tier, trigger: 'google_chat_command', triggeredBy: anchorUser.id });
        return { text: `✅ Run *${def.name}* (${def.tier}) enqueued.` };
      }

      case 'approvals': {
        let recs = [];
        try {
          const { rows } = await queryFn(
            `SELECT ar.id, ar.abstract_action_type AS action_type, ar.risk_tier AS risk_level, ar.summary,
                    ${clientLabelExpression()} AS client_name
               FROM ops_action_recommendations ar
               LEFT JOIN users u ON u.id = ar.client_user_id
               ${clientLabelJoins('ar.client_user_id')}
              WHERE ar.status = 'proposed'
              ORDER BY ar.created_at DESC LIMIT 10`
          );
          recs = rows;
        } catch {
          return { text: 'Approval system (F4) is not yet available.' };
        }
        return renderApprovalsCard(recs.map((r) => ({ id: r.id, actionType: r.action_type, riskLevel: r.risk_level, summary: r.summary, clientName: r.client_name || 'Unknown' })));
      }

      case 'audit': {
        let auditStatus = null;
        try {
          const row = await getLatestAuditRunFn();
          auditStatus = row?.status || null;
        } catch {
          // F0 not built or not accessible — degrade gracefully
        }
        return renderAuditCard(auditStatus);
      }

      default:
        return renderErrorCard('Unknown command. Try /anchorops help.');
    }
  } catch (err) {
    console.warn(`[gchat/handler] command '${command}' failed: ${err.message}`);
    return renderErrorCard('An error occurred processing your command.');
  }
}
