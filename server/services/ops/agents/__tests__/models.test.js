import test from 'node:test';
import assert from 'node:assert/strict';
import { MODELS, DEFAULT_CHAT_MODEL, providerOf, resolveChatModel, CLAUDE_MODELS, priceFor } from '../models.js';

test('registry has both providers and a Google default', () => {
  assert.equal(providerOf('gemini-2.5-flash'), 'google');
  assert.equal(providerOf('claude-sonnet-4-6'), 'anthropic');
  assert.equal(providerOf('nope'), null);
  assert.equal(MODELS[DEFAULT_CHAT_MODEL].provider, 'google');
});

test('resolveChatModel accepts known ids across providers, falls back to default', () => {
  assert.equal(resolveChatModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(resolveChatModel('gemini-2.5-flash'), 'gemini-2.5-flash');
  assert.equal(resolveChatModel('bogus'), DEFAULT_CHAT_MODEL);
  assert.equal(resolveChatModel(null), DEFAULT_CHAT_MODEL);
});

test('CLAUDE_MODELS back-compat view contains only anthropic models', () => {
  for (const id of Object.keys(CLAUDE_MODELS)) assert.equal(providerOf(id), 'anthropic');
});

test('priceFor returns per-1k rates for known + default-fallback', () => {
  const p = priceFor('claude-sonnet-4-6');
  assert.equal(typeof p.inPer1k, 'number');
  assert.equal(typeof p.outPer1k, 'number');
  const d = priceFor('bogus'); // falls back to default model's pricing
  assert.equal(typeof d.inPer1k, 'number');
  assert.equal(typeof d.outPer1k, 'number');
});
