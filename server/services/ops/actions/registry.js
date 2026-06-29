/**
 * Capability-aware abstract→provider action resolver (expandability §8).
 * An abstract action (website.clear_cache) resolves to a provider action
 * (hosting.kinsta.clear_cache) ONLY for a provider the client is connected to
 * AND that advertises the required capability. Connector access is injected so
 * this runs/test-greens before the F1 connector registry exists.
 */
export const ABSTRACT_ACTIONS = {
  'website.clear_cache': {
    capability: 'clear_cache',
    destructive: false,
    providerActionByProvider: { kinsta: 'hosting.kinsta.clear_cache' }
  }
};

export async function defaultGetConnector(provider) {
  try {
    const mod = await import('../connections/registry.js'); // F1; absent until then
    if (typeof mod.getConnector === 'function') return mod.getConnector(provider);
    return null;
  } catch {
    return null;
  }
}

export async function resolveAction(abstractActionType, { capabilities = [], getConnector = defaultGetConnector } = {}) {
  const def = ABSTRACT_ACTIONS[abstractActionType];
  if (!def) return { ok: false, reason: `unknown abstract action: ${abstractActionType}` };

  for (const entry of capabilities) {
    const provider = entry?.provider;
    const providerActionType = provider && def.providerActionByProvider[provider];
    if (!providerActionType) continue;
    const has = Array.isArray(entry.capabilities) && entry.capabilities.includes(def.capability);
    if (!has) continue;
    const connector = await getConnector(provider);
    if (!connector) return { ok: false, reason: `connector for ${provider} not available`, provider };
    return { ok: true, providerActionType, provider, connector, capability: def.capability };
  }
  return { ok: false, reason: `capability_unavailable: no connected provider offers ${def.capability}` };
}

export default { resolveAction, ABSTRACT_ACTIONS, defaultGetConnector };
