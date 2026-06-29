import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAbstractAction, CATEGORY_ACTION_MAP } from '../recommendations/actionFactory.js';

const g = (cat) => ({ key: `c::${cat}`, clientUserId: 'c', category: cat, affectedPlatforms: ['website'], severity: 'critical', findingIds: ['x'], findings: [] });

test('mapped category → provider-neutral abstract action', () => {
  const a = buildAbstractAction(g('correlation.gtm_missing_with_kinsta_drift'));
  assert.equal(a.abstractActionType, 'website.clear_cache');
  assert.equal(a.mutating, true);
  assert.equal(a.destructive, false);
  assert.equal(a.budgetDeltaCents, 0);
  assert.equal(typeof a.actionArgs, 'object');
});

test('unmapped category → advisory only (null action)', () => {
  const a = buildAbstractAction(g('correlation.unmapped_thing'));
  assert.equal(a.abstractActionType, null);
  assert.equal(a.mutating, false);
  assert.equal(a.destructive, false);
});

test('no abstract action in the map is destructive (phase non-goal)', () => {
  for (const [cat, def] of Object.entries(CATEGORY_ACTION_MAP)) {
    assert.equal(def.destructive, false, `${cat} must not be destructive in this phase`);
  }
});

test('abstract action types are provider-neutral (no vendor prefix)', () => {
  for (const def of Object.values(CATEGORY_ACTION_MAP)) {
    assert.ok(!/^(kinsta|wordpress|google_ads|meta|ctm)\./.test(def.abstractActionType),
      `${def.abstractActionType} leaks a provider name`);
  }
});
