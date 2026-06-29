import test from 'node:test';
import assert from 'node:assert/strict';
import { routeEvent } from '../googleChat/eventRouter.js';

const knownUser = { mapping: { google_user_id: 'users/123' }, anchorUser: { id: 'u1', role: 'admin' } };

function fakeResolve(user) {
  return async () => user;
}
function fakeHandle(response) {
  return async () => response;
}

test('MESSAGE event: known user → command handled', async () => {
  const event = { type: 'MESSAGE', message: { text: '/anchorops help', sender: { name: 'users/123' } } };
  const result = await routeEvent(event, {
    verifyToken: async () => ({ googleUserId: 'users/123' }),
    resolveUser: fakeResolve(knownUser),
    handleCommandFn: fakeHandle({ text: 'Help text' })
  });
  assert.equal(result.text, 'Help text');
});

test('MESSAGE event: unknown user → neutral refusal', async () => {
  const event = { type: 'MESSAGE', message: { text: 'daily', sender: { name: 'users/999' } } };
  const result = await routeEvent(event, {
    verifyToken: async () => ({ googleUserId: 'users/999' }),
    resolveUser: fakeResolve(null),
    handleCommandFn: fakeHandle({ text: 'should not reach' })
  });
  assert.ok(result.text.includes("don't recognize"), 'neutral refusal returned');
  assert.ok(!result.text.toLowerCase().includes('client_type'), 'never echoes client_type');
});

test('MESSAGE event: permission denied → permission error text', async () => {
  const { PermissionError } = await import('../googleChat/userMapper.js');
  const event = { type: 'MESSAGE', message: { text: '/anchorops approve ar-1', sender: { name: 'users/123' } } };
  const result = await routeEvent(event, {
    verifyToken: async () => ({ googleUserId: 'users/123' }),
    resolveUser: fakeResolve(knownUser),
    handleCommandFn: async () => { throw new PermissionError('not allowed'); }
  });
  assert.ok(result.text.includes("don't have permission"), 'permission error text returned');
});

test('ADDED_TO_SPACE event: returns help card', async () => {
  const event = { type: 'ADDED_TO_SPACE', space: { name: 'spaces/AAA' }, user: { name: 'users/123' } };
  const result = await routeEvent(event, {
    verifyToken: async () => ({ googleUserId: 'users/123' }),
    resolveUser: fakeResolve(knownUser)
  });
  assert.ok(result.text, 'returns help text on ADDED_TO_SPACE');
});

test('REMOVED_FROM_SPACE event: returns empty text', async () => {
  const event = { type: 'REMOVED_FROM_SPACE', space: { name: 'spaces/AAA' } };
  const result = await routeEvent(event, { verifyToken: async () => null });
  assert.equal(result.text, '');
});

test('CARD_CLICKED approve_action: missing action → error text', async () => {
  const event = {
    type: 'CARD_CLICKED',
    action: { actionMethodName: 'approve_action', parameters: [{ key: 'action_id', value: 'ar-missing' }] },
    user: { name: 'users/123' }
  };
  const result = await routeEvent(event, {
    verifyToken: async () => ({ googleUserId: 'users/123' }),
    resolveUser: fakeResolve(knownUser),
    queryFn: async () => ({ rows: [] })  // action not found
  });
  assert.ok(result.text, 'returns error text for missing action');
  assert.ok(!result.text.includes('ar-missing') || result.text.length < 300, 'does not echo raw id in a verbose way');
});

test('unknown event type returns empty text silently', async () => {
  const result = await routeEvent({ type: 'UNKNOWN_TYPE' }, { verifyToken: async () => null });
  assert.equal(result.text, '');
});

test('JWT verification failure returns empty text (auth rejected)', async () => {
  const event = { type: 'MESSAGE', message: { text: '/anchorops help', sender: { name: 'users/123' } } };
  const result = await routeEvent(event, {
    verifyToken: async () => { throw new Error('Missing Authorization header'); },
    resolveUser: fakeResolve(knownUser),
    handleCommandFn: fakeHandle({ text: 'Help text' })
  });
  assert.equal(result.text, '');
});
