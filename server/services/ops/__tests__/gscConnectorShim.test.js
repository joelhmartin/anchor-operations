import test from 'node:test';
import assert from 'node:assert/strict';

// Import the shim to trigger side-effect registrations
import '../checks/website/gsc.js';

import { getCheck } from '../checks/registry.js';

// Note: we do NOT reset the registry before this test because we're testing
// that the shim's side-effect registrations happen on import. The shim test
// file should run in its own process (node --test isolates test files).

const ORIGINAL_CHECK_IDS = [
  'web.gsc.coverage_errors',
  'web.gsc.manual_actions',
  'web.gsc.crux_lcp',
  'web.gsc.indexed_pages_drop'
];

test('umbrella shim: all 4 original web.gsc.* check IDs are registered', () => {
  for (const id of ORIGINAL_CHECK_IDS) {
    const entry = getCheck(id);
    assert.ok(entry, `${id} must be registered`);
    assert.equal(entry.umbrella, 'website');
    assert.equal(typeof entry.handler, 'function');
  }
});

test('umbrella shim: web.gsc.indexed_pages_drop returns a valid shape when skipped (no auth)', async () => {
  const entry = getCheck('web.gsc.indexed_pages_drop');
  const ctx = { clientUserId: '00000000-0000-0000-0000-000000000001', signal: null, config: {}, credentials: {} };
  const result = await entry.handler(ctx);
  assert.ok(['pass', 'fail', 'error', 'skipped'].includes(result.status), `unexpected status: ${result.status}`);
  assert.ok(result.payload !== undefined, 'payload must be present');
});

test('umbrella shim: web.gsc.coverage_errors returns a valid shape', async () => {
  const entry = getCheck('web.gsc.coverage_errors');
  const ctx = { clientUserId: '00000000-0000-0000-0000-000000000001', signal: null, config: {}, credentials: {} };
  const result = await entry.handler(ctx);
  assert.ok(['pass', 'fail', 'error', 'skipped'].includes(result.status));
});

test('connector: new gsc.* check IDs are also registered', () => {
  // The checks.js module registers them on import (side effect)
  // Pull in the connector to ensure checks.js is loaded
  const NEW_IDS = [
    'gsc.connection_health',
    'gsc.site_access_missing',
    'gsc.click_drop',
    'gsc.impression_drop',
    'gsc.page_decline',
    'gsc.query_decline',
    'gsc.query_opportunity',
    'gsc.page_indexing_issue',
    'gsc.canonical_mismatch',
    'gsc.device_specific_drop',
    'gsc.zero_click_high_impression_pages'
  ];
  for (const id of NEW_IDS) {
    const entry = getCheck(id);
    assert.ok(entry, `${id} must be registered`);
  }
});
