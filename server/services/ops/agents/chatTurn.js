// server/services/ops/agents/chatTurn.js
//
// Provider dispatch for chat turns. Resolves the model, looks up the provider,
// enforces provider-bound threads (an existing thread keeps its own provider;
// a cross-provider modelId is silently ignored in favour of the thread's model),
// then delegates to the right supervisor.

import { providerOf, resolveChatModel } from './models.js';
import { runClaudeChatTurn } from './claudeSupervisor.js';
import { runGeminiChatTurn } from './geminiSupervisor.js';
import { query } from '../../../db.js';

/**
 * Run one chat turn, routing to the right supervisor based on provider.
 *
 * @param {Object}   args
 * @param {string}  [args.clientUserId]
 * @param {string}   args.userId
 * @param {string}  [args.threadId]
 * @param {string}   args.prompt
 * @param {string}  [args.modelId]
 * @param {Function} [args.onEvent]
 * @returns {Promise<{ threadId, status, text, pendingApprovalId, costSummary, assistantMessageId }>}
 */
export async function runChatTurn(args) {
  let { threadId, modelId } = args;

  // Provider-bound threads: an existing thread keeps its provider; ignore a cross-provider modelId.
  if (threadId) {
    const { rows } = await query('SELECT provider, model_id FROM ops_chat_threads WHERE id = $1', [threadId]);
    const threadProvider = rows[0]?.provider || null;
    if (threadProvider && providerOf(resolveChatModel(modelId)) !== threadProvider) {
      modelId = rows[0].model_id; // stick to the thread's own model/provider
    }
  }

  const provider = providerOf(resolveChatModel(modelId));
  const next = { ...args, modelId };
  return provider === 'anthropic' ? runClaudeChatTurn(next) : runGeminiChatTurn(next);
}
