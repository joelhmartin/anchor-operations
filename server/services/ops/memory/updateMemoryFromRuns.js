/**
 * Memory updater orchestrator (F3, §2.9). Loads the raw activity for a client,
 * delegates the "what's worth remembering" decision to the pure extractor, and
 * persists each fact. Loaders + upsert are injectable so the logic is testable
 * with no DB. Default loaders read tables that already exist (ops_tool_approvals,
 * ops_findings); the stable-config loader is a documented seam for F1.
 */
import { query } from '../../../db.js';
import { extractFacts } from './clientFactsExtractor.js';
import { upsertMemoryFact } from './memoryStore.js';

// Supervisor inserts ops_tool_approvals with run_id=NULL (chat-session context);
// query directly on client_user_id (added to the table in F3 migration).
export async function loadApprovals(clientUserId) {
  const { rows } = await query(
    `SELECT tool_name, approved_at, executed_at, args_json
       FROM ops_tool_approvals
      WHERE client_user_id = $1
        AND approved_at IS NOT NULL
        AND executed_at IS NOT NULL
        AND (execution_result_json->>'rejected')::boolean IS NOT TRUE`,
    [clientUserId]
  );
  return rows.map((r) => ({
    tool_name: r.tool_name,
    approved_at: r.approved_at,
    executed_at: r.executed_at,
    scope: r.args_json?.service || r.args_json?.umbrella || 'client'
  }));
}

export async function loadRejections(clientUserId) {
  const { rows } = await query(
    `SELECT tool_name, executed_at, args_json
       FROM ops_tool_approvals
      WHERE client_user_id = $1
        AND executed_at IS NOT NULL
        AND (execution_result_json->>'rejected')::boolean = true`,
    [clientUserId]
  );
  return rows.map((r) => ({
    tool_name: r.tool_name,
    executed_at: r.executed_at,
    scope: r.args_json?.service || r.args_json?.umbrella || 'client'
  }));
}

export async function loadRepeatedFindings(clientUserId) {
  const { rows } = await query(
    `SELECT category,
            COUNT(*)::int AS occurrences,
            COUNT(*) FILTER (WHERE acknowledged_at IS NOT NULL OR resolved_at IS NOT NULL)::int AS dismissed_count
       FROM ops_findings
      WHERE client_user_id = $1
      GROUP BY category`,
    [clientUserId]
  );
  return rows.map((r) => ({
    category: r.category,
    occurrences: r.occurrences,
    dismissed_count: r.dismissed_count,
    scope: 'client'
  }));
}

// Config inventory arrives with F1 (ops_service_connections / ops_platform_inventory).
// Until then this returns nothing; the seam keeps the orchestrator stable.
export async function loadStableConfigs(_clientUserId) {
  return [];
}

export async function updateMemoryFromRuns({ clientUserId, notes = [], deps = {} }) {
  const {
    loadApprovals: loadApprovalsDep = loadApprovals,
    loadRejections: loadRejectionsDep = loadRejections,
    loadRepeatedFindings: loadFindingsDep = loadRepeatedFindings,
    loadStableConfigs: loadConfigsDep = loadStableConfigs,
    upsertFact = upsertMemoryFact
  } = deps;

  const [approvals, rejections, findings, configs] = await Promise.all([
    loadApprovalsDep(clientUserId),
    loadRejectionsDep(clientUserId),
    loadFindingsDep(clientUserId),
    loadConfigsDep(clientUserId)
  ]);

  const facts = extractFacts({ approvals, rejections, findings, configs, notes });

  let upserted = 0;
  for (const fact of facts) {
    await upsertFact({ clientUserId, ...fact });
    upserted += 1;
  }
  return { extracted: facts.length, upserted };
}
