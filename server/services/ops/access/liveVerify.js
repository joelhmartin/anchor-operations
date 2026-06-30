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
import { listAllSites } from '../operations-website/kinstaApi.js';

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

// Registry of live verifiers. Expanded slice-by-slice (CTM, Google Ads, GA4,
// GSC, Meta, Mailgun) as each is built and proven.
export const LIVE_VERIFIERS = {
  kinsta: checkKinsta
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
