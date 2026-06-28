/**
 * Pure capability availability + gate evaluation (spec §4 capability gate).
 * A check whose requiredCapabilities aren't satisfied by the client's
 * connections is SKIPPED by the executor (never errored). Only verified or
 * degraded connections grant capabilities.
 */
export const USABLE_CONNECTION_STATUSES = new Set(['verified', 'degraded']);

export function availableCapabilities(connections = []) {
  const caps = new Set();
  for (const c of connections) {
    if (!c || !USABLE_CONNECTION_STATUSES.has(c.status)) continue;
    for (const cap of c.capabilities || []) caps.add(cap);
  }
  return caps;
}

export function evaluateGate(requiredCapabilities = [], connections = []) {
  const required = Array.isArray(requiredCapabilities) ? requiredCapabilities : [];
  const available = availableCapabilities(connections);
  const missing = required.filter((cap) => !available.has(cap));
  return { satisfied: missing.length === 0, missing, available: [...available] };
}
