import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderHelpCard,
  renderClientsCard,
  renderClientSummaryCard,
  renderIssuesCard,
  renderApprovalsCard,
  renderErrorCard,
  renderConnectCard,
  renderAuditCard
} from '../googleChat/cardRenderer.js';

test('renderHelpCard: text contains all commands', () => {
  const { text } = renderHelpCard();
  const cmds = ['help', 'daily', 'clients', 'client', 'run', 'issues', 'approvals', 'approve', 'reject', 'connect', 'audit'];
  for (const cmd of cmds) {
    assert.ok(text.includes(cmd), `text includes command: ${cmd}`);
  }
});

test('renderClientsCard: lists each client name', () => {
  const { cardsV2 } = renderClientsCard([
    { id: 'c1', name: 'ACME Corp', openFindings: 3 },
    { id: 'c2', name: 'Beta Inc', openFindings: 0 }
  ]);
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('ACME Corp'));
  assert.ok(text.includes('Beta Inc'));
});

test('renderClientSummaryCard: shows finding counts', () => {
  const { cardsV2 } = renderClientSummaryCard(
    { id: 'c1', name: 'ACME Corp' },
    { critical: 2, warning: 5, info: 1 },
    3
  );
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('2'));
  assert.ok(text.includes('5'));
  assert.ok(text.includes('ACME Corp'));
});

test('renderIssuesCard: truncated to 10 findings', () => {
  const findings = Array.from({ length: 15 }, (_, i) => ({
    id: `f${i}`, severity: 'warning', category: 'ctm.x', summary: `Finding ${i}`
  }));
  const { cardsV2 } = renderIssuesCard(findings, 'ACME');
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('Finding 9'), 'finding 9 present');
  assert.ok(!text.includes('Finding 14'), 'finding 14 truncated');
});

test('renderApprovalsCard: each rec has approve and reject buttons', () => {
  const recs = [
    { id: 'ar-1', actionType: 'adjust_budget', riskLevel: 'medium', summary: 'Increase budget', clientName: 'ACME' }
  ];
  const { cardsV2 } = renderApprovalsCard(recs);
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('ar-1'), 'action_id present');
  assert.ok(text.includes('approve_action'), 'approve button present');
  assert.ok(text.includes('reject_action'), 'reject button present');
});

test('renderErrorCard: returns neutral text, no stack trace', () => {
  const { text } = renderErrorCard('Something went wrong');
  assert.ok(text.includes('Something went wrong'));
  assert.ok(!text.includes('at '), 'no stack trace lines');
});

test('renderConnectCard: includes a link widget', () => {
  const { cardsV2 } = renderConnectCard('https://anchor.example.com/ops/connect');
  const text = JSON.stringify(cardsV2);
  assert.ok(text.includes('https://anchor.example.com/ops/connect'));
});

test('renderAuditCard: degrades gracefully with null status', () => {
  const { text } = renderAuditCard(null);
  assert.ok(typeof text === 'string' && text.length > 0);
  assert.ok(!text.includes('null'));
});
