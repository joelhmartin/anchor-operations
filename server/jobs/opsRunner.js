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
const CANCEL_SUBSCRIPTION_NAME =
  process.env.OPS_RUN_CANCEL_SUBSCRIPTION || 'ops-runner-cancel';
const MAX_CONCURRENCY = Number(process.env.OPS_RUNNER_CONCURRENCY) || 4;

let inFlight = 0;
let draining = false;
let subscription = null;
let cancelSubscription = null;
// runId → AbortController for in-flight runs on this instance. The cancel
// subscriber aborts the matching controller; the executor's per-check loop
// observes `signal.aborted` and stops cleanly, and its terminal UPDATE
// preserves the 'cancelled' status set by the cancel route.
const inflightControllers = new Map();

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

  const controller = new AbortController();
  inflightControllers.set(runId, controller);

  console.warn(`[ops/runner] starting run ${runId}`);
  const startedAt = Date.now();
  try {
    await executeRun(runId, { signal: controller.signal });
    const took = Date.now() - startedAt;
    console.warn(`[ops/runner] finished run ${runId} in ${took}ms`);
    message.ack();
  } catch (err) {
    console.warn(`[ops/runner] run ${runId} failed: ${err?.message || err}`);
    // nack so Pub/Sub redelivers (and eventually moves to DLQ on max retries).
    message.nack();
  } finally {
    inflightControllers.delete(runId);
  }
}

// Cancel messages are best-effort signals. We always ack — a redelivery
// would just re-abort an already-aborted controller (no-op), and nacking
// could cause unbounded redeliveries when the target runId lives on a
// different worker instance.
function handleCancelMessage(message) {
  let payload;
  try {
    payload = JSON.parse(message.data.toString('utf8'));
  } catch (err) {
    console.warn(`[ops/runner] invalid JSON cancel message — acking: ${err.message}`);
    message.ack();
    return;
  }
  message.ack();

  const runId = payload?.runId;
  if (!runId) {
    console.warn('[ops/runner] cancel message missing runId — ignoring');
    return;
  }
  const controller = inflightControllers.get(runId);
  if (!controller) {
    // Run isn't in flight on this instance (held by another worker, already
    // finished, or never started here). Nothing to do.
    return;
  }
  console.warn(`[ops/runner] cancelling in-flight run ${runId}`);
  controller.abort();
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
  try {
    if (cancelSubscription) await cancelSubscription.close();
  } catch (err) {
    console.warn(`[ops/runner] cancel subscription.close error: ${err?.message || err}`);
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

  // Cancel-topic subscriber. Provisioned out-of-band as `ops-runner-cancel` on
  // `ops.run.cancel`. If the subscription isn't yet provisioned, Pub/Sub will
  // surface an error on the listener — we log and continue so normal run
  // execution still works.
  try {
    cancelSubscription = pubsub.subscription(CANCEL_SUBSCRIPTION_NAME);
    cancelSubscription.on('message', (message) => {
      if (draining) {
        // Still ack — draining means we're shutting down. There's no value
        // in redelivering a cancel signal that will land on another instance
        // (or eventually no one).
        message.ack();
        return;
      }
      handleCancelMessage(message);
    });
    cancelSubscription.on('error', (err) => {
      console.warn(`[ops/runner] cancel subscription error: ${err?.message || err}`);
    });
  } catch (err) {
    console.warn(`[ops/runner] cancel subscription init failed: ${err?.message || err}`);
    cancelSubscription = null;
  }

  console.warn(
    `[ops/runner] started — subscription=${SUBSCRIPTION_NAME} cancelSubscription=${CANCEL_SUBSCRIPTION_NAME} concurrency=${MAX_CONCURRENCY}`
  );
}

main().catch((err) => {
  console.error('[ops/runner] fatal:', err);
  process.exit(1);
});
