import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../googleChat/commandParser.js';

test('parses /anchorops help', () => {
  assert.deepEqual(parseCommand('/anchorops help'), { command: 'help', args: [] });
});

test('parses @AnchorOps daily', () => {
  assert.deepEqual(parseCommand('@AnchorOps daily'), { command: 'daily', args: [] });
});

test('parses bare command in DM context', () => {
  assert.deepEqual(parseCommand('clients'), { command: 'clients', args: [] });
});

test('parses /anchorops client with multi-word name', () => {
  assert.deepEqual(parseCommand('/anchorops client ACME Corp'), { command: 'client', args: ['ACME Corp'] });
});

test('parses /anchorops run with name', () => {
  assert.deepEqual(parseCommand('/anchorops run Weekly Deep'), { command: 'run', args: ['Weekly Deep'] });
});

test('parses /anchorops issues with client name', () => {
  assert.deepEqual(parseCommand('/anchorops issues Beta Inc'), { command: 'issues', args: ['Beta Inc'] });
});

test('parses /anchorops approvals', () => {
  assert.deepEqual(parseCommand('/anchorops approvals'), { command: 'approvals', args: [] });
});

test('parses /anchorops approve <id>', () => {
  assert.deepEqual(parseCommand('/anchorops approve ar-abc-123'), { command: 'approve', args: ['ar-abc-123'] });
});

test('parses /anchorops reject <id>', () => {
  assert.deepEqual(parseCommand('/anchorops reject ar-xyz-999'), { command: 'reject', args: ['ar-xyz-999'] });
});

test('parses /anchorops connect', () => {
  assert.deepEqual(parseCommand('/anchorops connect'), { command: 'connect', args: [] });
});

test('parses /anchorops audit', () => {
  assert.deepEqual(parseCommand('/anchorops audit'), { command: 'audit', args: [] });
});

test('unknown text returns unknown command', () => {
  const r = parseCommand('do something weird');
  assert.equal(r.command, 'unknown');
  assert.equal(r.raw, 'do something weird');
});

test('empty / whitespace-only input returns unknown', () => {
  assert.equal(parseCommand('   ').command, 'unknown');
});

test('extra whitespace normalized', () => {
  assert.deepEqual(parseCommand('  /anchorops   help  '), { command: 'help', args: [] });
});
