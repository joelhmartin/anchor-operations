/**
 * website/public_http connector — discoverInventory (F2).
 * Fetches the client's homepage through the SSRF-guarded fetch helper and
 * extracts crawled URLs (homepage + internal links), forms, and tracking
 * tags (GTM / GA4 / Meta Pixel). No PII — public markup only.
 */
import { query } from '../../../../db.js';
import { resolveClientWebsiteUrl, safeHttpFetch } from '../../checks/website/_lib/httpFetch.js';
import { inventoryRow } from '../inventoryRow.js';

function extractLinks(html, baseUrl) {
  const set = new Set();
  const baseOrigin = new URL(baseUrl).origin;
  const re = /<a\b[^>]*\bhref=["']([^"'#]+)/gi;
  let m;
  while ((m = re.exec(html)) && set.size < 100) {
    const href = m[1].trim();
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
      if (u.origin !== baseOrigin) continue;
      set.add(u.origin + u.pathname);
    } catch { /* ignore malformed href */ }
  }
  return [...set];
}

function countForms(html) {
  const tags = html.match(/<form\b[^>]*>/gi) || [];
  return tags.map((tag, i) => ({
    id: (tag.match(/\bid=["']([^"']*)["']/i) || [])[1] || `form-${i}`,
    action: (tag.match(/\baction=["']([^"']*)["']/i) || [])[1] || ''
  }));
}

function detectTags(html) {
  const out = [];
  const gtm = html.match(/GTM-[A-Z0-9]+/);
  const ga4 = html.match(/G-[A-Z0-9]{6,}/);
  const fbq = html.match(/fbq\(['"]init['"],\s*['"](\d+)['"]/);
  if (gtm) out.push({ kind: 'gtm', id: gtm[0] });
  if (ga4) out.push({ kind: 'ga4', id: ga4[0] });
  if (fbq) out.push({ kind: 'meta_pixel', id: fbq[1] });
  return out;
}

export default {
  id: 'public_http',
  serviceCategory: 'website',
  provider: 'public_http',

  async discoverInventory(ctx = {}) {
    const resolveUrl = ctx.clients?.resolveUrl || ((cid) => resolveClientWebsiteUrl(query, cid));
    const fetchUrl = ctx.clients?.httpFetch || ((u, o) => safeHttpFetch(u, o));

    const websiteUrl = ctx.connection?.metadata?.websiteUrl || await resolveUrl(ctx.clientUserId);
    if (!websiteUrl) return [];

    let res;
    try {
      res = await fetchUrl(websiteUrl, { timeoutMs: 12_000, maxBytes: 750_000, signal: ctx.signal });
    } catch {
      return [];
    }

    const html = (res?.body || '').slice(0, 400_000);
    const rows = [];

    rows.push(inventoryRow({
      object_type: 'url',
      external_id: websiteUrl,
      name: websiteUrl,
      status: String(res?.status ?? 'fetched'),
      url: websiteUrl,
      metadata: { homepage: true }
    }));

    for (const link of extractLinks(html, websiteUrl)) {
      if (link === websiteUrl) continue;
      rows.push(inventoryRow({ object_type: 'url', external_id: link, name: link, url: link, metadata: {} }));
    }

    for (const f of countForms(html)) {
      rows.push(inventoryRow({ object_type: 'form', external_id: f.id, name: f.id, metadata: { action: f.action } }));
    }

    for (const t of detectTags(html)) {
      rows.push(inventoryRow({
        object_type: 'tracking_tag',
        external_id: `${t.kind}:${t.id}`,
        name: t.kind,
        status: 'present',
        metadata: { id: t.id }
      }));
    }

    return rows;
  }
};
