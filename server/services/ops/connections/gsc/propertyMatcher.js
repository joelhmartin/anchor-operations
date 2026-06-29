/**
 * Pure GSC property matching (north-star §6.4).
 * Matches a client website URL against the list of GSC site properties
 * using a strict priority chain. No DB, no network.
 */

const CONFIDENCE = {
  exact_config:           1.0,
  sc_domain:              0.95,
  url_prefix_https_www:   0.9,
  url_prefix_https:       0.85,
  url_prefix_http:        0.7,
  manual:                 0
};

export function propertyType(siteUrl) {
  return typeof siteUrl === 'string' && siteUrl.startsWith('sc-domain:')
    ? 'domain'
    : 'url_prefix';
}

/**
 * @param {string} websiteUrl  - Client website URL (e.g. 'https://www.example.com')
 * @param {Array<{siteUrl: string, permissionLevel: string}>} siteList - From GSC sites.list API
 * @param {string|null} [exactConfig] - If client has a specific sc_site_url configured
 * @returns {{ siteUrl: string|null, permissionLevel: string|null, matchType: string, confidence: number }}
 */
export function matchProperty(websiteUrl, siteList = [], exactConfig = null) {
  const index = new Map(siteList.map((s) => [s.siteUrl, s]));

  const hit = (siteUrl, matchType) => {
    const entry = index.get(siteUrl);
    if (!entry) return null;
    return { siteUrl: entry.siteUrl, permissionLevel: entry.permissionLevel || null, matchType, confidence: CONFIDENCE[matchType] };
  };

  // 1. exact_config — client has told us exactly which property to use
  if (exactConfig) {
    const r = hit(exactConfig, 'exact_config');
    if (r) return r;
  }

  // Parse hostname
  let hostname;
  try {
    hostname = new URL(websiteUrl).hostname.toLowerCase();
  } catch {
    return { siteUrl: null, permissionLevel: null, matchType: 'manual', confidence: 0 };
  }
  const bare = hostname.replace(/^www\./, '');

  // 2. sc-domain (domain property)
  const r2 = hit(`sc-domain:${bare}`, 'sc_domain');
  if (r2) return r2;

  // 3. url-prefix https www
  const r3 = hit(`https://www.${bare}/`, 'url_prefix_https_www');
  if (r3) return r3;

  // 4. url-prefix https (no www)
  const r4 = hit(`https://${bare}/`, 'url_prefix_https');
  if (r4) return r4;

  // 5. url-prefix http www, then naked
  const r5a = hit(`http://www.${bare}/`, 'url_prefix_http');
  if (r5a) return r5a;
  const r5b = hit(`http://${bare}/`, 'url_prefix_http');
  if (r5b) return r5b;

  // 6. manual — no match found
  return { siteUrl: null, permissionLevel: null, matchType: 'manual', confidence: 0 };
}
