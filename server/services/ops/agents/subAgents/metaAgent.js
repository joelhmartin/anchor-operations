/**
 * Meta sub-agent — Phase 7 (read-only, HIPAA-gated).
 *
 * Compliance: Meta does NOT sign HIPAA Business Associate Agreements. Per the
 * trackingRelay gate and the Phase 5 _hipaaGate helper, Meta tooling MUST be
 * inaccessible for medical clients. The HIPAA refusal message NEVER reveals
 * that the client is medical — phrasing is neutral ("Meta tooling is not
 * available for this client") so the user does not infer PHI from the agent's
 * behavior.
 *
 * Mutations are deferred — same posture as Google Ads in v1 (P5).
 */

import { runSubAgentLoop } from './_runner.js';
import { getAdAccountClient } from '../../checks/meta/_client.js';
import { assertNonMedical } from '../../checks/meta/_hipaaGate.js';

const SYSTEM_PROMPT = `You are the **Meta** sub-agent for the Anchor Operations console. Read-only in v1. Tools include Graph reads and pixel test events.

## Hard rules
1. Read-only. You cannot mutate anything on Meta in v1.
2. If the gate refuses to engage, return the refusal verbatim — do not speculate about why or about the client's profile.
3. Quote pixel ids and ad account ids exactly. Cite Graph paths you queried.
4. Concise output. No throat-clearing.`;

const REFUSAL_MESSAGE = 'Meta tooling is not available for this client.';

async function gateEngagement(ctx) {
  const gate = await assertNonMedical({ clientUserId: ctx.clientUserId });
  if (gate.skipped) {
    // Neutral refusal — never reveal client_type to the model output.
    return { blocked: true, message: REFUSAL_MESSAGE };
  }
  return { blocked: false };
}

const meta_query = {
  declaration: {
    name: 'meta_query',
    description: 'Run a Graph API GET against the picked client\'s Meta ad account. The endpoint is prefixed with the resolved act_<id>; pass relative subpaths.',
    parameters: {
      type: 'object',
      properties: {
        endpoint: {
          type: 'string',
          description:
            'Graph relative path. Either starts with act_<id>/... or a leading / for absolute graph paths the agent already knows.'
        },
        params: { type: 'object', description: 'Query string params, optional' }
      },
      required: ['endpoint']
    }
  },
  mutating: false,
  async handler(args, ctx) {
    const gate = await gateEngagement(ctx);
    if (gate.blocked) return { skipped: true, reason: gate.message };
    const adapter = await getAdAccountClient({ clientUserId: ctx.clientUserId });
    if (!adapter.ok) return { skipped: true, reason: adapter.reason };
    const endpoint = String(args.endpoint || '').replace(/^\/+/, '');
    if (!endpoint) return { error: 'endpoint required' };
    const params = args.params && typeof args.params === 'object' ? args.params : {};
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const path = qs ? `${endpoint}?${qs}` : endpoint;
    try {
      const result = await adapter.graph(path);
      // Bound the response so we don't blow context.
      const json = JSON.stringify(result);
      if (json.length > 12000) {
        return { truncated: true, preview: json.slice(0, 12000) };
      }
      return result;
    } catch (err) {
      return { error: err.message || 'Graph fetch failed' };
    }
  }
};

const meta_pixel_test_event = {
  declaration: {
    name: 'meta_pixel_test_event',
    description:
      'Inspect recent pixel test events for the client. Returns the latest event_diagnostics payload from Graph for one pixel.',
    parameters: {
      type: 'object',
      properties: {
        pixel_id: { type: 'string' },
        event_name: { type: 'string', description: 'Optional filter, e.g. "Lead"' }
      },
      required: ['pixel_id']
    }
  },
  mutating: false,
  async handler(args, ctx) {
    const gate = await gateEngagement(ctx);
    if (gate.blocked) return { skipped: true, reason: gate.message };
    const adapter = await getAdAccountClient({ clientUserId: ctx.clientUserId });
    if (!adapter.ok) return { skipped: true, reason: adapter.reason };
    const pixelId = String(args.pixel_id || '').trim();
    if (!/^\d+$/.test(pixelId)) return { error: 'pixel_id must be numeric' };
    try {
      const stats = await adapter.graph(
        `${pixelId}/stats?aggregation=event&start_time=${Math.floor(Date.now() / 1000) - 86400}`
      );
      let filtered = stats;
      if (args.event_name && stats?.data) {
        filtered = { ...stats, data: stats.data.filter((d) => d.event === args.event_name) };
      }
      return { pixel_id: pixelId, stats: filtered };
    } catch (err) {
      return { error: err.message || 'Graph fetch failed' };
    }
  }
};

const TOOLS = { meta_query, meta_pixel_test_event };

const tools = {
  list() {
    return Object.values(TOOLS).map((t) => t.declaration);
  },
  get(name) {
    return TOOLS[name] || null;
  }
};

export default {
  name: 'meta',
  systemPrompt: SYSTEM_PROMPT,
  getTool(name) {
    return tools.get(name);
  },
  listTools() {
    return tools.list();
  },
  async run(params) {
    // Gate at agent entry. If the gate refuses, return the neutral refusal as
    // a no-cost final result without constructing a Vertex call.
    const gate = await gateEngagement({ clientUserId: params.clientUserId });
    if (gate.blocked) {
      return {
        subagent: 'meta',
        status: 'final',
        text: gate.message,
        toolCalls: [],
        costSummary: { total_cents: 0, total_dollars: 0, total_tokens: 0, prompt_tokens: 0, completion_tokens: 0, entries: [] }
      };
    }
    return runSubAgentLoop({
      name: 'meta',
      systemPrompt: SYSTEM_PROMPT,
      tools,
      ...params
    });
  }
};
