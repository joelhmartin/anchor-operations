import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSummarizePrompt, summarizeGroup } from '../recommendations/summarizeFindings.js';

const group = {
  category: 'correlation.gtm_missing_with_kinsta_drift',
  severity: 'critical',
  affectedPlatforms: ['website', 'google_ads'],
  findings: [{ summary: 'GTM missing from homepage; Kinsta drift detected.' }]
};
const computed = { riskScore: 88.5, riskTier: 'critical', approvalLevel: 'admin_required', baselineDelta: 2 };

test('prompt embeds computed numbers and forbids tool use / inventing numbers', () => {
  const p = buildSummarizePrompt(group, computed);
  assert.ok(p.includes('88.5'));
  assert.ok(p.includes('critical'));
  assert.ok(/do not (invent|compute|call)/i.test(p));
});

test('summarizeGroup trusts our numbers, not the model\'s', async () => {
  const llm = async () => JSON.stringify({
    title: 'Clear cache to restore GTM',
    summary: 'A deploy stripped the tracking snippet; clearing cache republishes it.',
    rationale: 'Drift + GTM-missing correlate.',
    priority: 2,
    riskScore: 1, riskTier: 'low' // model-invented numbers must be ignored
  });
  const out = await summarizeGroup(group, computed, { llm });
  assert.equal(out.title, 'Clear cache to restore GTM');
  assert.equal(out.priority, 2);
  assert.equal(out.riskScore, undefined, 'model numbers are not returned');
  assert.equal(out.riskTier, undefined);
});

test('priority is clamped to an integer 1..1000', async () => {
  const llm = async () => JSON.stringify({ title: 't', summary: 's', rationale: 'r', priority: 99999 });
  const out = await summarizeGroup(group, computed, { llm });
  assert.equal(out.priority, 1000);
  const llm2 = async () => JSON.stringify({ title: 't', summary: 's', rationale: 'r', priority: -5 });
  const out2 = await summarizeGroup(group, computed, { llm: llm2 });
  assert.equal(out2.priority, 1);
});

test('LLM/parse failure → deterministic fallback, never throws', async () => {
  const llm = async () => 'not json at all';
  const out = await summarizeGroup(group, computed, { llm });
  assert.ok(out.title.length > 0);
  assert.ok(out.summary.length > 0);
  assert.equal(typeof out.priority, 'number');
});

test('output is PHI-sanitized', async () => {
  const llm = async () => JSON.stringify({ title: 'Call patient at 555-123-4567', summary: 'email a@b.com', rationale: 'r', priority: 1 });
  const out = await summarizeGroup(group, computed, { llm });
  assert.ok(!/555-123-4567/.test(out.title));
  assert.ok(!/a@b\.com/.test(out.summary));
});
