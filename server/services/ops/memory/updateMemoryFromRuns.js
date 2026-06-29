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

export async function loadApprovals(clientUserId) {
  const { rows } = await query(
    `SELECT a.tool_name, a.approved_at, a.executed_at, a.args_json
       FROM ops_tool_approvals a
       JOIN ops_runs r ON r.id = a.run_id
      WHERE r.client_user_id = $1
        AND a.approved_at IS NOT NULL
        AND a.executed_at IS NOT NULL`,
    [clientUserId]
  );
  return rows.map((r) => ({
    tool_name: r.tool_name,
    approved_at: r.approved_at,
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
    loadRepeatedFindings: loadFindingsDep = loadRepeatedFindings,
    loadStableConfigs: loadConfigsDep = loadStableConfigs,
    upsertFact = upsertMemoryFact
  } = deps;

  const [approvals, findings, configs] = await Promise.all([
    loadApprovalsDep(clientUserId),
    loadFindingsDep(clientUserId),
    loadConfigsDep(clientUserId)
  ]);

  const facts = extractFacts({ approvals, findings, configs, notes });

  let upserted = 0;
  for (const fact of facts) {
    await upsertFact({ clientUserId, ...fact });
    upserted += 1;
  }
  return { extracted: facts.length, upserted };
}
