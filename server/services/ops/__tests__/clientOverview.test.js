/**
 * clientOverview unit tests — Task 4 (client-first redesign).
 *
 * Uses Node's built-in test runner (`node:test`). No DB I/O — exercises the
 * pure `shapeClientOverview` export from `clientOverview.js`.
 *
 * Run with:
 *   node --test server/services/ops/__tests__/clientOverview.test.js
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeClientOverview } from '../clientOverview.js';

test('shapeClientOverview caps top findings at 5 and counts open findings', () => {
  const findings = Array.from({ length: 8 }, (_, i) => ({
    id: `f${i}`, severity: i < 2 ? 'critical' : 'warning', summary: `s${i}`, status: 'open', attention_score: 100 - i
  }));
  const out = shapeClientOverview({
    findings, scheduledBlogs: [], scheduledSocial: [], lastRun: null, cost: { spend_cents: 250, cap_cents: 5000 }
  });
  assert.equal(out.topFindings.length, 5);
  assert.equal(out.counts.openFindings, 8);
  assert.equal(out.counts.mtdSpendCents, 250);
  assert.equal(out.counts.capCents, 5000);
});

test('shapeClientOverview groups scheduled content and counts posts', () => {
  const out = shapeClientOverview({
    findings: [],
    scheduledBlogs: [{ id: 'b1', title: 'Post', scheduled_for: '2026-06-25T10:00:00Z' }],
    scheduledSocial: [{ id: 's1', content: 'Hi', scheduled_for: '2026-06-25T12:00:00Z' }],
    lastRun: null, cost: null
  });
  assert.equal(out.scheduledToday.blogs.length, 1);
  assert.equal(out.scheduledToday.social.length, 1);
  assert.equal(out.counts.postsScheduled, 2);
  assert.equal(out.counts.mtdSpendCents, 0);
});
