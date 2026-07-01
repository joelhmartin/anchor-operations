import test from 'node:test';
import assert from 'node:assert/strict';
import { handleCommand } from '../googleChat/commandHandler.js';

const adminUser = { id: 'u1', role: 'admin' };

function noopQuery(rows = []) {
  return async () => ({ rows });
}

test('handleCommand: help returns text with all commands', async () => {
  const result = await handleCommand({ command: 'help', args: [], anchorUser: adminUser }, {});
  assert.ok(result.text.includes('help'));
  assert.ok(result.text.includes('audit'));
});

test('handleCommand: unknown command returns error text', async () => {
  const result = await handleCommand({ command: 'unknown', args: [], anchorUser: adminUser }, {});
  assert.ok(result.text.includes('Unknown command'));
});

test('handleCommand: clients with no mapped clients returns empty list', async () => {
  const result = await handleCommand(
    { command: 'clients', args: [], anchorUser: adminUser },
    { queryFn: noopQuery([]) }
  );
  const text = JSON.stringify(result);
  assert.ok(text.includes('client') || text.includes('Client'));
});

test('handleCommand: connect returns a cardsV2 with a link', async () => {
  const result = await handleCommand(
    { command: 'connect', args: [], anchorUser: adminUser },
    { appBaseUrl: 'https://anchor.example.com' }
  );
  assert.ok(result.cardsV2, 'returns cardsV2');
  const text = JSON.stringify(result);
  assert.ok(text.includes('https://anchor.example.com'));
});

test('handleCommand: approve via text returns instructional error', async () => {
  const result = await handleCommand({ command: 'approve', args: ['ar-1'], anchorUser: adminUser }, {});
  assert.ok(result.text.includes('button') || result.text.includes('Use the approval'));
});

// Regression: the client-name queries must reference only columns that exist in
// prod. They previously hit cp.business_name / u.name (neither exists), so every
// data command threw "column cp.business_name does not exist". They must now use
// the canonical clientLabel columns (client_profiles.client_identifier_value, etc.).
function capturingQuery() {
  const sqls = [];
  const fn = async (text) => { sqls.push(text); return { rows: [] }; };
  fn.sqls = sqls;
  return fn;
}

for (const command of ['clients', 'client', 'issues']) {
  test(`handleCommand: ${command} uses canonical client-label columns, not phantom ones`, async () => {
    const q = capturingQuery();
    await handleCommand(
      { command, args: ['Acme'], anchorUser: adminUser },
      { queryFn: q }
    );
    const all = q.sqls.join('\n');
    assert.ok(all.length > 0, 'ran at least one query');
    assert.ok(!/\bcp\.business_name\b/.test(all), 'does not reference cp.business_name');
    assert.ok(!/\bu\.name\b/.test(all), 'does not reference u.name');
    assert.ok(/client_identifier_value/.test(all), 'uses the canonical client_identifier_value');
  });
}

test('handleCommand: approvals uses canonical client-label columns', async () => {
  const q = capturingQuery();
  await handleCommand(
    { command: 'approvals', args: [], anchorUser: adminUser },
    { queryFn: q }
  );
  const all = q.sqls.join('\n');
  assert.ok(!/\bcp\.business_name\b/.test(all), 'does not reference cp.business_name');
  assert.ok(!/\bu\.name\b/.test(all), 'does not reference u.name');
  assert.ok(/client_identifier_value/.test(all), 'uses the canonical client_identifier_value');
});

test('handleCommand: audit degrades gracefully when F0 not built', async () => {
  const result = await handleCommand(
    { command: 'audit', args: [], anchorUser: adminUser },
    {
      getLatestAuditRunFn: async () => { throw new Error('relation "ops_access_audit_runs" does not exist'); }
    }
  );
  assert.ok(result.text, 'returns text');
  assert.ok(!result.text.includes('does not exist'), 'raw error not exposed');
});
