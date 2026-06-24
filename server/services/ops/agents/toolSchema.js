// Translate the Vertex functionDeclaration shape used across the ops agents
// into Anthropic's tool schema. The two are nearly identical; `parameters`
// becomes `input_schema`. We intentionally do NOT set `strict: true` — the
// existing declarations carry optional properties without additionalProperties:false.

export function toAnthropicTool(declaration = {}) {
  return {
    name: declaration.name,
    description: declaration.description || '',
    input_schema: declaration.parameters || { type: 'object', properties: {} }
  };
}

export function toAnthropicTools(toolObjs = []) {
  return toolObjs.map((t) => toAnthropicTool(t.declaration || t));
}
