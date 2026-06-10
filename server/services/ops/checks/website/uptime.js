/**
 * web.uptime.reachable — single-region HEAD probe with a 10s timeout.
 *
 * Multi-region probing is deferred (would need a separate worker pool).
 * Treats any 2xx/3xx as reachable; 4xx/5xx and network errors as down.
 */

import { registerCheck } from '../registry.js';
import { query } from '../../../../db.js';
import { resolveClientWebsiteUrl, safeHttpFetch } from './_lib/httpFetch.js';

registerCheck('web.uptime.reachable', {
  umbrella: 'website',
  tier: 'daily_essential',
  costEstimate: 0,
  requires: [],
  handler: async (ctx) => {
    const websiteUrl = await resolveClientWebsiteUrl(query, ctx.clientUserId);
    if (!websiteUrl) {
      return { status: 'skipped', payload: { reason: 'no website URL configured for client' } };
    }

    const startedAt = Date.now();
    try {
      const res = await safeHttpFetch(websiteUrl, {
        method: 'HEAD',
        timeoutMs: 10_000,
        maxBytes: 64 * 1024,
        redirectLimit: 3
      });
      const ok = res.status >= 200 && res.status < 400;
      return {
        status: ok ? 'pass' : 'fail',
        severity: ok ? null : 'critical',
        payload: {
          website_url: websiteUrl,
          http_status: res.status,
          duration_ms: Date.now() - startedAt
        }
      };
    } catch (err) {
      return {
        status: 'fail',
        severity: 'critical',
        payload: {
          website_url: websiteUrl,
          error: err.message,
          duration_ms: Date.now() - startedAt
        }
      };
    }
  }
});
