/**
 * Live access verification — actually call each agency API and report whether
 * we can reach the account (north-star §0 "test with the real runtime identity").
 *
 * Each verifier returns { status, detail, count? }:
 *   verified  — call succeeded AND at least one resource is visible
 *   degraded  — call succeeded but ZERO resources visible (authenticated, but the
 *               service account / token is not granted on any property/account —
 *               exactly the gap an access audit must surface, so NOT green), or
 *               partial config
 *   failed    — credentials present but the call errored (detail = reason)
 *   missing   — no credential configured
 *
 * Rules: never throw (orchestrator also wraps); never put a secret value in a
 * detail string, URL, or log; every network call has a 10s timeout so a hung
 * agency API cannot stall an operator-triggered audit.
 */
import { GoogleAuth } from 'google-auth-library';
import { listAllSites } from '../operations-website/kinstaApi.js';
import { listAccessibleCustomerIds } from '../checks/google_ads/_client.js';
import { resolveGscToken } from '../connections/gsc/auth.js';

const TIMEOUT_MS = 10000;
const withTimeout = () => ({ signal: AbortSignal.timeout(TIMEOUT_MS) });

// count>0 → verified (green); count===0 → degraded (yellow) — reached the API but
// the credential sees zero resources, which an operator must NOT read as "fine".
function byCount(count, { service, noun, emptyHint }) {
  if (count > 0) return { status: 'verified', detail: `reached ${service} — ${count} ${noun}`, count };
  return { status: 'degraded', detail: `reached ${service} but 0 ${noun} visible — ${emptyHint}`, count: 0 };
}

export async function checkKinsta(env = process.env) {
  if (!env.KINSTA_API_KEY) return { status: 'missing', detail: 'KINSTA_API_KEY not set' };
  if (!env.KINSTA_AGENCY_ID) return { status: 'degraded', detail: 'KINSTA_API_KEY set but KINSTA_AGENCY_ID missing' };
  try {
    const sites = await listAllSites(); // axios client carries its own 20s timeout
    return byCount(sites.length, { service: 'Kinsta', noun: 'sites', emptyHint: 'no sites under this agency id' });
  } catch (err) {
    const code = err?.response?.status;
    return { status: 'failed', detail: code ? `Kinsta API HTTP ${code}` : err?.message || 'Kinsta call failed' };
  }
}

export async function checkCtm(env = process.env) {
  const key = env.CTM_API_KEY;
  const secret = env.CTM_API_SECRET;
  if (!key || !secret) return { status: 'missing', detail: 'CTM_API_KEY / CTM_API_SECRET not set' };
  const base = env.CTM_API_BASE || 'https://api.calltrackingmetrics.com';
  try {
    const auth = Buffer.from(`${key}:${secret}`).toString('base64');
    const res = await fetch(`${base}/api/v1/accounts.json`, { headers: { Authorization: `Basic ${auth}` }, ...withTimeout() });
    if (!res.ok) return { status: 'failed', detail: `CTM API HTTP ${res.status}` };
    const j = await res.json();
    const n = j.total_entries ?? (Array.isArray(j.accounts) ? j.accounts.length : 0);
    return byCount(n, { service: 'CTM', noun: 'accounts', emptyHint: 'token has no accounts' });
  } catch (err) {
    return { status: 'failed', detail: err?.name === 'TimeoutError' ? 'CTM API timed out' : err?.message || 'CTM call failed' };
  }
}

export async function checkMeta(env = process.env) {
  const token = env.FACEBOOK_SYSTEM_USER_TOKEN;
  if (!token) return { status: 'missing', detail: 'FACEBOOK_SYSTEM_USER_TOKEN not set' };
  const headers = { Authorization: `Bearer ${token}` }; // token in header, never the URL
  try {
    const res = await fetch('https://graph.facebook.com/v19.0/me/adaccounts?limit=1&summary=true', { headers, ...withTimeout() });
    const j = await res.json();
    if (res.ok) {
      const n = j?.summary?.total_count ?? (Array.isArray(j.data) ? j.data.length : 0);
      return byCount(n, { service: 'Meta', noun: 'ad accounts', emptyHint: 'system user assigned to no ad accounts' });
    }
    // Fall back to plain token validity; ad-account visibility NOT confirmed → degraded.
    const me = await fetch('https://graph.facebook.com/v19.0/me', { headers, ...withTimeout() });
    if (me.ok) return { status: 'degraded', detail: 'Meta token valid but ad-account access not confirmed' };
    return { status: 'failed', detail: `Meta Graph HTTP ${res.status}${j?.error?.message ? ` — ${j.error.message}` : ''}` };
  } catch (err) {
    return { status: 'failed', detail: err?.name === 'TimeoutError' ? 'Meta Graph timed out' : err?.message || 'Meta call failed' };
  }
}

export async function checkMailgun(env = process.env) {
  const key = env.MAILGUN_API_KEY;
  if (!key) return { status: 'missing', detail: 'MAILGUN_API_KEY not set' };
  try {
    const auth = Buffer.from(`api:${key}`).toString('base64');
    const res = await fetch('https://api.mailgun.net/v3/domains?limit=1', { headers: { Authorization: `Basic ${auth}` }, ...withTimeout() });
    if (!res.ok) return { status: 'failed', detail: `Mailgun API HTTP ${res.status}` };
    const j = await res.json();
    const n = j.total_count ?? 0;
    return byCount(n, { service: 'Mailgun', noun: 'domains', emptyHint: 'key has no domains' });
  } catch (err) {
    return { status: 'failed', detail: err?.name === 'TimeoutError' ? 'Mailgun API timed out' : err?.message || 'Mailgun call failed' };
  }
}

export async function checkGoogleAds(env = process.env) {
  if (!(env.GOOGLE_ADS_DEVELOPER_TOKEN && env.GOOGLE_ADS_REFRESH_TOKEN && env.GOOGLE_ADS_CLIENT_ID && env.GOOGLE_ADS_CLIENT_SECRET)) {
    return { status: 'missing', detail: 'Google Ads agency credentials not set' };
  }
  try {
    const ids = await listAccessibleCustomerIds();
    // null means the client couldn't build creds (env/process.env divergence) — treat
    // as failed, NOT a verified-0 false positive.
    if (ids === null) return { status: 'failed', detail: 'Google Ads client could not resolve agency credentials' };
    return byCount(ids.length, { service: 'Google Ads', noun: 'accessible customers', emptyHint: 'refresh token has no accessible customers' });
  } catch (err) {
    return { status: 'failed', detail: err?.message ? `Google Ads: ${err.message}` : 'Google Ads call failed' };
  }
}

export async function checkGsc(env = process.env) {
  if (!env.GA4_SERVICE_ACCOUNT_KEY && !env.GOOGLE_APPLICATION_CREDENTIALS && !env.K_SERVICE) {
    return { status: 'missing', detail: 'No service-account / ADC for Search Console' };
  }
  try {
    const token = await resolveGscToken({ env });
    if (!token) return { status: 'failed', detail: 'Could not obtain a Search Console token' };
    const res = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: { Authorization: `Bearer ${token}` }, ...withTimeout() });
    if (!res.ok) return { status: 'failed', detail: `Search Console API HTTP ${res.status}` };
    const j = await res.json();
    const n = Array.isArray(j.siteEntry) ? j.siteEntry.length : 0;
    return byCount(n, { service: 'Search Console', noun: 'sites', emptyHint: 'service account not added to any property' });
  } catch (err) {
    return { status: 'failed', detail: err?.name === 'TimeoutError' ? 'Search Console API timed out' : err?.message || 'Search Console call failed' };
  }
}

export async function checkGa4(env = process.env) {
  const keyJson = env.GA4_SERVICE_ACCOUNT_KEY;
  if (!keyJson && !env.GOOGLE_APPLICATION_CREDENTIALS && !env.K_SERVICE) {
    return { status: 'missing', detail: 'No service-account / ADC for GA4' };
  }
  try {
    const scopes = ['https://www.googleapis.com/auth/analytics.readonly'];
    const auth = keyJson ? new GoogleAuth({ credentials: JSON.parse(keyJson), scopes }) : new GoogleAuth({ scopes });
    const token = await auth.getAccessToken();
    if (!token) return { status: 'failed', detail: 'Could not obtain a GA4 token' };
    const res = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', {
      headers: { Authorization: `Bearer ${token}` },
      ...withTimeout()
    });
    if (!res.ok) return { status: 'failed', detail: `GA4 Admin API HTTP ${res.status}` };
    const j = await res.json();
    const summaries = Array.isArray(j.accountSummaries) ? j.accountSummaries : [];
    const props = summaries.reduce((s, a) => s + (a.propertySummaries?.length || 0), 0);
    return byCount(props, { service: 'GA4', noun: `properties across ${summaries.length} accounts`, emptyHint: 'service account not added to any property' });
  } catch (err) {
    return { status: 'failed', detail: err?.name === 'TimeoutError' ? 'GA4 Admin API timed out' : err?.message || 'GA4 call failed' };
  }
}

// Registry of live verifiers — all six agency platforms.
export const LIVE_VERIFIERS = {
  kinsta: checkKinsta,
  ctm: checkCtm,
  meta: checkMeta,
  mailgun: checkMailgun,
  google_ads: checkGoogleAds,
  search_console: checkGsc,
  ga4: checkGa4
};

// Run all verifiers concurrently so total latency is the slowest single call,
// not the sum. Each is individually try/caught so one failure never sinks the rest.
export async function runLiveVerifiers(env = process.env, verifiers = LIVE_VERIFIERS) {
  const results = await Promise.all(
    Object.entries(verifiers).map(async ([name, fn]) => {
      try {
        return [name, await fn(env)];
      } catch (err) {
        return [name, { status: 'failed', detail: err?.message || 'verifier threw' }];
      }
    })
  );
  return Object.fromEntries(results);
}
