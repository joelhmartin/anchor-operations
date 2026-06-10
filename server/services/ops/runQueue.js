/**
 * Run queue — Phase 2.
 *
 * Single surface for the rest of the app: `enqueueRun(runId)`.
 *
 * Production (`NODE_ENV === 'production'`):
 *   Publishes a JSON message `{ runId, enqueuedAt }` to the Pub/Sub topic
 *   `ops.run.requested`. The Cloud Run Job (`server/jobs/opsRunner.js`) is
 *   subscribed to `ops-runner` and pulls + executes.
 *
 * Local (`NODE_ENV !== 'production'`):
 *   In-memory FIFO queue with a `setInterval` worker that calls `executeRun`
 *   from `runExecutor.js`. Worker is started lazily on the first enqueue and
 *   tears itself down on `SIGTERM`/`SIGINT`. Bounded concurrency = 4.
 *
 * Both modes catch handler errors and log via `console.warn` — the queue itself
 * must never crash the host process.
 *
 * HIPAA: message bodies carry only `runId` + `enqueuedAt`. No PHI.
 */

const TOPIC_NAME = 'ops.run.requested';
const CANCEL_TOPIC_NAME = 'ops.run.cancel';
const MAX_CONCURRENCY = 4;
const WORKER_TICK_MS = 250;

let pubsubClientPromise = null;
function getPubSubClient() {
  if (!pubsubClientPromise) {
    pubsubClientPromise = import('@google-cloud/pubsub')
      .then(({ PubSub }) => new PubSub())
      .catch((err) => {
        console.warn(`[ops/runQueue] @google-cloud/pubsub unavailable: ${err.message}`);
        pubsubClientPromise = null;
        throw err;
      });
  }
  return pubsubClientPromise;
}

async function publishToPubSub(topicName, payload) {
  const client = await getPubSubClient();
  const topic = client.topic(topicName);
  const data = Buffer.from(JSON.stringify(payload));
  return topic.publishMessage({ data });
}

// ---------------- in-memory worker (dev) ----------------

const queue = [];
const inflightControllers = new Map(); // runId → AbortController
let workerInterval = null;
let inFlight = 0;
let shutdownHandlersRegistered = false;
let executorPromise = null;
function getExecutor() {
  if (!executorPromise) {
    executorPromise = import('./runExecutor.js')
      .then((mod) => mod.executeRun)
      .catch((err) => {
        executorPromise = null;
        throw err;
      });
  }
  return executorPromise;
}

function ensureWorker() {
  if (workerInterval) return;
  registerShutdownHandlers();
  workerInterval = setInterval(tick, WORKER_TICK_MS);
  // Don't keep the event loop alive purely on the queue worker.
  if (typeof workerInterval.unref === 'function') workerInterval.unref();
}

function registerShutdownHandlers() {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  const drain = () => {
    if (workerInterval) {
      clearInterval(workerInterval);
      workerInterval = null;
    }
  };
  process.once('SIGTERM', drain);
  process.once('SIGINT', drain);
}

async function tick() {
  while (inFlight < MAX_CONCURRENCY && queue.length > 0) {
    const job = queue.shift();
    inFlight += 1;
    runJob(job).finally(() => {
      inFlight -= 1;
    });
  }
  if (queue.length === 0 && inFlight === 0 && workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}

async function runJob({ runId }) {
  const controller = new AbortController();
  inflightControllers.set(runId, controller);
  try {
    const executeRun = await getExecutor();
    await executeRun(runId, { signal: controller.signal });
  } catch (err) {
    console.warn(`[ops/runQueue] in-process executeRun(${runId}) failed: ${err?.message || err}`);
  } finally {
    inflightControllers.delete(runId);
  }
}

/**
 * Cancel an in-flight local run by aborting its controller. Returns true if
 * the run was in flight; false otherwise (no-op for runs queued elsewhere).
 */
export function cancelLocal(runId) {
  const controller = inflightControllers.get(runId);
  if (!controller) return false;
  controller.abort();
  return true;
}

// ---------------- public API ----------------

/**
 * Enqueue a run for execution. Production publishes to Pub/Sub; local pushes
 * onto the in-memory worker. Always resolves; any errors are swallowed and
 * logged so callers (HTTP handlers, schedule fanout) never see queue-layer
 * failures bubble up.
 */
export async function enqueueRun(runId) {
  if (!runId) {
    console.warn('[ops/runQueue] enqueueRun called without runId');
    return { ok: false, reason: 'missing_runId' };
  }

  const payload = { runId, enqueuedAt: new Date().toISOString() };

  if (process.env.NODE_ENV === 'production') {
    try {
      await publishToPubSub(TOPIC_NAME, payload);
      return { ok: true, mode: 'pubsub' };
    } catch (err) {
      // Pub/Sub topic / Cloud Run Job runner not yet provisioned in this env.
      // Fall back to the in-process worker so runs actually execute.
      console.warn(`[ops/runQueue] Pub/Sub publish failed for ${runId}, falling back to in-process: ${err?.message || err}`);
      queue.push(payload);
      ensureWorker();
      return { ok: true, mode: 'in_memory_fallback' };
    }
  }

  // dev / local
  queue.push(payload);
  ensureWorker();
  return { ok: true, mode: 'in_memory' };
}

/**
 * Best-effort cancel signal. In production this publishes to `ops.run.cancel`
 * (the Cloud Run Job is responsible for cooperative cancellation). Locally,
 * we simply log — the in-process worker doesn't yet thread an AbortSignal
 * (Phase 2 stub; Phase 6+ will refine).
 */
export async function publishCancelSignal(runId) {
  if (!runId) return { ok: false, reason: 'missing_runId' };

  const payload = { runId, requestedAt: new Date().toISOString() };

  if (process.env.NODE_ENV === 'production') {
    try {
      await publishToPubSub(CANCEL_TOPIC_NAME, payload);
      return { ok: true, mode: 'pubsub' };
    } catch (err) {
      console.warn(`[ops/runQueue] cancel publish failed for ${runId}: ${err?.message || err}`);
      return { ok: false, reason: 'pubsub_publish_failed', error: err?.message };
    }
  }

  console.warn(`[ops/runQueue] cancel signalled for ${runId} (dev mode — cooperative cancellation not yet wired)`);
  return { ok: true, mode: 'in_memory_noop' };
}

// Test/debug helper — exposes queue depth for the in-memory mode only.
export function _devQueueDepth() {
  return { queued: queue.length, in_flight: inFlight };
}
