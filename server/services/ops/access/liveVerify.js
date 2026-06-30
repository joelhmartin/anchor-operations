/**
 * Live access verification — actually call each agency API and report whether
 * we can reach the account (north-star §0 "test with the real runtime identity").
 *
 * Each verifier returns { status, detail, count? }:
 *   verified  — call succeeded; detail carries a real count/name
 *   failed    — credentials present but the call errored (detail = reason)
 *   degraded  — partial config (e.g. key but no agency id)
 *   missing   — no credential configured
 *
 * Verifiers must NEVER throw (the orchestrator also wraps them) and never log
 * secrets. Each guards on credential presence so it makes no network call when
 * unconfigured — keeping tests offline.
 */
import { GoogleAuth } from 'google-auth-library';
import { listAllSites } from '../operations-website/kinstaApi.js';
import { listAccessibleCustomerIds } from '../checks/google_ads/_client.js';
import { resolveGscToken } from '../connections/gsc/auth.js';

export async function checkKinsta(env = process.env) {
  if (!env.KINSTA_API_KEY) return { status: 'missing', detail: 'KINSTA_API_KEY not set' };
  if (!env.KINSTA_AGENCY_ID) return { status: 'degraded', detail: 'KINSTA_API_KEY set but KINSTA_AGENCY_ID missing' };
  try {
    const sites = await listAllSites();
    return { status: 'verified', detail: `reached Kinsta — ${sites.length} sites`, count: sites.length };
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
    const res = await fetch(`${base}/api/v1/accounts.json`, { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) return { status: 'failed', detail: `CTM API HTTP ${res.status}` };
    const j = await res.json();
    const n = j.total_entries ?? (Array.isArray(j.accounts) ? j.accounts.length : 0);
    return { status: 'verified', detail: `reached CTM — ${n} accounts`, count: n };
  } catch (err) {
    return { status: 'failed', detail: err?.message || 'CTM call failed' };
  }
}

export async function checkMeta(env = process.env) {
  const token = env.FACEBOOK_SYSTEM_USER_TOKEN;
  if (!token) return { status: 'missing', detail: 'FACEBOOK_SYSTEM_USER_TOKEN not set' };
  const tok = encodeURIComponent(token);
  try {
    // Ad accounts are the ops-relevant resource for a system-user token.
    const res = await fetch(`https://graph.facebook.com/v19.0/me/adaccounts?limit=1&summary=true&access_token=${tok}`);
    const j = await res.json();
    if (res.ok) {
      const n = j?.summary?.total_count ?? (Array.isArray(j.data) ? j.data.length : 0);
      return { status: 'verified', detail: `reached Meta — ${n} ad account(s)`, count: n };
    }
    // Fall back to plain token validity if adaccounts permission is missing.
    const me = await fetch(`https://graph.facebook.com/v19.0/me?access_token=${tok}`);
    if (me.ok) return { status: 'verified', detail: 'reached Meta — token valid' };
    return { status: 'failed', detail: `Meta Graph HTTP ${res.status}${j?.error?.message ? ` — ${j.error.message}` : ''}` };
  } catch (err) {
    return { status: 'failed', detail: err?.message || 'Meta call failed' };
  }
}

export async function checkMailgun(env = process.env) {
  const key = env.MAILGUN_API_KEY;
  if (!key) return { status: 'missing', detail: 'MAILGUN_API_KEY not set' };
  try {
    const auth = Buffer.from(`api:${key}`).toString('base64');
    const res = await fetch('https://api.mailgun.net/v3/domains?limit=1', { headers: { Authorization: `Basic ${auth}` } });
    if (!res.ok) return { status: 'failed', detail: `Mailgun API HTTP ${res.status}` };
    const j = await res.json();
    const n = j.total_count ?? 0;
    return { status: 'verified', detail: `reached Mailgun — ${n} domains`, count: n };
  } catch (err) {
    return { status: 'failed', detail: err?.message || 'Mailgun call failed' };
  }
}

export async function checkGoogleAds(env = process.env) {
  if (!(env.GOOGLE_ADS_DEVELOPER_TOKEN && env.GOOGLE_ADS_REFRESH_TOKEN && env.GOOGLE_ADS_CLIENT_ID && env.GOOGLE_ADS_CLIENT_SECRET)) {
    return { status: 'missing', detail: 'Google Ads agency credentials not set' };
  }
  try {
    const ids = await listAccessibleCustomerIds();
    const n = ids?.length || 0;
    return { status: 'verified', detail: `reached Google Ads — ${n} accessible customers`, count: n };
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
    const res = await fetch('https://www.googleapis.com/webmasters/v3/sites', { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { status: 'failed', detail: `Search Console API HTTP ${res.status}` };
    const j = await res.json();
    const n = Array.isArray(j.siteEntry) ? j.siteEntry.length : 0;
    return { status: 'verified', detail: `reached Search Console — ${n} sites`, count: n };
  } catch (err) {
    return { status: 'failed', detail: err?.message || 'Search Console call failed' };
  }
}

export async function checkGa4(env = process.env) {
  const keyJson = env.GA4_SERVICE_ACCOUNT_KEY;
  if (!keyJson && !env.GOOGLE_APPLICATION_CREDENTIALS && !env.K_SERVICE) {
    return { status: 'missing', detail: 'No service-account / ADC for GA4' };
  }
  try {
    const scopes = ['https://www.googleapis.com/auth/analytics.readonly'];
    const auth = keyJson
      ? new GoogleAuth({ credentials: JSON.parse(keyJson), scopes })
      : new GoogleAuth({ scopes });
    const token = await auth.getAccessToken();
    if (!token) return { status: 'failed', detail: 'Could not obtain a GA4 token' };
    const res = await fetch('https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200', {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!res.ok) return { status: 'failed', detail: `GA4 Admin API HTTP ${res.status}` };
    const j = await res.json();
    const summaries = Array.isArray(j.accountSummaries) ? j.accountSummaries : [];
    const props = summaries.reduce((s, a) => s + (a.propertySummaries?.length || 0), 0);
    return { status: 'verified', detail: `reached GA4 — ${props} properties across ${summaries.length} accounts`, count: props };
  } catch (err) {
    return { status: 'failed', detail: err?.message || 'GA4 call failed' };
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

export async function runLiveVerifiers(env = process.env, verifiers = LIVE_VERIFIERS) {
  const out = {};
  for (const [name, fn] of Object.entries(verifiers)) {
    try {
      out[name] = await fn(env);
    } catch (err) {
      out[name] = { status: 'failed', detail: err?.message || 'verifier threw' };
    }
  }
  return out;
}
