import test from 'node:test';
import assert from 'node:assert/strict';
import wordpress from '../connections/providers/wordpress.js';

test('wordpress connector emits page/plugin/user rows and never collects user PII', async () => {
  const calls = [];
  const fakeWp = async (envId, args) => {
    calls.push(args);
    if (args.includes('post list')) return { exitCode: 0, stdout: JSON.stringify([{ ID: 10, post_title: 'Home', post_status: 'publish' }]) };
    if (args.includes('plugin list')) return { exitCode: 0, stdout: JSON.stringify([{ name: 'akismet', status: 'active', version: '5.0' }]) };
    if (args.includes('user list')) return { exitCode: 0, stdout: JSON.stringify([{ ID: 1, roles: ['administrator'] }]) };
    return { exitCode: 1, stdout: '' };
  };

  const rows = await wordpress.discoverInventory({ environmentId: 'env-1', clients: { wpcli: fakeWp } });

  const page = rows.find((r) => r.object_type === 'page');
  assert.equal(page.external_id, '10');
  assert.equal(page.name, 'Home');
  assert.equal(page.status, 'publish');

  const plugin = rows.find((r) => r.object_type === 'plugin');
  assert.equal(plugin.external_id, 'akismet');
  assert.deepEqual(plugin.metadata, { version: '5.0' });

  const user = rows.find((r) => r.object_type === 'user');
  assert.equal(user.external_id, '1');
  assert.equal(user.name, null, 'PII-safe: no username/email persisted as the user name');
  assert.deepEqual(user.metadata, { roles: ['administrator'] });

  // The user-list command must request ID + roles ONLY — never PII fields.
  const userCall = calls.find((a) => a.includes('user list'));
  assert.ok(!/user_email|display_name|user_login|user_pass/.test(userCall), 'no PII fields requested from WP-CLI');
});

test('wordpress connector returns [] when no environment id is available', async () => {
  const rows = await wordpress.discoverInventory({ clients: { wpcli: async () => ({ exitCode: 0, stdout: '[]' }) } });
  assert.deepEqual(rows, []);
});
