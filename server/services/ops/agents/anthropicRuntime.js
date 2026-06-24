// server/services/ops/agents/anthropicRuntime.js
import Anthropic from '@anthropic-ai/sdk';
import { priceFor } from './models.js';

let cached = null;
export function ensureAnthropic() {
  if (cached) return cached;
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured');
  cached = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return cached;
}

const MAX_OUTPUT_TOKENS = 4096;

function usageDollars(modelId, usage = {}) {
  const p = priceFor(modelId);
  const inTok = (usage.input_tokens || 0)
            + (usage.cache_creation_input_tokens || 0) * 1.25
            + (usage.cache_read_input_tokens || 0) * 0.1;
  const outTok = usage.output_tokens || 0;
  return (inTok / 1000) * p.inPer1k + (outTok / 1000) * p.outPer1k;
}

// Mark cache breakpoints on the system block and the last message block.
function withCaching(system, messages) {
  const sys = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  const msgs = messages.map((m) => ({ ...m }));
  const last = msgs[msgs.length - 1];
  if (last) {
    const raw = Array.isArray(last.content) ? last.content : [{ type: 'text', text: last.content }];
    if (raw.length) {
      const c = raw.map((b) => ({ ...b }));
      c[c.length - 1] = { ...c[c.length - 1], cache_control: { type: 'ephemeral' } };
      msgs[msgs.length - 1] = { ...last, content: c };
    }
  }
  return { sys, msgs };
}

export async function runClaudeToolLoop({
  modelId,
  system,
  messages,
  tools = [],
  runTool,
  costTracker,
  maxHops = 8,
  onEvent = () => {},
  __clientForTest = null
}) {
  const client = __clientForTest || ensureAnthropic();

  for (let hop = 0; hop < maxHops; hop += 1) {
    const { sys, msgs } = withCaching(system, messages);
    const stream = client.messages.stream({
      model: modelId,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: sys,
      messages: msgs,
      tools,
      thinking: { type: 'adaptive', display: 'summarized' }
    });

    // Relay deltas (real SDK emits these; the test fake skips them).
    if (typeof stream.on === 'function') {
      stream.on('text', (delta) => onEvent({ type: 'text', delta }));
      stream.on('thinking', (delta) => onEvent({ type: 'thinking', delta }));
    }

    const message = await stream.finalMessage();
    costTracker.add({
      promptTokens: message.usage?.input_tokens || 0,
      completionTokens: message.usage?.output_tokens || 0,
      dollars: usageDollars(modelId, message.usage),
      source: `anthropic:${modelId}`
    });
    onEvent({ type: 'cost', summary: costTracker.summary() });

    // Persist the assistant turn into the running history (full blocks).
    messages.push({ role: 'assistant', content: message.content });

    if (message.stop_reason !== 'tool_use') {
      const text = (message.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
      return { status: 'final', text, hopsUsed: hop + 1, messages };
    }

    // Execute all tool_use blocks; collect tool_result blocks for one user turn.
    const toolUses = (message.content || []).filter((b) => b.type === 'tool_use');
    const results = [];
    for (const tu of toolUses) {
      onEvent({ type: 'tool_use', name: tu.name, input: tu.input });
      let outcome;
      try {
        outcome = await runTool(tu.name, tu.input || {});
      } catch (err) {
        outcome = { result: { error: err.message || 'Tool error' } };
      }
      if (outcome?.__awaiting_approval) {
        return { status: 'awaiting_approval', proposedTool: { name: tu.name, input: tu.input || {}, ...outcome }, hopsUsed: hop + 1, messages };
      }
      const payload = outcome.result ?? outcome;
      onEvent({ type: 'tool_result', name: tu.name, result: payload });
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(payload) });
    }
    messages.push({ role: 'user', content: results });
  }

  return { status: 'tool_loop_exhausted', text: 'Tool loop exceeded maximum hops.', hopsUsed: maxHops, messages };
}
