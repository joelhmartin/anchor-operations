/**
 * Skill executor.
 *
 * Loads a skill from the store, maps each collector to a check handler from
 * the registry (wrapping it as a callable tool), and hands the skill's
 * prompt_md to the sub-agent loop as the system prompt with the collectors
 * exposed as tools.
 *
 * The agent is instructed (at the end of the user message) to return a JSON
 * object as its final response:
 *
 *   {
 *     "findings": [{...}, ...],
 *     "summary": "...",
 *     "suggestions": [
 *       {
 *         "proposed_prompt_md": "...",
 *         "proposed_collectors": ["check.id"],
 *         "rationale": "..."
 *       }
 *     ]
 *   }
 *
 * suggestions is optional — an empty array (or omitting the field) means
 * "nothing to suggest." findings and summary are always expected.
 *
 * HIPAA: skill prompts are admin-authored. Collector handlers must not return
 * PHI (they are individually responsible for that gate). The executor does not
 * re-validate handler output — it trusts the check layer.
 */

import { getCheck } from '../checks/registry.js';
import { getSkill } from './store.js';
import { listRecipes } from './recipes.js';
import { runSubAgentLoop } from '../agents/subAgents/_runner.js';
import { createCostTracker } from '../costTracker.js';

/**
 * Build a tools shim that satisfies the interface expected by runSubAgentLoop:
 *   tools.list()          → Array of Vertex function declarations
 *   tools.get(name)       → tool descriptor with { handler, mutating }
 *
 * Each collector is exposed as a Vertex function with a single optional
 * argument object. The handler wraps the registry handler so the agent can
 * call any collector by its checkId (dots replaced by underscores, since
 * Vertex tool names must be identifier-safe).
 *
 * @param {Array<{ checkId, umbrella, tool }>} collectors
 * @returns {{ list: () => Array, get: (name: string) => Object|null }}
 */
function buildToolsShim(collectors) {
  const byName = new Map();

  for (const col of collectors) {
    // Vertex function names must match /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/.
    // Replace dots and hyphens with underscores.
    const toolName = col.checkId.replace(/[.\-]/g, '_');
    if (byName.has(toolName)) {
      throw new Error(`tool name collision after sanitization: "${toolName}" from "${col.checkId}"`);
    }

    byName.set(toolName, {
      mutating: false,
      // _ctx is { userId, clientUserId, agentType } from _runner.js — the
      // wrapper closes over clientUserId already, so we ignore the second arg.
      handler: async (args, _ctx) => {
        try {
          return await col.tool(args || {});
        } catch (err) {
          return { error: err.message || 'collector error', checkId: col.checkId };
        }
      },
      declaration: {
        name: toolName,
        description: `Run the "${col.checkId}" collector (umbrella: ${col.umbrella}). Returns the check result payload.`,
        parameters: {
          type: 'object',
          properties: {
            args: {
              type: 'object',
              description: 'Optional override arguments passed to the collector handler.'
            }
          },
          required: []
        }
      }
    });
  }

  return {
    list() {
      return Array.from(byName.values()).map((t) => t.declaration);
    },
    get(name) {
      return byName.get(name) || null;
    }
  };
}

/**
 * Extract structured output from the agent's final text response.
 *
 * The agent is instructed to return JSON. We try to parse it; if that fails
 * we treat the whole text as a summary with empty findings/suggestions.
 *
 * @param {string} text
 * @returns {{ findings: Array, summary: string, suggestions: Array }}
 */
function parseAgentOutput(text) {
  const raw = (text || '').trim();

  // Try to extract a JSON block (the model sometimes wraps in ```json ... ```)
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ||
                    raw.match(/^(\{[\s\S]*\})$/m);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw;

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      findings: Array.isArray(parsed.findings) ? parsed.findings : [],
      summary: typeof parsed.summary === 'string' ? parsed.summary : raw,
      suggestions: Array.isArray(parsed.suggestions) ? parseSuggestions(parsed.suggestions) : []
    };
  } catch {
    // Not valid JSON — treat the whole response as a plain summary.
    return { findings: [], summary: raw, suggestions: [] };
  }
}

function parseSuggestions(rawSuggestions) {
  if (!Array.isArray(rawSuggestions)) return [];
  return rawSuggestions
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      proposedPromptMd: s.proposed_prompt_md || s.proposedPromptMd || null,
      proposedCollectors: Array.isArray(s.proposed_collectors || s.proposedCollectors)
        ? (s.proposed_collectors || s.proposedCollectors)
        : [],
      rationale: typeof s.rationale === 'string' ? s.rationale : '',
      proposedSlug: s.proposed_slug || s.proposedSlug || null,
      proposedUmbrella: s.proposed_umbrella || s.proposedUmbrella || null,
      proposedTitle: s.proposed_title || s.proposedTitle || null
    }))
    .filter((s) => s.proposedPromptMd || s.proposedCollectors.length);
}

/**
 * Run a skill against a client context.
 *
 * @param {Object} p
 * @param {string} p.skillId          ops_skills.id
 * @param {string|null} p.runId       ops_runs.id (for audit trail)
 * @param {string} p.clientUserId     The client this run is scoped to
 * @param {Object} [p.umbrellaContext] Extra context forwarded to collector handlers (e.g. accountId, siteUrl)
 *
 * @returns {Promise<{
 *   skillId: string,
 *   skillVersion: number,
 *   findings: Array,
 *   summary: string,
 *   cost_cents: number,
 *   suggestions: Array
 * }>}
 */
export async function runSkill({ skillId, runId, clientUserId, umbrellaContext = {}, modelName }) {
  const skill = await getSkill(skillId);
  if (!skill) throw new Error(`skill not found: ${skillId}`);
  if (skill.archived_at) throw new Error(`skill archived: ${skill.slug}`);

  // Load approved (non-archived) recipes for this skill's umbrella.
  // Recipes are admin-authored or admin-approved markdown — same trust level as the directive.
  // They must never contain PHI; they are prepended to the user prompt as reference material.
  const recipes = await listRecipes({ umbrella: skill.umbrella });

  // Map each collector checkId → registry entry → callable tool.
  const collectors = (skill.collectors_json || []).map((checkId) => {
    const reg = getCheck(checkId);
    if (!reg) {
      throw new Error(`skill ${skill.slug} references unknown collector ${checkId}`);
    }
    return {
      checkId,
      umbrella: reg.umbrella,
      tool: async (args = {}) =>
        reg.handler({ ...umbrellaContext, ...args, clientUserId, runId })
    };
  });

  const tools = buildToolsShim(collectors);
  const costTracker = createCostTracker();

  // Build the recipes block to prepend to the user prompt (not the system prompt —
  // the directive remains the system prompt; recipes are reference material).
  const recipesBlock = recipes.length
    ? `Reusable recipes for the ${skill.umbrella} umbrella (apply when relevant):\n\n` +
      recipes.map((r, i) => `### Recipe ${i + 1}: ${r.title}\n${r.recipe_md}`).join('\n\n') +
      '\n\n---\n\n'
    : '';

  // The user message instructs the agent to respond with structured JSON.
  const userPrompt = [
    `You are running a skill audit for client user_id=${clientUserId}.`,
    runId ? `Run ID: ${runId}.` : null,
    '',
    'Use the available collector tools to gather data, then produce your final response as a JSON object with this shape:',
    '',
    '```json',
    '{',
    '  "findings": [{ "check_id": "...", "status": "pass|warn|fail|error", "detail": "..." }],',
    '  "summary": "One-paragraph summary of what you found.",',
    '  "suggestions": [',
    '    {',
    '      "proposed_prompt_md": "...",',
    '      "proposed_collectors": ["check.id"],',
    '      "rationale": "Why this change would improve the skill."',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'suggestions is optional — omit or use [] if you have nothing to suggest.',
    'Do not include any PHI (patient names, contact info, health data) in findings or summary.'
  ]
    .filter((l) => l !== null)
    .join('\n');

  const loopResult = await runSubAgentLoop({
    name: `skill:${skill.slug}`,
    systemPrompt: skill.prompt_md,
    tools,
    prompt: recipesBlock + userPrompt,
    context: null,
    clientUserId,
    userId: null,   // skills run headlessly; no human userId in scope
    costTracker,
    budgetCents: skill.cost_estimate_cents > 0 ? skill.cost_estimate_cents : undefined,
    modelName: modelName || skill.model || undefined  // definition override → skill model → vertexRuntime default
  });

  const parsed = parseAgentOutput(loopResult.text);
  const costSummary = costTracker.summary();

  return {
    skillId: skill.id,
    skillVersion: skill.current_version,
    findings: parsed.findings,
    summary: parsed.summary,
    cost_cents: costSummary.total_cents,
    suggestions: parsed.suggestions
  };
}
