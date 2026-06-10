/**
 * Sub-agent registry for the Phase 7 supervisor.
 *
 * Each sub-agent module exports:
 *   default { name, run, getTool, listTools }
 *
 *   - run({ prompt, context, clientUserId, userId, costTracker, budgetCents })
 *       Executes one sub-agent turn (its own tool loop). Returns
 *       { messages, text, toolCalls, costSummary, status }.
 *   - getTool(name) → { declaration, mutating, handler } | null
 *   - listTools() → tool declarations (Vertex shape)
 */

import websiteAgent from './websiteAgent.js';
import googleAdsAgent from './googleAdsAgent.js';
import metaAgent from './metaAgent.js';
import ctmAgent from './ctmAgent.js';

const REGISTRY = new Map([
  [websiteAgent.name, websiteAgent],
  [googleAdsAgent.name, googleAdsAgent],
  [metaAgent.name, metaAgent],
  [ctmAgent.name, ctmAgent]
]);

export function listSubAgents() {
  return Array.from(REGISTRY.keys());
}

export function getSubAgent(name) {
  return REGISTRY.get(name) || null;
}

export function getSubAgentTool(subagent, tool) {
  const agent = REGISTRY.get(subagent);
  if (!agent) return null;
  return agent.getTool(tool) || null;
}

export async function runSubAgent(name, params) {
  const agent = REGISTRY.get(name);
  if (!agent) throw new Error(`Unknown sub-agent: ${name}`);
  return agent.run(params);
}
