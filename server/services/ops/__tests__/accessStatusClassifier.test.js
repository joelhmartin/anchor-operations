import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyService, rollupStatus, summarize } from '../access/statusClassifier.js';

test('classifyService maps each status to a color', () => {
  assert.equal(classifyService('verified'), 'green');
  assert.equal(classifyService('degraded'), 'yellow');
  assert.equal(classifyService('missing'), 'yellow');
  assert.equal(classifyService('failed'), 'red');
  assert.equal(classifyService('error'), 'red');
  assert.equal(classifyService('skipped'), 'gray');
  assert.equal(classifyService('something-unknown'), 'gray');
});

test('rollupStatus: any red → failed', () => {
  assert.equal(rollupStatus(['verified', 'degraded', 'failed']), 'failed');
});

test('rollupStatus: yellow but no red → degraded', () => {
  assert.equal(rollupStatus(['verified', 'missing']), 'degraded');
});

test('rollupStatus: all green → verified', () => {
  assert.equal(rollupStatus(['verified', 'verified']), 'verified');
});

test('summarize counts colors', () => {
  assert.deepEqual(summarize(['verified', 'verified', 'missing', 'failed', 'skipped']), { green: 2, yellow: 1, red: 1, gray: 1 });
});
