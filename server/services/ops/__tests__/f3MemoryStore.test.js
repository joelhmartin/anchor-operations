import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { upsertMemoryFact, getMemory, archiveMemoryFact, recordManualNote } from '../memory/memoryStore.js';

const CLIENT = randomUUID();

test('upsertMemoryFact inserts then updates via GREATEST on conflict', async () => {
  const first = await upsertMemoryFact({
    clientUserId: CLIENT, scope: 'paid_ads', fact_type: 'approved_pattern',
    fact_key: 'approved:pause_keyword', fact_value: { tool: 'pause_keyword' },
    confidence: 0.5, occurrences: 1, source: 'learned'
  });
  assert.equal(first.occurrences, 1);
  assert.equal(Number(first.confidence), 0.5);

  // Second call with higher occurrences/confidence (simulating more evidence).
  const second = await upsertMemoryFact({
    clientUserId: CLIENT, scope: 'paid_ads', fact_type: 'approved_pattern',
    fact_key: 'approved:pause_keyword', fact_value: { tool: 'pause_keyword', last: 'again' },
    confidence: 0.8, occurrences: 3, source: 'learned'
  });
  assert.equal(second.id, first.id, 'same row');
  assert.equal(second.occurrences, 3, 'occurrences updated via GREATEST');
  assert.ok(Number(second.confidence) > 0.5, 'confidence raised to higher value');
  assert.deepEqual(second.fact_value, { tool: 'pause_keyword', last: 'again' });

  // Re-upsert with lower values is idempotent (GREATEST keeps the higher values).
  const third = await upsertMemoryFact({
    clientUserId: CLIENT, scope: 'paid_ads', fact_type: 'approved_pattern',
    fact_key: 'approved:pause_keyword', fact_value: { tool: 'pause_keyword', last: 'again' },
    confidence: 0.5, occurrences: 1, source: 'learned'
  });
  assert.equal(third.occurrences, 3, 'idempotent: lower occurrences not applied');
  assert.ok(Number(third.confidence) >= 0.8, 'idempotent: lower confidence not applied');
});

test('getMemory filters by status/scope/type', async () => {
  const CLIENT2 = randomUUID();
  await upsertMemoryFact({
    clientUserId: CLIENT2, scope: 'paid_ads', fact_type: 'approved_pattern',
    fact_key: 'approved:test_tool', fact_value: {}, confidence: 0.5, source: 'learned'
  });
  const all = await getMemory({ clientUserId: CLIENT2 });
  assert.ok(all.length >= 1);
  const scoped = await getMemory({ clientUserId: CLIENT2, scope: 'paid_ads', factType: 'approved_pattern' });
  assert.ok(scoped.every((r) => r.scope === 'paid_ads' && r.fact_type === 'approved_pattern'));
});

test('archiveMemoryFact hides a fact from active reads (scoped by client)', async () => {
  const note = await recordManualNote({ clientUserId: CLIENT, scope: 'client', text: 'Client only wants weekday changes', createdBy: null });
  assert.equal(note.source, 'manual');
  assert.equal(Number(note.confidence), 1);

  await archiveMemoryFact({ id: note.id, clientUserId: CLIENT });
  const active = await getMemory({ clientUserId: CLIENT, status: 'active' });
  assert.equal(active.some((r) => r.id === note.id), false);
  const archived = await getMemory({ clientUserId: CLIENT, status: 'archived' });
  assert.equal(archived.some((r) => r.id === note.id), true);

  // Archiving with wrong client has no effect.
  const otherClient = randomUUID();
  const note2 = await recordManualNote({ clientUserId: CLIENT, scope: 'client', text: 'Second note', createdBy: null });
  const result = await archiveMemoryFact({ id: note2.id, clientUserId: otherClient });
  assert.equal(result, null, 'wrong client cannot archive another tenant row');
});
