import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeHomeDigest } from '../homeDigest.js';

test('shapeHomeDigest derives needs-attention from critical discoveries grouped by client', () => {
  const cc = {
    discoveries: [
      { id: 'd1', client_user_id: 'c1', severity: 'critical', summary: 'A' },
      { id: 'd2', client_user_id: 'c1', severity: 'critical', summary: 'B' },
      { id: 'd3', client_user_id: 'c2', severity: 'warning', summary: 'C' }
    ],
    kpis: { clients_at_risk: 1, approvals_waiting: 3 }
  };
  const out = shapeHomeDigest({ commandCenter: cc, scheduledBlogs: [], scheduledSocial: [] });
  assert.equal(out.needsAttention.length, 1);
  assert.equal(out.needsAttention[0].clientUserId, 'c1');
  assert.equal(out.needsAttention[0].criticalCount, 2);
  assert.equal(out.approvalsWaiting, 3);
});

test('shapeHomeDigest passes through scheduled content', () => {
  const out = shapeHomeDigest({
    commandCenter: { discoveries: [], kpis: {} },
    scheduledBlogs: [{ id: 'b1', client_id: 'c9', title: 'T' }],
    scheduledSocial: []
  });
  assert.equal(out.scheduledToday.blogs.length, 1);
  assert.equal(out.scheduledToday.social.length, 0);
});
