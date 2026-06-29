import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FALSE_POSITIVE_MIN_RECURRENCE,
  STABLE_CONFIG_MIN_DAYS,
  factsFromApprovals,
  factsFromRejections,
  factsFromRepeatedFindings,
  factsFromStableConfigs,
  factsFromManualNotes,
  extractFacts
} from '../memory/clientFactsExtractor.js';

test('constants', () => {
  assert.equal(FALSE_POSITIVE_MIN_RECURRENCE, 3);
  assert.equal(STABLE_CONFIG_MIN_DAYS, 30);
});

test('factsFromApprovals aggregates by tool and scales confidence', () => {
  const facts = factsFromApprovals([
    { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' },
    { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' },
    { tool_name: 'unexecuted', scope: 'paid_ads', approved_at: 't', executed_at: null } // ignored
  ]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].fact_type, 'approved_pattern');
  assert.equal(facts[0].fact_key, 'approved:pause_keyword');
  assert.equal(facts[0].fact_value.count, 2);
  assert.ok(facts[0].confidence > 0.5);
});

test('factsFromRejections emits rejected_pattern', () => {
  const facts = factsFromRejections([{ tool_name: 'raise_budget', scope: 'paid_ads' }]);
  assert.equal(facts[0].fact_type, 'rejected_pattern');
  assert.equal(facts[0].fact_key, 'rejected:raise_budget');
});

test('factsFromRepeatedFindings flags only consistently-dismissed recurring categories', () => {
  const facts = factsFromRepeatedFindings([
    { category: 'gads.spend_spike', occurrences: 4, dismissed_count: 4 }, // false positive
    { category: 'gads.real_issue', occurrences: 5, dismissed_count: 1 },  // genuine, skip
    { category: 'gads.rare', occurrences: 2, dismissed_count: 2 }          // too few, skip
  ]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].fact_key, 'false_positive:gads.spend_spike');
  assert.equal(facts[0].fact_type, 'false_positive');
});

test('factsFromStableConfigs requires the minimum stable days', () => {
  const facts = factsFromStableConfigs([
    { key: 'budget_cents', value: 50000, days_stable: 45, scope: 'paid_ads' },
    { key: 'flaky', value: 1, days_stable: 5, scope: 'paid_ads' }
  ]);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].fact_key, 'stable:budget_cents');
});

test('factsFromManualNotes passes through with manual source', () => {
  const facts = factsFromManualNotes([{ text: 'No weekend changes', scope: 'client' }]);
  assert.equal(facts[0].fact_type, 'manual_note');
  assert.equal(facts[0].source, 'manual');
  assert.equal(facts[0].confidence, 1);
});

test('extractFacts merges all sources and dedupes by key keeping max confidence', () => {
  const facts = extractFacts({
    approvals: [
      { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' },
      { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' },
      { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' }
    ],
    findings: [{ category: 'x', occurrences: 3, dismissed_count: 3 }],
    notes: [{ text: 'hi', scope: 'client' }]
  });
  const keys = facts.map((f) => `${f.scope}|${f.fact_type}|${f.fact_key}`);
  assert.equal(new Set(keys).size, keys.length, 'no duplicate keys');
  assert.ok(facts.some((f) => f.fact_key === 'approved:pause_keyword'));
  assert.ok(facts.some((f) => f.fact_key === 'false_positive:x'));
  assert.ok(facts.some((f) => f.fact_type === 'manual_note'));
});
