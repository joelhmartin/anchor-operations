/**
 * Snapshot scheduler (V5) — the runnable daily path that wires snapshot
 * collection + baseline recompute together for the agency roster.
 *
 * Bound at `POST /api/ops/internal/snapshot-collect` (OIDC-authed, same pattern
 * as the fanout / chat-digest internal endpoints). Cloud Scheduler can hit this
 * once a day BEFORE the run-fanout so the anomaly check has a fresh observed day
 * + recomputed baselines to score against.
 *
 * Read-only collection: connectors' collectSnapshot() only READ from their
 * platforms. No posting / mutation. Clients without configured credentials
 * collect zero rows (a no-op) rather than erroring.
 */

import gscConnector from '../connections/gsc/index.js';
import { collectAndPersistSnapshots, recomputeBaselinesForClient } from './snapshotCollection.js';

/**
 * The connectors whose collectSnapshot() output feeds the baseline engine.
 * GSC is the proven real source (returns canonical ops_daily_snapshots rows and
 * needs only the GA4 service-account token from Secret Manager). New sources
 * (GA4, paid_ads) drop in here as their snapshot wiring lands.
 */
export const DEFAULT_SNAPSHOT_CONNECTORS = [gscConnector];

/**
 * Collect snapshots for one client from every connector, then recompute that
 * client's baselines over the accumulated history.
 *
 * @param {object} opts
 * @param {string} opts.clientUserId
 * @param {Array}  [opts.connectors]      injectable connector list
 * @param {string} [opts.asOf]            snapshot date / baseline asOf (ISO)
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{clientUserId, collected, persisted, baselines, perConnector}>}
 */
export async function collectAndBaselineForClient({
  clientUserId, connectors = DEFAULT_SNAPSHOT_CONNECTORS, asOf = null, signal = null
}) {
  const date = asOf || new Date().toISOString().slice(0, 10);
  const perConnector = [];
  let collected = 0;
  let persisted = 0;

  for (const connector of connectors) {
    try {
      const res = await collectAndPersistSnapshots({
        clientUserId, connector, snapshotDate: date, signal
      });
      collected += res.collected;
      persisted += res.persisted;
      perConnector.push({ connector: connector.id, ...res });
    } catch (err) {
      console.warn(`[ops/snapshotScheduler] connector ${connector?.id} failed for client ${clientUserId}: ${err?.message || err}`);
      perConnector.push({ connector: connector?.id, error: err?.message || String(err) });
    }
  }

  // Recompute baselines even if this run collected 0 new rows — prior history
  // may still merit a (re)computed baseline.
  let baselines = { persisted: 0, series: 0 };
  try {
    baselines = await recomputeBaselinesForClient({ clientUserId, asOf: date });
  } catch (err) {
    console.warn(`[ops/snapshotScheduler] baseline recompute failed for client ${clientUserId}: ${err?.message || err}`);
  }

  return { clientUserId, collected, persisted, baselines, perConnector };
}

/**
 * Roster-wide daily collection. Iterates the Operations client roster, runs
 * collectAndBaselineForClient per client, and returns an aggregate summary.
 *
 * @param {object} [opts]
 * @param {string} [opts.clientUserId]   restrict to a single client (manual run)
 * @param {function} [opts.listRoster]   injectable roster source
 * @param {Array} [opts.connectors]
 * @param {string} [opts.asOf]
 * @returns {Promise<{clients, collected, persisted, baselines, results}>}
 */
export async function runScheduledSnapshotCollection({
  clientUserId = null, listRoster = null, connectors = DEFAULT_SNAPSHOT_CONNECTORS, asOf = null
} = {}) {
  let clientIds;
  if (clientUserId) {
    clientIds = [clientUserId];
  } else {
    const rosterFn = listRoster || (async () => {
      const { listOpsClientRoster } = await import('../clientRoster.js');
      return listOpsClientRoster();
    });
    const roster = await rosterFn();
    clientIds = roster.map((c) => c.user_id || c.id).filter(Boolean);
  }

  const results = [];
  let collected = 0;
  let persisted = 0;
  let baselines = 0;

  for (const id of clientIds) {
    const res = await collectAndBaselineForClient({ clientUserId: id, connectors, asOf });
    collected += res.collected;
    persisted += res.persisted;
    baselines += res.baselines?.persisted || 0;
    results.push(res);
  }

  return { clients: clientIds.length, collected, persisted, baselines, results };
}
