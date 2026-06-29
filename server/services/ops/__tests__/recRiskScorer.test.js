import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreRisk, tierFromScore } from '../recommendations/riskScorer.js';

test('tierFromScore thresholds', () => {
  assert.equal(tierFromScore(90), 'critical');
  assert.equal(tierFromScore(85), 'critical');
  assert.equal(tierFromScore(60), 'high');
  assert.equal(tierFromScore(30), 'medium');
  assert.equal(tierFromScore(29.99), 'low');
  assert.equal(tierFromScore(0), 'low');
});

test('critical finding, single platform, no extras → high tier baseline', () => {
  const r = scoreRisk({ severity: 'critical' }, {});
  assert.equal(r.score, 100);
  assert.equal(r.tier, 'critical');
  assert.equal(r.factors.severityWeight, 100);
});

test('info finding scores low', () => {
  const r = scoreRisk({ severity: 'info' }, {});
  assert.equal(r.tier, 'low');
});

test('multi-platform + business impact raise the score', () => {
  const base = scoreRisk({ severity: 'warning' }, {});
  const more = scoreRisk({ severity: 'warning', affectedPlatformCount: 3, businessImpact: true }, {});
  assert.ok(more.score > base.score);
});

test('baselineDelta (sigma above normal) raises the score; null is neutral', () => {
  const neutral = scoreRisk({ severity: 'warning', baselineDelta: null }, {});
  const anomalous = scoreRisk({ severity: 'warning', baselineDelta: 3 }, {});
  assert.ok(anomalous.score > neutral.score);
});

test('budget increase raises the score', () => {
  const base = scoreRisk({ severity: 'info' }, {});
  const budget = scoreRisk({ severity: 'info' }, { budgetDeltaCents: 5000 });
  assert.ok(budget.score > base.score);
});

test('destructive action forces critical tier regardless of score', () => {
  const r = scoreRisk({ severity: 'info' }, { destructive: true });
  assert.equal(r.tier, 'critical');
  assert.equal(r.factors.destructive, true);
});

test('medical client bumps the tier up exactly one level', () => {
  const normal = scoreRisk({ severity: 'warning' }, { clientType: 'standard' });
  const medical = scoreRisk({ severity: 'warning' }, { clientType: 'medical' });
  const order = ['low', 'medium', 'high', 'critical'];
  assert.ok(order.indexOf(medical.tier) === Math.min(order.length - 1, order.indexOf(normal.tier) + 1));
});

test('medical bump never echoes client_type in factors', () => {
  const r = scoreRisk({ severity: 'warning' }, { clientType: 'medical' });
  assert.ok(!JSON.stringify(r).includes('medical'));
});
