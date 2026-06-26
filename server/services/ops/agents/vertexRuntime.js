/**
 * Shared Vertex runtime for the supervisor + sub-agents (Phase 7).
 *
 * Why a shared runtime:
 *   - Vertex client construction (Compute auth on Cloud Run, scoped creds in
 *     dev) is identical across the supervisor and every sub-agent.
 *   - Safety thresholds were locked in Phase 0 (BLOCK_MEDIUM_AND_ABOVE across
 *     four categories). One copy keeps that gate auditable.
 *   - Per-turn cost tracking ($0.50 cap, plan §9.3) needs a single integration
 *     point so every model call accrues automatically.
 *
 * The module exposes a small API:
 *   ensureVertex()                 → cached VertexAI instance
 *   getModel(name, tools, system)  → a model bound to function declarations
 *   runToolLoop({ ... })           → drives a function-calling loop until the
 *                                    model produces a final text response, a
 *                                    mutating tool needs approval, the per-
 *                                    turn budget is exhausted, or MAX_HOPS hits
 *
 * The loop is deliberately stateless — the caller passes in `messages` and
 * gets the updated `messages` back, mirroring the legacy opsAssistant pattern
 * and letting the supervisor re-enter mid-turn after an approval.
 */

import { VertexAI } from '@google-cloud/vertexai';
import { Compute } from 'google-auth-library';

const DEFAULT_MODEL = process.env.OPERATIONS_AGENT_MODEL || process.env.VERTEX_MODEL || 'gemini-2.5-flash';
const DEFAULT_LOCATION = process.env.GOOGLE_CLOUD_REGION || process.env.VERTEX_LOCATION || 'us-central1';
const VERTEX_SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

// Phase 0 — locked safety thresholds. Do not weaken without compliance review.
export const SAFETY_SETTINGS = [
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_MEDIUM_AND_ABOVE' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_MEDIUM_AND_ABOVE' }
];

// Per-turn budget ceiling for the supervisor + sub-agents combined. Plan §9.3.
// Cents to keep arithmetic precise.
export const PER_TURN_BUDGET_CENTS = 50;

// Vertex Gemini 2.5 Flash list price (snapshot 2026-05). Used to convert token
// counts → dollars when the API does not return a usage cost. Adjust if Vertex
// changes pricing — these are advisory caps, not invoiced amounts.
const PRICE_PROMPT_PER_1K = Number(process.env.OPS_VERTEX_PROMPT_USD_PER_1K) || 0.000075;
const PRICE_OUTPUT_PER_1K = Number(process.env.OPS_VERTEX_OUTPUT_USD_PER_1K) || 0.0003;

const MAX_TOOL_HOPS = 8;

let cachedVertex = null;

function isCloudRunRuntime() {
  return Boolean(process.env.K_SERVICE || process.env.K_REVISION);
}

export function ensureVertex() {
  if (cachedVertex) return cachedVertex;
  const project = process.env.GOOGLE_CLOUD_PROJECT || process.env.VERTEX_PROJECT_ID;
  if (!project) throw new Error('Vertex AI not configured (GOOGLE_CLOUD_PROJECT missing)');
  const googleAuthOptions = isCloudRunRuntime()
    ? { authClient: new Compute({ serviceAccountEmail: 'default', scopes: VERTEX_SCOPES }) }
    : { scopes: VERTEX_SCOPES };
  if (!isCloudRunRuntime() && process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    googleAuthOptions.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  cachedVertex = new VertexAI({ project, location: DEFAULT_LOCATION, googleAuthOptions });
  return cachedVertex;
}

function getModel({ modelName = DEFAULT_MODEL, toolDeclarations = [] } = {}) {
  const v = ensureVertex();
  const factory =
    typeof v.preview?.getGenerativeModel === 'function'
      ? v.preview.getGenerativeModel.bind(v.preview)
      : v.getGenerativeModel.bind(v);
  return factory({
    model: modelName,
    tools: toolDeclarations.length ? [{ functionDeclarations: toolDeclarations }] : undefined
  });
}

function tokensToDollars({ promptTokens = 0, completionTokens = 0 } = {}) {
  return (
    (Number(promptTokens) / 1000) * PRICE_PROMPT_PER_1K +
    (Number(completionTokens) / 1000) * PRICE_OUTPUT_PER_1K
  );
}

function readUsage(response) {
  const usage = response?.response?.usageMetadata || response?.usageMetadata || null;
  if (!usage) return { promptTokens: 0, completionTokens: 0 };
  return {
    promptTokens: usage.promptTokenCount || usage.prompt_token_count || 0,
    completionTokens: usage.candidatesTokenCount || usage.candidates_token_count || 0
  };
}

/**
 * Run a function-calling loop until the model produces a final text response,
 * proposes a mutating tool (caller must handle approval), or the budget caps.
 *
 * @param {Object}   p
 * @param {string}   p.modelName
 * @param {Array}    p.messages           Vertex Content[] — mutated in place; also returned
 * @param {Object}   p.systemInstruction  { role:'system', parts:[{ text }] }
 * @param {Array}    p.toolDeclarations   Vertex function declarations
 * @param {Function} p.runTool            async (name, args) => { result, mutating }
 *                                        - if mutating: caller wants to pause; runTool returns
 *                                          { __awaiting_approval: true, args } and the loop ends
 * @param {Object}   p.costTracker        Phase 2 cost tracker (createCostTracker())
 * @param {number}   [p.maxHops]          Default MAX_TOOL_HOPS
 * @param {number}   [p.budgetCents]      Default PER_TURN_BUDGET_CENTS
 * @returns {Promise<{ status, text?, awaitingApproval?, hopsUsed }>}
 */
export async function runToolLoop({
  modelName = DEFAULT_MODEL,
  messages,
  systemInstruction,
  toolDeclarations,
  runTool,
  costTracker,
  maxHops = MAX_TOOL_HOPS,
  budgetCents = PER_TURN_BUDGET_CENTS
}) {
  const model = getModel({ modelName, toolDeclarations });

  for (let hop = 0; hop < maxHops; hop += 1) {
    if (costTracker.totalCents() >= budgetCents) {
      return {
        status: 'budget_exhausted',
        text: "I've hit my per-turn budget — please ask a more focused question or split this into multiple turns.",
        hopsUsed: hop
      };
    }

    let result;
    try {
      result = await model.generateContent({
        contents: messages,
        systemInstruction,
        generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
        safetySettings: SAFETY_SETTINGS
      });
    } catch (err) {
      return {
        status: 'model_error',
        text: `Model call failed: ${err.message || err}`,
        hopsUsed: hop
      };
    }

    const usage = readUsage(result);
    costTracker.add({
      tokens: (usage.promptTokens || 0) + (usage.completionTokens || 0),
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      dollars: tokensToDollars(usage),
      source: `vertex:${modelName}`
    });

    const candidate = result?.response?.candidates?.[0];
    const parts = candidate?.content?.parts || [];

    if (!parts.length) {
      return { status: 'empty', text: '', hopsUsed: hop + 1 };
    }

    messages.push({ role: 'model', parts });

    const fnCall = parts.find((p) => p.functionCall)?.functionCall;
    if (!fnCall) {
      const text = parts.map((p) => p.text || '').join('').trim();
      return { status: 'final', text, hopsUsed: hop + 1 };
    }

    let toolOutcome;
    try {
      toolOutcome = await runTool(fnCall.name, fnCall.args || {});
    } catch (err) {
      toolOutcome = { result: { error: err.message || 'Tool error' } };
    }

    if (toolOutcome?.__awaiting_approval) {
      return {
        status: 'awaiting_approval',
        proposedTool: { name: fnCall.name, args: fnCall.args || {}, ...toolOutcome },
        hopsUsed: hop + 1
      };
    }

    messages.push({
      role: 'tool',
      parts: [{ functionResponse: { name: fnCall.name, response: toolOutcome.result || toolOutcome } }]
    });
  }

  return { status: 'tool_loop_exhausted', text: 'Tool loop exceeded maximum hops', hopsUsed: maxHops };
}

/**
 * Streaming variant of runToolLoop for the Gemini chat path.
 *
 * Mirrors runToolLoop exactly for cost accounting, budget guard, safety
 * thresholds, and message format — only the model call changes to
 * generateContentStream so the caller can receive token deltas via onEvent.
 *
 * @param {Object}   p
 * @param {string}   [p.modelName]
 * @param {Array}    p.messages           Vertex Content[] (not mutated — convo copy is returned)
 * @param {Object}   p.systemInstruction  { role:'system', parts:[{ text }] }
 * @param {Array}    p.toolDeclarations   Vertex function declarations
 * @param {Function} p.runTool            async (name, args) => result
 * @param {Object}   p.costTracker        Phase 2 cost tracker (createCostTracker())
 * @param {number}   [p.maxHops]          Default MAX_TOOL_HOPS
 * @param {number}   [p.budgetCents]      Default PER_TURN_BUDGET_CENTS
 * @param {Function} [p.onEvent]          ({ type, ... }) → void. Defaults to no-op.
 *                                        type='text'        → { text }  (delta)
 *                                        type='tool_use'    → { id, name, args }
 *                                        type='tool_result' → { id, result }
 *                                        type='cost'        → { promptTokens, completionTokens, dollars, source }
 * @param {Object}   [p.__modelForTest]   Injected fake model for unit tests (skips Vertex init)
 * @returns {Promise<{ text, messages, usage }>}
 */
export async function runToolLoopStream({
  modelName = DEFAULT_MODEL,
  messages,
  systemInstruction,
  toolDeclarations,
  runTool,
  costTracker,
  maxHops = MAX_TOOL_HOPS,
  budgetCents = PER_TURN_BUDGET_CENTS,
  onEvent = () => {},
  __modelForTest = null
}) {
  const model = __modelForTest || getModel({ modelName, toolDeclarations });
  const convo = [...messages];
  let finalText = '';

  for (let hop = 0; hop < maxHops; hop += 1) {
    // Budget guard — mirrors runToolLoop's costTracker.totalCents() check
    if (costTracker?.totalCents?.() >= budgetCents) {
      return {
        text: "I've hit my per-turn budget — please ask a more focused question or split this into multiple turns.",
        messages: convo,
        usage: {}
      };
    }

    let stream, response;
    try {
      ({ stream, response } = await model.generateContentStream({
        contents: convo,
        systemInstruction,
        generationConfig: { temperature: 0.2, maxOutputTokens: 1500 },
        safetySettings: SAFETY_SETTINGS
      }));
    } catch (err) {
      return { text: `Model call failed: ${err.message || err}`, messages: convo, usage: {} };
    }

    // Emit text deltas from the stream as they arrive
    for await (const chunk of stream) {
      const chunkParts = chunk?.candidates?.[0]?.content?.parts || [];
      for (const p of chunkParts) {
        if (typeof p.text === 'string' && p.text) {
          onEvent({ type: 'text', text: p.text });
        }
      }
    }

    // Await the authoritative full response — functionCalls live here
    const full = await response;
    const parts = full?.candidates?.[0]?.content?.parts || [];

    // Cost accounting — mirrors runToolLoop's costTracker.add(...) shape exactly
    const usage = readUsage(full);
    if (costTracker?.add) {
      costTracker.add({
        tokens: (usage.promptTokens || 0) + (usage.completionTokens || 0),
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        dollars: tokensToDollars(usage),
        source: `vertex:${modelName}`
      });
    }
    onEvent({
      type: 'cost',
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      dollars: tokensToDollars(usage),
      source: `vertex:${modelName}`
    });

    if (!parts.length) {
      return { text: finalText, messages: convo, usage: {} };
    }

    // Record the model turn — mirrors runToolLoop's { role:'model', parts }
    convo.push({ role: 'model', parts });

    // Collect all functionCalls from the authoritative full response
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);

    if (!calls.length) {
      finalText = parts.map((p) => p.text || '').join('').trim();
      break;
    }

    // Run each tool and collect responses — mirrors runToolLoop's role:'tool' message
    const responseParts = [];
    for (const call of calls) {
      onEvent({ type: 'tool_use', id: `${call.name}-${hop}`, name: call.name, args: call.args || {} });
      let result;
      try {
        result = await runTool(call.name, call.args || {});
      } catch (err) {
        result = { error: String(err?.message || err) };
      }
      onEvent({ type: 'tool_result', id: `${call.name}-${hop}`, result });
      responseParts.push({ functionResponse: { name: call.name, response: result } });
    }
    // role:'tool' mirrors how runToolLoop appends function responses
    convo.push({ role: 'tool', parts: responseParts });
  }

  return { text: finalText, messages: convo, usage: {} };
}

/**
 * Liveness probe for the Ops supervisor's Vertex path. Minimal generation,
 * no tools, no cost tracker. Returns { ok, model }. Throws on transport/auth/model error.
 */
export async function pingVertex() {
  const v = ensureVertex();
  const factory =
    typeof v.preview?.getGenerativeModel === 'function'
      ? v.preview.getGenerativeModel.bind(v.preview)
      : v.getGenerativeModel.bind(v);
  const model = factory({ model: DEFAULT_MODEL });
  // Budget must cover the model's internal "thinking" tokens (gemini-2.5-flash is a
  // thinking model) PLUS the visible reply, or the response comes back empty with
  // finishReason=MAX_TOKENS — which would falsely flag the supervisor as down.
  const res = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }],
    generationConfig: { maxOutputTokens: 256, temperature: 0 }
  });
  const candidate = res?.response?.candidates?.[0];
  const text = candidate?.content?.parts?.map((p) => p.text || '').join('').trim();
  // Liveness: the model is healthy if it returned visible text OR completed normally
  // (finishReason STOP). A 404/auth/transport failure throws before reaching here.
  const ok = Boolean(text) || candidate?.finishReason === 'STOP';
  return { ok, model: DEFAULT_MODEL };
}
