import test from 'node:test';
import assert from 'node:assert/strict';
import { updateMemoryFromRuns } from '../memory/updateMemoryFromRuns.js';

test('updateMemoryFromRuns extracts from injected loaders and upserts each fact', async () => {
  const upserts = [];
  const out = await updateMemoryFromRuns({
    clientUserId: 'client-1',
    notes: [{ text: 'No weekend pushes', scope: 'client' }],
    deps: {
      loadApprovals: async () => [
        { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' },
        { tool_name: 'pause_keyword', scope: 'paid_ads', approved_at: 't', executed_at: 't' }
      ],
      loadRepeatedFindings: async () => [{ category: 'gads.spike', occurrences: 3, dismissed_count: 3 }],
      loadStableConfigs: async () => [],
      upsertFact: async (fact) => { upserts.push(fact); return { id: `m-${upserts.length}`, ...fact }; }
    }
  });

  assert.equal(out.extracted, 3); // approved_pattern + false_positive + manual_note
  assert.equal(out.upserted, 3);
  // every upserted fact carries the client id
  assert.ok(upserts.every((f) => f.clientUserId === 'client-1'));
  assert.ok(upserts.some((f) => f.fact_key === 'approved:pause_keyword'));
  assert.ok(upserts.some((f) => f.fact_key === 'false_positive:gads.spike'));
  assert.ok(upserts.some((f) => f.fact_type === 'manual_note'));
});

test('updateMemoryFromRuns with no activity upserts nothing', async () => {
  const out = await updateMemoryFromRuns({
    clientUserId: 'client-1',
    deps: {
      loadApprovals: async () => [],
      loadRepeatedFindings: async () => [],
      loadStableConfigs: async () => [],
      upsertFact: async () => { throw new Error('should not upsert'); }
    }
  });
  assert.equal(out.extracted, 0);
  assert.equal(out.upserted, 0);
});
