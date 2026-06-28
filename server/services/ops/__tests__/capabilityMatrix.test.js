import test from 'node:test';
import assert from 'node:assert/strict';
import { USABLE_CONNECTION_STATUSES, availableCapabilities, evaluateGate } from '../connections/capabilityMatrix.js';

const conn = (status, capabilities) => ({ status, capabilities });

test('usable statuses are exactly verified + degraded', () => {
  assert.deepEqual([...USABLE_CONNECTION_STATUSES].sort(), ['degraded', 'verified']);
});

test('availableCapabilities unions only usable connections', () => {
  const caps = availableCapabilities([
    conn('verified', ['read', 'crawl']),
    conn('degraded', ['list_pages']),
    conn('failed', ['publish']),       // ignored
    conn('configured', ['mutate'])     // ignored
  ]);
  assert.deepEqual([...caps].sort(), ['crawl', 'list_pages', 'read']);
});

test('empty requiredCapabilities is always satisfied (legacy/un-gated)', () => {
  const g = evaluateGate([], []);
  assert.equal(g.satisfied, true);
  assert.deepEqual(g.missing, []);
});

test('gate satisfied when every required capability is available', () => {
  const g = evaluateGate(['read', 'crawl'], [conn('verified', ['read', 'crawl', 'inspect_html'])]);
  assert.equal(g.satisfied, true);
  assert.deepEqual(g.missing, []);
});

test('gate reports the missing capabilities and is not satisfied', () => {
  const g = evaluateGate(['read', 'publish'], [conn('verified', ['read'])]);
  assert.equal(g.satisfied, false);
  assert.deepEqual(g.missing, ['publish']);
});

test('a failed connection does not satisfy the gate', () => {
  const g = evaluateGate(['read'], [conn('failed', ['read'])]);
  assert.equal(g.satisfied, false);
  assert.deepEqual(g.missing, ['read']);
});

test('no connections at all → all required are missing', () => {
  const g = evaluateGate(['read'], []);
  assert.equal(g.satisfied, false);
  assert.deepEqual(g.missing, ['read']);
});
