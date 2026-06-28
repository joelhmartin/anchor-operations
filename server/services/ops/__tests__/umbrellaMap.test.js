import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveFromUmbrella,
  umbrellaFromCategoryProvider,
  UMBRELLA_TO_CATEGORY_PROVIDER,
  SECONDARY_UMBRELLA_CATEGORIES
} from '../connections/umbrellaMap.js';

test('deriveFromUmbrella maps the four shipped umbrellas (spec §4)', () => {
  assert.deepEqual(deriveFromUmbrella('website'), { serviceCategory: 'website', provider: 'public_http' });
  assert.deepEqual(deriveFromUmbrella('google_ads'), { serviceCategory: 'paid_ads', provider: 'google_ads' });
  assert.deepEqual(deriveFromUmbrella('meta'), { serviceCategory: 'paid_ads', provider: 'meta' });
  assert.deepEqual(deriveFromUmbrella('ctm'), { serviceCategory: 'call_tracking', provider: 'ctm' });
});

test('deriveFromUmbrella throws on an unknown umbrella', () => {
  assert.throws(() => deriveFromUmbrella('tiktok'), /unknown umbrella/i);
});

test('umbrellaFromCategoryProvider reverses the primary map', () => {
  assert.equal(umbrellaFromCategoryProvider('paid_ads', 'google_ads'), 'google_ads');
  assert.equal(umbrellaFromCategoryProvider('call_tracking', 'ctm'), 'ctm');
  assert.equal(umbrellaFromCategoryProvider('website', 'public_http'), 'website');
  assert.equal(umbrellaFromCategoryProvider('analytics', 'ga4'), null);
});

test('website declares secondary categories for F2 (hosting + cms)', () => {
  const sec = SECONDARY_UMBRELLA_CATEGORIES.website;
  assert.deepEqual(sec, [
    { serviceCategory: 'hosting', provider: 'kinsta' },
    { serviceCategory: 'cms', provider: 'wordpress' }
  ]);
  assert.ok(UMBRELLA_TO_CATEGORY_PROVIDER.website);
});
