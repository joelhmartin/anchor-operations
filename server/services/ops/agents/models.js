// Claude model registry for the ops chat. Exact IDs (no date suffix).

export const CLAUDE_MODELS = {
  'claude-haiku-4-5': { label: 'Haiku 4.5 (fast/cheap)', inPer1k: 0.001, outPer1k: 0.005 },
  'claude-sonnet-4-6': { label: 'Sonnet 4.6 (balanced)', inPer1k: 0.003, outPer1k: 0.015 },
  'claude-opus-4-8': { label: 'Opus 4.8 (deep strategy)', inPer1k: 0.005, outPer1k: 0.025 }
};

export const DEFAULT_CHAT_MODEL = process.env.OPS_CHAT_DEFAULT_MODEL || 'claude-sonnet-4-6';
export const SUBAGENT_MODEL = process.env.OPS_CHAT_SUBAGENT_MODEL || 'claude-haiku-4-5';

export function resolveChatModel(modelId) {
  if (modelId && CLAUDE_MODELS[modelId]) return modelId;
  return CLAUDE_MODELS[DEFAULT_CHAT_MODEL] ? DEFAULT_CHAT_MODEL : 'claude-sonnet-4-6';
}

export function priceFor(modelId) {
  return CLAUDE_MODELS[modelId] || CLAUDE_MODELS['claude-sonnet-4-6'];
}
