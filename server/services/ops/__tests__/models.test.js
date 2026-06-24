import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveChatModel, priceFor, DEFAULT_CHAT_MODEL } from '../agents/models.js';

test('resolveChatModel returns the default for null/unknown', () => {
  assert.equal(resolveChatModel(null), DEFAULT_CHAT_MODEL);
  assert.equal(resolveChatModel('gpt-4'), DEFAULT_CHAT_MODEL);
});

test('resolveChatModel accepts allowlisted Claude models', () => {
  assert.equal(resolveChatModel('claude-opus-4-8'), 'claude-opus-4-8');
  assert.equal(resolveChatModel('claude-haiku-4-5'), 'claude-haiku-4-5');
});

test('priceFor returns per-1K input/output rates', () => {
  const p = priceFor('claude-sonnet-4-6');
  assert.equal(p.inPer1k, 0.003);
  assert.equal(p.outPer1k, 0.015);
});
