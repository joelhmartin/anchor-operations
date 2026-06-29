import test from 'node:test';
import assert from 'node:assert/strict';
import { gateForExecution } from '../actions/policy.js';

const rec = (over) => ({ abstractActionType: 'website.clear_cache', mutating: true, destructive: false, budgetDeltaCents: 0, riskTier: 'medium', approvalLevel: 'approval_required', ...over });

test('blocked recommendation never executes', () => {
  const g = gateForExecution(rec({ destructive: true, approvalLevel: 'blocked' }), { mutationsEnabled: true, actorIsAdmin: true });
  assert.equal(g.allow, false);
  assert.equal(g.requiredLevel, 'blocked');
});

test('admin_required + non-admin actor → not allowed', () => {
  const g = gateForExecution(rec({ riskTier: 'critical' }), { mutationsEnabled: true, actorIsAdmin: false });
  assert.equal(g.requiredLevel, 'admin_required');
  assert.equal(g.allow, false);
});

test('admin_required + admin actor → allowed', () => {
  const g = gateForExecution(rec({ riskTier: 'critical' }), { mutationsEnabled: true, actorIsAdmin: true });
  assert.equal(g.allow, true);
});

test('approval_required + admin actor (approve endpoint) → allowed', () => {
  const g = gateForExecution(rec(), { mutationsEnabled: false, actorIsAdmin: true });
  assert.equal(g.requiredLevel, 'approval_required');
  assert.equal(g.allow, true);
});

test('advisory none → auto-allowed', () => {
  const g = gateForExecution(rec({ abstractActionType: null, mutating: false }), { mutationsEnabled: false, actorIsAdmin: false });
  assert.equal(g.requiredLevel, 'none');
  assert.equal(g.allow, true);
});

test('re-derived level overrides a stale persisted approval_level (defense in depth)', () => {
  // Persisted says approval_required, but it is actually destructive → must block.
  const g = gateForExecution(rec({ destructive: true, approvalLevel: 'approval_required' }), { mutationsEnabled: true, actorIsAdmin: true });
  assert.equal(g.allow, false);
  assert.equal(g.requiredLevel, 'blocked');
});
