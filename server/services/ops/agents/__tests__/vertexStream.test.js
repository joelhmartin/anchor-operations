import test from 'node:test';
import assert from 'node:assert/strict';
import { runToolLoopStream } from '../vertexRuntime.js';

// Fake Vertex model: hop 1 streams two text deltas + a functionCall; hop 2 streams final text.
function fakeModel() {
  let hop = 0;
  return {
    generateContentStream() {
      hop += 1;
      if (hop === 1) {
        return {
          stream: (async function* () {
            yield { candidates: [{ content: { parts: [{ text: 'Hel' }] } }] };
            yield { candidates: [{ content: { parts: [{ text: 'lo ' }] } }] };
            yield { candidates: [{ content: { parts: [{ functionCall: { name: 'ping', args: { x: 1 } } }] } }] };
          })(),
          response: Promise.resolve({
            candidates: [{ content: { parts: [{ text: 'Hello ' }, { functionCall: { name: 'ping', args: { x: 1 } } }] } }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3 }
          })
        };
      }
      return {
        stream: (async function* () {
          yield { candidates: [{ content: { parts: [{ text: 'done.' }] } }] };
        })(),
        response: Promise.resolve({
          candidates: [{ content: { parts: [{ text: 'done.' }] } }],
          usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 2 }
        })
      };
    }
  };
}

test('runToolLoopStream emits text deltas, runs the tool, and finishes', async () => {
  const events = [];
  const toolCalls = [];
  const out = await runToolLoopStream({
    modelName: 'gemini-2.5-flash',
    messages: [{ role: 'user', parts: [{ text: 'hi' }] }],
    systemInstruction: { role: 'system', parts: [{ text: 'sys' }] },
    toolDeclarations: [{ name: 'ping', description: 'p', parameters: { type: 'object', properties: {} } }],
    runTool: async (name, args) => { toolCalls.push({ name, args }); return { ok: true }; },
    costTracker: { add() {} },
    onEvent: (e) => events.push(e),
    __modelForTest: fakeModel()
  });
  const textDeltas = events.filter((e) => e.type === 'text').map((e) => e.text).join('');
  assert.ok(textDeltas.includes('Hello'));
  assert.ok(textDeltas.includes('done.'));
  assert.deepEqual(toolCalls, [{ name: 'ping', args: { x: 1 } }]);
  assert.ok(events.some((e) => e.type === 'tool_use' && e.name === 'ping'));
  assert.ok(events.some((e) => e.type === 'tool_result'));
  assert.equal(out.text, 'done.');
});
