import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveGoogleChatUser, assertPermission, PermissionError, VIEWER_COMMANDS } from '../googleChat/userMapper.js';

function fakeQuery(mappingRow, userRow) {
  return async (sql) => {
    if (sql.includes('ops_chat_user_mappings')) return { rows: mappingRow ? [mappingRow] : [] };
    if (sql.includes('FROM users')) return { rows: userRow ? [userRow] : [] };
    return { rows: [] };
  };
}

const mapping = { id: 'm1', google_user_id: 'users/123', anchor_user_id: 'u1', display_name: 'Joel', enabled: true };
const adminUser = { id: 'u1', role: 'admin', email: 'joel@example.com' };
const viewerUser = { id: 'u2', role: 'ops_viewer', email: 'viewer@example.com' };

test('resolveGoogleChatUser: returns mapping + anchorUser for known enabled user', async () => {
  const result = await resolveGoogleChatUser('users/123', { queryFn: fakeQuery(mapping, adminUser) });
  assert.ok(result, 'result is non-null');
  assert.equal(result.mapping.google_user_id, 'users/123');
  assert.equal(result.anchorUser.role, 'admin');
  assert.equal(result.anchorUser.id, 'u1');
});

test('resolveGoogleChatUser: returns null when mapping not found', async () => {
  const result = await resolveGoogleChatUser('users/999', { queryFn: fakeQuery(null, null) });
  assert.equal(result, null);
});

test('resolveGoogleChatUser: returns null when mapping disabled', async () => {
  const disabledMapping = { ...mapping, enabled: false };
  const result = await resolveGoogleChatUser('users/123', { queryFn: fakeQuery(disabledMapping, adminUser) });
  assert.equal(result, null);
});

test('assertPermission: admin can approve', () => {
  assert.doesNotThrow(() => assertPermission(adminUser, 'approve'));
});

test('assertPermission: admin can run', () => {
  assert.doesNotThrow(() => assertPermission(adminUser, 'run'));
});

test('assertPermission: ops_viewer can read daily', () => {
  assert.doesNotThrow(() => assertPermission(viewerUser, 'daily'));
  assert.doesNotThrow(() => assertPermission(viewerUser, 'clients'));
  assert.ok(VIEWER_COMMANDS.has('audit'));
});

test('assertPermission: ops_viewer cannot approve', () => {
  assert.throws(
    () => assertPermission(viewerUser, 'approve'),
    PermissionError
  );
});

test('assertPermission: ops_viewer cannot run', () => {
  assert.throws(() => assertPermission(viewerUser, 'run'), PermissionError);
});

test('assertPermission: unknown role cannot do anything', () => {
  assert.throws(() => assertPermission({ role: 'editor' }, 'daily'), PermissionError);
});
