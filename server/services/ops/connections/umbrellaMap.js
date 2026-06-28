/**
 * Back-compat shim core (spec §4): the shipped registry keys checks by
 * `umbrella`. This maps each legacy umbrella to its PRIMARY (service_category,
 * provider) and back. `website` legitimately spans three categories; the
 * primary public-facing pair is used for single-check classification and the
 * rest are recorded as secondary for F2 connector inventory.
 */
export const UMBRELLA_TO_CATEGORY_PROVIDER = {
  website:    { serviceCategory: 'website', provider: 'public_http' },
  google_ads: { serviceCategory: 'paid_ads', provider: 'google_ads' },
  meta:       { serviceCategory: 'paid_ads', provider: 'meta' },
  ctm:        { serviceCategory: 'call_tracking', provider: 'ctm' }
};

export const SECONDARY_UMBRELLA_CATEGORIES = {
  website: [
    { serviceCategory: 'hosting', provider: 'kinsta' },
    { serviceCategory: 'cms', provider: 'wordpress' }
  ]
};

export function deriveFromUmbrella(umbrella) {
  const hit = UMBRELLA_TO_CATEGORY_PROVIDER[umbrella];
  if (!hit) throw new Error(`umbrellaMap: unknown umbrella "${umbrella}"`);
  return { ...hit };
}

export function umbrellaFromCategoryProvider(serviceCategory, provider) {
  for (const [umbrella, cp] of Object.entries(UMBRELLA_TO_CATEGORY_PROVIDER)) {
    if (cp.serviceCategory === serviceCategory && cp.provider === provider) return umbrella;
  }
  return null;
}
