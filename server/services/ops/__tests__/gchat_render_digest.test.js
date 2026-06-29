import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderDailyDigestCard,
  renderCriticalAlertCard,
  renderApprovalNeededCard,
  renderActionResultCard
} from '../notifications/renderGoogleChatDigest.js';

test('renderDailyDigestCard: returns cardsV2 array and correct threadKey', () => {
  const { cardsV2, threadKey } = renderDailyDigestCard({
    runId: 'aaa-111',
    clientName: 'ACME Corp',
    runStatus: 'completed',
    tier: 'daily_essential',
    findingCounts: { critical: 2, warning: 5, info: 10 },
    topFindings: [
      { id: 'f1', summary: 'Budget overspend detected', severity: 'critical', category: 'google_ads.budget' }
    ]
  });
  assert.equal(threadKey, 'run-aaa-111');
  assert.ok(Array.isArray(cardsV2) && cardsV2.length > 0, 'cardsV2 is non-empty array');
  const cardText = JSON.stringify(cardsV2);
  assert.ok(cardText.includes('ACME Corp'), 'client name present');
  assert.ok(cardText.includes('2'), 'critical count present');
  assert.ok(cardText.includes('Budget overspend'), 'finding summary present');
  // PII guard: no email-like patterns
  assert.ok(!/@[a-z]+\.[a-z]+/.test(cardText), 'no email addresses');
});

test('renderDailyDigestCard: truncates topFindings to 5', () => {
  const findings = Array.from({ length: 10 }, (_, i) => ({ id: `f${i}`, summary: `Finding ${i}`, severity: 'warning', category: 'ctm.x' }));
  const { cardsV2 } = renderDailyDigestCard({ runId: 'r1', clientName: 'X', runStatus: 'completed', tier: 'weekly_deep', findingCounts: { critical: 0, warning: 10, info: 0 }, topFindings: findings });
  const text = JSON.stringify(cardsV2);
  // Only findings 0-4 should appear; Finding 9 must not
  assert.ok(!text.includes('Finding 9'), 'truncated at 5');
});

test('renderCriticalAlertCard: returns correct threadKey and includes category', () => {
  const { cardsV2, threadKey } = renderCriticalAlertCard({
    findingId: 'fnd-222',
    clientName: 'Beta Inc',
    summary: 'CTR dropped 40%',
    severity: 'critical',
    category: 'google_ads.performance',
    businessImpact: 'Estimated $500/day revenue impact'
  });
  assert.equal(threadKey, 'finding-fnd-222');
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('CTR dropped 40%'), 'summary present');
  assert.ok(text.includes('google_ads.performance'), 'category present');
});

test('renderApprovalNeededCard: approval buttons present with action_id parameter', () => {
  const { cardsV2, threadKey } = renderApprovalNeededCard({
    actionRecommendationId: 'ar-333',
    clientName: 'Gamma LLC',
    actionType: 'adjust_budget',
    riskLevel: 'medium',
    summary: 'Increase daily budget by $50',
    argsJson: { campaign_id: 'c1', delta_cents: 5000 }
  });
  assert.equal(threadKey, 'action-ar-333');
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('approve_action') || text.includes('approve'), 'approve action present');
  assert.ok(text.includes('reject_action') || text.includes('reject'), 'reject action present');
  assert.ok(text.includes('ar-333'), 'action_id parameter present');
  // Must NOT embed raw argsJson values as PII-risk — only show safe summary
  assert.ok(!text.includes('c1'), 'raw campaign_id not in card payload');
});

test('renderActionResultCard: outcome reflected in card', () => {
  const { cardsV2 } = renderActionResultCard({
    actionRecommendationId: 'ar-444',
    clientName: 'Delta Co',
    actionType: 'pause_campaign',
    outcome: 'approved',
    detail: 'Action queued for execution.'
  });
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('approved') || text.includes('Approved'), 'outcome present');
});

test('renderDailyDigestCard: summary truncated to 200 chars', () => {
  const longSummary = 'A'.repeat(250);
  const { cardsV2 } = renderDailyDigestCard({
    runId: 'r2', clientName: 'X', runStatus: 'completed', tier: 'daily_essential',
    findingCounts: { critical: 1, warning: 0, info: 0 },
    topFindings: [{ id: 'f1', summary: longSummary, severity: 'critical', category: 'ctm.x' }]
  });
  const text = JSON.stringify(cardsV2);
  assert.ok(!text.includes('A'.repeat(201)), 'summary truncated');
});
