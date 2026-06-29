import test from 'node:test';
import assert from 'node:assert/strict';
import { groupFindings } from '../recommendations/groupFindings.js';

const f = (over) => ({
  id: over.id, client_user_id: over.c || 'client-1', category: over.cat,
  severity: over.sev || 'info', affected_platforms: over.plat || ['website'],
  summary: over.summary || 's'
});

test('findings with same client+category collapse into one group', () => {
  const groups = groupFindings([
    f({ id: 'a', cat: 'correlation.x', sev: 'warning', plat: ['website'] }),
    f({ id: 'b', cat: 'correlation.x', sev: 'critical', plat: ['google_ads'] })
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].findingIds.sort(), ['a', 'b']);
  assert.equal(groups[0].severity, 'critical', 'group severity is the max');
  assert.deepEqual(groups[0].affectedPlatforms, ['google_ads', 'website']);
});

test('different categories or clients stay separate', () => {
  const groups = groupFindings([
    f({ id: 'a', cat: 'correlation.x' }),
    f({ id: 'b', cat: 'correlation.y' }),
    f({ id: 'c', c: 'client-2', cat: 'correlation.x' })
  ]);
  assert.equal(groups.length, 3);
});

test('groups are sorted highest-severity-first and truncated to maxGroups', () => {
  const groups = groupFindings([
    f({ id: 'a', cat: 'k1', sev: 'info' }),
    f({ id: 'b', cat: 'k2', sev: 'critical' }),
    f({ id: 'c', cat: 'k3', sev: 'warning' })
  ], { maxGroups: 2 });
  assert.equal(groups.length, 2);
  assert.equal(groups[0].severity, 'critical');
  assert.equal(groups[1].severity, 'warning');
});

test('empty input → empty array', () => {
  assert.deepEqual(groupFindings([]), []);
  assert.deepEqual(groupFindings(null), []);
});
