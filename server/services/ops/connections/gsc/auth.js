/**
 * GSC authentication — resolves a Bearer token for Search Console REST calls.
 *
 * Auth priority (north-star §6, spec §3.1 env-var/Postgres model):
 *   1. GA4_SERVICE_ACCOUNT_KEY (JSON string in env) — service account
 *   2. ADC — GOOGLE_APPLICATION_CREDENTIALS file or Cloud Run metadata
 *   3. oauthFallback() — caller-supplied per-client OAuth token
 *   4. null (no credentials configured)
 *
 * _createAuth is injectable for tests: (googleAuthOpts) => { getAccessToken }
 * In production it defaults to (opts) => new GoogleAuth(opts).
 */
import { GoogleAuth } from 'google-auth-library';

const GSC_SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly'];

export async function resolveGscToken({
  env = process.env,
  oauthFallback = null,
  _createAuth = null
} = {}) {
  const makeAuth = _createAuth || ((opts) => new GoogleAuth(opts));

  // 1. Service account JSON from env
  const keyJson = env.GA4_SERVICE_ACCOUNT_KEY;
  if (keyJson) {
    try {
      const credentials = JSON.parse(keyJson);
      const token = await makeAuth({ credentials, scopes: GSC_SCOPES }).getAccessToken();
      if (token) return token;
    } catch {
      // malformed JSON or token fetch failed — fall through
    }
  }

  // 2. ADC (GOOGLE_APPLICATION_CREDENTIALS file or Cloud Run metadata server)
  if (env.GOOGLE_APPLICATION_CREDENTIALS || env.K_SERVICE) {
    try {
      const token = await makeAuth({ scopes: GSC_SCOPES }).getAccessToken();
      if (token) return token;
    } catch {
      // ADC not available — fall through
    }
  }

  // 3. Per-client OAuth token (caller provides)
  if (typeof oauthFallback === 'function') {
    return await oauthFallback();
  }

  return null;
}
