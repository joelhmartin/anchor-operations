/**
 * Access Audit orchestrator (north-star §0). Runs each checker, classifies into
 * green/yellow/red, rolls up an overall status, and persists one audit-run row.
 * Every checker is wrapped so a throw degrades to a `failed` service result —
 * one broken service never fails the whole audit.
 */
import { detectRuntime as detectRuntimeDefault } from './runtimeIdentity.js';
import { auditCredentials } from './envSecrets.js';
import { checkOpsTables as checkOpsTablesDefault, probeReadWrite as probeReadWriteDefault } from './databaseAccess.js';
import { checkPubSubTopics, listTopicShortNames } from './pubsubAccess.js';
import { classifyService, rollupStatus, summarize } from './statusClassifier.js';
import { createAuditRun as createAuditRunDefault, finishAuditRun as finishAuditRunDefault } from './auditStore.js';
import { computeClientCoverage as computeClientCoverageDefault } from './clientCoverage.js';
import { runLiveVerifiers as runLiveVerifiersDefault } from './liveVerify.js';

async function safe(fn, onError) {
  try {
    return await fn();
  } catch (err) {
    return onError(err);
  }
}

const withColor = (result) => ({ ...result, color: classifyService(result.status) });

export async function runAccessAudit(deps = {}) {
  const {
    env = process.env,
    detectRuntime = detectRuntimeDefault,
    checkOpsTables = checkOpsTablesDefault,
    probeReadWrite = probeReadWriteDefault,
    pubsubClient = undefined, // undefined → build a real client; null → skip
    createAuditRun = createAuditRunDefault,
    finishAuditRun = finishAuditRunDefault,
    computeClientCoverage = computeClientCoverageDefault,
    runLiveVerifiers = runLiveVerifiersDefault
  } = deps;

  const run = await createAuditRun();

  const runtime = await safe(
    () => detectRuntime({ env }),
    (err) => ({ environment: 'unknown', projectId: null, serviceAccount: null, cloudRunService: null, error: err?.message })
  );

  // --- credential services (pure) ---
  const cred = auditCredentials(env);
  const services = {};
  for (const [name, r] of Object.entries(cred.services)) services[name] = withColor(r);

  // --- database ---
  const dbTables = await safe(() => checkOpsTables(), (err) => ({ status: 'failed', present: [], missing: [], detail: err?.message }));
  const dbRw = await safe(() => probeReadWrite(), (err) => ({ status: 'failed', detail: err?.message }));
  const dbStatus = dbTables.status === 'failed' || dbRw.status === 'failed' ? 'failed' : dbTables.status;
  services.database = withColor({ status: dbStatus, tables: dbTables, readWrite: dbRw });

  // --- pub/sub ---
  const warnings = [];
  let actualTopics = null;
  if (pubsubClient === null) {
    warnings.push('pubsub: topic listing skipped (no client provided)');
  } else {
    actualTopics = await safe(async () => {
      const client = pubsubClient || (await import('@google-cloud/pubsub').then(({ PubSub }) => new PubSub()));
      return listTopicShortNames(client);
    }, (err) => { warnings.push(`pubsub: list failed — ${err?.message || err}`); return null; });
  }
  const pubsub = checkPubSubTopics({ actual: actualTopics });
  services.pubsub = withColor(pubsub);
  if (pubsub.status === 'skipped' && pubsubClient !== null) {
    warnings.push('pubsub: topic listing skipped');
  }

  // --- live verification (real API calls where creds exist; overrides presence) ---
  const live = await safe(() => runLiveVerifiers(env), () => ({}));
  for (const [name, r] of Object.entries(live)) services[name] = withColor(r);

  // --- client access coverage (real per-client connection state) ---
  const clientCoverage = await safe(
    () => computeClientCoverage(),
    (err) => ({ total: 0, services: {}, error: err?.message })
  );

  // --- rollup ---
  const statuses = Object.values(services).map((s) => s.status);
  const overall = rollupStatus(statuses);
  const summary = summarize(statuses);

  const details = { runtime, services, clientCoverage };
  const missing = [...cred.missing];

  const finished = await finishAuditRun(run.id, {
    status: overall,
    environment: runtime.environment,
    serviceAccount: runtime.serviceAccount,
    projectId: runtime.projectId,
    summary,
    details,
    missing,
    warnings
  });

  // Return a convenient view (store row + the assembled objects) for callers/tests.
  return { ...finished, status: overall, environment: runtime.environment, summary, details, missing, warnings };
}
