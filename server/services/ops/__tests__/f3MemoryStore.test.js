import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { upsertMemoryFact, getMemory, archiveMemoryFact, recordManualNote } from '../memory/memoryStore.js';

const CLIENT = randomUUID();

test('upsertMemoryFact inserts then accrues on conflict', async () => {
  const first = await upsertMemoryFact({
    clientUserId: CLIENT, scope: 'paid_ads', fact_type: 'approved_pattern',
    fact_key: 'approved:pause_keyword', fact_value: { tool: 'pause_keyword' }, confidence: 0.5, source: 'learned'
  });
  assert.equal(first.occurrences, 1);
  assert.equal(Number(first.confidence), 0.5);

  const second = await upsertMemoryFact({
    clientUserId: CLIENT, scope: 'paid_ads', fact_type: 'approved_pattern',
    fact_key: 'approved:pause_keyword', fact_value: { tool: 'pause_keyword', last: 'again' }, confidence: 0.5, source: 'learned'
  });
  assert.equal(second.id, first.id, 'same row');
  assert.equal(second.occurrences, 2, 'occurrences accrued');
  assert.ok(Number(second.confidence) > 0.5, 'confidence raised');
  assert.deepEqual(second.fact_value, { tool: 'pause_keyword', last: 'again' });
});

test('getMemory filters by status/scope/type', async () => {
  const all = await getMemory({ clientUserId: CLIENT });
  assert.ok(all.length >= 1);
  const scoped = await getMemory({ clientUserId: CLIENT, scope: 'paid_ads', factType: 'approved_pattern' });
  assert.ok(scoped.every((r) => r.scope === 'paid_ads' && r.fact_type === 'approved_pattern'));
});

test('archiveMemoryFact hides a fact from active reads', async () => {
  const note = await recordManualNote({ clientUserId: CLIENT, scope: 'client', text: 'Client only wants weekday changes', createdBy: null });
  assert.equal(note.source, 'manual');
  assert.equal(Number(note.confidence), 1);

  await archiveMemoryFact(note.id);
  const active = await getMemory({ clientUserId: CLIENT, status: 'active' });
  assert.equal(active.some((r) => r.id === note.id), false);
  const archived = await getMemory({ clientUserId: CLIENT, status: 'archived' });
  assert.equal(archived.some((r) => r.id === note.id), true);
});
