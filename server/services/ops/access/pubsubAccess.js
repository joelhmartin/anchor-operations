/** Pub/Sub topic-presence check (north-star §0.2 Pub/Sub). Pure compare + a thin lister. */

// Reconciled with runQueue.js TOPIC_NAME / CANCEL_TOPIC_NAME constants.
export const EXPECTED_TOPICS = ['ops.run.requested', 'ops.run.cancel'];

const shortName = (full) => String(full || '').split('/').pop();

export function checkPubSubTopics({ actual, expected = EXPECTED_TOPICS } = {}) {
  if (actual == null) {
    return { status: 'skipped', present: [], missing: [...expected] };
  }
  const have = new Set(actual);
  const present = expected.filter((t) => have.has(t));
  const missing = expected.filter((t) => !have.has(t));
  return { status: missing.length ? 'degraded' : 'verified', present, missing };
}

export async function listTopicShortNames(pubsubClient) {
  const [topics] = await pubsubClient.getTopics();
  return topics.map((t) => shortName(t.name));
}
