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
