/**
 * SSRF-guarded HTTP fetch helper for ops website checks.
 *
 * Wraps node:http(s) with a body-size cap and request timeout, and runs every
 * URL through `assertPublicHttpUrl` from services/security/ssrfGuard.js so any
 * accidental internal/private target is rejected before bytes leave the box.
 *
 * Returns `{ status, headers, body, finalUrl }`. Throws on network errors,
 * size cap breaches, timeouts, or SSRF rejections — callers should catch and
 * convert to a check `status: 'error'` or `'skipped'` outcome.
 */

import https from 'node:https';
import http from 'node:http';
import { assertPublicHttpUrl, SsrfBlockedError } from '../../../../security/ssrfGuard.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BYTES = 750_000;

export { SsrfBlockedError };

export async function safeHttpFetch(rawUrl, opts = {}) {
  const {
    method = 'GET',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
    headers = {},
    redirectLimit = 3,
    bodyEncoding = 'utf8'
  } = opts;

  // Validate URL + DNS-resolve hostname against the SSRF block-list.
  const parsed = await assertPublicHttpUrl(rawUrl);

  return new Promise((resolve, reject) => {
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request(
      parsed,
      {
        method,
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'AnchorOps/1.0 (+https://anchorcorps.com)',
          Accept: '*/*',
          ...headers
        }
      },
      (res) => {
        // Follow at most `redirectLimit` 3xx redirects.
        if (
          res.statusCode &&
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location &&
          redirectLimit > 0
        ) {
          const next = new URL(res.headers.location, parsed).toString();
          res.resume();
          safeHttpFetch(next, { ...opts, redirectLimit: redirectLimit - 1 }).then(resolve, reject);
          return;
        }

        let received = 0;
        const chunks = [];
        res.on('data', (chunk) => {
          received += chunk.length;
          if (received > maxBytes) {
            req.destroy();
            reject(new Error(`response exceeded ${maxBytes} byte cap`));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode || 0,
            headers: res.headers,
            body: bodyEncoding === 'buffer' ? buf : buf.toString(bodyEncoding),
            finalUrl: parsed.toString()
          });
        });
        res.on('error', reject);
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`fetch timeout after ${timeoutMs}ms`));
    });
    req.end();
  });
}

/**
 * Resolve the primary website URL for a client. Looks first at the linked
 * Kinsta site primary domain, falls back to `client_profiles.website_url`.
 * Returns `null` when nothing is configured.
 *
 * Caller responsibility: pass the result through `assertPublicHttpUrl` before
 * any fetch (safeHttpFetch already does this).
 */
export async function resolveClientWebsiteUrl(query, clientUserId) {
  const sql = `
    SELECT COALESCE(
             NULLIF(ks.primary_domain, ''),
             NULLIF(ba.website_url, '')
           ) AS website_url
      FROM users u
      LEFT JOIN brand_assets ba ON ba.user_id = u.id
      LEFT JOIN kinsta_site_clients ksc ON ksc.client_user_id = u.id
      LEFT JOIN kinsta_sites ks ON ks.id = ksc.site_id
     WHERE u.id = $1
     ORDER BY ks.primary_domain DESC NULLS LAST
     LIMIT 1
  `;
  const { rows } = await query(sql, [clientUserId]);
  const raw = rows[0]?.website_url || null;
  if (!raw) return null;
  // Normalize: prepend https:// if no scheme.
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, '')}`;
}
