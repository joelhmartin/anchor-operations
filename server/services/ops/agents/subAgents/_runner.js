/**
 * Shared sub-agent runner.
 *
 * Sub-agents are uniform: a system prompt, a tool registry, an entry point
 * `run({ prompt, context, ...shared })`. This module factors the loop so each
 * agent file is just (a) the prompt + (b) the tool registry.
 *
 * The supervisor passes its costTracker through to sub-agents so the per-turn
 * $0.50 cap is enforced across the whole chain (supervisor calls + sub-agent
 * calls). Mutating tools never run during delegate_to — they go through the
 * supervisor's propose_action path; we return an explicit error if the model
 * tries to call one directly.
 */

import { runToolLoop, PER_TURN_BUDGET_CENTS } from '../vertexRuntime.js';
import { createCostTracker } from '../../costTracker.js';

export async function runSubAgentLoop({
  name,
  systemPrompt,
  tools,
  prompt,
  context,
  clientUserId,
  userId,
  costTracker,
  budgetCents = PER_TURN_BUDGET_CENTS,
  modelName
}) {
  const tracker = costTracker || createCostTracker();

  const grounding = context ? `\n\n## Caller context\n${context}` : '';
  const messages = [
    {
      role: 'user',
      parts: [{ text: `${prompt || ''}${grounding}` }]
    }
  ];

  const declarations = tools.list();
  const toolCallsLog = [];

  const runTool = async (toolName, args) => {
    const tool = tools.get(toolName);
    if (!tool) return { result: { error: `Unknown ${name} tool: ${toolName}` } };
    if (tool.mutating) {
      // Sub-agents cannot mutate directly. The supervisor must call propose_action.
      return {
        result: {
          error: `Tool "${toolName}" is mutating. Return your finding to the supervisor; the supervisor will call propose_action.`
        }
      };
    }
    try {
      const result = await tool.handler(args || {}, { userId, clientUserId, agentType: name });
      toolCallsLog.push({ tool: toolName, ok: !result?.error });
      return { result };
    } catch (err) {
      toolCallsLog.push({ tool: toolName, ok: false });
      return { result: { error: err.message || 'Tool error' } };
    }
  };

  const loop = await runToolLoop({
    messages,
    systemInstruction: { role: 'system', parts: [{ text: systemPrompt }] },
    toolDeclarations: declarations,
    runTool,
    costTracker: tracker,
    budgetCents,
    ...(modelName ? { modelName } : {})
  });

  return {
    subagent: name,
    status: loop.status,
    text: loop.text || '',
    toolCalls: toolCallsLog,
    costSummary: tracker.summary()
  };
}
