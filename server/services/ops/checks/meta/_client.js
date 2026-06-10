/**
 * Meta umbrella — adapter / API client wrapper.
 *
 * Wraps the existing services/analytics/metaAdsAdapter.js Graph helpers so the
 * ops checks have a single entry point with:
 *   - Token resolution (agency-level FACEBOOK_SYSTEM_USER_TOKEN per CLAUDE.md
 *     §Tracking auth model — per-client OAuth deferred per P1).
 *   - Ad account ID resolution from client_platform_credentials (platform='meta').
 *   - A small graph(path) helper for endpoints not covered by the adapter.
 *   - Per-run, per-client memoization on the ctx object so multiple Meta
 *     checks on one run only hit /me/adaccounts and /act_X once.
 *
 * Design note: this file does NOT enforce the HIPAA gate. That belongs in
 * `_hipaaGate.js` and must be called BEFORE getAdAccountClient(). Putting the
 * gate here would obscure it for code review — keep the policy explicit at
 * the call site of every Meta check.
 */

import { query } from '../../../../db.js';

const META_GRAPH_URL = 'https://graph.facebook.com/v21.0';
const _clientCacheKey = '_metaAdAccountClientCache';

function resolveSystemToken() {
  const token = process.env.FACEBOOK_SYSTEM_USER_TOKEN;
  return token && token.trim() ? token.trim() : null;
}

async function resolveAdAccountId(clientUserId) {
  if (!clientUserId) return null;
  const { rows } = await query(
    `SELECT account_id
       FROM client_platform_credentials
      WHERE client_user_id = $1 AND platform = 'meta'
      ORDER BY created_at DESC
      LIMIT 1`,
    [clientUserId]
  );
  const raw = rows[0]?.account_id;
  if (!raw) return null;
  // Normalise to act_<digits> form expected by Graph endpoints.
  return raw.startsWith('act_') ? raw : `act_${raw}`;
}

async function graph(token, path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${META_GRAPH_URL}/${path}${sep}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  if (!res.ok) {
    const msg = parsed?.error?.message || res.statusText || 'unknown';
    const code = parsed?.error?.code;
    const subcode = parsed?.error?.error_subcode;
    const e = new Error(`Meta API error: ${msg}`);
    e.status = res.status;
    e.metaCode = code;
    e.metaSubcode = subcode;
    e.body = parsed;
    throw e;
  }
  return parsed || {};
}

/**
 * Resolve a per-run Meta client for a given (run, client). Returns:
 *   { ok: false, reason }                  — credentials/token missing
 *   { ok: true, token, adAccountId, graph(subpath) }
 *
 * The result is memoized on ctx so multiple checks share one resolution.
 */
export async function getAdAccountClient(ctx) {
  if (ctx && ctx[_clientCacheKey] !== undefined) {
    return ctx[_clientCacheKey];
  }

  const token = resolveSystemToken();
  if (!token) {
    const out = { ok: false, reason: 'FACEBOOK_SYSTEM_USER_TOKEN not configured' };
    if (ctx) ctx[_clientCacheKey] = out;
    return out;
  }

  const adAccountId = await resolveAdAccountId(ctx?.clientUserId);
  if (!adAccountId) {
    const out = {
      ok: false,
      reason: 'no Meta ad_account_id configured for client (client_platform_credentials platform=meta)'
    };
    if (ctx) ctx[_clientCacheKey] = out;
    return out;
  }

  const out = {
    ok: true,
    token,
    adAccountId,
    graph: (subpath) => graph(token, subpath)
  };
  if (ctx) ctx[_clientCacheKey] = out;
  return out;
}

/**
 * Convenience: build the standard "skipped — adapter unavailable" outcome
 * for a check whose adapter resolution failed. Keeps payload shape uniform.
 */
export function adapterSkipOutcome(reason) {
  return {
    status: 'skipped',
    payload: { reason }
  };
}
