import test from 'node:test';
import assert from 'node:assert/strict';
import { decideApproval, requiresApproval, isBlocked, escalate, APPROVAL_LEVELS } from '../recommendations/policyApplicator.js';

const act = (over) => ({ abstractActionType: 'website.clear_cache', mutating: true, destructive: false, budgetDeltaCents: 0, riskTier: 'medium', ...over });

test('escalate returns the stricter level', () => {
  assert.equal(escalate('none', 'admin_required'), 'admin_required');
  assert.equal(escalate('blocked', 'approval_required'), 'blocked');
  assert.equal(escalate('approval_required', 'approval_required'), 'approval_required');
});

test('advisory (no action) → none', () => {
  const d = decideApproval({ abstractActionType: null, mutating: false, destructive: false, budgetDeltaCents: 0, riskTier: 'low' }, {});
  assert.equal(d.approvalLevel, 'none');
});

test('destructive → blocked (terminal)', () => {
  const d = decideApproval(act({ destructive: true }), { mutationsEnabled: true });
  assert.equal(d.approvalLevel, 'blocked');
  assert.ok(isBlocked(d.approvalLevel));
  assert.ok(d.reasons.some((r) => /destructive/i.test(r)));
});

test('mutating with mutations disabled → at least approval_required', () => {
  const d = decideApproval(act(), { mutationsEnabled: false });
  assert.equal(d.approvalLevel, 'approval_required');
  assert.ok(requiresApproval(d.approvalLevel));
  assert.ok(d.reasons.some((r) => /disabled by default/i.test(r)));
});

test('budget increase → at least approval_required even if mutations enabled', () => {
  const d = decideApproval(act({ budgetDeltaCents: 5000 }), { mutationsEnabled: true });
  assert.ok(requiresApproval(d.approvalLevel));
  assert.ok(d.reasons.some((r) => /budget/i.test(r)));
});

test('critical risk tier → at least admin_required', () => {
  const d = decideApproval(act({ riskTier: 'critical' }), { mutationsEnabled: true });
  assert.equal(d.approvalLevel, 'admin_required');
});

test('medical client escalates approval_required → admin_required', () => {
  const standard = decideApproval(act(), { mutationsEnabled: false, clientType: 'standard' });
  const medical = decideApproval(act(), { mutationsEnabled: false, clientType: 'medical' });
  assert.equal(standard.approvalLevel, 'approval_required');
  assert.equal(medical.approvalLevel, 'admin_required');
});

test('reasons never echo client_type value', () => {
  const d = decideApproval(act(), { mutationsEnabled: false, clientType: 'medical' });
  assert.ok(!JSON.stringify(d.reasons).includes('medical'));
});

test('APPROVAL_LEVELS is the locked north-star vocabulary', () => {
  assert.deepEqual(APPROVAL_LEVELS, ['none', 'approval_required', 'admin_required', 'blocked']);
});
