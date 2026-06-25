import test from 'node:test';
import assert from 'node:assert/strict';
import { planWipe, ALLOWED_ACTIVITY_TABLES, SOCIAL_TABLES } from '../wipePlan.js';

test('planWipe excludes social tables by default', () => {
  const plan = planWipe({ includeSocial: false });
  assert.ok(plan.length > 0);
  for (const t of SOCIAL_TABLES) assert.ok(!plan.includes(t), `${t} must be excluded by default`);
  // child-before-parent ordering: messages before threads
  assert.ok(plan.indexOf('ops_chat_messages') < plan.indexOf('ops_chat_threads'));
});

test('planWipe includes social tables only when flagged, child before parent', () => {
  const plan = planWipe({ includeSocial: true });
  for (const t of SOCIAL_TABLES) assert.ok(plan.includes(t), `${t} must be included when flagged`);
  assert.ok(plan.indexOf('social_media_tokens') < plan.indexOf('social_posts'));
});

test('planWipe never emits a table outside the allowlist', () => {
  const allowed = new Set([...ALLOWED_ACTIVITY_TABLES, ...SOCIAL_TABLES]);
  for (const t of planWipe({ includeSocial: true })) assert.ok(allowed.has(t), `${t} not in allowlist`);
});
