import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRunModel } from '../models.js';

test('resolveRunModel passes through a valid id, nulls unknown/empty', () => {
  assert.equal(resolveRunModel('gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(resolveRunModel('claude-haiku-4-5'), 'claude-haiku-4-5');
  assert.equal(resolveRunModel('bogus'), null);
  assert.equal(resolveRunModel(null), null);
  assert.equal(resolveRunModel(''), null);
});
