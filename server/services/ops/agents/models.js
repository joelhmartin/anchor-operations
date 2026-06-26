// Unified model registry across providers. Anthropic stays available; Google
// (Vertex Gemini) is the default because the Anthropic credit balance is
// exhausted. Gemini already runs in prod for checks/sub-agents.
export const MODELS = {
  'claude-haiku-4-5': { provider: 'anthropic', label: 'Claude Haiku 4.5 (fast)', inPer1k: 0.001, outPer1k: 0.005 },
  'claude-sonnet-4-6': { provider: 'anthropic', label: 'Claude Sonnet 4.6 (balanced)', inPer1k: 0.003, outPer1k: 0.015 },
  'claude-opus-4-8': { provider: 'anthropic', label: 'Claude Opus 4.8 (deep)', inPer1k: 0.005, outPer1k: 0.025 },
  'gemini-2.5-flash': { provider: 'google', label: 'Gemini 2.5 Flash (fast/cheap)', inPer1k: 0.000075, outPer1k: 0.0003 },
  'gemini-2.5-pro': { provider: 'google', label: 'Gemini 2.5 Pro (deep)', inPer1k: 0.00125, outPer1k: 0.005 }
};

// Back-compat: some code imports CLAUDE_MODELS.
export const CLAUDE_MODELS = Object.fromEntries(
  Object.entries(MODELS).filter(([, m]) => m.provider === 'anthropic')
);

export const DEFAULT_CHAT_MODEL = process.env.OPS_CHAT_DEFAULT_MODEL || 'gemini-2.5-flash';
export const SUBAGENT_MODEL = process.env.OPS_CHAT_SUBAGENT_MODEL || 'gemini-2.5-flash';

export function providerOf(modelId) {
  return MODELS[modelId]?.provider || null;
}

export function resolveChatModel(modelId) {
  if (modelId && MODELS[modelId]) return modelId;
  return MODELS[DEFAULT_CHAT_MODEL] ? DEFAULT_CHAT_MODEL : 'gemini-2.5-flash';
}

// Pricing lookup across providers. Falls back to the default model's rates for
// unknown ids. Returns the model entry (has inPer1k/outPer1k, consumed by the
// runtime cost meters).
export function priceFor(modelId) {
  return MODELS[modelId] || MODELS[DEFAULT_CHAT_MODEL] || MODELS['gemini-2.5-flash'];
}
