/**
 * Ops runner — Cloud Run Job entry — Phase 2.
 *
 * Pulls messages from the Pub/Sub subscription `ops-runner`, parses
 * `{ runId, enqueuedAt }`, calls `executeRun(runId)`, and acks. Keeps at most
 * 4 runs in-flight per instance. On SIGTERM, stops accepting new messages and
 * drains in-flight executions before exiting.
 *
 * No PHI in message bodies — runId only.
 *
 * Bootstrap (first deploy):
 *   gcloud run jobs deploy anchor-ops-runner \
 *     --image=<artifact-registry-url> \
 *     --region=us-central1 \
 *     --service-account=anchor-hub@anchor-hub-480305.iam.gserviceaccount.com
 */

import '../loadEnv.js';

const SUBSCRIPTION_NAME = process.env.OPS_RUN_SUBSCRIPTION || 'ops-runner';
const MAX_CONCURRENCY = Number(process.env.OPS_RUNNER_CONCURRENCY) || 4;

let inFlight = 0;
let draining = false;
let subscription = null;

async function loadDeps() {
  // Lazy imports keep cold-start cheap if the runner needs to short-circuit.
  const [{ PubSub }, executorMod] = await Promise.all([
    import('@google-cloud/pubsub'),
    import('../services/ops/runExecutor.js')
  ]);
  return { PubSub, executeRun: executorMod.executeRun };
}

async function handleMessage(executeRun, message) {
  let payload;
  try {
    payload = JSON.parse(message.data.toString('utf8'));
  } catch (err) {
    console.warn(`[ops/runner] invalid JSON message — acking and discarding: ${err.message}`);
    message.ack();
    return;
  }

  const runId = payload?.runId;
  if (!runId) {
    console.warn('[ops/runner] message missing runId — acking');
    message.ack();
    return;
  }

  console.warn(`[ops/runner] starting run ${runId}`);
  const startedAt = Date.now();
  try {
    await executeRun(runId);
    const took = Date.now() - startedAt;
    console.warn(`[ops/runner] finished run ${runId} in ${took}ms`);
    message.ack();
  } catch (err) {
    console.warn(`[ops/runner] run ${runId} failed: ${err?.message || err}`);
    // nack so Pub/Sub redelivers (and eventually moves to DLQ on max retries).
    message.nack();
  }
}

async function shutdown(signal) {
  if (draining) return;
  draining = true;
  console.warn(`[ops/runner] received ${signal}; draining ${inFlight} in-flight runs`);
  try {
    if (subscription) await subscription.close();
  } catch (err) {
    console.warn(`[ops/runner] subscription.close error: ${err?.message || err}`);
  }
  // Wait for in-flight runs to settle, with a hard stop after 5 minutes.
  const deadline = Date.now() + 5 * 60 * 1000;
  while (inFlight > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn(`[ops/runner] drain complete (in_flight=${inFlight})`);
  process.exit(0);
}

async function main() {
  const { PubSub, executeRun } = await loadDeps();
  const pubsub = new PubSub();
  subscription = pubsub.subscription(SUBSCRIPTION_NAME, {
    flowControl: { maxMessages: MAX_CONCURRENCY }
  });

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  subscription.on('message', async (message) => {
    if (draining) {
      message.nack();
      return;
    }
    inFlight += 1;
    try {
      await handleMessage(executeRun, message);
    } finally {
      inFlight -= 1;
    }
  });

  subscription.on('error', (err) => {
    console.warn(`[ops/runner] subscription error: ${err?.message || err}`);
  });

  console.warn(
    `[ops/runner] started — subscription=${SUBSCRIPTION_NAME} concurrency=${MAX_CONCURRENCY}`
  );
}

main().catch((err) => {
  console.error('[ops/runner] fatal:', err);
  process.exit(1);
});
