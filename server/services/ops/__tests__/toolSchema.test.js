import test from 'node:test';
import assert from 'node:assert/strict';
import { toAnthropicTool } from '../agents/toolSchema.js';

test('translates a Vertex functionDeclaration to an Anthropic tool', () => {
  const decl = {
    name: 'load_run',
    description: 'Fetch one ops_run.',
    parameters: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] }
  };
  const tool = toAnthropicTool(decl);
  assert.equal(tool.name, 'load_run');
  assert.equal(tool.description, 'Fetch one ops_run.');
  assert.deepEqual(tool.input_schema, decl.parameters);
  assert.ok(!('parameters' in tool));
  assert.ok(!('strict' in tool)); // existing schemas have optional props; strict would 400
});

test('defaults input_schema to an empty object schema when parameters missing', () => {
  const tool = toAnthropicTool({ name: 'noargs', description: 'x' });
  assert.deepEqual(tool.input_schema, { type: 'object', properties: {} });
});
