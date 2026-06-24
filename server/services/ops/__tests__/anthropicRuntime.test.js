// server/services/ops/__tests__/anthropicRuntime.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
process.env.ANTHROPIC_API_KEY = 'test-key';
const { runClaudeToolLoop } = await import('../agents/anthropicRuntime.js');

// Minimal fake of client.messages.stream(): returns an object whose
// finalMessage() resolves to a scripted assistant message. Each call to
// stream() pops the next scripted turn.
function fakeClient(turns) {
  let i = 0;
  return {
    messages: {
      stream() {
        const msg = turns[i++];
        return {
          async *[Symbol.asyncIterator]() { /* no deltas needed for this test */ },
          on() { return this; },
          finalMessage: async () => msg
        };
      }
    }
  };
}

function tracker() { let c = 0; return { add({ dollars = 0 }) { c += dollars; }, totalCents: () => Math.ceil(c * 100), summary: () => ({ total_cents: Math.ceil(c * 100) }) }; }

test('returns final text when the model stops with end_turn', async () => {
  const client = fakeClient([
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'All good.' }], usage: { input_tokens: 10, output_tokens: 5 } }
  ]);
  const out = await runClaudeToolLoop({
    modelId: 'claude-haiku-4-5', system: 'sys', messages: [{ role: 'user', content: 'hi' }],
    tools: [], runTool: async () => ({ result: {} }), costTracker: tracker(), __clientForTest: client
  });
  assert.equal(out.status, 'final');
  assert.equal(out.text, 'All good.');
});

test('executes a read-only tool then finishes', async () => {
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_1', name: 'load_run', input: { runId: 'r1' } }], usage: { input_tokens: 8, output_tokens: 4 } },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Run r1 looks healthy.' }], usage: { input_tokens: 12, output_tokens: 6 } }
  ]);
  let called = null;
  const out = await runClaudeToolLoop({
    modelId: 'claude-haiku-4-5', system: 'sys', messages: [{ role: 'user', content: 'check r1' }],
    tools: [{ name: 'load_run', description: 'x', input_schema: { type: 'object', properties: {} } }],
    runTool: async (name, args) => { called = { name, args }; return { result: { ok: true } }; },
    costTracker: tracker(), __clientForTest: client
  });
  assert.deepEqual(called, { name: 'load_run', args: { runId: 'r1' } });
  assert.equal(out.status, 'final');
  assert.equal(out.text, 'Run r1 looks healthy.');
});

test('pauses on an approval-gated tool', async () => {
  const client = fakeClient([
    { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_2', name: 'propose_action', input: { tool: 'plugin_update' } }], usage: { input_tokens: 8, output_tokens: 4 } }
  ]);
  const out = await runClaudeToolLoop({
    modelId: 'claude-haiku-4-5', system: 'sys', messages: [{ role: 'user', content: 'update plugin' }],
    tools: [{ name: 'propose_action', description: 'x', input_schema: { type: 'object', properties: {} } }],
    runTool: async () => ({ __awaiting_approval: true, approval_id: 'a1' }),
    costTracker: tracker(), __clientForTest: client
  });
  assert.equal(out.status, 'awaiting_approval');
  assert.equal(out.proposedTool.name, 'propose_action');
});
