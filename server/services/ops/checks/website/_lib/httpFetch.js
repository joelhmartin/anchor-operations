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
    bodyEncoding = 'utf8',
    // Optional AbortSignal. The ops run executor passes a per-check signal
    // here so a check-timeout or run-level cancel actually tears down the
    // socket instead of leaving a hung request burning bytes after the
    // executor moved on.
    signal
  } = opts;

  // Fast-fail when the signal is already aborted so we don't open a socket.
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error('fetch aborted');
  }

  // Validate URL + DNS-resolve hostname against the SSRF block-list.
  const parsed = await assertPublicHttpUrl(rawUrl);

  // Re-check after the DNS await: AbortSignal does not replay 'abort' events
  // to listeners attached after the abort fired, so a signal that flipped
  // during DNS would otherwise slip past and let the socket run to its own
  // timeout instead of being torn down.
  if (signal?.aborted) {
    const reason = signal.reason;
    throw reason instanceof Error ? reason : new Error('fetch aborted');
  }

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
          // Pass `signal` (already in `opts`) through so a mid-redirect abort
          // tears down the next hop as well.
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

    // Wire the AbortSignal: on abort, destroy the request (cuts the socket and
    // emits 'close'), then reject with the abort reason. Cleanup the listener
    // on any termination so the controller isn't pinned by a dangling handler.
    let onAbort;
    if (signal) {
      onAbort = () => {
        const reason = signal.reason;
        req.destroy();
        reject(reason instanceof Error ? reason : new Error('fetch aborted'));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      req.on('close', () => signal.removeEventListener('abort', onAbort));
    }

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
 * Kinsta site's live-environment primary domain, falls back to
 * `brand_assets.website_url`. Returns `null` when nothing is configured.
 *
 * NOTE: `primary_domain` lives on `kinsta_environments` (per live environment),
 * NOT on `kinsta_sites`. We resolve it via the live environment for the linked
 * site. (A prior version selected `kinsta_sites.primary_domain`, a column that
 * does not exist, which threw at runtime and forced every website check to
 * record `error` instead of running.)
 *
 * Caller responsibility: pass the result through `assertPublicHttpUrl` before
 * any fetch (safeHttpFetch already does this).
 */
export async function resolveClientWebsiteUrl(query, clientUserId) {
  const sql = `
    SELECT COALESCE(
             NULLIF(ke.primary_domain, ''),
             NULLIF(ba.website_url, '')
           ) AS website_url
      FROM users u
      LEFT JOIN brand_assets ba ON ba.user_id = u.id
      LEFT JOIN kinsta_site_clients ksc ON ksc.client_user_id = u.id
      LEFT JOIN LATERAL (
        SELECT e.primary_domain
          FROM kinsta_environments e
         WHERE e.site_id = ksc.site_id
           AND e.is_live = TRUE
           AND e.primary_domain IS NOT NULL
         ORDER BY e.created_at ASC
         LIMIT 1
      ) ke ON TRUE
     WHERE u.id = $1
     ORDER BY ke.primary_domain DESC NULLS LAST
     LIMIT 1
  `;
  const { rows } = await query(sql, [clientUserId]);
  const raw = rows[0]?.website_url || null;
  if (!raw) return null;
  // Normalize: prepend https:// if no scheme.
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw.replace(/^\/+/, '')}`;
}
